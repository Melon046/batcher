"use client";

import type { Thread } from "@/lib/types";

interface Props {
  threads: Thread[];
  activeId: string | null;
  open: boolean;
  workspaceName: string;
  joinCode: string;
  userEmail: string;
  displayName: string;
  copied: boolean;
  onCopyCode: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onSignOut: () => void;
  onClose: () => void;
}

/**
 * The thread list plus the thing that makes Batcher collaborative: the join
 * code. It sits above the threads rather than buried in settings because
 * sharing the workspace is the first thing a second person needs to do.
 */
export function ThreadRail({
  threads,
  activeId,
  open,
  workspaceName,
  joinCode,
  userEmail,
  displayName,
  copied,
  onCopyCode,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onSignOut,
  onClose,
}: Props) {
  function handleRename(thread: Thread) {
    const next = window.prompt("Rename batch", thread.title);
    if (next !== null) onRename(thread.id, next);
  }

  function handleDelete(thread: Thread) {
    const ok = window.confirm(
      `Delete "${thread.title}"? This cannot be undone.`,
    );
    if (ok) onDelete(thread.id);
  }

  return (
    <>
      {open && (
        <div
          onClick={onClose}
          className="fixed inset-0 z-30 bg-black/70 md:hidden"
          aria-hidden
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-white/[0.07] bg-[#0a0b0d] transition-transform duration-200 md:static md:z-auto md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center gap-2.5 px-4 py-4">
          <div className="flex h-8 w-8 flex-col justify-center gap-[3px] rounded-lg bg-gradient-to-br from-teal-400 to-emerald-600 px-2">
            <span className="h-[2px] w-full rounded-full bg-teal-950/70" />
            <span className="h-[2px] w-full rounded-full bg-teal-950/70" />
            <span className="h-[2px] w-2/3 rounded-full bg-teal-950/70" />
          </div>
          <div className="min-w-0 leading-tight">
            <p className="text-sm font-semibold tracking-tight text-white">
              Batcher
            </p>
            <p className="truncate text-[11px] text-zinc-500">{workspaceName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close threads"
            className="ml-auto rounded-lg p-1.5 text-zinc-500 transition hover:bg-white/5 md:hidden"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Join code — the invite, front and centre */}
        <div className="mx-3 rounded-xl border border-teal-400/20 bg-teal-400/[0.05] p-3">
          <p className="text-[10px] font-medium uppercase tracking-wider text-teal-400/80">
            Team join code
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="flex-1 font-mono text-sm tracking-[0.15em] text-teal-200">
              {joinCode}
            </code>
            <button
              type="button"
              onClick={onCopyCode}
              className="rounded-md bg-teal-400/15 px-2 py-1 text-[11px] font-medium text-teal-200 transition hover:bg-teal-400/25"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
            Your teammate signs in, then pastes this to share every thread.
          </p>
        </div>

        <div className="px-3 pt-3">
          <button
            type="button"
            onClick={onNew}
            className="w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-sm font-medium text-white transition hover:bg-white/[0.07]"
          >
            + New batch
          </button>
        </div>

        <nav className="mt-3 flex-1 overflow-y-auto px-2 pb-4">
          {threads.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-zinc-600">
              No batches yet.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {threads.map((thread) => {
                const isActive = thread.id === activeId;
                return (
                  <li key={thread.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => onSelect(thread.id)}
                      className={`w-full truncate rounded-lg px-3 py-2 pr-14 text-left text-sm transition ${
                        isActive
                          ? "bg-white/[0.08] text-white"
                          : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200"
                      }`}
                      title={thread.title}
                    >
                      {thread.title}
                    </button>

                    <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 gap-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                      <button
                        type="button"
                        onClick={() => handleRename(thread)}
                        aria-label="Rename batch"
                        className="rounded-md p-1.5 text-zinc-500 transition hover:bg-white/10 hover:text-white"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(thread)}
                        aria-label="Delete batch"
                        className="rounded-md p-1.5 text-zinc-500 transition hover:bg-red-500/15 hover:text-red-300"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
                        </svg>
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>

        <div className="border-t border-white/[0.07] p-3">
          <p className="truncate text-xs font-medium text-zinc-300">
            {displayName}
          </p>
          <p className="truncate text-[11px] text-zinc-600" title={userEmail}>
            {userEmail}
          </p>
          <button
            type="button"
            onClick={onSignOut}
            className="mt-2 w-full rounded-lg px-2 py-1.5 text-left text-xs text-zinc-500 transition hover:bg-white/5 hover:text-white"
          >
            Sign out
          </button>
        </div>
      </aside>
    </>
  );
}
