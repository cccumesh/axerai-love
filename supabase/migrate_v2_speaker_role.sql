-- Run once in Supabase SQL Editor (ledger labels + sender/receiver role on scans)

alter table scans add column if not exists session_role text;

alter table messages add column if not exists speaker text;

alter table messages drop constraint if exists messages_role_check;
alter table messages add constraint messages_role_check check (role in ('user', 'myra', 'choocha'));
