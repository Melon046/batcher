# Batcher

**A shared AI workspace for two people who build together.**

Wade is one person's assistant. Batcher is a *team's* — you and your friend sign into the same workspace, keep the same threads, and get answers back as a list instead of one long reply.

The core idea is the name: **ask in batches**. Paste eight questions, get eight answers, each one numbered and streaming in on its own. That is the whole product, and everything else exists to support it.

Batcher can also **read your own documents** and **remember what matters to you** — both free-tier, both optional. See [Memory + documents](#memory--documents).

Target running cost: **R15.17/month** (i.e. R0 on free tiers until real traffic).

---

## What makes it different from Wade

| | Wade | Batcher |
| --- | --- | --- |
| Whose is it | one person | two co-builders, shared workspace |
| Access control | rows belong to `auth.uid()` | rows belong to a **workspace** you both join |
| Input | one message | a list of up to 8 questions |
| Response | one text stream | **NDJSON events**, per-item, out of one request |
| Concurrency | one answer at a time | answers run **sequentially** to stay inside free-tier rate limits |
| Knowledge | your conversation only | your uploaded PDFs + shared memories, retrieved per batch |
| Package | `wade` | `batcher` |
| Env prefix | `WADE_*` | `BATCHER_*` |
| Port | 3000 | **3001** |
| Database | its own Supabase project | **a different** Supabase project |

They share no database, no keys, and no code history. Running both is fine — that is the point.

---

## What's in the box

| Layer | Choice | Why |
| --- | --- | --- |
| Framework | Next.js 15 (App Router) + React 19 | One repo serves the UI and the route that holds the key |
| Styling | Tailwind CSS v4 | No build config; cool slate + teal identity |
| LLM (primary) | Google AI Studio — Gemini Flash | Best free-tier quality, no card needed |
| LLM (fallback) | Groq — Llama 3.3 70B | Far larger daily budget when Gemini throttles |
| Embeddings | Gemini `gemini-embedding-001` @ 768 dims | Same free key as chat; Matryoshka truncation keeps storage 4x smaller |
| Vector search | Supabase pgvector + HNSW | Included in the free Postgres, no extra service |
| PDF parsing | `pdfjs-dist` **legacy** build | The modern build needs Node 22 globals and dies on Node 20 |
| Streaming | Vercel AI SDK 6 `streamText` | Provider-agnostic; one loop, two providers |
| Transport | **NDJSON over `fetch`** | Each item is its own event, not a slice of one string |
| Database | Supabase Postgres | 500 MB + generous auth free |
| Auth | Supabase magic link | No passwords to store or leak |
| Isolation | `workspace_members` + RLS | Membership, not ownership, decides access |

---

## Architecture

```
Browser
  │  fetch POST /api/chat  { workspaceId?, threadId?, input }
  │      input = "q1\nq2\nq3"      (paste a list)
  ▼
Next.js Route Handler  (src/app/api/chat/route.ts)
  │  1. authenticate via Supabase cookies
  │  2. parseBatch() → up to BATCHER_MAX_BATCH_SIZE items
  │  3. enforce the per-user daily token cap
  │  4. resolve thread, verifying workspace membership
  │  5. persist every question as one row (item_index 0..n)
  │  6. retrieve context ONCE for the whole batch
  │        embed the joined questions → match_document_chunks + match_memories
  │        (no key? → search_document_chunks by keyword)
  │  7. for each item, in order:
  │        streamText() → Gemini Flash
  │           └─ on 429/404 → Groq Llama
  │        emit {delta} frames as tokens arrive
  │        persist the answer + a usage_event
  │  8. emit {batch_done}
  ▼
application/x-ndjson        one JSON object per line
  {"type":"batch_start","threadId":"…","items":8}
  {"type":"context","sources":[{"title":"Chapter 4",…}]}
  {"type":"item_start","index":2}
  {"type":"delta","index":2,"text":"A p-value is…"}
  {"type":"item_done","index":2,"provider":"google",…}
  ▼
Client folds each line into its own item's state
```

**Why sequential, not parallel?** Eight parallel completions is the fastest way to trip a free tier's *per-minute* limit — and then all eight fail at once. Going one at a time keeps the batch under the limit, gives the UI honest progress, and means a partial failure costs one item, not the whole batch.

**Why NDJSON?** A plain text stream can only grow one string. Batcher needs to say "item 4 started" while item 2 is still streaming, so every frame names its item.

**Why retrieve once per batch?** Same reason. Eight embedding calls would spend the entire minute's free-tier budget on lookups before a single token streamed. Details in [Memory + documents](#why-retrieval-runs-once-per-batch-not-once-per-item).

---

## Quick start

### 1. Install

```bash
git clone https://github.com/Melon046/batcher.git
cd batcher
npm install
```

### 2. Create a **separate** Supabase project

Use a project of its own — do **not** point Batcher at Wade's database, or both apps will write into one schema.

1. [supabase.com](https://supabase.com) → **New project** → name it `batcher` → region **Europe (Frankfurt)** for South Africa.
2. Wait for provisioning (~2 min).
3. **SQL Editor** → **New query** → paste all of [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) → **Run**.
   You should see *"Success. No rows returned"* — that is correct for DDL.
4. **SQL Editor → New query** again → paste all of [`supabase/migrations/0002_memory_documents.sql`](supabase/migrations/0002_memory_documents.sql) → **Run**.
   This adds documents, memories and the vector index. Run 0001 first, always.
5. **Storage** → **New bucket** → name it `documents` → keep it **private** → Create.
   Optional: without it, uploads still work and are still searchable; the original
   file just isn't kept. Nothing breaks.
6. **Project Settings → API** → copy the **Project URL** and the **publishable** key.

### 3. Configure

```bash
cp .env.example .env.local
```

| Variable | Where to get it |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same page — the **publishable/anon** key, never the secret one |
| `GOOGLE_GENERATIVE_AI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `GROQ_API_KEY` | [console.groq.com/keys](https://console.groq.com/keys) |

One LLM key is enough to run. Both is what keeps a batch alive when Gemini rate-limits mid-list.

The same `GOOGLE_GENERATIVE_AI_API_KEY` also powers embeddings — memory and documents need no second key. Everything else in `.env.example` has a working default; see **[Memory + documents](#memory--documents)** for the four dials that change cost.

### 4. Run

```bash
npm run dev
```

Batcher defaults to **port 3001** so it can run alongside Wade on 3000:

```bash
npm run dev -- -p 3001
```

Open <http://localhost:3001>, sign in by magic link, and paste a numbered list.

> **Magic links locally:** Supabase's built-in sender is capped at a couple of emails per hour. Add `http://localhost:3001/auth/callback` under **Authentication → URL Configuration → Redirect URLs**, and use **Generate link** in the dashboard for repeat testing.

### 5. Invite your teammate

Your first sign-in auto-creates a workspace with a join code shown in the sidebar. They sign in (creating their own workspace), then call the join endpoint — or you wire a "join with code" box to `POST /api/workspaces/join`:

```bash
curl -X POST http://localhost:3001/api/workspaces/join \
  -H 'Content-Type: application/json' \
  -H 'Cookie: <their session cookie>' \
  -d '{"code":"AB12CD34"}'
```

After that, every thread and answer is visible to both of you.

### 6. Try the knowledge features

1. Click **Knowledge** in the workspace header.
2. **Documents** tab → **Choose a file** → pick a PDF of lecture notes.
   You should see `Added "…" — N searchable passages`.
3. Ask a question about that document in a batch.
   A teal chip naming the file appears above the answers when it was used.
4. **Memories** tab → add something like *"We're both second-year students at UJ."*
   It is now sent with every batch.

---

## Project layout

```
src/
├── app/
│   ├── api/chat/route.ts             # batch endpoint — NDJSON out
│   ├── api/documents/route.ts        # upload + list (PDF/txt → chunks → vectors)
│   ├── api/memories/route.ts         # list / add / forget a memory
│   ├── api/workspaces/join/route.ts  # redeem a join code
│   ├── app/page.tsx                  # server-rendered workspace
│   ├── auth/callback/route.ts        # magic-link → session
│   ├── login/page.tsx                # magic-link form
│   ├── page.tsx                      # public landing page
│   ├── layout.tsx
│   └── globals.css                   # slate + teal design system
├── components/
│   ├── batch-workspace.tsx           # state + NDJSON reader
│   ├── thread-rail.tsx               # threads + join code
│   ├── batch-composer.tsx            # multi-line input, ⌘↵ to run
│   ├── batch-results.tsx             # numbered answers + source chips
│   ├── knowledge-panel.tsx           # documents + memories panel
│   └── markdown.tsx
├── lib/
│   ├── batch.ts                      # the parser (shared client+server)
│   ├── models.ts                     # provider chain + limits
│   ├── prompt.ts                     # Batcher's personality
│   ├── types.ts                      # BatchEvent union
│   ├── chunk.ts                      # text → overlapping passages
│   ├── extract.ts                    # PDF / text → plain text
│   ├── embeddings.ts                 # Gemini embeddings, degrades to null
│   ├── retrieval.ts                  # pull context for a batch
│   ├── retrieval-config.ts           # every cost dial in one file
│   └── supabase/{client,server,middleware}.ts
└── middleware.ts
supabase/migrations/0001_init.sql        # core schema
supabase/migrations/0002_memory_documents.sql   # docs, chunks, memories, vectors
scripts/check-chunk.ts                   # chunker tests, no test framework
```

### Checking the chunker

The chunker is the one piece where a silent bug would quietly degrade every answer,
so it has its own checks and no test-framework dependency:

```bash
npm run check:chunk
```

22 checks: PDF line-wrap repair, ligatures, the sentence-survival invariant, overlap
termination, and the pathological cases (a 5,000-character string with no spaces,
an overlap larger than the chunk).

---

## Database schema

Nine tables, all RLS-protected, all keyed to **workspace membership**.

- **`profiles`** — display name per user, so a shared thread isn't anonymous.
- **`workspaces`** — the tenant. Holds the `join_code`.
- **`workspace_members`** — the access-control table. This is what every other policy asks about.
- **`threads`** — one batch conversation.
- **`messages`** — one row per question and per answer, with `item_index` so a batch replays in order.
- **`usage_events`** — append-only spend log, one row per answered item, plus `embedding_tokens` for retrieval spend.
- **`documents`** — one row per uploaded file, with the extracted text and its status.
- **`document_chunks`** — the document's text split into passages, each with a `vector(768)`.
- **`memories`** — durable facts, owned by the workspace, not by a person.

Plus `public.is_workspace_member(uuid)` (SECURITY DEFINER, so the policy on `workspace_members` can check itself without infinite recursion) and `public.join_workspace(text)` (SECURITY DEFINER, because a non-member cannot SELECT the workspace row to find its id).

Retrieval functions in 0002, all `SECURITY INVOKER` so the caller's RLS still applies:
`match_document_chunks`, `match_memories` (cosine similarity via HNSW) and
`search_document_chunks` (keyword fallback when there are no embeddings).

**`document_chunks` has no `workspace_id` on purpose.** Its policy joins through
`documents` instead. A duplicated tenancy column is how multi-tenant schemas leak:
the copy can silently disagree with its parent. A trigger also blocks moving a
document between workspaces, since that would hand its chunks to another team.

### Verifying sharing actually works

1. Sign in as you, copy a thread id from the URL or the network tab.
2. Join the workspace as your teammate with the code.
3. Open that thread id as them — you should see the full batch.
4. Have a *third* account (not a member) try the same id — zero rows, not an error. That is RLS working.
5. Same test for documents: upload a PDF as you, then as the non-member call
   `GET /api/documents?workspaceId=<your workspace>` — you get an empty list, not the file.

---

## Cost model

Batcher spends quota per **item**, not per send, so the batch size is the real budget dial.

At ~350 tokens in and ~250 out per item:

| Batch | Items/day at R0 | Rough cost past free tier |
| --- | --- | --- |
| 4 items | ~250 batches | ≈ R0.02 per item |
| 8 items | ~125 batches | ≈ R0.02 per item |

`BATCHER_MAX_BATCH_SIZE` (default 8) and `BATCHER_MAX_OUTPUT_TOKENS` (default 700) are the two numbers that keep R15.17/month honest. Raise the token cap and you pay for it on **every** item in **every** batch.

### Free-tier ceilings that matter here

| Provider | Daily requests | The real ceiling |
| --- | --- | --- |
| Google AI Studio (Flash) | ~1,000–1,500 | **5–15 requests/minute** |
| Groq (Llama 3.3 70B) | ~1,000 | 12,000 tokens/minute |
| Gemini Embedding | ~1,000 | request-rate limited; batched 20 at a time |

A batch is N requests. At 8 items you use roughly one-tenth of a minute-budget per batch — which is exactly why items are answered sequentially with the fallback ready.

---

## Memory + documents

Stage 1 of the growth path. Batcher can now read your own files and remember what
matters, and both are still free at this scale.

### What it does

* **Documents** — upload a PDF, `.txt`, `.md` or `.csv`. Batcher splits it into
  overlapping ~1200-character passages, embeds each one, and pulls the most
  relevant few into every batch. Answers cite what they used as `[1]`, `[2]`, and
  the UI shows a source chip above the answers.
* **Memories** — short durable facts ("we're second-year UJ students", "answers in
  plain English please"). Both teammates see and edit the same list.

Open either from the **Knowledge** button in the workspace header.

Only PDF and plain text are supported, on purpose. `.docx` and `.pptx` are rejected
with a clear message rather than stored and silently unreadable — that is a deliberate
second step, not an oversight.

### Why retrieval runs once per batch, not once per item

This is the single most important cost decision in the feature. A batch of eight
questions could be eight embedding calls — against a free tier of ~10-15 requests
per minute, that spends the entire minute's budget before a single token streams.
So the eight questions are joined and embedded **once**, and the resulting context
is used for all eight items.

Cost of that choice: if item 7 is about a totally different subject, it sees a few
hundred tokens of irrelevant context. Cheaper than seven extra embedding calls,
and the prompt tells the model to ignore sources that don't apply.

### The cost math

Assumptions, stated so you can check them: ~350 input / ~250 output tokens per item,
Gemini Flash at $0.30 per 1M input and $2.50 per 1M output (paid tier — used only as
a ceiling, because the free tier bills R0), and **R18 ≈ $1**.

Per batch, with the defaults (`BATCHER_RETRIEVAL_CHUNKS=4`, `BATCHER_RETRIEVAL_MEMORIES=3`):

| Item | Tokens |
| --- | --- |
| 4 document passages — ~300 each | ~1,200 |
| 3 memories — ~25 each | ~75 |
| Retrieval instruction block | ~90 |
| **Context added per batch item** | **~1,365** |

So one item goes from ~350 to ~1,715 input tokens: **+56% on input**. Because output
tokens cost 8x input, that is only **+$0.00041 per item** — about **R0.007**.

| Usage | Items/month | Base cost | With context | Difference |
| --- | --- | --- | --- | --- |
| 1 batch/day (8 items) | 240 | R3.15 | **R4.93** | R1.77 |
| 2 batches/day | 480 | R6.30 | **R9.85** | R3.55 |
| 3 batches/day | 720 | R9.46 | **R14.78** | R5.32 |

**Read that honestly:** at one to two batches a day per person, cost with memory and
documents is **R4.93–R9.85/month** — the low end is inside the R5–R8 target. Push to
three batches a day and paid-tier cost approaches the R15.17 price itself.

That is the whole reason this app is built free-tier-first rather than "cheap on
paid": **on the free tier the marginal cost is R0 regardless of the batch count.**
The paid column exists so you know what it would cost the day you outgrow the quota
— and at that point `BATCHER_RETRIEVAL_CHUNKS` is the dial you turn (see below), not
the subscription price.

Note it is the *context*, not the answers, that grew by 56%. If you drop
`BATCHER_RETRIEVAL_CHUNKS` from 4 to 2, the added input halves to ~R0.0035/item.

Embeddings themselves are almost free:

| Item | Cost |
| --- | --- |
| Embedding a 6-page PDF (~5,400 tokens) | ≈ $0.0008 (**R0.014**) |
| 20 documents | ≈ **R0.28**, one-off |
| Embedding one batch's questions per send | ≈ **R0.0005** |

Free-tier headroom that makes this R0 in practice:

| Resource | Free allowance | What it covers here |
| --- | --- | --- |
| Gemini Embedding (`gemini-embedding-001`) | free tier, ~1,000 requests/day | ~1,000 uploads or batch lookups/day |
| Supabase Postgres | 500 MB | ~10,000 passages at 768 dims ≈ 40 MB, plus text |
| Supabase Storage | 1 GB | ~1,000 PDFs at 1 MB |
| Supabase vector index | included | HNSW, no extra charge |

**Verdict:** memory + documents adds **R0 while you are inside the free tiers**, and at
most ~R0.007 per item if you ever move to paid. The R15.17 base price does not move.

### Tuning it down (or off)

| Env var | Default | Effect |
| --- | --- | --- |
| `BATCHER_RETRIEVAL_CHUNKS` | `4` | Passages per batch. `0` disables document retrieval. |
| `BATCHER_RETRIEVAL_MEMORIES` | `3` | Memories per batch. `0` disables them. |
| `BATCHER_RETRIEVAL_MIN_SCORE` | `0.35` | Cosine similarity floor; higher = fewer, tighter passages. |
| `BATCHER_CHUNK_SIZE` | `1200` | Characters per passage (~300 tokens). |
| `BATCHER_EMBEDDINGS` | `on` | `off` stores documents without vectors; keyword search takes over. |
| `BATCHER_MAX_UPLOAD_MB` | `8` | Upload ceiling. |

Set `BATCHER_RETRIEVAL_CHUNKS=0` and `BATCHER_RETRIEVAL_MEMORIES=0` to spend exactly
what Batcher spent before this feature existed.

### It degrades instead of breaking

Every path here has a working fallback, because a student hitting a rate limit at
11pm should still be able to upload their notes:

| Missing | What happens |
| --- | --- |
| No `GOOGLE_GENERATIVE_AI_API_KEY` | Documents store without vectors; `search_document_chunks` finds them by keyword. |
| Embedding call fails / rate-limits | Same keyword fallback, for that request only. |
| No `documents` storage bucket | Upload still succeeds — the extracted text in Postgres is what retrieval uses. The raw file simply isn't kept. |
| Migration 0002 not applied | Retrieval returns nothing and the batch runs exactly as before. |
| A scanned PDF (no text layer) | Rejected with "this looks like a scan" instead of embedding three words. |

---

## Guardrails

| Env var | Default | Effect |
| --- | --- | --- |
| `BATCHER_MAX_BATCH_SIZE` | `8` | Hard cap on items per send (1–12) |
| `BATCHER_MAX_OUTPUT_TOKENS` | `700` | Per-item cap — multiplies by batch size |
| `BATCHER_DAILY_TOKEN_LIMIT` | `0` (off) | Per-user daily cap. **On before you share the join code widely.** |
| `BATCHER_MAX_UPLOAD_MB` | `8` | Upload ceiling |
| `BATCHER_PRIMARY_MODEL` | `gemini-2.5-flash` | Override a retired model id |
| `BATCHER_FALLBACK_MODEL` | `llama-3.3-70b-versatile` | Same |

---

## Deploying

1. Push to GitHub.
2. [vercel.com/new](https://vercel.com/new) → import `Melon046/batcher`.
3. Add every variable from `.env.local` under **Settings → Environment Variables**.
4. Deploy, then add your `*.vercel.app` URL to Supabase **Authentication → URL Configuration** (Site URL + Redirect URLs).
5. Deploy Wade separately — a second Vercel project and a second Supabase project, not a second environment on the same one.

> Vercel Hobby is non-commercial. Fine for you two; move to Cloudflare Workers if you ever charge for it.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `No LLM provider is configured` | no key in `.env.local` | add one, restart dev server |
| Every item fails on item 1 | bad model id or invalid key | override `BATCHER_PRIMARY_MODEL`, check the key |
| Item 1–3 answer, 4+ fail | per-minute rate limit hit | fallback key missing, or lower `BATCHER_MAX_BATCH_SIZE` |
| Teammate sees an empty sidebar | not a member of the workspace | redeem the join code via `/api/workspaces/join` |
| `No workspace matches that join code` | typo, or code from another project | codes are per Supabase project — copy from the sidebar |
| Batch arrives all at once | a proxy buffering the stream | confirm `X-Accel-Buffering: no` and `no-transform` survive your host |
| `column … does not exist` in SQL | migration applied partially | re-run `0001_init.sql` then `0002_memory_documents.sql` — both are idempotent |
| **Upload says "keyword" instead of "vector"** | embeddings unavailable or key missing | expected; the file is still searchable. Add/repair `GOOGLE_GENERATIVE_AI_API_KEY` for semantic search |
| **"That PDF has no text layer — it is probably a scan"** | image-only PDF | no OCR yet. Paste the text into a `.txt` and upload that |
| **Sources never appear on answers** | nothing scored above `BATCHER_RETRIEVAL_MIN_SCORE` | lower it to `0.25`, or check the document actually uploaded (`chunk_count > 0`) |
| **`function match_document_chunks does not exist`** | migration 0002 not run | run it in the SQL Editor |
| Signed out mid-batch | middleware not refreshing | check `src/middleware.ts` matcher |

---

## Roadmap

**Shipped:** batch input (up to 8 items) · NDJSON per-item streaming · shared workspaces with join codes · membership-based RLS · sequential provider fallback · per-item usage logging · thread history · markdown + code rendering · **document upload with pgvector retrieval** · **shared workspace memories** · **source citations on answers**.

**Next, in order of value per hour:**
1. **"Run last batch again"** — re-ask the same list after you change one answer.
2. **Export a batch as Markdown** — the team's notes should leave the app.
3. **Per-item retry** — re-run only the items that failed.
4. **Spend dashboard** — chart `usage_events` per day and per teammate, now including `embedding_tokens`.
5. **`.docx` and `.pptx` upload** — the formats after PDF; needs a parser, so it is a deliberate second step.
6. **Image generation** — stage 2 of the growth path.
7. **Video** — stage 3.

**Deliberately not built:** voice, model picker, automatic memory extraction. Each one
adds a per-item cost multiplier or an extra model call without making the batch loop
better. Auto-extracted memories in particular are a data-quality trap — a wrong
memory is re-sent on every batch forever, so memories stay a thing you write down.

---

## License

MIT.
