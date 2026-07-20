-- =============================================================================
-- AXERAI LOVE — FRESH START (sirf yehi file chalao)
-- =============================================================================
-- WARNING: Purana data DELETE ho jayega.
--
-- Supabase → SQL Editor → New query → poori file paste → Run
-- Baad me migrate_v2 / v3 / v4 / v5 / v6 mat chalana — sab isme already hai.
--
-- Table: ledger_threads
--   • verification_code + role (sender | receiver) — ek code pe max 2 rows
--   • conversation, session_summaries
--   • axerai_ai_usage    = Axerai AI tokens
--   • axerai_voice_usage = Axerai voice tokens
-- =============================================================================

drop table if exists public.messages cascade;
drop table if exists public.scans cascade;
drop table if exists public.ledger_threads cascade;

create table public.ledger_threads (
  id uuid primary key default gen_random_uuid(),
  verification_code text not null,
  device_id text not null default '',
  role text not null check (role in ('sender', 'receiver')),
  scan_count int not null default 0,
  conversation text not null default '',
  session_summaries text not null default '',
  axerai_ai_usage text not null default '',
  axerai_voice_usage text not null default '',
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
comment on column public.ledger_threads.axerai_ai_usage is 'Axerai AI tokens — JSON lines per AI call.';
comment on column public.ledger_threads.axerai_voice_usage is 'Axerai voice tokens — JSON lines per TTS character usage.';

create index idx_ledger_threads_code on public.ledger_threads (verification_code);

alter table public.ledger_threads enable row level security;

drop policy if exists "anon insert ledger_threads" on public.ledger_threads;
drop policy if exists "anon select ledger_threads" on public.ledger_threads;
drop policy if exists "anon update ledger_threads" on public.ledger_threads;

create policy "anon insert ledger_threads"
  on public.ledger_threads for insert to anon with check (true);

create policy "anon select ledger_threads"
  on public.ledger_threads for select to anon using (true);

create policy "anon update ledger_threads"
  on public.ledger_threads for update to anon using (true) with check (true);

insert into public.ledger_threads (
  verification_code,
  device_id,
  role,
  scan_count,
  conversation,
  session_summaries,
  axerai_ai_usage,
  axerai_voice_usage
)
values
  ('R', '', 'sender', 0, '', '', '', ''),
  ('R', '', 'receiver', 0, '', '', '', '');

-- Verify: select verification_code, role, scan_count from public.ledger_threads order by role;
