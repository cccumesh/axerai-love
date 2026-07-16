-- Add Gemini token usage log per thread (run once if column missing)
alter table ledger_threads
  add column if not exists gemini_usage text not null default '';
