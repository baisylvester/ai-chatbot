-- Durable native compose requests. A lost Gmail response must never create a
-- second draft/approval silently. No email content or provider secrets are stored.
create table public.mail_draft_requests (
  user_id uuid not null references public.users(id) on delete cascade,
  request_id uuid not null,
  fingerprint text not null,
  status text not null check (status in ('running', 'completed', 'uncertain')),
  result jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, request_id)
);
alter table public.mail_draft_requests enable row level security;
revoke all on public.mail_draft_requests from public, anon, authenticated;
-- Access is through trusted server code, always scoped to the verified user.
