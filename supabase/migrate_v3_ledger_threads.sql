-- Migrate v3: replace per-message rows with 2-thread ledger (sender + receiver per code).
-- WARNING: Deletes all existing scans and messages data.

drop table if exists messages cascade;
drop table if exists scans cascade;

create table if not exists ledger_threads (
  id uuid primary key default gen_random_uuid(),
  verification_code text not null,
  device_id text not null,
  role text not null check (role in ('sender', 'receiver')),
  scan_count int not null default 1,
  conversation text not null default '',
  session_summaries text not null default '',
  started_at timestamptz not null default now(),
  last_active_at timestamptz,
  ended_at timestamptz,
  duration_seconds int,
  summary text,
  praise_detected boolean not null default false,
  praise_quote text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (verification_code, role)
);

create index if not exists idx_ledger_threads_code on ledger_threads(verification_code);

alter table ledger_threads enable row level security;

drop policy if exists "anon insert ledger_threads" on ledger_threads;
drop policy if exists "anon select ledger_threads" on ledger_threads;
drop policy if exists "anon update ledger_threads" on ledger_threads;

create policy "anon insert ledger_threads" on ledger_threads for insert to anon with check (true);
create policy "anon select ledger_threads" on ledger_threads for select to anon using (true);
create policy "anon update ledger_threads" on ledger_threads for update to anon using (true);
