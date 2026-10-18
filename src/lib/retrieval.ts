import type { createClient } from "./supabase/server";
import { embedQuery, toVectorLiteral, isEmbeddingConfigured } from "./embeddings";
import {
  RETRIEVAL_CHUNK_COUNT,
  RETRIEVAL_MEMORY_COUNT,
  RETRIEVAL_MIN_SIMILARITY,
} from "./retrieval-config";
import { estimateTokens } from "./chunk";

/**
 * Pulling the team's own documents and memories into a batch.
 *
 * THE IMPORTANT DESIGN DECISION: retrieval happens **once per batch**, not once
 * per item.
 *
 * A batch of eight questions would otherwise mean eight embedding calls before
 * a single answer streams. On a free tier limited to 10-15 requests/minute that
 * is the whole minute's budget spent on looking things up. One retrieval call
 * for the concatenated batch costs one request and improves every item,
 * because the concatenated questions cover every topic in the batch.
 *
 * The tradeoff is honest: if item 7 is about a completely different subject,
 * the shared context is noise for it. At 4 chunks that is a few hundred wasted
 * tokens — cheaper than 7 extra embedding requests, and the answer quality cost
 * is negligible because the model is told which sources exist and can ignore
 * them.
 *
 * Everything degrades: no key → keyword search; keyword search fails → no
 * context, and the batch still runs exactly as it did before this feature.
 */

type Db = Awaited<ReturnType<typeof createClient>>;

export interface SourceRef {
  /** Document title, shown as a chip under the answer. */
  title: string;
  documentId: string;
  /** 1-based chunk position, for "part 3" in the UI. */
  part: number;
  similarity: number;
}

export interface RetrievalContext {
  /** Text to prepend to the system prompt. Empty when nothing was found. */
  block: string;
  sources: SourceRef[];
  memories: string[];
  /** Embedding tokens used, so the caller can log spend. */
  embeddingTokens: number;
  /** 'vector' | 'keyword' | 'none' — surfaced for debugging and the UI. */
  mode: "vector" | "keyword" | "none";
}

const EMPTY: RetrievalContext = {
  block: "",
  sources: [],
  memories: [],
  embeddingTokens: 0,
  mode: "none",
};

interface ChunkRow {
  chunk_id: string;
  document_id: string;
  title: string;
  chunk_index: number;
  content: string;
  similarity: number;
}

interface MemoryRow {
  memory_id: string;
  content: string;
  kind: string;
  similarity: number;
}

/**
 * Retrieve context for a whole batch.
 *
 * @param query every question in the batch, joined — this is what gets embedded.
 */
