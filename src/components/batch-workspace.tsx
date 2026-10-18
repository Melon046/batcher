"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { parseBatch } from "@/lib/batch";
import type { BatchEvent, BatchItem, Thread, SourceRef } from "@/lib/types";
import { ThreadRail } from "./thread-rail";
import { BatchComposer } from "./batch-composer";
import { BatchResults } from "./batch-results";
import { KnowledgePanel } from "./knowledge-panel";

interface Props {
  workspaceId: string;
  workspaceName: string;
  joinCode: string;
  userEmail: string;
  defaultName: string;
}

const MAX_ITEMS = 8;

/**
 * Owns all client state for the workspace and drives the NDJSON stream.
 *
 * The stream is read by hand rather than with a helper because each line is an
 * independent event about a *different* item — a batch is not one growing
 * string, it is N answers growing at once, one at a time.
 */
export function BatchWorkspace({
  workspaceId,
  workspaceName,
  joinCode,
  userEmail,
  defaultName,
}: Props) {
  const supabase = useMemo(() => createClient(), []);

  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [items, setItems] = useState<BatchItem[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [sources, setSources] = useState<SourceRef[]>([]);

  const abortRef = useRef<AbortController | null>(null);

  const plannedItems = useMemo(() => parseBatch(input, MAX_ITEMS), [input]);

  // --- Threads -------------------------------------------------------------
  const loadThreads = useCallback(async () => {
    const { data, error: listError } = await supabase
      .from("threads")
      .select("id, workspace_id, title, created_by, created_at, updated_at")
      .eq("workspace_id", workspaceId)
      .order("updated_at", { ascending: false });

    if (listError) {
      setError(listError.message);
      return;
    }
    setThreads((data ?? []) as Thread[]);
  }, [supabase, workspaceId]);

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  const openThread = useCallback(
    async (id: string) => {
      setActiveThreadId(id);
      setRailOpen(false);
      setError(null);
      // Sources belong to a batch, not to a thread — clear them so an old
      // batch's chips do not appear above a different thread's answers.
      setSources([]);

      const { data, error: loadError } = await supabase
        .from("messages")
        .select(
          "id, thread_id, workspace_id, author_id, role, item_index, content, model, provider, created_at",
        )
        .eq("thread_id", id)
        .order("item_index", { ascending: true })
        .order("created_at", { ascending: true });

      if (loadError) {
        setError(loadError.message);
        return;
      }

      // Rebuild the batch view: pair each question with its answer by index.
      const questions = (data ?? []).filter((row) => row.role === "user");
      const answers = (data ?? []).filter((row) => row.role === "assistant");

      setItems(
        questions.map((question) => {
          const answer = answers.find(
            (row) => row.item_index === question.item_index,
          );
          return {
            index: question.item_index,
            question: question.content,
            answer: answer?.content ?? "",
            status: answer ? ("done" as const) : ("failed" as const),
            provider: answer?.provider ?? null,
            model: answer?.model ?? null,
            error: answer ? undefined : "No saved answer for this item.",
          };
        }),
      );
    },
    [supabase],
  );

  const newBatch = useCallback(() => {
    abortRef.current?.abort();
    setActiveThreadId(null);
    setItems([]);
    setSources([]);
    setInput("");
    setError(null);
    setRailOpen(false);
  }, []);

  const deleteThread = useCallback(
    async (id: string) => {
      await supabase.from("threads").delete().eq("id", id);
      if (activeThreadId === id) newBatch();
      await loadThreads();
    },
    [supabase, activeThreadId, newBatch, loadThreads],
  );

  const renameThread = useCallback(
    async (id: string, title: string) => {
      const clean = title.trim();
      if (!clean) return;
      await supabase.from("threads").update({ title: clean }).eq("id", id);
      await loadThreads();
    },
    [supabase, loadThreads],
  );

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }, [supabase]);

  const copyJoinCode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(joinCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Couldn't copy automatically — select the code and copy it.");
    }
  }, [joinCode]);

  // --- Run a batch ---------------------------------------------------------
  const runBatch = useCallback(async () => {
    const questions = parseBatch(input, MAX_ITEMS);
    if (questions.length === 0 || running) return;

    setError(null);
    setRunning(true);
    setSources([]);

    // Show every item immediately in "queued", so the user sees the whole
    // shape of the batch before the first token arrives.
    setItems(
      questions.map((question, index) => ({
        index,
        question,
        answer: "",
        status: "queued" as const,
      })),
    );
    setInput("");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          threadId: activeThreadId,
          input: questions.join("\n"),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const payload = (await response
          .json()
          .catch(() => ({ error: null }))) as { error?: string } | null;
        throw new Error(
          payload?.error ?? `Request failed with status ${response.status}.`,
        );
      }

      const newThreadId = response.headers.get("X-Thread-Id");
      if (newThreadId && newThreadId !== activeThreadId) {
        setActiveThreadId(newThreadId);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("The response had no readable body.");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // NDJSON: only act on complete lines; a chunk can split one in half.
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) applyEvent(line, setItems, setSources);
          newline = buffer.indexOf("\n");
        }
      }

      if (buffer.trim()) applyEvent(buffer.trim(), setItems, setSources);
      await loadThreads();
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (!isAbort) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
        setItems((prev) =>
          prev.map((item) =>
            item.status === "queued" || item.status === "answering"
              ? { ...item, status: "failed" as const, error: "Batch interrupted." }
              : item,
          ),
        );
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [input, running, workspaceId, activeThreadId, loadThreads]);

  const stopBatch = useCallback(() => {
    abortRef.current?.abort();
    setItems((prev) =>
      prev.map((item) => {
        if (item.status === "answering") {
          return { ...item, status: "failed" as const, error: "Stopped." };
        }
        if (item.status === "queued") {
          return { ...item, status: "failed" as const, error: "Not run." };
        }
        return item;
      }),
    );
  }, []);

  // --- Render --------------------------------------------------------------
  return (
    <div className="flex h-dvh overflow-hidden bg-[#07080a]">
      <ThreadRail
        threads={threads}
        activeId={activeThreadId}
        open={railOpen}
        workspaceName={workspaceName}
        joinCode={joinCode}
        userEmail={userEmail}
        displayName={defaultName}
        copied={copied}
        onCopyCode={copyJoinCode}
        onSelect={openThread}
        onNew={newBatch}
        onRename={renameThread}
        onDelete={deleteThread}
        onSignOut={signOut}
        onClose={() => setRailOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-white/[0.07] px-4 py-3">
          <button
            type="button"
            onClick={() => setRailOpen(true)}
            aria-label="Open threads"
            className="rounded-lg border border-white/10 p-2 text-zinc-400 transition hover:bg-white/5 md:hidden"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>

          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tracking-tight text-white">
              {activeThreadId
                ? threads.find((thread) => thread.id === activeThreadId)
                    ?.title ?? "Batch"
                : "New batch"}
            </p>
            <p className="text-[11px] text-zinc-500">
              {running
                ? "Working through the list…"
                : plannedItems.length > 0
                  ? `${plannedItems.length} item${plannedItems.length === 1 ? "" : "s"} ready`
                  : "One question per line"}
            </p>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setKnowledgeOpen(true)}
              className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-white/5 hover:text-white"
            >
              Knowledge
            </button>
            <span className="hidden rounded-full border border-white/[0.07] bg-white/[0.03] px-2.5 py-1 text-[11px] text-zinc-500 sm:inline">
              Gemini Flash → Groq
            </span>
            <button
              type="button"
              onClick={newBatch}
              className="rounded-lg bg-white/[0.08] px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white/[0.13]"
            >
              New batch
            </button>
          </div>
        </header>

        {error && (
          <div className="border-b border-red-500/20 bg-red-500/[0.08] px-4 py-2.5 text-sm text-red-300">
            {error}
          </div>
        )}

        <BatchResults
          items={items}
          running={running}
          sources={sources}
          onSuggestion={(text) => setInput(text)}
        />

        <BatchComposer
          value={input}
          onChange={setInput}
          onRun={runBatch}
          onStop={stopBatch}
          running={running}
          itemCount={plannedItems.length}
          maxItems={MAX_ITEMS}
        />
      </div>

      <KnowledgePanel
        workspaceId={workspaceId}
        open={knowledgeOpen}
        onClose={() => setKnowledgeOpen(false)}
      />
    </div>
  );
}

