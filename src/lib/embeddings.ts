import { embedMany } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import {
  EMBEDDINGS_ENABLED,
  EMBED_BATCH_SIZE,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL_ID,
} from "./retrieval-config";
import { estimateTokens } from "./chunk";

/**
 * Embeddings via Gemini.
 *
 * Deliberately tolerant: if there is no key, or the free tier rate-limits us,
 * every function here returns null instead of throwing. Retrieval then falls
 * back to keyword search (see `search_document_chunks` in migration 0002), so
 * an uploaded document is still useful. A document that uploads fine but can
 * never be *found* again would be the worst outcome, and that is exactly what
 * a hard failure here would cause.
 *
 * Cost: `gemini-embedding-001` is $0.15 per 1M input tokens on the paid tier,
 * and free on the AI Studio tier within its rate limits. A 6-page PDF of
 * ~4,000 words is roughly 5,400 tokens = ~$0.0008. At the scale this app
 * targets that rounds to zero.
 */

function getEmbeddingModel() {
  if (!EMBEDDINGS_ENABLED) return null;

  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  if (!apiKey) return null;

  const google = createGoogleGenerativeAI({ apiKey });

  return google.textEmbeddingModel(EMBEDDING_MODEL_ID);
}

/** True when a key is configured and embeddings are turned on. */
export function isEmbeddingConfigured(): boolean {
  return getEmbeddingModel() !== null;
}

export interface EmbedResult {
  embeddings: number[][];
  /** Approximate input tokens, for the usage log. */
  tokens: number;
}

/**
 * Embed a list of strings.
 *
 * Values are sent in batches of `EMBED_BATCH_SIZE` in ONE `embedMany` call per
 * batch. On a free tier limited by requests per minute, 20 values in one
 * request is dramatically kinder than 20 requests — this is the difference
 * between a 40-page PDF ingesting in seconds and timing out.
 *
 * Returns null if anything fails; the caller degrades to keyword search.
 */
export async function embedTexts(texts: string[]): Promise<EmbedResult | null> {
  const model = getEmbeddingModel();
  if (!model || texts.length === 0) return null;

  const cleaned = texts.map((text) => text.replace(/\s+/g, " ").trim());

  // A provider rejects empty strings, and an empty chunk is meaningless.
  if (cleaned.some((text) => text.length === 0)) {
    return null;
  }

  const embeddings: number[][] = [];
  let tokens = 0;

  try {
    for (let start = 0; start < cleaned.length; start += EMBED_BATCH_SIZE) {
      const batch = cleaned.slice(start, start + EMBED_BATCH_SIZE);

      const result = await embedMany({
        model,
        values: batch,
        maxRetries: 1,
        // Matryoshka truncation: ask for 768 of the model's 3072 dimensions so
        // storage and index cost drop 4x. Must match vector(768) in the schema.
        providerOptions: {
          google: {
            outputDimensionality: EMBEDDING_DIMENSIONS,
            taskType: "RETRIEVAL_DOCUMENT",
          },
        },
      });

      for (const embedding of result.embeddings) {
        // Normalise: cosine distance in pgvector compares direction, and
        // truncated embeddings are not unit-length by default.
        embeddings.push(normaliseVector(embedding));
      }

      tokens += result.usage?.tokens ?? 0;
    }
  } catch (error) {
    console.warn("[batcher] embedding failed, falling back to keyword search", error);
    return null;
  }

  if (embeddings.length !== cleaned.length) return null;

  return {
    embeddings,
    // Trust the provider's count when it gives one; otherwise estimate.
    tokens: tokens > 0 ? tokens : cleaned.reduce((sum, t) => sum + estimateTokens(t), 0),
  };
}

/** Embed a single search query. */
export async function embedQuery(
  text: string,
): Promise<{ embedding: number[]; tokens: number } | null> {
  const model = getEmbeddingModel();
  if (!model) return null;

  const cleaned = text.replace(/\s+/g, " ").trim().slice(0, 2000);
  if (!cleaned) return null;

  try {
    const result = await embedMany({
      model,
      values: [cleaned],
      maxRetries: 1,
      providerOptions: {
        google: {
          outputDimensionality: EMBEDDING_DIMENSIONS,
          // Queries use a different task type than documents. Mixing them up
          // measurably hurts retrieval, because the model optimises the two
          // sides for different geometry.
          taskType: "RETRIEVAL_QUERY",
        },
      },
    });

    const embedding = result.embeddings[0];
    if (!embedding) return null;

    return {
      embedding: normaliseVector(embedding),
      tokens: result.usage?.tokens ?? estimateTokens(cleaned),
    };
  } catch (error) {
    console.warn("[batcher] query embedding failed, falling back to keyword search", error);
    return null;
  }
}

/**
 * Scale a vector to unit length.
 *
 * pgvector's `vector` type stores values as given. Cosine distance normalises
 * internally, so this is not strictly required — but it keeps scores
 * comparable across providers and prevents a zero-vector from producing NaN
 * similarities.
 */
function normaliseVector(vector: number[]): number[] {
  let magnitude = 0;
  for (const value of vector) magnitude += value * value;

  magnitude = Math.sqrt(magnitude);
  if (!Number.isFinite(magnitude) || magnitude === 0) return vector;

  return vector.map((value) => value / magnitude);
}

/**
 * Format a JS number array as a pgvector literal: `[0.1,0.2,...]`.
 *
 * Supabase's PostgREST accepts this string for a `vector` column, which is how
 * vectors travel over the wire without a binary protocol.
 */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
