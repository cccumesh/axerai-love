-- Axerai Love ledger — simple 6 columns + id
-- One product code = max 2 rows (sender + receiver)

drop table if exists messages cascade;
drop table if exists scans cascade;
drop table if exists ledger_threads cascade;

create table ledger_threads (
  id uuid primary key default gen_random_uuid(),
  verification_code text not null,
  device_id text not null default '',
  role text not null check (role in ('sender', 'receiver')),
  scan_count int not null default 0,
  conversation text not null default '',
  session_summaries text not null default '',
  gemini_usage text not null default '',
  unique (verification_code, role)
);

create index idx_ledger_threads_code on ledger_threads(verification_code);

alter table ledger_threads enable row level security;

drop policy if exists "anon insert ledger_threads" on ledger_threads;
drop policy if exists "anon select ledger_threads" on ledger_threads;
drop policy if exists "anon update ledger_threads" on ledger_threads;

create policy "anon insert ledger_threads" on ledger_threads for insert to anon with check (true);
create policy "anon select ledger_threads" on ledger_threads for select to anon using (true);
create policy "anon update ledger_threads" on ledger_threads for update to anon using (true);
