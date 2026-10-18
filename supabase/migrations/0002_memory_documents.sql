-- ===========================================================================
-- BATCHER — memory + documents
-- ---------------------------------------------------------------------------
-- Adds the first stage of the growth path:
--
--   * `documents`       — one row per uploaded file, with its extracted text
--   * `document_chunks` — that text split into overlapping pieces, plus a
--                         768-dimension embedding for each piece
--   * `memories`        — durable facts Batcher should remember about the team
--
-- Apply AFTER 0001_init.sql. Like 0001, this file is idempotent: running it
-- twice is safe.
--
-- WHY 768 DIMENSIONS
-- `gemini-embedding-001` returns 3072 by default, but supports Matryoshka
-- truncation — you can ask for fewer dimensions and still get usable quality.
-- 768 is the sweet spot here: pgvector's HNSW index caps out at 2000 dims for
-- vectors, index build is ~4x cheaper, storage is 4x smaller, and retrieval
-- quality on a document set this small is indistinguishable. It also fits in
-- a quarter of the 500 MB free Postgres budget, which is the real constraint.
--
-- WHY NO `workspace_id` ON document_chunks
-- A chunk always belongs to exactly one document, and that document already
-- carries the workspace. Duplicating it would create a row that can silently
-- disagree with its parent. The RLS policy below joins through `documents`
-- instead. (Duplicated tenancy columns are the most common way a multi-tenant
-- schema leaks.)
-- ===========================================================================

-- pgvector is pre-installed on Supabase; this line is a no-op there and makes
-- the migration runnable on a plain Postgres for testing.
create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- documents — an uploaded PDF / notes / slide deck
-- ---------------------------------------------------------------------------
create table if not exists public.documents (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  uploaded_by   uuid references auth.users (id) on delete set null,
  title         text not null,
  -- Where the file went. Null for pasted text, which has no file.
  storage_path  text,
  mime_type     text not null default 'text/plain',
  size_bytes    integer not null default 0,
  -- Full extracted text. Kept so a document can be re-chunked later without
  -- asking the uploader to fetch it again.
  content       text not null default '',
  chunk_count   integer not null default 0,
  -- 'pending' while chunks are being written, then 'ready'. A 'failed' row
  -- keeps the error so the UI can explain itself instead of hanging.
  status        text not null default 'ready'
                check (status in ('pending', 'ready', 'failed')),
  error         text,
  created_at    timestamptz not null default now()
);

create index if not exists documents_workspace_created_idx
  on public.documents (workspace_id, created_at desc);

-- A file name repeated in one workspace is almost always a re-upload. This
-- lets the upload path upsert instead of piling up duplicates.
create index if not exists documents_workspace_title_idx
  on public.documents (workspace_id, lower(title));

-- ---------------------------------------------------------------------------
-- document_chunks — retrievable pieces of a document
-- ---------------------------------------------------------------------------
create table if not exists public.document_chunks (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  chunk_index integer not null,
  content     text not null,
  -- Null when no embedding provider is configured: the row is still stored,
  -- so Batcher can fall back to keyword search instead of losing the file.
  embedding   vector(768),
  created_at  timestamptz not null default now(),
  unique (document_id, chunk_index)
);

create index if not exists document_chunks_document_idx
  on public.document_chunks (document_id, chunk_index);

-- HNSW with cosine distance. Built for recall at this scale; an exact scan
-- would be fine for a few hundred chunks, but HNSW keeps the query plan stable
-- when a workspace grows to a few thousand.
create index if not exists document_chunks_embedding_idx
  on public.document_chunks
  using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- memories — durable facts, scoped to a workspace
