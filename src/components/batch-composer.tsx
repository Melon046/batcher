"use client";

import { useEffect, useRef } from "react";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  onStop: () => void;
  running: boolean;
  itemCount: number;
  maxItems: number;
}

/**
 * The batch composer.
 *
 * Cmd/Ctrl+Enter runs the batch rather than Enter, because the input is
 * multi-line by nature — one question per line. Enter must insert a newline
 * here, which is the opposite of a normal chat box.
 */
export function BatchComposer({
  value,
  onChange,
  onRun,
  onStop,
  running,
  itemCount,
  maxItems,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [value]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onRun();
    }
  }

  const atLimit = itemCount >= maxItems;

  return (
    <div className="border-t border-white/[0.07] bg-[#07080a]/90 px-4 py-3 backdrop-blur">
      <div className="mx-auto w-full max-w-3xl">
        <div className="rounded-2xl border border-white/[0.09] bg-white/[0.02] p-2 transition focus-within:border-teal-400/40 focus-within:ring-2 focus-within:ring-teal-400/10">
          <textarea
            ref={textareaRef}
            rows={3}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              "One question per line:\n1. What does a 403 from Supabase RLS mean?\n2. Draft a revision timetable for 3 subjects\n3. Summarise chapter 4 in five bullets"
            }
            className="max-h-[260px] w-full resize-none bg-transparent px-2 py-1.5 text-[0.9375rem] leading-6 text-white placeholder-zinc-600 outline-none"
          />

          <div className="flex items-center gap-2 px-1 pb-1">
            <span
              className={`text-[11px] ${
                atLimit ? "text-amber-400" : "text-zinc-600"
              }`}
            >
              {itemCount}/{maxItems} items
              {itemCount > 1 ? " · answered one at a time" : ""}
            </span>
            <span className="text-[11px] text-zinc-700">·</span>
            <span className="hidden text-[11px] text-zinc-600 sm:inline">
              ⌘/Ctrl + Enter to run
            </span>

            <div className="ml-auto flex items-center gap-2">
              {running ? (
                <button
                  type="button"
                  onClick={onStop}
                  className="rounded-xl border border-white/15 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/10"
                >
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onRun}
                  disabled={itemCount === 0}
                  className="rounded-xl bg-teal-400 px-4 py-2 text-sm font-semibold text-teal-950 transition hover:bg-teal-300 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  Run batch
                </button>
              )}
            </div>
          </div>
        </div>

        <p className="mt-2 text-center text-[11px] text-zinc-700">
          Answers are shared with everyone in this workspace.
        </p>
      </div>
    </div>
  );
}