export async function retrieveContext(args: {
  supabase: Db;
  workspaceId: string;
  query: string;
  /** Retrieved per-question context is not needed when both limits are 0. */
  includeMemories?: boolean;
}): Promise<RetrievalContext> {
  const { supabase, workspaceId, query } = args;
  const includeMemories = args.includeMemories ?? true;

  if (RETRIEVAL_CHUNK_COUNT === 0 && RETRIEVAL_MEMORY_COUNT === 0) return EMPTY;

  const trimmed = query.trim().slice(0, 4000);
  if (!trimmed) return EMPTY;

  let chunks: ChunkRow[] = [];
  let memories: MemoryRow[] = [];
  let mode: RetrievalContext["mode"] = "none";
  let embeddingTokens = 0;

  // --- Preferred path: vector search -------------------------------------
  if (isEmbeddingConfigured()) {
    const queryEmbedding = await embedQuery(trimmed);

    if (queryEmbedding) {
      embeddingTokens = queryEmbedding.tokens;
      const literal = toVectorLiteral(queryEmbedding.embedding);

      if (RETRIEVAL_CHUNK_COUNT > 0) {
        const { data, error } = await supabase.rpc("match_document_chunks", {
          query_embedding: literal,
          target_workspace: workspaceId,
          match_count: RETRIEVAL_CHUNK_COUNT,
        });

        if (error) {
          console.warn("[batcher] vector chunk search failed", error.message);
        } else {
          chunks = ((data ?? []) as ChunkRow[]).filter(
            (row) => row.similarity >= RETRIEVAL_MIN_SIMILARITY,
          );
          if (chunks.length > 0) mode = "vector";
        }
      }

      if (includeMemories && RETRIEVAL_MEMORY_COUNT > 0) {
        const { data, error } = await supabase.rpc("match_memories", {
          query_embedding: literal,
          target_workspace: workspaceId,
          match_count: RETRIEVAL_MEMORY_COUNT,
        });

        if (error) {
          console.warn("[batcher] vector memory search failed", error.message);
        } else {
          memories = ((data ?? []) as MemoryRow[]).filter(
            (row) => row.similarity >= RETRIEVAL_MIN_SIMILARITY,
          );
        }
      }
    }
  }

  // --- Fallback: keyword search over chunks ------------------------------
  // Reached when there is no key, the embedding call failed, or vector search
  // returned nothing above the threshold. Documents are still reachable.
  if (chunks.length === 0 && RETRIEVAL_CHUNK_COUNT > 0) {
    const { data, error } = await supabase.rpc("search_document_chunks", {
      query_text: trimmed,
      target_workspace: workspaceId,
      match_count: RETRIEVAL_CHUNK_COUNT,
    });

    if (!error) {
      const rows = (data ?? []) as ChunkRow[];
      // Keyword scores are word-overlap fractions, so they live on a different
      // scale than cosine similarity and must not share the vector threshold.
      if (rows.length > 0) {
        chunks = rows;
        mode = "keyword";
      }
    }
  }

  if (chunks.length === 0 && memories.length === 0) {
    return { ...EMPTY, embeddingTokens, mode: "none" };
  }

  return {
    block: formatBlock(chunks, memories),
    sources: dedupeSources(chunks),
    memories: memories.map((row) => row.content),
    embeddingTokens,
    mode,
  };
}

/**
 * Build the prompt block.
 *
 * Rules that matter for answer quality:
 *   * Numbered sources, so an answer can cite [2] and a reader can check it.
 *   * An explicit instruction to prefer the sources but say so when they do
 *     not cover the question. Without that line, models tend to force an
 *     irrelevant chunk into the answer.
 *   * Memories are labelled as durable context, separate from documents —
 *     they are unverified statements, not sources.
 */
function formatBlock(chunks: ChunkRow[], memories: MemoryRow[]): string {
  const parts: string[] = [];

  if (memories.length > 0) {
    parts.push(
      "WHAT YOU REMEMBER ABOUT THIS TEAM (durable context, written by them or learned earlier):",
      ...memories.map((row) => `- ${row.content}`),
    );
  }

  if (chunks.length > 0) {
    parts.push(
      "",
      "SOURCES FROM THE TEAM'S UPLOADED DOCUMENTS (numbered; cite as [1], [2] when you use one):",
    );

    chunks.forEach((chunk, index) => {
      parts.push(
        "",
        `[${index + 1}] ${chunk.title} — part ${chunk.chunk_index + 1}`,
        chunk.content,
      );
    });
  }

  parts.push(
    "",
    "HOW TO USE THIS MATERIAL:",
    "- Prefer these sources over your general knowledge when the question is about their content.",
    "- Cite a source as [n] only when you actually used it.",
    "- If the sources do not cover the question, say so briefly and answer from general knowledge instead of forcing a match.",
    "- This material is shared by both people in the workspace; it is not private to one of them.",
  );

  return parts.join("\n");
}

/**
 * One chip per document, not per chunk.
 *
 * Four chunks from the same PDF should read as one source ('Chapter 4 · 4
 * passages'), not four chips — otherwise the chip row becomes longer than the
 * answer.
 */
function dedupeSources(chunks: ChunkRow[]): SourceRef[] {
  const byDocument = new Map<string, SourceRef>();

  for (const chunk of chunks) {
    const existing = byDocument.get(chunk.document_id);
    if (!existing || chunk.similarity > existing.similarity) {
      byDocument.set(chunk.document_id, {
        title: chunk.title,
        documentId: chunk.document_id,
        part: chunk.chunk_index + 1,
        similarity: chunk.similarity,
      });
    }
  }

  return Array.from(byDocument.values());
}

/** Token cost of the retrieved block, for the usage log. */
export function contextTokenCost(context: RetrievalContext): number {
  return context.block ? estimateTokens(context.block) : 0;
}