/** Fold one NDJSON event into the item list. */
function applyEvent(
  line: string,
  setItems: React.Dispatch<React.SetStateAction<BatchItem[]>>,
  setSources: React.Dispatch<React.SetStateAction<SourceRef[]>>,
) {
  let event: BatchEvent;
  try {
    event = JSON.parse(line) as BatchEvent;
  } catch {
    return;
  }

  switch (event.type) {
    case "item_start":
      setItems((prev) =>
        prev.map((item) =>
          item.index === event.index ? { ...item, status: "answering" } : item,
        ),
      );
      break;
    case "delta":
      setItems((prev) =>
        prev.map((item) =>
          item.index === event.index
            ? {
                ...item,
                answer: item.answer + event.text,
                status: "answering",
              }
            : item,
        ),
      );
      break;
    case "item_done":
      setItems((prev) =>
        prev.map((item) =>
          item.index === event.index
            ? {
                ...item,
                status: "done",
                provider: event.provider,
                model: event.model,
                usedFallback: event.usedFallback,
              }
            : item,
        ),
      );
      break;
    case "item_error":
      setItems((prev) =>
        prev.map((item) =>
          item.index === event.index
            ? { ...item, status: "failed", error: event.message }
            : item,
        ),
      );
      break;
    case "context":
      // Retrieved for the whole batch, so it is shown once above the answers
      // rather than repeated on every item.
      setSources(event.sources);
      break;
    default:
      break;
  }
}
