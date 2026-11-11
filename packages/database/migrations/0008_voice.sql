-- Voice (Phase 6): realtime voice sessions and voice usage.

create table public.voice_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  chatbot_id uuid not null references public.chatbots (id) on delete cascade,
  chat_session_id uuid not null references public.chat_sessions (id) on delete cascade,
  mode text not null check (mode in ('realtime')),
  provider text not null,
  model text not null,
  voice text,
  status text not null default 'active' check (status in ('active', 'ended', 'failed')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_seconds integer check (duration_seconds >= 0),
  tool_calls integer not null default 0 check (tool_calls >= 0)
);
create index voice_sessions_chatbot_idx on public.voice_sessions (organization_id, chatbot_id, started_at desc);

alter table public.voice_sessions enable row level security;
grant select on public.voice_sessions to chatbot_app;
create policy voice_sessions_member_select on public.voice_sessions for select to chatbot_app
  using (public.is_org_member(organization_id));

-- Usage kinds: chat (tokens), stt (audio seconds), tts (characters), realtime (audio seconds).
alter table public.usage_records
  add column kind text not null default 'chat' check (kind in ('chat', 'stt', 'tts', 'realtime')),
  add column audio_seconds numeric(10, 2) check (audio_seconds >= 0),
  add column characters integer check (characters >= 0);
