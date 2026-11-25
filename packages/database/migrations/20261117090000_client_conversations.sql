-- Persistent, private conversations for signed-in web and native clients.
-- Access-token lifetimes are deliberately independent of conversation lifetimes.
alter table public.chat_sessions drop constraint chat_sessions_source_check;
alter table public.chat_sessions add constraint chat_sessions_source_check
  check (source in ('widget', 'api', 'playground', 'client'));
alter table public.usage_records drop constraint usage_records_source_check;
alter table public.usage_records add constraint usage_records_source_check
  check (source in ('widget', 'api', 'playground', 'client'));

alter table public.chat_sessions
  alter column expires_at drop not null,
  add column owner_user_id uuid references public.users(id) on delete cascade,
  add column title text not null default 'New conversation' check (char_length(title) between 1 and 120),
  add column updated_at timestamptz not null default now(),
  add column revision bigint not null default 0 check (revision >= 0),
  add constraint client_session_owner check (
    (source = 'client' and owner_user_id is not null and expires_at is null)
    or (source <> 'client' and owner_user_id is null and expires_at is not null)
  );
create index chat_sessions_owner_idx on public.chat_sessions(owner_user_id, chatbot_id, created_at desc, id desc)
  where source = 'client';

-- Only one generation may run for a conversation. Expired leases are interrupted,
-- never regenerated automatically: a provider or a mailbox tool may already have run.
create table public.client_turns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  chat_session_id uuid not null references public.chat_sessions(id) on delete cascade,
  request_id uuid not null,
  request_hash text not null,
  status text not null default 'running' check (status in ('running', 'completed', 'failed', 'interrupted')),
  result jsonb,
  lease_expires_at timestamptz not null default (now() + interval '10 minutes'),
  created_at timestamptz not null default clock_timestamp(),
  unique (chat_session_id, request_id)
);
create unique index client_turns_one_running on public.client_turns(chat_session_id) where status = 'running';
alter table public.client_turns enable row level security;
-- These are trusted-server records. Do not grant the Supabase Data API or chatbot_app access.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'chatbot_app'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.client_turns from %I', r);
    end if;
  end loop;
end $$;

alter table public.messages
  add column turn_id uuid references public.client_turns(id) on delete cascade,
  add column sequence bigint;
create unique index messages_client_sequence on public.messages(chat_session_id, sequence) where sequence is not null;

-- Increment under the session row lock, in the SAME transaction as the message insert.
-- A reader's revision can never skip a message that has not committed yet.
create function public.number_client_message() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  update public.chat_sessions set revision = revision + 1, updated_at = clock_timestamp()
    where id = new.chat_session_id and organization_id = new.organization_id and source = 'client'
    returning revision into new.sequence;
  return new;
end $$;
revoke all on function public.number_client_message() from public;
create trigger number_client_message before insert on public.messages
  for each row execute function public.number_client_message();

-- Organization membership does not grant access to someone's private client chat.
drop policy chat_sessions_member_select on public.chat_sessions;
create policy chat_sessions_member_select on public.chat_sessions for select to chatbot_app
  using (source <> 'client' and public.is_org_member(organization_id));
create policy chat_sessions_owner_select on public.chat_sessions for select to chatbot_app
  using (source = 'client' and owner_user_id = public.current_app_user_id());
drop policy messages_member_select on public.messages;
create policy messages_member_select on public.messages for select to chatbot_app
  using (public.is_org_member(organization_id) and exists (
    select 1 from public.chat_sessions s where s.id = chat_session_id and s.source <> 'client'
  ));
create policy messages_owner_select on public.messages for select to chatbot_app
  using (exists (select 1 from public.chat_sessions s
    where s.id = chat_session_id and s.source = 'client' and s.owner_user_id = public.current_app_user_id()));
