import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { embedTexts, toVectorLiteral, isEmbeddingConfigured } from "@/lib/embeddings";

/**
 * The team's remembered facts.
 *
 *   GET    /api/memories?workspaceId=…   list
 *   POST   /api/memories                 { workspaceId, content, kind? }
 *   DELETE /api/memories                 { id }
 *
 * Memories are short, durable statements ("We study at UJ, second year",
 * "Prefers answers in Afrikaans", "Our project is a study app"). They are
 * injected into every batch, so the cap below is deliberately tight: a long
 * memory is paid for on every single item of every single batch.
 */

export const runtime = "nodejs";

/** Hard cap per memory. Anything longer belongs in a document. */
const MAX_MEMORY_CHARS = 400;

/** Cap on stored memories per workspace, to bound the context cost. */
const MAX_MEMORIES_PER_WORKSPACE = 60;

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const workspaceId = request.nextUrl.searchParams.get("workspaceId")?.trim();
  if (!workspaceId) {
    return NextResponse.json({ error: "Missing workspaceId." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("memories")
    .select("id, content, kind, source, created_at")
    .eq("workspace_id", workspaceId)
    .eq("archived", false)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ memories: data ?? [] });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    workspaceId?: string;
    content?: string;
    kind?: string;
  };

  const workspaceId = body.workspaceId?.trim();
  const content = body.content?.trim();

  if (!workspaceId) {
    return NextResponse.json({ error: "Missing workspaceId." }, { status: 400 });
  }
  if (!content) {
    return NextResponse.json({ error: "Write something to remember." }, { status: 400 });
  }
  if (content.length > MAX_MEMORY_CHARS) {
    return NextResponse.json(
      { error: `Keep a memory under ${MAX_MEMORY_CHARS} characters — long text belongs in a document.` },
      { status: 413 },
    );
  }

  // Explicit membership check for a clear 403 instead of a silent RLS miss.
  const { data: membership } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!membership) {
    return NextResponse.json(
      { error: "You're not a member of that workspace." },
      { status: 403 },
    );
  }

  // --- Cap ---------------------------------------------------------------
  // Counted rather than enforced by a constraint, because the message needs to
  // tell the user what to do about it.
  const { count } = await supabase
    .from("memories")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("archived", false);

  if ((count ?? 0) >= MAX_MEMORIES_PER_WORKSPACE) {
    return NextResponse.json(
      {
        error: `This workspace already has ${MAX_MEMORIES_PER_WORKSPACE} memories. Delete one first — every memory costs tokens on every batch.`,
      },
      { status: 429 },
    );
  }

  // --- Embed (optional) ---------------------------------------------------
  // A memory is still useful without an embedding: retrieval falls back to the
  // fact that it exists at all, and the UI lists it plainly.
  let embeddingLiteral: string | null = null;
  let tokens = 0;

  if (isEmbeddingConfigured()) {
    const embedded = await embedTexts([content]);
    if (embedded) {
      embeddingLiteral = toVectorLiteral(embedded.embeddings[0]);
      tokens = embedded.tokens;
    }
  }

  const { data, error } = await supabase
    .from("memories")
    .insert({
      workspace_id: workspaceId,
      created_by: user.id,
      content,
      kind: (body.kind ?? "fact").slice(0, 40),
      source: "manual",
      embedding: embeddingLiteral,
    })
    .select("id, content, kind, source, created_at")
    .single();

  if (error || !data) {
    console.error("[batcher] memory insert failed", error);
    return NextResponse.json({ error: "Could not save that memory." }, { status: 500 });
  }

  if (tokens > 0) {
    await supabase.from("usage_events").insert({
      user_id: user.id,
      workspace_id: workspaceId,
      provider: "google",
      model: process.env.BATCHER_EMBEDDING_MODEL?.trim() || "gemini-embedding-001",
      items: 0,
      input_tokens: tokens,
      output_tokens: 0,
      embedding_tokens: tokens,
      fallback_used: false,
    });
  }

  return NextResponse.json({ memory: data }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { id?: string };
  const id = body.id?.trim();
  if (!id) {
    return NextResponse.json({ error: "Missing id." }, { status: 400 });
  }

  // A real delete, not an archive: the button says "forget this", and a hidden
  // row that still counts toward the cap would be a lie. RLS scopes it to
  // workspaces the caller belongs to.
  const { error } = await supabase.from("memories").delete().eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
