-- Pinned messages: Gmail has no pin, so the app keeps the user's pinned message ids per mailbox address.
-- Only ids are stored (no email content). Synced across the user's devices.
create table if not exists public.mail_pins (
  user_id uuid not null references public.users(id) on delete cascade,
  mailbox text not null check (char_length(mailbox) between 3 and 320),
  message_id text not null check (message_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  pinned_at timestamptz not null default now(),
  primary key (user_id, mailbox, message_id)
);
alter table public.mail_pins enable row level security;
revoke all on public.mail_pins from public, anon, authenticated;

-- Small per-user app preferences synced across devices (currently the color theme).
create table if not exists public.client_preferences (
  user_id uuid primary key references public.users(id) on delete cascade,
  theme jsonb,
  updated_at timestamptz not null default now()
);
alter table public.client_preferences enable row level security;
revoke all on public.client_preferences from public, anon, authenticated;
-- Access to both tables is through trusted server code, always scoped to the verified user.
