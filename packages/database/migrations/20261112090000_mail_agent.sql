-- Mail agent: a user's connected Gmail mailbox, actions waiting for their approval, the notifications
-- the agent wrote for them, and the devices to wake when one arrives.
--
-- These rows are personal (not organization data) and mail_connections holds an encrypted mailbox
-- token. RLS is on with no policies and no grants, so the restricted chatbot_app role cannot touch
-- them; the server reads them in a trusted context, always filtered by the signed-in user's id.

create table public.mail_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.users (id) on delete cascade,
  provider text not null default 'gmail' check (provider in ('gmail')),
  email text not null check (char_length(email) between 3 and 320),
  refresh_token_enc text not null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  notify boolean not null default true,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.mail_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  kind text not null check (kind in ('send', 'trash')),
  summary text not null check (char_length(summary) between 1 and 500),
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'done', 'rejected', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index mail_actions_user_idx on public.mail_actions (user_id, status, created_at desc);

create table public.mail_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  title text not null,
  body text not null,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
create index mail_notifications_user_idx on public.mail_notifications (user_id, created_at desc);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  endpoint text not null unique check (endpoint like 'https://%' and char_length(endpoint) <= 2000),
  created_at timestamptz not null default now()
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.mail_connections enable row level security;
alter table public.mail_actions enable row level security;
alter table public.mail_notifications enable row level security;
alter table public.push_subscriptions enable row level security;

-- Supabase grants new public tables to its API roles by default; 0011 closed that door, keep it closed.
revoke all on public.mail_connections, public.mail_actions, public.mail_notifications, public.push_subscriptions from anon, authenticated;
