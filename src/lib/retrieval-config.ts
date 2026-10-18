/**
 * Retrieval configuration.
 *
 * Everything that decides "how much context does Batcher pull in" lives here,
 * because those numbers are the ones that cost money. Each pulled chunk is
 * extra input tokens on *every* item in a batch, so this is not a cosmetic
 * setting — it multiplies by batch size.
 *
 * All of it is env-overridable so the team can tune spend without a code
 * change, and every value is clamped so a typo cannot produce a runaway bill.
 */

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function clampFloat(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/**
 * `gemini-embedding-001` supports Matryoshka truncation, so we ask for 768
 * dimensions instead of its native 3072. Quality on document retrieval is
 * effectively unchanged at this corpus size, while storage and index build
 * drop by 4x — which matters against a 500 MB free Postgres.
 *
 * This MUST match the `vector(768)` columns in 0002_memory_documents.sql.
 */
export const EMBEDDING_DIMENSIONS = 768;

export const EMBEDDING_MODEL_ID =
  process.env.BATCHER_EMBEDDING_MODEL?.trim() || "gemini-embedding-001";

/** How many document chunks to retrieve per batch. */
export const RETRIEVAL_CHUNK_COUNT = clampInt(
  process.env.BATCHER_RETRIEVAL_CHUNKS ?? 4,
  0,
  10,
  4,
);

/** How many remembered facts to retrieve per batch. */
export const RETRIEVAL_MEMORY_COUNT = clampInt(
  process.env.BATCHER_RETRIEVAL_MEMORIES ?? 3,
  0,
  10,
  3,
);

/**
 * A chunk scoring below this cosine similarity is noise. 0.35 is deliberately
 * low — the cost of one irrelevant chunk is a few hundred tokens, while the
 * cost of missing the one chunk that answers the question is a wrong answer.
 */
export const RETRIEVAL_MIN_SIMILARITY = clampFloat(
  process.env.BATCHER_RETRIEVAL_MIN_SCORE ?? 0.35,
  0,
  0.95,
  0.35,
);

/** Characters per document chunk. ~1200 chars is roughly 300 tokens. */
export const CHUNK_SIZE = clampInt(
  process.env.BATCHER_CHUNK_SIZE ?? 1200,
  300,
  4000,
  1200,
);

/** Characters of overlap between chunks, so a sentence is never cut in half and lost. */
export const CHUNK_OVERLAP = clampInt(
  process.env.BATCHER_CHUNK_OVERLAP ?? 150,
  0,
  600,
  150,
);

/** Largest file Batcher will accept, in bytes. Supabase free storage is 1 GB. */
export const MAX_UPLOAD_BYTES = clampInt(
  Number(process.env.BATCHER_MAX_UPLOAD_MB ?? 8) * 1024 * 1024,
  1024,
  25 * 1024 * 1024,
  8 * 1024 * 1024,
);

/**
 * Chunks are embedded in batches of this size. Gemini's free embedding tier is
 * request-rate limited, so one request with 20 values is far kinder than 20
 * requests with one value each.
 */
export const EMBED_BATCH_SIZE = 20;

/** Turn embedding on/off wholesale — useful when troubleshooting a quota problem. */
export const EMBEDDINGS_ENABLED =
  (process.env.BATCHER_EMBEDDINGS ?? "on").trim().toLowerCase() !== "off";
