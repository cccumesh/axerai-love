-- Axerai Love — current ledger schema (reference / new project setup)
-- For wipe + recreate with seed rows, use fresh_start.sql instead.

create table if not exists public.ledger_threads (
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

create index if not exists idx_ledger_threads_code on public.ledger_threads (verification_code);

alter table public.ledger_threads enable row level security;

drop policy if exists "anon insert ledger_threads" on public.ledger_threads;
drop policy if exists "anon select ledger_threads" on public.ledger_threads;
drop policy if exists "anon update ledger_threads" on public.ledger_threads;

create policy "anon insert ledger_threads" on public.ledger_threads for insert to anon with check (true);
create policy "anon select ledger_threads" on public.ledger_threads for select to anon using (true);
create policy "anon update ledger_threads" on public.ledger_threads for update to anon using (true) with check (true);
