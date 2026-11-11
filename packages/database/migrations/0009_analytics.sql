-- Analytics, retention and privacy (Phase 7).

-- Widget problems that never reach a conversation (refused origins, inactive chatbots), so admins
-- can see why a site isn't showing the chat. Written by trusted server code only.
create table public.analytics_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  chatbot_id uuid references public.chatbots (id) on delete cascade,
  type text not null check (type in ('widget_origin_refused', 'widget_chatbot_inactive')),
  origin text check (char_length(origin) <= 300),
  created_at timestamptz not null default now()
);
create index analytics_events_org_idx on public.analytics_events (organization_id, created_at desc);
alter table public.analytics_events enable row level security;
grant select on public.analytics_events to chatbot_app;
create policy analytics_events_member_select on public.analytics_events for select to chatbot_app
  using (public.is_org_member(organization_id));

-- Conversation retention per organization (null = keep until deleted). Enforced by purge jobs.
alter table public.organizations
  add column retention_days integer check (retention_days between 7 and 3650);

-- Analytics range queries.
create index chat_sessions_org_created_idx on public.chat_sessions (organization_id, created_at);
create index messages_org_created_idx on public.messages (organization_id, created_at);
