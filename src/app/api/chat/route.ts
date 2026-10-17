import { NextResponse, type NextRequest } from "next/server";
import { streamText } from "ai";
import { createClient } from "@/lib/supabase/server";
import {
  DAILY_TOKEN_LIMIT,
  MAX_BATCH_SIZE,
  MAX_OUTPUT_TOKENS,
  resolveModelChain,
  type ModelChoice,
} from "@/lib/models";
import { parseBatch, threadTitle } from "@/lib/batch";
import { BATCHER_SYSTEM_PROMPT } from "@/lib/prompt";

/**
 * Batch chat endpoint.
 *
 * This is where Batcher differs from a normal chat API. One request carries N
 * separate questions, and the response is a stream of NDJSON *events* rather
 * than one blob of text — because the client has to show item 1 finishing while
 * item 4 is still queued.
 *
 * Contract
 *   POST /api/chat
 *   body: { threadId?: string, workspaceId?: string, input: string }
 *   200 : application/x-ndjson, one JSON object per line (see BatchEvent)
 *   400 : empty input, bad JSON
 *   401 : not signed in
 *   403 : not a member of that workspace / thread
 *   413 : message too long
 *   429 : daily token cap reached
 *   503 : no provider configured
 *
 * Event stream
 *   {type:"batch_start", threadId, items}
 *   {type:"item_start", index}
 *   {type:"delta", index, text}          (repeated)
 *   {type:"item_done", index, provider, model, usedFallback}
 *   {type:"item_error", index, message}
 *   {type:"batch_done", threadId, answered, failed}
 *
 * Items are answered SEQUENTIALLY on purpose. Firing eight completions in
 * parallel is the fastest way to hit a free tier's per-minute limit and get
 * every one of them throttled; going one at a time keeps the batch inside the
 * limit and lets the UI show real progress.
 *
 * Provider keys never leave this process.
 */

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_INPUT_CHARS = 12_000;

