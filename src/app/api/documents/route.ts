import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { extractText, ACCEPTED_EXTENSIONS } from "@/lib/extract";
import { chunkText } from "@/lib/chunk";
import { embedTexts, toVectorLiteral, isEmbeddingConfigured } from "@/lib/embeddings";
import { CHUNK_OVERLAP, CHUNK_SIZE, MAX_UPLOAD_BYTES } from "@/lib/retrieval-config";

/**
 * Upload a document into a workspace.
 *
 * POST /api/documents  (multipart/form-data)
 *   file        — the PDF / notes file
 *   workspaceId — which workspace to put it in
 *
 *   201 { document: {id, title, chunkCount, status}, embedding: 'vector'|'keyword' }
 *   400 unsupported type, empty file, bad form
 *   401 not signed in
 *   403 not a member of that workspace
 *   413 file too large
 *   500 extraction or storage failure
 *
 * The raw file is ALSO written to Supabase Storage under
 * `documents/{workspace_id}/{document_id}.{ext}`, but that write is allowed to
 * fail — the extracted text in Postgres is what retrieval actually uses. A
 * storage bucket that was never created should not block a working upload.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

const BUCKET = "documents";

export async function POST(request: NextRequest) {
  // --- 1. Authenticate -----------------------------------------------------
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  // --- 2. Read the form ----------------------------------------------------
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected a file upload (multipart form data)." },
      { status: 400 },
    );
  }

  const file = form.get("file");
  const workspaceId = String(form.get("workspaceId") ?? "").trim();

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file was attached." }, { status: 400 });
  }
  if (!workspaceId) {
    return NextResponse.json({ error: "Missing workspaceId." }, { status: 400 });
  }

  // --- 3. Membership -------------------------------------------------------
  // RLS would block the insert anyway, but an explicit check turns a confusing
  // 500 into a clear 403. This is the check that matters most: without it a
  // signed-in stranger could try to write into another team's workspace.
  const { data: membership } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!membership) {
    return NextResponse.json(
      { error: "You're not a member of that workspace." },
      { status: 403 },
    );
  }

  // --- 4. Size + type gate -------------------------------------------------
  if (file.size === 0) {
    return NextResponse.json({ error: "That file is empty." }, { status: 400 });
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. Batcher accepts up to ${(
          MAX_UPLOAD_BYTES /
          1024 /
          1024
        ).toFixed(0)} MB.`,
      },
      { status: 413 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  // --- 5. Extract ----------------------------------------------------------
  const extraction = await extractText({
    bytes,
    fileName: file.name,
    mimeType: file.type,
  });

  if (!extraction.ok) {
    return NextResponse.json(
      {
        error: extraction.reason,
        accepted: ACCEPTED_EXTENSIONS,
      },
      { status: 400 },
    );
  }

  // --- 6. Chunk ------------------------------------------------------------
  const chunks = chunkText(extraction.text, CHUNK_SIZE, CHUNK_OVERLAP);
  if (chunks.length === 0) {
    return NextResponse.json(
      { error: "No readable text was found in that file." },
      { status: 400 },
    );
  }

  const title = cleanTitle(file.name);

  // --- 7. Insert the document row ------------------------------------------
  // A re-upload of the same name in the same workspace replaces the old one
  // rather than creating a second copy — students re-download readers often.
  const { data: existing } = await supabase
    .from("documents")
    .select("id")
    .eq("workspace_id", workspaceId)
    .ilike("title", title)
    .maybeSingle();

  if (existing?.id) {
    // Chunks cascade-delete with the document, so this is a clean replace.
    await supabase.from("documents").delete().eq("id", existing.id);
  }

  const { data: document, error: documentError } = await supabase
    .from("documents")
    .insert({
      workspace_id: workspaceId,
      uploaded_by: user.id,
      title,
      mime_type: file.type || (extraction.kind === "pdf" ? "application/pdf" : "text/plain"),
      size_bytes: file.size,
      content: extraction.text,
      chunk_count: chunks.length,
      storage_path: null,
      status: "pending",
    })
    .select("id, title")
    .single();

  if (documentError || !document) {
    console.error("[batcher] document insert failed", documentError);
    return NextResponse.json(
      { error: "Could not save that document." },
      { status: 500 },
    );
  }

  // --- 8. Raw file to Storage (best effort) --------------------------------
  const storagePath = `${workspaceId}/${document.id}.${extensionOf(file.name)}`;
  const { error: storageError } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, bytes, {
      contentType: file.type || "application/octet-stream",
      upsert: true,
    });

  if (storageError) {
    // Expected when the bucket has not been created yet. The text in Postgres
    // is the source of truth for retrieval, so this is a warning, not a fail.
    console.warn(
      "[batcher] storage upload skipped:",
      storageError.message,
      `(create a private "${BUCKET}" bucket to keep original files)`,
    );
  } else {
    await supabase
      .from("documents")
      .update({ storage_path: storagePath })
      .eq("id", document.id);
  }

  // --- 9. Embed ------------------------------------------------------------
  // One embedMany call for all chunks (internally batched). If there is no key
  // or the free tier throttles, we store the chunks WITHOUT embeddings — the
  // keyword fallback in the retrieval layer still finds them.
  const embedded = isEmbeddingConfigured()
    ? await embedTexts(chunks.map((chunk) => chunk.content))
    : null;

  const rows = chunks.map((chunk, index) => ({
    document_id: document.id,
    chunk_index: chunk.index,
    content: chunk.content,
    embedding: embedded ? toVectorLiteral(embedded.embeddings[index]) : null,
  }));

  const { error: chunkError } = await supabase
    .from("document_chunks")
    .insert(rows);

  if (chunkError) {
    console.error("[batcher] chunk insert failed", chunkError);
    await supabase
      .from("documents")
      .update({ status: "failed", error: chunkError.message })
      .eq("id", document.id);

    return NextResponse.json(
      { error: "That document was read, but its text could not be indexed." },
      { status: 500 },
    );
  }

  await supabase
    .from("documents")
    .update({ status: "ready", error: null })
    .eq("id", document.id);

  // --- 10. Usage log -------------------------------------------------------
  if (embedded) {
    await supabase.from("usage_events").insert({
      user_id: user.id,
      workspace_id: workspaceId,
      provider: "google",
      model: process.env.BATCHER_EMBEDDING_MODEL?.trim() || "gemini-embedding-001",
      items: 0,
      input_tokens: embedded.tokens,
      output_tokens: 0,
      embedding_tokens: embedded.tokens,
      fallback_used: false,
    });
  }

  return NextResponse.json(
    {
      document: {
        id: document.id,
        title,
        chunkCount: chunks.length,
        pages: extraction.pages ?? null,
        status: "ready",
      },
      embedding: embedded ? "vector" : "keyword",
      note: embedded
        ? undefined
        : "Stored without embeddings — Batcher will find this document by keyword. Add GOOGLE_GENERATIVE_AI_API_KEY to enable semantic search.",
    },
    { status: 201 },
  );
}

/** GET — list the workspace's documents. */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const workspaceId = request.nextUrl.searchParams.get("workspaceId")?.trim();
  if (!workspaceId) {
    return NextResponse.json({ error: "Missing workspaceId." }, { status: 400 });
  }

  // RLS decides what comes back; a non-member gets an empty list.
  const { data, error } = await supabase
    .from("documents")
    .select("id, title, mime_type, size_bytes, chunk_count, status, error, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ documents: data ?? [] });
}

/** Strip the extension and trim to something readable in the UI. */
function cleanTitle(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim();
  return (base || "Untitled document").slice(0, 200);
}

function extensionOf(fileName: string): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec(fileName);
  return (match?.[1] ?? "bin").toLowerCase();
}
