-- Scheduled sending: the mailbox owner approves a reviewed draft for a later time. The approval stays
-- bound to the reviewed version; the maintenance cron sends it when due only if the draft is unchanged.

alter table public.mail_actions add column if not exists scheduled_for timestamptz;
alter table public.mail_actions add column if not exists approved_version text
  check (approved_version is null or char_length(approved_version) = 64);

alter table public.mail_actions drop constraint if exists mail_actions_status_check;
alter table public.mail_actions add constraint mail_actions_status_check
  check (status in ('pending', 'scheduled', 'processing', 'done', 'rejected', 'failed', 'uncertain'));

alter table public.mail_actions drop constraint if exists mail_actions_scheduled_check;
alter table public.mail_actions add constraint mail_actions_scheduled_check
  check (status <> 'scheduled' or (kind = 'send' and scheduled_for is not null and approved_version is not null));

create index if not exists mail_actions_due_idx on public.mail_actions (scheduled_for) where status = 'scheduled';
