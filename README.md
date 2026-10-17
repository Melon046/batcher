# Batcher

**A shared AI workspace for two people who build together.**

Wade is one person's assistant. Batcher is a *team's* — you and your friend sign into the same workspace, keep the same threads, and get answers back as a list instead of one long reply.

The core idea is the name: **ask in batches**. Paste eight questions, get eight answers, each one numbered and streaming in on its own. That is the whole product, and everything else exists to support it.

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
| Package | `wade` | `batcher` |
| Env prefix | `WADE_*` | `BATCHER_*` |
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
  │  6. for each item, in order:
  │        streamText() → Gemini Flash
  │           └─ on 429/404 → Groq Llama
  │        emit {delta} frames as tokens arrive
  │        persist the answer + a usage_event
  │  7. emit {batch_done}
  ▼
application/x-ndjson        one JSON object per line
  {"type":"item_start","index":2}
  {"type":"delta","index":2,"text":"A p-value is…"}
  {"type":"item_done","index":2,"provider":"google",…}
  ▼
Client folds each line into its own item's state
```

**Why sequential, not parallel?** Eight parallel completions is the fastest way to trip a free tier's *per-minute* limit — and then all eight fail at once. Going one at a time keeps the batch under the limit, gives the UI honest progress, and means a partial failure costs one item, not the whole batch.

**Why NDJSON?** A plain text stream can only grow one string. Batcher needs to say "item 4 started" while item 2 is still streaming, so every frame names its item.

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
4. **Project Settings → API** → copy the **Project URL** and the **publishable** key.

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

---

## Project layout

```
src/
├── app/
│   ├── api/chat/route.ts             # batch endpoint — NDJSON out
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
│   ├── batch-results.tsx             # numbered answers
│   └── markdown.tsx
├── lib/
│   ├── batch.ts                      # the parser (shared client+server)
│   ├── models.ts                     # provider chain + limits
│   ├── prompt.ts                     # Batcher's personality
│   ├── types.ts                      # BatchEvent union
│   └── supabase/{client,server,middleware}.ts
└── middleware.ts
supabase/migrations/0001_init.sql
```

---

## Database schema

Six tables, all RLS-protected, all keyed to **workspace membership**.

- **`profiles`** — display name per user, so a shared thread isn't anonymous.
- **`workspaces`** — the tenant. Holds the `join_code`.
- **`workspace_members`** — the access-control table. This is what every other policy asks about.
- **`threads`** — one batch conversation.
- **`messages`** — one row per question and per answer, with `item_index` so a batch replays in order.
- **`usage_events`** — append-only spend log, one row per answered item.

Plus `public.is_workspace_member(uuid)` (SECURITY DEFINER, so the policy on `workspace_members` can check itself without infinite recursion) and `public.join_workspace(text)` (SECURITY DEFINER, because a non-member cannot SELECT the workspace row to find its id).

### Verifying sharing actually works

1. Sign in as you, copy a thread id from the URL or the network tab.
2. Join the workspace as your teammate with the code.
3. Open that thread id as them — you should see the full batch.
4. Have a *third* account (not a member) try the same id — zero rows, not an error. That is RLS working.

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

A batch is N requests. At 8 items you use roughly one-tenth of a minute-budget per batch — which is exactly why items are answered sequentially with the fallback ready.

---

## Guardrails

| Env var | Default | Effect |
| --- | --- | --- |
| `BATCHER_MAX_BATCH_SIZE` | `8` | Hard cap on items per send (1–12) |
| `BATCHER_MAX_OUTPUT_TOKENS` | `700` | Per-item cap — multiplies by batch size |
| `BATCHER_DAILY_TOKEN_LIMIT` | `0` (off) | Per-user daily cap. **On before you share the join code widely.** |
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
| `column … does not exist` in SQL | migration applied partially | re-run `0001_init.sql` — it is idempotent |
| Signed out mid-batch | middleware not refreshing | check `src/middleware.ts` matcher |

---

## Roadmap

**Shipped:** batch input (up to 8 items) · NDJSON per-item streaming · shared workspaces with join codes · membership-based RLS · sequential provider fallback · per-item usage logging · thread history · markdown + code rendering.

**Next, in order of value per hour:**
1. **"Run last batch again"** — re-ask the same list after you change one answer.
2. **Export a batch as Markdown** — the team's notes should leave the app.
3. **Per-item retry** — re-run only the items that failed.
4. **Shared study docs** — attach a PDF and reference it across a batch.
5. **Spend dashboard** — chart `usage_events` per day and per teammate.

**Deliberately not built:** voice, image generation, model picker. Each one adds a per-item cost multiplier without making the batch loop better.

---

## License

MIT.