export async function POST(request: NextRequest) {
  // --- 1. Authenticate -----------------------------------------------------
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  // --- 2. Parse + validate -------------------------------------------------
  let body: { threadId?: string; workspaceId?: string; input?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const raw = body.input?.trim();
  if (!raw) {
    return NextResponse.json(
      { error: "Type at least one question." },
      { status: 400 },
    );
  }
  if (raw.length > MAX_INPUT_CHARS) {
    return NextResponse.json(
      { error: `Input is too long (max ${MAX_INPUT_CHARS} characters).` },
      { status: 413 },
    );
  }

  const items = parseBatch(raw, MAX_BATCH_SIZE);
  if (items.length === 0) {
    return NextResponse.json({ error: "No questions found." }, { status: 400 });
  }

  // --- 3. Provider chain ---------------------------------------------------
  const chain = resolveModelChain();
  if (chain.length === 0) {
    return NextResponse.json(
      {
        error:
          "No LLM provider is configured. Add GOOGLE_GENERATIVE_AI_API_KEY or GROQ_API_KEY to .env.local and restart the dev server.",
      },
      { status: 503 },
    );
  }

  // --- 4. Daily cap --------------------------------------------------------
  if (DAILY_TOKEN_LIMIT > 0) {
    const { data: usage } = await supabase
      .from("usage_today")
      .select("input_tokens, output_tokens")
      .eq("user_id", user.id)
      .maybeSingle();

    const spent = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
    if (spent >= DAILY_TOKEN_LIMIT) {
      return NextResponse.json(
        { error: "Today's token budget is used up. Try again tomorrow." },
        { status: 429 },
      );
    }
  }

  // --- 5. Resolve the thread, enforcing workspace membership --------------
  // RLS already hides other teams' rows, but resolving explicitly lets us
  // return a clear 403 instead of silently creating a new thread.
  let threadId: string | null = body.threadId ?? null;
  let workspaceId: string | null = body.workspaceId ?? null;

  if (threadId) {
    const { data: existing } = await supabase
      .from("threads")
      .select("id, workspace_id")
      .eq("id", threadId)
      .maybeSingle();

    if (!existing) {
      return NextResponse.json(
        { error: "That thread doesn't exist, or you're not in its workspace." },
        { status: 403 },
      );
    }
    workspaceId = existing.workspace_id;
  } else {
    // Pick the first workspace this user belongs to, if none was supplied.
    if (!workspaceId) {
      const { data: membership } = await supabase
        .from("workspace_members")
        .select("workspace_id")
        .eq("user_id", user.id)
        .order("joined_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      workspaceId = membership?.workspace_id ?? null;
    }

    if (!workspaceId) {
      return NextResponse.json(
        {
          error:
            "You're not in a workspace yet. Reload the page to create one.",
        },
        { status: 403 },
      );
    }

    const { data: created, error } = await supabase
      .from("threads")
      .insert({
        workspace_id: workspaceId,
        title: threadTitle(items),
        created_by: user.id,
      })
      .select("id")
      .single();

    if (error || !created) {
      return NextResponse.json(
        { error: "Could not start a new batch." },
        { status: 500 },
      );
    }
    threadId = created.id;
  }

  // --- 6. Persist the questions -------------------------------------------
  // One row per item, so a teammate opening the thread later sees exactly the
  // list that was asked, in order.
  const { error: questionError } = await supabase.from("messages").insert(
    items.map((question, index) => ({
      thread_id: threadId,
      workspace_id: workspaceId,
      author_id: user.id,
      role: "user" as const,
      item_index: index,
      content: question,
    })),
  );

  if (questionError) {
    return NextResponse.json(
      { error: "Could not save your batch." },
      { status: 500 },
    );
  }

  // --- 7. Stream the answers ----------------------------------------------
  // Narrow the nulls once, here. Every branch above either returned or set a
  // real value, but TypeScript cannot see through the mutation.
  if (!threadId || !workspaceId) {
    return NextResponse.json(
      { error: "Could not resolve the batch's thread." },
      { status: 500 },
    );
  }

  const resolvedThreadId: string = threadId;
  const resolvedWorkspaceId: string = workspaceId;
  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      let answered = 0;
      let failed = 0;

      emit({
        type: "batch_start",
        threadId: resolvedThreadId,
        items: items.length,
      });

      for (let index = 0; index < items.length; index += 1) {
        if (request.signal.aborted) break;

        const question = items[index];
        emit({ type: "item_start", index });

        let accumulated = "";
        let done = false;

        for (const choice of chain) {
          if (request.signal.aborted) break;

          try {
            const result = streamText({
              model: choice.model,
              system: BATCHER_SYSTEM_PROMPT,
              prompt: `Batch question ${index + 1} of ${items.length}:\n\n${question}`,
              maxOutputTokens: MAX_OUTPUT_TOKENS,
              temperature: 0.6,
              abortSignal: request.signal,
            });

            const iterator = result.textStream[Symbol.asyncIterator]();
            // Pull the first chunk before committing, so a 429/404 falls
            // through to the next provider instead of emitting a dead item.
            const first = await iterator.next();

            if (!first.done && first.value) {
              accumulated += first.value;
              emit({ type: "delta", index, text: first.value });
            }

            while (true) {
              const next = await iterator.next();
              if (next.done) break;
              accumulated += next.value;
              emit({ type: "delta", index, text: next.value });
            }

            emit({
              type: "item_done",
              index,
              provider: choice.provider,
              model: choice.modelId,
              usedFallback: choice !== chain[0],
            });

            await persistAnswer(supabase, {
              threadId: resolvedThreadId,
              workspaceId: resolvedWorkspaceId,
              userId: user.id,
              index,
              content: accumulated,
              choice,
              usedFallback: choice !== chain[0],
              startedAt,
              items: 1,
            });

            answered += 1;
            done = true;
            break;
          } catch (providerError) {
            if (request.signal.aborted) break;
            console.warn(
              `[batcher] item ${index + 1}: provider "${choice.provider}" failed, trying next`,
              providerError,
            );
          }
        }

        if (!done && !request.signal.aborted) {
          failed += 1;
          emit({
            type: "item_error",
            index,
            message: "Every provider failed for this question.",
          });
        }
      }

      emit({
        type: "batch_done",
        threadId: resolvedThreadId,
        answered,
        failed,
      });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Thread-Id": resolvedThreadId ?? "",
      "X-Batch-Items": String(items.length),
      // Stop nginx and friends from buffering the stream into one blob.
      "X-Accel-Buffering": "no",
    },
  });
}

async function persistAnswer(
  supabase: Awaited<ReturnType<typeof createClient>>,
  args: {
    threadId: string;
    workspaceId: string;
    userId: string;
    index: number;
    content: string;
    choice: ModelChoice;
    usedFallback: boolean;
    startedAt: number;
    items: number;
  },
) {
  try {
    await supabase.from("messages").insert({
      thread_id: args.threadId,
      workspace_id: args.workspaceId,
      author_id: null,
      role: "assistant",
      item_index: args.index,
      content: args.content,
      model: args.choice.modelId,
      provider: args.choice.provider,
    });

    // Token counts are approximated from characters: the free tier is limited
    // by requests per minute, and a per-item exact count would need another
    // await inside the stream for no real benefit at this scale.
    const approxOut = Math.ceil(args.content.length / 4);
    const approxIn = Math.ceil(280 / 4);

    await supabase.from("usage_events").insert({
      user_id: args.userId,
      workspace_id: args.workspaceId,
      thread_id: args.threadId,
      provider: args.choice.provider,
      model: args.choice.modelId,
      items: args.items,
      input_tokens: approxIn,
      output_tokens: approxOut,
      latency_ms: Date.now() - args.startedAt,
      fallback_used: args.usedFallback,
    });

    await supabase
      .from("threads")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", args.threadId);
  } catch (error) {
    // Bookkeeping must never cost the team an answer.
    console.error("[batcher] failed to persist answer", error);
  }
}
