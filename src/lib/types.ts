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

/** NDJSON frames emitted by POST /api/chat. */
export type BatchEvent =
  | { type: "batch_start"; threadId: string; items: number }
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
