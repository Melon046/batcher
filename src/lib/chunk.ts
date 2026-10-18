/**
 * Text chunking for document ingestion.
 *
 * Batcher embeds a document by splitting it into overlapping pieces and
 * embedding each piece. Two rules drive the implementation:
 *
 *   1. **Never cut mid-sentence if you can avoid it.** A chunk that starts
 *      with "…and that is why the mitochondria" is a chunk that retrieves
 *      badly, because the embedding has lost the sentence's subject.
 *   2. **Overlap.** Consecutive chunks share a tail. Without overlap, the
 *      sentence that straddles a boundary is in neither chunk and can never be
 *      retrieved — which is exactly the sentence a student usually needs.
 *
 * This is deliberately simple and dependency-free: two students should be able
 * to read it, and there is a unit test that pins its behaviour.
 *
 * It is NOT a tokenizer. It works in characters because that is what the
 * caller has, and because "roughly 4 characters per token" is accurate enough
 * for sizing a retrieval window.
 */

export interface Chunk {
  index: number;
  content: string;
}

/**
 * Normalise extracted text before chunking.
 *
 * PDF extraction in particular produces hard-wrapped lines, page furniture,
 * ligature junk and repeated whitespace. Left alone, those artifacts end up
 * inside embeddings and quietly degrade retrieval.
 */
export function normaliseText(input: string): string {
  return (
    input
      // PDF line-ending noise.
      .replace(/\r\n?/g, "\n")
      // Ligatures and typographic quotes that some PDF fonts emit.
      .replace(/\uFB01/g, "fi")
      .replace(/\uFB02/g, "fl")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\u2013|\u2014/g, "-")
      // Hyphenation at a line break: "mito-\nchondria" -> "mitochondria".
      .replace(/(\w)-\n(\w)/g, "$1$2")
      // A single newline inside a paragraph is a hard wrap, not a new
      // paragraph. Joining them lets the chunker work on real sentences.
      .replace(/([^\n])\n(?=[a-z(])/g, "$1 ")
      // Collapse runs of spaces and blank lines.
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Split text into overlapping chunks of at most `size` characters.
 *
 * Strategy: walk forward `size` characters, then pull the boundary *back* to
 * the last sentence end (or failing that, the last space) within the final
 * `size * 0.25` characters. Then start the next chunk `overlap` characters
 * before the boundary.
 */
export function chunkText(
  raw: string,
  size: number,
  overlap: number,
): Chunk[] {
  const text = normaliseText(raw);

  if (!text) return [];
  // A short document is one chunk. No point splitting a paragraph.
  if (text.length <= size) return [{ index: 0, content: text }];

  // Overlap must leave forward progress on every step, or this loops forever.
  const safeOverlap = Math.min(Math.max(overlap, 0), Math.floor(size / 2));

  const chunks: Chunk[] = [];
  let start = 0;

  while (start < text.length) {
    const hardEnd = Math.min(start + size, text.length);
    let end = hardEnd;

    if (hardEnd < text.length) {
      // Only look back across the last quarter of the window — searching the
      // whole window would produce short chunks on dense prose.
      const floor = start + Math.floor(size * 0.75);
      const window = text.slice(floor, hardEnd);

      const lastBreak = Math.max(
        window.lastIndexOf(". "),
        window.lastIndexOf("? "),
        window.lastIndexOf("! "),
        window.lastIndexOf(".\n"),
        window.lastIndexOf("?\n"),
        window.lastIndexOf("!\n"),
      );

      if (lastBreak >= 0) {
        // +1 keeps the punctuation, and the space stays as the next chunk's
        // leading character (harmless, and it normalises away).
        end = floor + lastBreak + 1;
      } else {
        const lastSpace = window.lastIndexOf(" ");
        if (lastSpace >= 0) end = floor + lastSpace;
      }

      // Guard against a pathological boundary finding nothing usable.
      if (end <= start) end = hardEnd;
    }

    const content = text.slice(start, end).trim();
    if (content) chunks.push({ index: chunks.length, content });

    if (end >= text.length) break;

    // Step back by the overlap, but always move forward.
    start = Math.max(end - safeOverlap, start + 1);

    // If the next window would start inside a word, snap it to the next space
    // so a chunk does not begin mid-word.
    if (start > 0 && start < text.length && !/\s/.test(text[start])) {
      const nextSpace = text.indexOf(" ", start);
      if (nextSpace !== -1 && nextSpace - start < 40) start = nextSpace + 1;
    }
  }

  return chunks;
}

/**
 * Rough token estimate for a string, for cost accounting.
 *
 * Batcher approximates rather than calls a tokenizer: the free tiers are
 * limited by requests per minute, and the difference between 298 and 303
 * tokens never changes a decision. Consistent with the existing chat route,
 * which uses the same 4-characters-per-token rule.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
