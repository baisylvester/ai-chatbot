-- Native (Android/iOS) mailbox connection. A native app cannot rely on the browser's session or
-- state cookies, so each Gmail connection it starts is a short-lived, single-use server transaction
-- bound to the signed-in user:
--   * state_hash          sha256 of the OAuth state sent to Google (the state itself is never stored)
--   * verifier_challenge  base64url sha256 of a secret held only by the app that started the flow
--   * pkce_verifier       server-side PKCE verifier for the Google code exchange
--   * completion_hash     sha256 of the one-time code delivered to the app after Google's callback
--   * sealed_refresh_token the encrypted Gmail token, parked until the app completes the transaction
-- The connection is saved only when the same signed-in user presents both the completion code and the
-- verifier. Rows are personal and hold an encrypted token: RLS on, no policies, no grants.

create table public.mail_oauth_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  chatbot_public_id text not null check (char_length(chatbot_public_id) between 1 and 80),
  state_hash text not null unique check (char_length(state_hash) = 64),
  verifier_challenge text not null check (char_length(verifier_challenge) = 43),
  pkce_verifier text not null check (char_length(pkce_verifier) between 43 and 128),
  completion_hash text check (completion_hash is null or char_length(completion_hash) = 64),
  sealed_refresh_token text,
  email text check (email is null or char_length(email) between 3 and 320),
  error text,
  expires_at timestamptz not null,
  callback_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index mail_oauth_transactions_user_idx on public.mail_oauth_transactions (user_id, created_at desc);
create index mail_oauth_transactions_expiry_idx on public.mail_oauth_transactions (expires_at);

alter table public.mail_oauth_transactions enable row level security;
revoke all on public.mail_oauth_transactions from anon, authenticated;

-- A Gmail request that failed without a definite answer (network error, 5xx) may or may not have
-- happened. It is recorded as 'uncertain' and is never retried automatically.
alter table public.mail_actions drop constraint if exists mail_actions_status_check;
alter table public.mail_actions add constraint mail_actions_status_check
  check (status in ('pending', 'processing', 'done', 'rejected', 'failed', 'uncertain'));
