/**
 * Batch input parsing.
 *
 * Batcher's core idea is that you paste a list of questions and get a list of
 * answers back. The parser is deliberately forgiving, because the whole point
 * is that the team can paste straight out of a notes app:
 *
 *   - one question per line, or
 *   - a numbered / bulleted list ("1. ...", "- ...", "* ..."), or
 *   - blank-line separated paragraphs
 *
 * Shared by the client (to preview the item count) and the server (to build
 * the real batch), so the count the user sees is exactly what gets billed.
 */

const LIST_PREFIX = /^\s*(?:\d+[.)]|[-*•])\s+/;

export function parseBatch(input: string, maxItems: number): string[] {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) return [];

  // Every line looks like a list item -> one question per line.
  const allListItems = lines.every((line) => LIST_PREFIX.test(line));
  if (allListItems) {
    return lines
      .map((line) => line.replace(LIST_PREFIX, "").trim())
      .filter(Boolean)
      .slice(0, maxItems);
  }

  // Otherwise split on blank lines, so a multi-line paragraph stays one item.
  const blocks = input
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.length > 1) {
    return blocks.slice(0, maxItems);
  }

  // Single block: if it has several sentence-like lines, treat each as an item.
  if (lines.length > 1) {
    return lines
      .map((line) => line.replace(LIST_PREFIX, "").trim())
      .slice(0, maxItems);
  }

  return [blocks[0]].filter(Boolean).slice(0, maxItems);
}

/** Title for a new thread: first question, trimmed to a sensible length. */
export function threadTitle(items: string[]): string {
  const first = items[0] ?? "New batch";
  const base = first.length > 54 ? `${first.slice(0, 54).trimEnd()}…` : first;
  return items.length > 1 ? `${base} (+${items.length - 1})` : base;
}
