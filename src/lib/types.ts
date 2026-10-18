export type MessageRole = "user" | "assistant";

export interface Workspace {
  id: string;
  name: string;
  join_code: string;
  created_by: string;
  created_at: string;
}

export interface Thread {
  id: string;
  workspace_id: string;
  title: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface BatchMessage {
  id: string;
  thread_id: string;
  workspace_id: string;
  author_id: string | null;
  role: MessageRole;
  item_index: number;
  content: string;
  model: string | null;
  provider: string | null;
  created_at: string;
}

/** One question in a batch, paired with its streaming answer. */
export interface BatchItem {
  index: number;
  question: string;
  answer: string;
  status: "queued" | "answering" | "done" | "failed";
  provider?: string | null;
  model?: string | null;
  usedFallback?: boolean;
  error?: string;
}

/** A document passage that was fed into the batch as context. */
export interface SourceRef {
  title: string;
  documentId: string;
  part: number;
  similarity: number;
}

/** A document in the workspace's library. */
export interface KnowledgeDocument {
  id: string;
  title: string;
  mime_type: string;
  size_bytes: number;
  chunk_count: number;
  status: "pending" | "ready" | "failed";
  error: string | null;
  created_at: string;
}

/** A durable fact Batcher should keep in mind. */
export interface MemoryRow {
  id: string;
  content: string;
  kind: string;
  source: "manual" | "auto";
  created_at: string;
}

/** NDJSON frames emitted by POST /api/chat. */
export type BatchEvent =
  | { type: "batch_start"; threadId: string; items: number }
  | {
      type: "context";
      sources: SourceRef[];
      memories: string[];
      mode: "vector" | "keyword" | "none";
      tokens: number;
    }
  | { type: "item_start"; index: number }
  | { type: "delta"; index: number; text: string }
  | {
      type: "item_done";
      index: number;
      provider: string;
      model: string;
      usedFallback: boolean;
    }
  | { type: "item_error"; index: number; message: string }
  | { type: "batch_done"; threadId: string; answered: number; failed: number };
