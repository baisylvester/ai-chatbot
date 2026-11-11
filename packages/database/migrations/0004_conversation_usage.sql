-- Conversation and usage details for the AI engine (Phase 3).

-- Where a session came from, and (for dashboard playground sessions) which member started it.
alter table public.chat_sessions
  add column source text not null default 'widget' check (source in ('widget', 'api', 'playground')),
  add column created_by uuid references public.users (id) on delete set null;

-- Which model produced an assistant message (null for user messages).
alter table public.messages
  add column provider text,
  add column model text;

-- One row per model request, successful or not, for analytics, cost estimates and failure tracking.
alter table public.usage_records
  add column chat_session_id uuid references public.chat_sessions (id) on delete set null,
  add column source text not null default 'widget' check (source in ('widget', 'api', 'playground')),
  add column status text not null default 'ok' check (status in ('ok', 'error', 'interrupted', 'cancelled')),
  add column latency_ms integer check (latency_ms >= 0),
  add column error text;

create index usage_records_chatbot_idx on public.usage_records (chatbot_id, created_at desc);
