-- FRESH START — simple table + 2 empty rows for R
-- Supabase → SQL Editor → paste → Run

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

create policy "anon insert ledger_threads" on ledger_threads for insert to anon with check (true);
create policy "anon select ledger_threads" on ledger_threads for select to anon using (true);
create policy "anon update ledger_threads" on ledger_threads for update to anon using (true);

-- 2 khali lines — scan ke baad bharengi
insert into ledger_threads (verification_code, device_id, role, scan_count, conversation, session_summaries, gemini_usage)
values
  ('R', '', 'sender', 0, '', '', ''),
  ('R', '', 'receiver', 0, '', '', '');
