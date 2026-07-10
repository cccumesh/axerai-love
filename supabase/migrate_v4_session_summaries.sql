-- v4: separate accumulating summary box (session_summaries) per thread row.
-- Run in Supabase SQL Editor if you already ran migrate_v3.

alter table ledger_threads
  add column if not exists session_summaries text not null default '';
