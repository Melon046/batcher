-- ===========================================================================
-- BATCHER — initial schema
-- ---------------------------------------------------------------------------
-- Apply with either:
--   * Supabase Dashboard  ->  SQL Editor  ->  paste & run, or
--   * Supabase CLI        ->  supabase db push
--
-- This is NOT Wade's schema. Wade isolates rows per user (auth.uid() = user_id).
-- Batcher is built for a *team*: two or more people share a `workspace`, and
-- access is granted through membership, not ownership. Getting that wrong is
-- the difference between "my friend can read our shared thread" and "my friend
-- can read nothing".
--
-- Design notes
--   * `workspaces` is the tenant. Every thread and message belongs to one.
--   * `workspace_members` is the access-control table: RLS everywhere else
--     asks "is the caller a member of this workspace?".
--   * `messages.item_index` records which question in a batch an answer
--     belongs to, so a batch reply can be read back in the right order.
--   * `usage_events` is append-only and powers the daily spend cap.
-- ===========================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- profiles — one row per auth user, so a shared thread can show a name
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default 'Teammate',
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- workspaces — the shared tenant (the two of you, plus invitees later)
-- ---------------------------------------------------------------------------
create table if not exists public.workspaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null default 'Our workspace',
  join_code  text not null unique,
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- workspace_members — the access-control table
-- ---------------------------------------------------------------------------
create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  role         text not null default 'member' check (role in ('owner', 'member')),
  joined_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index if not exists workspace_members_user_idx
  on public.workspace_members (user_id);

