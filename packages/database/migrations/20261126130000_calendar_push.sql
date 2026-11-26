-- Google Calendar, connected separately from the mailbox (opt-in): one per user, token encrypted.
create table if not exists public.calendar_connections (
  user_id uuid primary key references public.users(id) on delete cascade,
  email text not null check (char_length(email) between 3 and 320),
  refresh_token_enc text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.calendar_connections enable row level security;
revoke all on public.calendar_connections from public, anon, authenticated;

alter table public.mail_oauth_transactions drop constraint if exists mail_oauth_transactions_provider_check;
alter table public.mail_oauth_transactions add constraint mail_oauth_transactions_provider_check check (provider in ('gmail', 'outlook', 'gcal'));

-- Firebase Cloud Messaging tokens of the user's phones, for native new-mail notifications.
create table if not exists public.fcm_tokens (
  token text primary key check (char_length(token) between 20 and 4096),
  user_id uuid not null references public.users(id) on delete cascade,
  platform text not null default 'android' check (platform in ('android', 'ios')),
  updated_at timestamptz not null default now()
);
create index if not exists fcm_tokens_user_idx on public.fcm_tokens (user_id);
alter table public.fcm_tokens enable row level security;
revoke all on public.fcm_tokens from public, anon, authenticated;
