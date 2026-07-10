-- Run once if messages insert fails with role check constraint (choocha → myra rebrand)

alter table messages drop constraint if exists messages_role_check;
alter table messages add constraint messages_role_check check (role in ('user', 'myra', 'choocha'));
