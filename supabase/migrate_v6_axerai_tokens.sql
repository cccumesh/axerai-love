-- Axerai token columns (run once in Supabase SQL Editor)
-- Axerai AI tokens   = former gemini_usage
-- Axerai voice tokens = former elevenlabs_usage

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ledger_threads' and column_name = 'gemini_usage'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ledger_threads' and column_name = 'axerai_ai_usage'
  ) then
    alter table public.ledger_threads rename column gemini_usage to axerai_ai_usage;
  end if;
end $$;

alter table public.ledger_threads
  add column if not exists axerai_ai_usage text not null default '';

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ledger_threads' and column_name = 'elevenlabs_usage'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ledger_threads' and column_name = 'axerai_voice_usage'
  ) then
    alter table public.ledger_threads rename column elevenlabs_usage to axerai_voice_usage;
  end if;
end $$;

alter table public.ledger_threads
  add column if not exists axerai_voice_usage text not null default '';

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ledger_threads' and column_name = 'gemini_usage'
  ) then
    update public.ledger_threads
    set axerai_ai_usage = gemini_usage
    where coalesce(axerai_ai_usage, '') = '' and coalesce(gemini_usage, '') <> '';
  end if;
end $$;

comment on column public.ledger_threads.axerai_ai_usage is
  'Axerai AI tokens — JSON lines per AI call.';
comment on column public.ledger_threads.axerai_voice_usage is
  'Axerai voice tokens — JSON lines per TTS character usage.';
