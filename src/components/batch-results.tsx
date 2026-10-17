"use client";

import type { BatchItem } from "@/lib/types";
import { Markdown } from "./markdown";

interface Props {
  items: BatchItem[];
  running: boolean;
  onSuggestion: (text: string) => void;
}

const EXAMPLES: { label: string; text: string }[] = [
  {
    label: "Study sprint",
    text: [
      "Explain the difference between confidence interval and p-value, in plain English.",
      "Give me a 25-minute revision plan for a maths test tomorrow.",
      "Turn this into 6 flashcard questions: photosynthesis light and dark reactions.",
      "What is the most common mistake students make with sig figs?",
    ].join("\n"),
  },
  {
    label: "Build split",
    text: [
      "What should I build first: auth or the data model? One sentence.",
      "List 3 free tools for deploying a Next.js app with a database.",
      "Write a Prisma schema for users, projects and tasks.",
      "How do I test that Row Level Security actually blocks another user?",
    ].join("\n"),
  },
  {
    label: "Content batch",
    text: [
      "Give me 5 short video titles about studying with AI.",
      "Write a 60-word caption for the best one.",
      "Suggest 3 hooks for the opening 3 seconds.",
      "What thumbnail text would work for each?",
    ].join("\n"),
  },
];

/**
 * Renders the batch as a numbered list of independent answers.
 *
 * Each item carries its own status, so the page reads as progress rather than
 * as one long reply: queued items are dimmed, the active one shows a caret, and
 * finished ones keep their provider badge.
 */
export function BatchResults({ items, running, onSuggestion }: Props) {
  const done = items.filter((item) => item.status === "done").length;

  if (items.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-10">
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            What are we working through?
          </h1>
          <p className="mt-2 max-w-lg text-sm leading-relaxed text-zinc-400">
            Paste a list — one question per line. Batcher answers each one in
            order and keeps the whole batch in this thread for both of you.
          </p>

          <div className="mt-8 space-y-2">
            {EXAMPLES.map((example) => (
              <button
                key={example.label}
                type="button"
                onClick={() => onSuggestion(example.text)}
                className="w-full rounded-xl border border-white/[0.07] bg-white/[0.02] p-4 text-left transition hover:border-teal-400/25 hover:bg-white/[0.04]"
              >
                <p className="text-[11px] font-medium uppercase tracking-wider text-teal-400/80">
                  {example.label}
                </p>
                <p className="mt-1.5 text-[13px] leading-relaxed text-zinc-400">
                  {example.text.split("\n")[0]}
                  <span className="text-zinc-600">
                    {" "}
                    +{example.text.split("\n").length - 1} more
                  </span>
                </p>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <div className="mb-5 flex items-center gap-2 border-b border-white/[0.06] pb-3">
          <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            Batch
          </span>
          <span className="text-[11px] text-zinc-600">
            {done}/{items.length} answered
          </span>
          {running && (
            <span className="ml-auto flex items-center gap-1.5 text-[11px] text-teal-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-400" />
              running
            </span>
          )}
        </div>

        <ol className="space-y-7">
          {items.map((item) => (
            <li key={item.index} className="flex gap-3">
              <div
                className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md font-mono text-[11px] ${
                  item.status === "done"
                    ? "bg-teal-400/15 text-teal-300"
                    : item.status === "answering"
                      ? "bg-teal-400/10 text-teal-400/70"
                      : item.status === "failed"
                        ? "bg-red-500/10 text-red-400"
                        : "bg-white/[0.04] text-zinc-600"
                }`}
              >
                {item.index + 1}
              </div>

              <div className="min-w-0 flex-1">
                <p className="text-[0.9375rem] font-medium leading-6 text-zinc-100">
                  {item.question}
                </p>

                <div className="mt-2">
                  {item.status === "queued" && (
                    <p className="text-[13px] text-zinc-600">Queued…</p>
                  )}

                  {item.status === "answering" && !item.answer && (
                    <div
                      className="flex items-center gap-1 py-1"
                      aria-label="Thinking"
                    >
                      {[0, 1, 2].map((i) => (
                        <span
                          key={i}
                          className="h-1.5 w-1.5 animate-bounce rounded-full bg-teal-400/50"
                          style={{ animationDelay: `${i * 120}ms` }}
                        />
                      ))}
                    </div>
                  )}

                  {item.answer && (
                    <div
                      className={
                        item.status === "answering" ? "batch-caret" : undefined
                      }
                    >
                      <Markdown content={item.answer} />
                    </div>
                  )}

                  {item.status === "failed" && (
                    <p className="rounded-lg border border-red-500/20 bg-red-500/[0.07] px-3 py-2 text-[13px] text-red-300">
                      {item.error ?? "This item failed."}
                    </p>
                  )}

                  {item.status === "done" && item.provider && (
                    <p className="mt-1.5 text-[11px] text-zinc-600">
                      {item.provider === "google"
                        ? "Gemini Flash"
                        : "Llama (Groq)"}
                      {item.model ? ` · ${item.model}` : ""}
                      {item.usedFallback ? " · fallback" : ""}
                    </p>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>

        <div className="h-6" />
      </div>
    </div>
  );
}
