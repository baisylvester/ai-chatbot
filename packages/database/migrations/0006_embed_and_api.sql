-- Universal embedding and public API (Phase 5).

-- Allow `localhost` as a website domain for local development and testing.
alter table public.website_domains drop constraint website_domains_domain_check;
alter table public.website_domains add constraint website_domains_domain_check
  check (domain ~ '^(localhost|(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,63})$');

-- Look up API keys by hash quickly; keys are always resolved by trusted server code.
create index api_keys_active_idx on public.api_keys (key_hash) where revoked_at is null;
alter table public.api_keys add column last_used_at timestamptz;

-- Embedded sessions are looked up by id + chatbot on every message.
create index chat_sessions_lookup_idx on public.chat_sessions (id, chatbot_id);

-- Let admins see when a key was last used (the hash stays hidden).
grant select (last_used_at) on public.api_keys to chatbot_app;
