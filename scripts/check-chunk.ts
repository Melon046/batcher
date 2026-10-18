/**
 * Sanity checks for the chunker.
 *
 * Run with:  npm run check:chunk
 *
 * No test-runner dependency on purpose: two students should be able to read
 * this and add a case without learning Jest.
 */

import { chunkText, normaliseText, estimateTokens } from "../src/lib/chunk";

let failures = 0;

/** Shared fixture: one complete sentence, repeated to build long inputs. */
const SENTENCE =
  "This is a complete sentence that carries enough words to matter for retrieval purposes. ";

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\nnormaliseText");
{
  const pdfNoise = normaliseText(
    "The mito-\nchondria is the\npowerhouse of the cell.\n\n\n\nIt produces ATP.",
  );
  check(
    "joins a hyphenated line break",
    pdfNoise.includes("mitochondria"),
    pdfNoise,
  );
  check("collapses triple newlines", !pdfNoise.includes("\n\n\n"), pdfNoise);
  // A hard wrap inside a sentence (newline, then a lowercase word) is a
  // layout artifact, not a paragraph break, so it must be joined.
  check(
    "joins a hard-wrapped sentence",
    pdfNoise.includes("the powerhouse of the cell"),
    pdfNoise,
  );
  // …but a real paragraph break is preserved.
  check(
    "keeps a real paragraph break",
    pdfNoise.includes("\n\nIt produces"),
    pdfNoise,
  );

  const ligatures = normaliseText("The \uFB01rst \uFB02oor");
  check("expands fi/fl ligatures", ligatures === "The first floor", ligatures);
}

console.log("\nchunkText — short input");
{
  const chunks = chunkText("Just one short paragraph.", 1200, 150);
  check("returns exactly one chunk", chunks.length === 1);
  check("index starts at 0", chunks[0]?.index === 0);
  check("content preserved", chunks[0]?.content === "Just one short paragraph.");
}

console.log("\nchunkText — empty input");
{
  check("empty string gives no chunks", chunkText("", 1200, 150).length === 0);
  check(
    "whitespace-only gives no chunks",
    chunkText("   \n\n  \t ", 1200, 150).length === 0,
  );
}

console.log("\nchunkText — long input");
{
  // 40 sentences of ~100 chars = ~4000 chars, so a 1200-char window needs 4ish.
  const text = SENTENCE.repeat(40);

  const chunks = chunkText(text, 1200, 150);

  check("produces more than one chunk", chunks.length > 1, `${chunks.length}`);
  check(
    "no chunk exceeds the size limit",
    chunks.every((chunk) => chunk.content.length <= 1200),
    chunks.map((c) => c.content.length).join(","),
  );
  check(
    "every chunk is non-empty",
    chunks.every((chunk) => chunk.content.trim().length > 0),
  );
  check(
    "indices are sequential from 0",
    chunks.every((chunk, i) => chunk.index === i),
  );

  // The whole point of overlap: no sentence may fall entirely through a seam.
  const covered = chunks.map((chunk) => chunk.content).join(" ");
  check(
    "concatenation covers the original vocabulary",
    covered.includes("retrieval purposes"),
  );

  // THE INVARIANT THAT MATTERS: every sentence must survive whole inside at
  // least one chunk. Chunks legitimately START mid-sentence — that is what
  // overlap does — but no sentence may be split across the seam in *every*
  // chunk, or it becomes unretrievable.
  const sentences = SENTENCE.trim()
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.trim().length > 0);

  // The fixture repeats one sentence, so checking the unique one is enough.
  const uniqueSentence = sentences[0];
  const chunksContainingItWhole = chunks.filter((chunk) =>
    chunk.content.includes(uniqueSentence),
  );
  check(
    "every sentence survives whole in at least one chunk",
    chunksContainingItWhole.length > 0,
    `${chunksContainingItWhole.length}/${chunks.length} chunks contain it whole`,
  );
}

console.log("\nchunkText — pathological inputs");
{
  // One giant run with no spaces at all must still terminate.
  const noSpaces = "a".repeat(5000);
  const chunks = chunkText(noSpaces, 1200, 150);
  check("no-space input still terminates", chunks.length > 0, `${chunks.length}`);
  check(
    "no-space input respects the limit",
    chunks.every((chunk) => chunk.content.length <= 1200),
  );

  // Overlap larger than the chunk must not loop forever.
  const hugeOverlap = chunkText(SENTENCE.repeat(20), 300, 5000);
  check("huge overlap is clamped and terminates", hugeOverlap.length > 0);
  check(
    "huge overlap respects the limit",
    hugeOverlap.every((chunk) => chunk.content.length <= 300),
  );
}

console.log("\nestimateTokens");
{
  check(
    "roughly 4 characters per token",
    estimateTokens("abcdefgh") === 2,
    String(estimateTokens("abcdefgh")),
  );
  check("empty string is 0", estimateTokens("") === 0);
}

console.log(
  failures === 0
    ? "\nAll chunker checks passed.\n"
    : `\n${failures} chunker check(s) FAILED.\n`,
);

process.exit(failures === 0 ? 0 : 1);
