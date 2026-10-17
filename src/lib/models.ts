import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import type { LanguageModel } from "ai";

/**
 * Model configuration.
 *
 * Batcher runs a two-provider chain so one free tier running dry does not take
 * the team's workspace offline:
 *
 *   1. Google AI Studio (Gemini Flash) — best quality on a free tier.
 *   2. Groq (Llama)                    — much larger daily request budget.
 *
 * Batcher spends its quota very differently from a normal chat app: one send
 * can be eight separate completions. That makes the *per-minute* limits, not
 * the daily limits, the real constraint — and it is why the fallback is a
 * first-class part of the design rather than an afterthought.
 *
 * Model IDs get retired. Override with BATCHER_PRIMARY_MODEL / BATCHER_FALLBACK_MODEL.
 */

export const PRIMARY_MODEL_ID =
  process.env.BATCHER_PRIMARY_MODEL?.trim() || "gemini-2.5-flash";

export const FALLBACK_MODEL_ID =
  process.env.BATCHER_FALLBACK_MODEL?.trim() || "llama-3.3-70b-versatile";

/** Hard ceiling on questions per batch. Defaults to 8. */
export const MAX_BATCH_SIZE = clampInt(
  Number(process.env.BATCHER_MAX_BATCH_SIZE ?? 8),
  1,
  12,
  8,
);

/** Output budget per individual answer, not per request. */
export const MAX_OUTPUT_TOKENS = clampInt(
  Number(process.env.BATCHER_MAX_OUTPUT_TOKENS ?? 700),
  128,
  4096,
  700,
);

/** 0 disables the per-user daily cap. */
export const DAILY_TOKEN_LIMIT = Math.max(
  0,
  Number(process.env.BATCHER_DAILY_TOKEN_LIMIT ?? 0) || 0,
);

export type ProviderName = "google" | "groq";

export interface ModelChoice {
  provider: ProviderName;
  modelId: string;
  model: LanguageModel;
}

/** Primary provider, or null when its API key is not configured. */
export function getPrimaryModel(): ModelChoice | null {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  if (!apiKey) return null;

  const google = createGoogleGenerativeAI({ apiKey });
  return {
    provider: "google",
    modelId: PRIMARY_MODEL_ID,
    model: google(PRIMARY_MODEL_ID),
  };
}

/** Fallback provider, or null when its API key is not configured. */
export function getFallbackModel(): ModelChoice | null {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) return null;

  const groq = createGroq({ apiKey });
  return {
    provider: "groq",
    modelId: FALLBACK_MODEL_ID,
    model: groq(FALLBACK_MODEL_ID),
  };
}

/**
 * The ordered providers to try. Providers without a key are skipped, so a team
 * with only a Groq key still gets a working workspace.
 */
export function resolveModelChain(): ModelChoice[] {
  return [getPrimaryModel(), getFallbackModel()].filter(
    (choice): choice is ModelChoice => choice !== null,
  );
}

/** Human-readable label for the status pill. */
export function describeModel(choice: ModelChoice): string {
  return choice.provider === "google" ? "Gemini Flash" : "Llama (Groq)";
}

function clampInt(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
