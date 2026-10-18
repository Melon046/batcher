"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { KnowledgeDocument, MemoryRow } from "@/lib/types";

interface Props {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  /** Called after an upload lands, so the workspace can refresh its state. */
  onChanged?: () => void;
}

/**
 * The knowledge panel: what Batcher can read, and what it remembers.
 *
 * Two tabs rather than two panels, because they answer the same question —
 * "what does Batcher know about us?" — and a second sidebar would crowd the
 * thread rail, which is the thing people actually use every minute.
 *
 * Kept intentionally plain: a file input, a list, and a text box. Two students
 * should be able to read every line of this and change it.
 */
export function KnowledgePanel({ workspaceId, open, onClose, onChanged }: Props) {
  const [tab, setTab] = useState<"documents" | "memories">("documents");
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [memories, setMemories] = useState<MemoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [memoryDraft, setMemoryDraft] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [docsResponse, memoriesResponse] = await Promise.all([
        fetch(`/api/documents?workspaceId=${encodeURIComponent(workspaceId)}`),
        fetch(`/api/memories?workspaceId=${encodeURIComponent(workspaceId)}`),
      ]);

      const docsPayload = (await docsResponse.json()) as {
        documents?: KnowledgeDocument[];
        error?: string;
      };
      const memoriesPayload = (await memoriesResponse.json()) as {
        memories?: MemoryRow[];
        error?: string;
      };

      if (docsPayload.error) setError(docsPayload.error);
      if (memoriesPayload.error) setError(memoriesPayload.error);

      setDocuments(docsPayload.documents ?? []);
      setMemories(memoriesPayload.memories ?? []);
    } catch {
      setError("Could not load your library.");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  async function handleUpload(file: File) {
    setUploading(true);
    setError(null);
    setNotice(null);

    try {
      const form = new FormData();
      form.append("file", file);
      form.append("workspaceId", workspaceId);

      const response = await fetch("/api/documents", {
        method: "POST",
        body: form,
      });

      const payload = (await response.json()) as {
        error?: string;
        note?: string;
        document?: { chunkCount: number; title: string };
      };

      if (!response.ok) {
        setError(payload.error ?? "That upload failed.");
        return;
      }

      setNotice(
        payload.note ??
          `Added "${payload.document?.title}" — ${payload.document?.chunkCount} searchable passages.`,
      );
      await refresh();
      onChanged?.();
    } catch {
      setError("That upload failed. Check your connection and try again.");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function handleAddMemory() {
    const content = memoryDraft.trim();
    if (!content) return;

    setError(null);
    const response = await fetch("/api/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, content }),
    });

    const payload = (await response.json()) as { error?: string };
    if (!response.ok) {
      setError(payload.error ?? "Could not save that memory.");
      return;
    }

    setMemoryDraft("");
    await refresh();
  }

  async function handleDeleteMemory(id: string) {
    setError(null);
    const response = await fetch("/api/memories", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });

    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setError(payload.error ?? "Could not delete that memory.");
      return;
    }
    await refresh();
  }

  if (!open) return null;

  return (
    <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-white/[0.08] bg-[#0a0b0d] shadow-2xl">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-white/[0.07] px-4 py-3">
        <p className="text-sm font-semibold tracking-tight text-white">
          What Batcher knows
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="ml-auto rounded-lg p-1.5 text-zinc-500 transition hover:bg-white/5 hover:text-white"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-white/[0.07] px-3 py-2">
        {(["documents", "memories"] as const).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition ${
              tab === name
                ? "bg-white/[0.08] text-white"
                : "text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-300"
            }`}
          >
            {name}
            <span className="ml-1.5 text-zinc-600">
              {name === "documents" ? documents.length : memories.length}
            </span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => void refresh()}
          className="ml-auto rounded-lg px-2 py-1.5 text-xs text-zinc-600 transition hover:text-zinc-300"
        >
          {loading ? "…" : "Refresh"}
        </button>
      </div>

      {error && (
        <p className="border-b border-red-500/20 bg-red-500/[0.08] px-4 py-2 text-xs leading-relaxed text-red-300">
          {error}
        </p>
      )}
      {notice && (
        <p className="border-b border-teal-400/20 bg-teal-400/[0.06] px-4 py-2 text-xs leading-relaxed text-teal-200">
          {notice}
        </p>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4">
        {tab === "documents" ? (
          <div className="space-y-3">
            {/* Upload */}
            <div className="rounded-xl border border-dashed border-white/[0.12] bg-white/[0.015] p-4 text-center">
              <p className="text-xs leading-relaxed text-zinc-400">
                Upload a PDF or notes file. Batcher splits it up and can answer
                from it in every batch from then on.
              </p>
              <input
                ref={fileInput}
                type="file"
                accept=".pdf,.txt,.md,.markdown,.csv"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleUpload(file);
                }}
              />
              <button
                type="button"
                disabled={uploading}
                onClick={() => fileInput.current?.click()}
                className="mt-3 rounded-lg bg-teal-400 px-3.5 py-2 text-xs font-semibold text-teal-950 transition hover:bg-teal-300 disabled:opacity-50"
              >
                {uploading ? "Reading…" : "Choose a file"}
              </button>
              <p className="mt-2 text-[11px] text-zinc-600">
                PDF, .txt, .md, .csv · up to 8 MB
              </p>
            </div>

            {documents.length === 0 ? (
              <p className="px-1 py-6 text-center text-xs text-zinc-600">
                Nothing uploaded yet. A past paper or your lecture notes is a
                good first one.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {documents.map((document) => (
                  <li
                    key={document.id}
                    className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5"
                  >
                    <div className="flex items-baseline gap-2">
                      <p className="min-w-0 flex-1 truncate text-[13px] text-zinc-200">
                        {document.title}
                      </p>
                      {document.status === "failed" ? (
                        <span className="shrink-0 text-[10px] text-red-400">
                          failed
                        </span>
                      ) : (
                        <span className="shrink-0 font-mono text-[10px] text-zinc-600">
                          {document.chunk_count}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-zinc-600">
                      {formatSize(document.size_bytes)}
                      {document.status === "failed" && document.error
                        ? ` · ${document.error}`
                        : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <textarea
                value={memoryDraft}
                onChange={(event) => setMemoryDraft(event.target.value)}
                rows={3}
                placeholder={
                  "Something worth remembering, e.g.\nWe're both second-year students at UJ.\nAnswers should be in plain English."
                }
                className="w-full resize-none rounded-xl border border-white/[0.09] bg-black/30 px-3 py-2.5 text-[13px] leading-5 text-white placeholder-zinc-600 outline-none transition focus:border-teal-400/40"
              />
              <div className="mt-2 flex items-center gap-2">
                <span className="text-[11px] text-zinc-600">
                  {memoryDraft.length}/400
                </span>
                <button
                  type="button"
                  onClick={() => void handleAddMemory()}
                  disabled={!memoryDraft.trim()}
                  className="ml-auto rounded-lg bg-teal-400 px-3.5 py-1.5 text-xs font-semibold text-teal-950 transition hover:bg-teal-300 disabled:opacity-40"
                >
                  Remember this
                </button>
              </div>
            </div>

            {memories.length === 0 ? (
              <p className="px-1 py-6 text-center text-xs leading-relaxed text-zinc-600">
                Nothing remembered yet. Memories are sent with every batch, so
                keep them short and true.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {memories.map((memory) => (
                  <li
                    key={memory.id}
                    className="group flex items-start gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5"
                  >
                    <p className="min-w-0 flex-1 text-[13px] leading-5 text-zinc-300">
                      {memory.content}
                    </p>
                    <button
                      type="button"
                      onClick={() => void handleDeleteMemory(memory.id)}
                      aria-label="Forget this"
                      className="shrink-0 rounded p-1 text-zinc-700 opacity-0 transition hover:bg-red-500/15 hover:text-red-300 group-hover:opacity-100"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <p className="px-1 text-[11px] leading-relaxed text-zinc-600">
              Both of you can see and edit these. Every memory is sent with each
              batch, so it costs a little on every answer — keep the list short.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
