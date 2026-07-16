-- =============================================================================
-- AXERAI LOVE — FRESH START (Supabase SQL Editor)
-- =============================================================================
-- WARNING: Purana data delete ho jayega. Sirf tab chalao jab naya setup chahiye.
--
-- Kaise use karein:
--   1. Supabase project → SQL Editor → New query
--   2. Poori file paste karo → Run
--   3. Table Editor mein `ledger_threads` dikhega (2 rows for code R)
--
-- Ek product code = max 2 rows: sender + receiver
-- =============================================================================

-- Purani tables (agar thi) hata do
drop table if exists public.messages cascade;
drop table if exists public.scans cascade;
drop table if exists public.ledger_threads cascade;

-- -----------------------------------------------------------------------------
-- MAIN TABLE: ledger_threads
-- -----------------------------------------------------------------------------
create table public.ledger_threads (
  id uuid primary key default gen_random_uuid(),

  -- Product code from card scan (e.g. R = RICHERA)
  verification_code text not null,

  -- Browser device UUID — sender vs receiver decide hota hai isse
  device_id text not null default '',

  -- sender = gift dene wala device | receiver = gift lene wala device
  role text not null check (role in ('sender', 'receiver')),

  -- Kitni baar scan hua is thread pe
  scan_count int not null default 0,

  -- Poori chat + session start/end markers (live dialogue)
  conversation text not null default '',

  -- Har exit scan ka Gemini summary (USER SAID + MYRA SAID + brand praise)
  session_summaries text not null default '',

  -- Har Gemini API call ka token log (JSON lines, one per line)
  gemini_usage text not null default '',

  -- Ek code pe sirf ek sender + ek receiver row
  unique (verification_code, role)
);

comment on table public.ledger_threads is
  'Axerai Love memory — max 2 rows per product code (sender + receiver).';

comment on column public.ledger_threads.verification_code is 'RICHERA product code from verify (e.g. R).';
comment on column public.ledger_threads.device_id is 'Stable browser device id from localStorage/cookie.';
comment on column public.ledger_threads.role is 'sender or receiver thread for this product code.';
comment on column public.ledger_threads.scan_count is 'Total completed scans on this thread.';
comment on column public.ledger_threads.conversation is 'Full chat log with session markers.';
comment on column public.ledger_threads.session_summaries is 'Exit summaries appended per scan.';
comment on column public.ledger_threads.gemini_usage is 'Token usage JSON lines per Gemini call.';

-- Fast lookup by product code (dashboard + app prefetch)
create index idx_ledger_threads_code on public.ledger_threads (verification_code);

-- -----------------------------------------------------------------------------
-- ROW LEVEL SECURITY (app uses anon key)
-- -----------------------------------------------------------------------------
alter table public.ledger_threads enable row level security;

drop policy if exists "anon insert ledger_threads" on public.ledger_threads;
drop policy if exists "anon select ledger_threads" on public.ledger_threads;
drop policy if exists "anon update ledger_threads" on public.ledger_threads;

create policy "anon insert ledger_threads"
  on public.ledger_threads
  for insert
  to anon
  with check (true);

create policy "anon select ledger_threads"
  on public.ledger_threads
  for select
  to anon
  using (true);

create policy "anon update ledger_threads"
  on public.ledger_threads
  for update
  to anon
  using (true)
  with check (true);

-- -----------------------------------------------------------------------------
-- SEED: product code R — 2 empty rows (app inhe scan pe bharega)
-- -----------------------------------------------------------------------------
insert into public.ledger_threads (
  verification_code,
  device_id,
  role,
  scan_count,
  conversation,
  session_summaries,
  gemini_usage
)
values
  ('R', '', 'sender', 0, '', '', ''),
  ('R', '', 'receiver', 0, '', '', '');

-- Done. Verify:
-- select verification_code, role, scan_count from public.ledger_threads order by role;
