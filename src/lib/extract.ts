import { normaliseText } from "./chunk";

/**
 * Turning an uploaded file into readable text.
 *
 * Only two formats are supported on purpose:
 *
 *   * **PDF** — the format students actually get handed (readers, lecture
 *     notes, past papers).
 *   * **Plain text-ish** (.txt, .md, .csv) — notes copied out of anywhere.
 *
 * `.docx` and `.pptx` are *not* handled. Claiming otherwise would mean either
 * a heavy dependency or a queue, and this is stage one. The upload route
 * rejects them with a clear message rather than silently storing a file that
 * can never be read back.
 *
 * Extraction never throws for a "we could not read it" case — it returns
 * `{ ok: false, reason }` so the UI can explain itself in one sentence.
 */

export type SupportedKind = "pdf" | "text";

export interface ExtractionOk {
  ok: true;
  text: string;
  kind: SupportedKind;
  /** PDF page count, when known. Useful in the UI and for cost estimates. */
  pages?: number;
}

export interface ExtractionFailure {
  ok: false;
  reason: string;
}

export type Extraction = ExtractionOk | ExtractionFailure;

/** Extensions and MIME types Batcher accepts on upload. */
export const ACCEPTED_EXTENSIONS = [".pdf", ".txt", ".md", ".markdown", ".csv"];

export const ACCEPTED_MIME_HINT =
  "application/pdf, text/plain, text/markdown, text/csv";

export function detectKind(fileName: string, mimeType: string): SupportedKind | null {
  const lower = fileName.toLowerCase();

  if (lower.endsWith(".pdf") || mimeType === "application/pdf") return "pdf";
  if (
    lower.endsWith(".txt") ||
    lower.endsWith(".md") ||
    lower.endsWith(".markdown") ||
    lower.endsWith(".csv") ||
    mimeType.startsWith("text/")
  ) {
    return "text";
  }

  return null;
}

/**
 * Extract text from a file's bytes.
 *
 * PDFs go through PDF.js's **legacy** build. That detail is load-bearing:
 * the modern build assumes `Promise.withResolvers`, `Iterator` helpers and
 * other ES2024 globals that Node 20 (and Vercel's default runtime) do not
 * have, and it fails with "Iterator is not defined" — inside a serverless
 * function that surfaces to the user as an unexplained upload failure. The
 * legacy build is the same parser, transpiled down to run on older runtimes.
 *
 * It is imported dynamically so a plain-text upload never pays for loading
 * the whole PDF engine.
 */
export async function extractText(args: {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
}): Promise<Extraction> {
  const kind = detectKind(args.fileName, args.mimeType);

  if (!kind) {
    return {
      ok: false,
      reason: `Batcher can read ${ACCEPTED_EXTENSIONS.join(", ")}. This file is neither a PDF nor plain text.`,
    };
  }

  if (kind === "text") {
    const text = normaliseText(new TextDecoder("utf-8").decode(args.bytes));
    if (!text) {
      return { ok: false, reason: "That file had no readable text in it." };
    }
    return { ok: true, text, kind };
  }

  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

    // A copy of the buffer: PDF.js transfers ownership of the underlying
    // ArrayBuffer to its worker, which would detach the caller's view.
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(args.bytes),
      useSystemFonts: true,
      disableFontFace: true,
      // No DOM in a route handler; skip font/CMap fetching entirely.
      isEvalSupported: false,
    }).promise;

    const pages: string[] = [];
    // Capture this before destroy(): the proxy is unusable afterwards.
    const pageCount: number = doc.numPages;

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();

      const pageText = content.items
        // Text items carry a `str`; marked-content items do not.
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      if (pageText) pages.push(pageText);

      // Free the page as we go — a 200-page reader would otherwise hold every
      // page's operator list in memory at once.
      page.cleanup();
    }

    await doc.destroy();

    const cleaned = normaliseText(pages.join("\n\n"));

    if (!cleaned) {
      return {
        ok: false,
        reason:
          "That PDF has no text layer — it is probably a scan. Batcher cannot read images yet.",
      };
    }

    // A PDF whose text layer is present but nearly empty is almost always a
    // scan with an OCR stub. Better to say so than to embed three words.
    if (cleaned.length < 40 && pageCount > 0) {
      return {
        ok: false,
        reason:
          "That PDF has almost no extractable text — it looks like a scan. Batcher cannot read images yet.",
      };
    }

    return { ok: true, text: cleaned, kind: "pdf", pages: pageCount };
  } catch (error) {
    console.warn("[batcher] PDF extraction failed", error);
    return {
      ok: false,
      reason:
        "Batcher could not read that PDF. It may be encrypted, corrupted, or in an unsupported encoding.",
    };
  }
}