-- ---------------------------------------------------------------------------
create table if not exists public.memories (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- Null for memories Batcher derived itself; set when a person wrote it.
  created_by   uuid references auth.users (id) on delete set null,
  content      text not null,
  -- Free-text grouping ("study", "project", "preference") — not an enum, so
  -- adding a kind never needs a migration.
  kind         text not null default 'fact',
  -- 'manual' = a teammate typed it. 'auto' = extracted from a conversation.
  source       text not null default 'manual'
               check (source in ('manual', 'auto')),
  -- Which thread a derived memory came from, for "where did this come from?".
  thread_id    uuid references public.threads (id) on delete set null,
  embedding    vector(768),
  -- Soft delete: keeps the row for the day someone asks where a memory went.
  archived     boolean not null default false,
  created_at   timestamptz not null default now()
);

create index if not exists memories_workspace_created_idx
  on public.memories (workspace_id, created_at desc)
  where archived = false;

create index if not exists memories_embedding_idx
  on public.memories
  using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.documents       enable row level security;
alter table public.document_chunks enable row level security;
alter table public.memories        enable row level security;

-- --- documents: workspace members only ------------------------------------
drop policy if exists "documents_select_member" on public.documents;
create policy "documents_select_member" on public.documents
  for select using (public.is_workspace_member(workspace_id));

drop policy if exists "documents_insert_member" on public.documents;
create policy "documents_insert_member" on public.documents
  for insert with check (
    public.is_workspace_member(workspace_id)
    and (uploaded_by is null or uploaded_by = auth.uid())
  );

drop policy if exists "documents_update_member" on public.documents;
create policy "documents_update_member" on public.documents
  for update using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "documents_delete_member" on public.documents;
create policy "documents_delete_member" on public.documents
  for delete using (public.is_workspace_member(workspace_id));

-- --- document_chunks: membership is inherited from the parent document ----
-- Note there is no workspace column here to check, so the policy asks the
-- parent. That is also why a chunk insert needs its document to exist first.
drop policy if exists "chunks_select_member" on public.document_chunks;
create policy "chunks_select_member" on public.document_chunks
  for select using (
    exists (
      select 1
      from public.documents d
      where d.id = document_chunks.document_id
        and public.is_workspace_member(d.workspace_id)
    )
  );

drop policy if exists "chunks_insert_member" on public.document_chunks;
create policy "chunks_insert_member" on public.document_chunks
  for insert with check (
    exists (
      select 1
      from public.documents d
      where d.id = document_chunks.document_id
        and public.is_workspace_member(d.workspace_id)
    )
  );

drop policy if exists "chunks_delete_member" on public.document_chunks;
create policy "chunks_delete_member" on public.document_chunks
  for delete using (
    exists (
      select 1
      from public.documents d
      where d.id = document_chunks.document_id
        and public.is_workspace_member(d.workspace_id)
    )
  );

-- --- memories: workspace members only -------------------------------------
drop policy if exists "memories_select_member" on public.memories;
create policy "memories_select_member" on public.memories
  for select using (public.is_workspace_member(workspace_id));

drop policy if exists "memories_insert_member" on public.memories;
create policy "memories_insert_member" on public.memories
  for insert with check (
    public.is_workspace_member(workspace_id)
    and (created_by is null or created_by = auth.uid())
  );

drop policy if exists "memories_update_member" on public.memories;
create policy "memories_update_member" on public.memories
  for update using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "memories_delete_member" on public.memories;