-- ---------------------------------------------------------------------------
-- threads — a batch conversation
-- ---------------------------------------------------------------------------
create table if not exists public.threads (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  title        text not null default 'New batch',
  created_by   uuid not null references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists threads_workspace_updated_idx
  on public.threads (workspace_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- messages — one row per batch item (user prompt) and per answer
-- ---------------------------------------------------------------------------
create table if not exists public.messages (
  id           uuid primary key default gen_random_uuid(),
  thread_id    uuid not null references public.threads (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  author_id    uuid references auth.users (id) on delete set null,
  role         text not null check (role in ('user', 'assistant')),
  item_index   integer not null default 0,
  content      text not null,
  model        text,
  provider     text,
  input_tokens integer,
  output_tokens integer,
  created_at   timestamptz not null default now()
);

create index if not exists messages_thread_order_idx
  on public.messages (thread_id, created_at, item_index);

-- ---------------------------------------------------------------------------
-- usage_events — append-only, one row per answered batch item
-- ---------------------------------------------------------------------------
create table if not exists public.usage_events (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid references public.workspaces (id) on delete set null,
  thread_id    uuid references public.threads (id) on delete set null,
  provider     text not null,
  model        text not null,
  items        integer not null default 1,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  latency_ms   integer,
  fallback_used boolean not null default false,
  created_at   timestamptz not null default now()
);

create index if not exists usage_events_user_created_idx
  on public.usage_events (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists threads_touch_updated_at on public.threads;
create trigger threads_touch_updated_at
  before update on public.threads
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Membership helper
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER so the membership check itself is not blocked by the RLS
-- policy it is used inside (the classic infinite-recursion trap when a policy
-- on workspace_members queries workspace_members).
create or replace function public.is_workspace_member(ws uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = ws
      and m.user_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
-- Auto-provision: profile + first workspace on signup
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_workspace_id uuid;
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'display_name',
      split_part(new.email, '@', 1),
      'Teammate'
    )
  )
  on conflict (id) do nothing;

  -- Everyone starts with their own workspace. Joining someone else's is a
  -- separate, explicit action (see /api/workspaces/join).
  insert into public.workspaces (name, join_code, created_by)
  values (
    coalesce(split_part(new.email, '@', 1), 'Our') || '''s workspace',
    upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
    new.id
  )
  returning id into new_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (new_workspace_id, new.id, 'owner')
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles          enable row level security;
alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;
alter table public.threads           enable row level security;
alter table public.messages          enable row level security;
alter table public.usage_events      enable row level security;

-- --- profiles: read your own, plus anyone you share a workspace with -------
drop policy if exists "profiles_select_self_or_teammate" on public.profiles;
create policy "profiles_select_self_or_teammate" on public.profiles
  for select using (
    id = auth.uid()
    or exists (
      select 1
      from public.workspace_members me
      join public.workspace_members them
        on them.workspace_id = me.workspace_id
      where me.user_id = auth.uid()
        and them.user_id = profiles.id
    )
  );

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "profiles_insert_self" on public.profiles;
create policy "profiles_insert_self" on public.profiles
  for insert with check (id = auth.uid());

-- --- workspaces: visible to members; anyone can create their own ----------
drop policy if exists "workspaces_select_member" on public.workspaces;
create policy "workspaces_select_member" on public.workspaces
  for select using (public.is_workspace_member(id));

drop policy if exists "workspaces_insert_self" on public.workspaces;
create policy "workspaces_insert_self" on public.workspaces
  for insert with check (created_by = auth.uid());

drop policy if exists "workspaces_update_owner" on public.workspaces;
create policy "workspaces_update_owner" on public.workspaces
  for update using (created_by = auth.uid()) with check (created_by = auth.uid());

-- --- workspace_members: see your own memberships; owners can add ----------
drop policy if exists "members_select_own_or_teammate" on public.workspace_members;
create policy "members_select_own_or_teammate" on public.workspace_members
  for select using (
    user_id = auth.uid()
    or public.is_workspace_member(workspace_id)
  );

drop policy if exists "members_insert_self" on public.workspace_members;
create policy "members_insert_self" on public.workspace_members
  for insert with check (user_id = auth.uid());

drop policy if exists "members_delete_self" on public.workspace_members;
create policy "members_delete_self" on public.workspace_members
  for delete using (user_id = auth.uid());

-- --- threads: members read and write within their workspace ---------------
drop policy if exists "threads_select_member" on public.threads;
create policy "threads_select_member" on public.threads
  for select using (public.is_workspace_member(workspace_id));

drop policy if exists "threads_insert_member" on public.threads;
create policy "threads_insert_member" on public.threads
  for insert with check (
    created_by = auth.uid() and public.is_workspace_member(workspace_id)
  );

drop policy if exists "threads_update_member" on public.threads;
create policy "threads_update_member" on public.threads
  for update using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "threads_delete_member" on public.threads;
create policy "threads_delete_member" on public.threads
  for delete using (public.is_workspace_member(workspace_id));

-- --- messages: members read and write within their workspace --------------
drop policy if exists "messages_select_member" on public.messages;
create policy "messages_select_member" on public.messages
  for select using (public.is_workspace_member(workspace_id));

drop policy if exists "messages_insert_member" on public.messages;
create policy "messages_insert_member" on public.messages
  for insert with check (
    public.is_workspace_member(workspace_id)
    and (author_id is null or author_id = auth.uid())
  );

drop policy if exists "messages_delete_member" on public.messages;
create policy "messages_delete_member" on public.messages
  for delete using (public.is_workspace_member(workspace_id));

-- --- usage_events: read + insert your own, never update/delete ------------
drop policy if exists "usage_select_own" on public.usage_events;
create policy "usage_select_own" on public.usage_events
  for select using (user_id = auth.uid());

drop policy if exists "usage_insert_own" on public.usage_events;
create policy "usage_insert_own" on public.usage_events
  for insert with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Join a workspace by code
-- ---------------------------------------------------------------------------
-- Done as a SECURITY DEFINER function because the caller cannot yet SELECT the
-- workspace row (they are not a member), so they could never find its id.
create or replace function public.join_workspace(code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target uuid;
begin
  select id into target
  from public.workspaces
  where upper(join_code) = upper(trim(code));

  if target is null then
    raise exception 'No workspace matches that join code.';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (target, auth.uid(), 'member')
  on conflict (workspace_id, user_id) do nothing;

  return target;
end;
$$;

-- ---------------------------------------------------------------------------
-- Today's spend per user (used by the daily cap)
-- ---------------------------------------------------------------------------
create or replace view public.usage_today
with (security_invoker = true) as
select
  user_id,
  count(*)                        as batches,
  coalesce(sum(items), 0)         as items,
  coalesce(sum(input_tokens), 0)  as input_tokens,
  coalesce(sum(output_tokens), 0) as output_tokens
from public.usage_events
where created_at >= date_trunc('day', now())
group by user_id;