create policy "memories_delete_member" on public.memories
  for delete using (public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- Retrieval functions
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER is deliberate: the caller's RLS policies still apply, so a
-- member of workspace A who guesses a workspace B id gets zero rows. A
-- SECURITY DEFINER version here would be a full cross-tenant read.
--
-- `<=>` is pgvector's cosine distance operator (0 = identical). Returning
-- `1 - distance` gives a similarity score where higher is better, which is far
-- easier to explain in a UI than a distance.

create or replace function public.match_document_chunks(
  query_embedding vector(768),
  target_workspace uuid,
  match_count integer default 6
)
returns table (
  chunk_id    uuid,
  document_id uuid,
  title       text,
  chunk_index integer,
  content     text,
  similarity  double precision
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    c.id,
    d.id,
    d.title,
    c.chunk_index,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.document_chunks c
  join public.documents d on d.id = c.document_id
  where d.workspace_id = target_workspace
    and c.embedding is not null
  order by c.embedding <=> query_embedding
  limit least(greatest(match_count, 1), 20);
$$;

create or replace function public.match_memories(
  query_embedding vector(768),
  target_workspace uuid,
  match_count integer default 6
)
returns table (
  memory_id  uuid,
  content    text,
  kind       text,
  similarity double precision
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    m.id,
    m.content,
    m.kind,
    1 - (m.embedding <=> query_embedding) as similarity
  from public.memories m
  where m.workspace_id = target_workspace
    and m.archived = false
    and m.embedding is not null
  order by m.embedding <=> query_embedding
  limit least(greatest(match_count, 1), 20);
$$;

-- ---------------------------------------------------------------------------
-- Keyword fallback
-- ---------------------------------------------------------------------------
-- Used when no embedding provider is configured (or an embedding call failed).
-- Not as good as vector search, but it means uploading a document is never
-- useless just because a free-tier key is missing.
create or replace function public.search_document_chunks(
  query_text text,
  target_workspace uuid,
  match_count integer default 6
)
returns table (
  chunk_id    uuid,
  document_id uuid,
  title       text,
  chunk_index integer,
  content     text,
  similarity  double precision
)
language sql
stable
security invoker
set search_path = public
as $$
  with terms as (
    select distinct word
    from unnest(
      regexp_split_to_array(lower(coalesce(query_text, '')), '[^a-z0-9]+')
    ) as word
    where length(word) > 2
  ),
  scored as (
    select
      c.id,
      d.id            as doc_id,
      d.title,
      c.chunk_index,
      c.content,
      -- Share of distinct query words that appear in this chunk.
      (
        select count(*)
        from terms t
        where lower(c.content) like '%' || t.word || '%'
      )::double precision / (select count(*) from terms) as score
    from public.document_chunks c
    join public.documents d on d.id = c.document_id
    where d.workspace_id = target_workspace
  )
  select
    scored.id,
    scored.doc_id,
    scored.title,
    scored.chunk_index,
    scored.content,
    scored.score
  from scored
  where scored.score > 0
  order by scored.score desc, scored.chunk_index
  limit least(greatest(match_count, 1), 20);
$$;

-- ---------------------------------------------------------------------------
-- Storage bookkeeping
-- ---------------------------------------------------------------------------
-- A document's workspace must never change after upload. Without this, an
-- update that "moved" a document would silently hand its chunks to another
-- team, because the chunks' policy asks the parent document.
create or replace function public.documents_lock_workspace()
returns trigger
language plpgsql
as $$
begin
  if new.workspace_id <> old.workspace_id then
    raise exception 'A document cannot be moved between workspaces.';
  end if;
  return new;
end;
$$;

drop trigger if exists documents_lock_workspace on public.documents;
create trigger documents_lock_workspace
  before update on public.documents
  for each row execute function public.documents_lock_workspace();

-- ---------------------------------------------------------------------------
-- Daily usage view, extended with embedding tokens
-- ---------------------------------------------------------------------------
-- Order matters: the column has to exist before a view can select it. Adding
-- it first also means this block is safe to re-run on a database that already
-- has the 0001 version of `usage_today`.
-- Embedding usage is billed separately from chat tokens, so it needs its own
-- counter for the cost dashboard to be truthful.
alter table public.usage_events
  add column if not exists embedding_tokens integer not null default 0;

create or replace view public.usage_today
with (security_invoker = true) as
select
  user_id,
  count(*)                                        as batches,
  coalesce(sum(items), 0)                         as items,
  coalesce(sum(input_tokens), 0)                  as input_tokens,
  coalesce(sum(output_tokens), 0)                 as output_tokens,
  coalesce(sum(embedding_tokens), 0)              as embedding_tokens
from public.usage_events
where created_at >= date_trunc('day', now())
group by user_id;
