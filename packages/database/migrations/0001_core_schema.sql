-- Core multi-tenant schema for plain PostgreSQL (Neon): organizations > workspaces > websites > chatbots,
-- knowledge (global + chatbot-scoped), pgvector retrieval, conversations, keys, audit, usage.
-- Every tenant-scoped row carries organization_id so RLS and retrieval filters can enforce isolation directly.
--
-- Access model (replaces Supabase's anon/authenticated/service_role):
--   * The migration/owner role owns every table. It bypasses RLS and is used only by trusted server
--     code (ingestion, conversation writes, organization creation) - the equivalent of a service role.
--   * chatbot_app is a NOLOGIN role subject to RLS. Per-user dashboard requests run inside a transaction
--     that does `SET LOCAL ROLE chatbot_app` and `set_config('app.user_id', <uuid>, true)`.
--     See packages/database/src/client.ts (withUserContext).

create extension if not exists vector;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'chatbot_app') then
    create role chatbot_app nologin;
  end if;
end
$$;

-- Allow the owner role to switch into chatbot_app (SET option is required on PostgreSQL 16+).
do $$
begin
  execute format('grant chatbot_app to %I with set true', current_user);
end
$$;

-- ---------------------------------------------------------------- current user
create or replace function public.current_app_user_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.user_id', true), '')::uuid;
$$;

-- ---------------------------------------------------------------- identity & tenancy
-- Application users. The authentication provider (e.g. Neon Auth / Better Auth) maps its identity to this row.
create table public.users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  full_name text,
  created_at timestamptz not null default now()
);
create unique index users_email_key on public.users (lower(email));

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  created_at timestamptz not null default now()
);

create table public.organization_members (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index organization_members_user_idx on public.organization_members (user_id);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  created_at timestamptz not null default now(),
  unique (organization_id, slug)
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  role text not null check (role in ('admin', 'member', 'viewer')),
  primary key (workspace_id, user_id)
);

-- ---------------------------------------------------------------- websites & chatbots
create table public.websites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  created_at timestamptz not null default now()
);
create index websites_org_idx on public.websites (organization_id, workspace_id);

create table public.website_domains (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  website_id uuid not null references public.websites (id) on delete cascade,
  domain text not null check (domain ~ '^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$'),
  created_at timestamptz not null default now(),
  unique (website_id, domain)
);

create table public.chatbots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  website_id uuid not null references public.websites (id) on delete cascade,
  -- Public identifier used by embeds. Identifier only, never an authorization credential.
  public_id text not null unique check (public_id ~ '^cb_[A-Za-z0-9]{16,64}$'),
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'archived')),
  created_at timestamptz not null default now()
);
create index chatbots_org_idx on public.chatbots (organization_id, website_id);

create table public.chatbot_settings (
  chatbot_id uuid primary key references public.chatbots (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- knowledge
create table public.knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- Global sources have a null workspace only when scoped to the whole organization.
  workspace_id uuid references public.workspaces (id) on delete cascade,
  scope text not null check (scope in ('global', 'chatbot')),
  -- For scope = 'chatbot' the owning chatbot is required; global sources are linked via assignments.
  chatbot_id uuid references public.chatbots (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  source_type text not null check (source_type in ('file', 'url', 'text')),
  status text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'failed')),
  created_at timestamptz not null default now(),
  constraint knowledge_scope_owner check (
    (scope = 'chatbot' and chatbot_id is not null) or (scope = 'global' and chatbot_id is null)
  )
);
create index knowledge_sources_org_idx on public.knowledge_sources (organization_id, scope);

-- Explicit assignment: global sources are never exposed to a chatbot unless assigned here.
create table public.chatbot_knowledge_assignments (
  chatbot_id uuid not null references public.chatbots (id) on delete cascade,
  knowledge_source_id uuid not null references public.knowledge_sources (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (chatbot_id, knowledge_source_id)
);

create table public.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  knowledge_source_id uuid not null references public.knowledge_sources (id) on delete cascade,
  title text not null,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  -- Object storage key (S3-compatible bucket); file bytes are not stored in Postgres.
  storage_key text,
  status text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  -- Duplicate detection within a source.
  unique (knowledge_source_id, content_hash)
);

create table public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  knowledge_source_id uuid not null references public.knowledge_sources (id) on delete cascade,
  document_id uuid not null references public.knowledge_documents (id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null,
  -- Dimension must match the configured embedding model; change via a new migration.
  embedding vector(1536),
  fts tsvector generated always as (to_tsvector('simple', content)) stored,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (document_id, chunk_index)
);
create index document_chunks_org_source_idx on public.document_chunks (organization_id, knowledge_source_id);
create index document_chunks_fts_idx on public.document_chunks using gin (fts);
create index document_chunks_embedding_idx on public.document_chunks using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------- conversations
create table public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  chatbot_id uuid not null references public.chatbots (id) on delete cascade,
  -- Salted hash of the visitor identifier; no raw personal data is stored.
  visitor_hash text,
  origin text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '1 day')
);
create index chat_sessions_chatbot_idx on public.chat_sessions (organization_id, chatbot_id, created_at desc);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  chat_session_id uuid not null references public.chat_sessions (id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null check (char_length(content) <= 20000),
  citations jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index messages_session_idx on public.messages (chat_session_id, created_at);

-- ---------------------------------------------------------------- security & operations
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  scope text not null check (scope in ('public', 'private')),
  key_prefix text not null,
  -- Only a hash of the key is stored; the plaintext is shown once at creation.
  key_hash text not null unique,
  created_by uuid references public.users (id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  actor_id uuid references public.users (id) on delete set null,
  action text not null,
  target_type text not null,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_org_idx on public.audit_logs (organization_id, created_at desc);

create table public.usage_records (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  chatbot_id uuid references public.chatbots (id) on delete set null,
  provider text not null,
  model text not null,
  prompt_tokens integer not null default 0 check (prompt_tokens >= 0),
  completion_tokens integer not null default 0 check (completion_tokens >= 0),
  created_at timestamptz not null default now()
);
create index usage_records_org_idx on public.usage_records (organization_id, created_at desc);

-- ---------------------------------------------------------------- RLS helpers
-- SECURITY DEFINER so policies can read memberships without recursive RLS checks.
create or replace function public.is_org_member(org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = org and m.user_id = public.current_app_user_id()
  );
$$;

create or replace function public.is_org_admin(org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = org
      and m.user_id = public.current_app_user_id()
      and m.role in ('owner', 'admin')
  );
$$;

revoke all on function public.is_org_member(uuid) from public;
revoke all on function public.is_org_admin(uuid) from public;
grant execute on function public.is_org_member(uuid) to chatbot_app;
grant execute on function public.is_org_admin(uuid) to chatbot_app;
grant execute on function public.current_app_user_id() to chatbot_app;

-- ---------------------------------------------------------------- privileges
revoke all on all tables in schema public from public;
grant usage on schema public to chatbot_app;
grant select, insert, update, delete on all tables in schema public to chatbot_app;

-- Clients must never read secret hashes: replace the table grant with an explicit column list.
revoke all on public.api_keys from chatbot_app;
grant select (id, organization_id, name, scope, key_prefix, created_by, revoked_at, created_at)
  on public.api_keys to chatbot_app;
grant delete, update (name, revoked_at) on public.api_keys to chatbot_app;

-- ---------------------------------------------------------------- RLS policies
alter table public.users enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.websites enable row level security;
alter table public.website_domains enable row level security;
alter table public.chatbots enable row level security;
alter table public.chatbot_settings enable row level security;
alter table public.knowledge_sources enable row level security;
alter table public.chatbot_knowledge_assignments enable row level security;
alter table public.knowledge_documents enable row level security;
alter table public.document_chunks enable row level security;
alter table public.chat_sessions enable row level security;
alter table public.messages enable row level security;
alter table public.api_keys enable row level security;
alter table public.audit_logs enable row level security;
alter table public.usage_records enable row level security;

-- Users: read and update only your own row. Rows are created by the trusted auth callback.
create policy users_self_select on public.users for select to chatbot_app
  using (id = public.current_app_user_id());
create policy users_self_update on public.users for update to chatbot_app
  using (id = public.current_app_user_id()) with check (id = public.current_app_user_id());

-- Organization-scoped read: members only. Writes: owners/admins only.
-- Organizations themselves are created by trusted server code, which also inserts the owner membership.
create policy organizations_member_select on public.organizations for select to chatbot_app
  using (public.is_org_member(id));
create policy organizations_admin_update on public.organizations for update to chatbot_app
  using (public.is_org_admin(id)) with check (public.is_org_admin(id));

create policy organization_members_member_select on public.organization_members for select to chatbot_app
  using (public.is_org_member(organization_id));
create policy organization_members_admin_write on public.organization_members for all to chatbot_app
  using (public.is_org_admin(organization_id)) with check (public.is_org_admin(organization_id));

create policy workspaces_member_select on public.workspaces for select to chatbot_app
  using (public.is_org_member(organization_id));
create policy workspaces_admin_write on public.workspaces for all to chatbot_app
  using (public.is_org_admin(organization_id)) with check (public.is_org_admin(organization_id));

create policy workspace_members_member_select on public.workspace_members for select to chatbot_app
  using (public.is_org_member(organization_id));
create policy workspace_members_admin_write on public.workspace_members for all to chatbot_app
  using (public.is_org_admin(organization_id)) with check (public.is_org_admin(organization_id));

create policy websites_member_select on public.websites for select to chatbot_app
  using (public.is_org_member(organization_id));
create policy websites_admin_write on public.websites for all to chatbot_app
  using (public.is_org_admin(organization_id)) with check (public.is_org_admin(organization_id));

create policy website_domains_member_select on public.website_domains for select to chatbot_app
  using (public.is_org_member(organization_id));
create policy website_domains_admin_write on public.website_domains for all to chatbot_app
  using (public.is_org_admin(organization_id)) with check (public.is_org_admin(organization_id));

create policy chatbots_member_select on public.chatbots for select to chatbot_app
  using (public.is_org_member(organization_id));
create policy chatbots_admin_write on public.chatbots for all to chatbot_app
  using (public.is_org_admin(organization_id)) with check (public.is_org_admin(organization_id));

create policy chatbot_settings_member_select on public.chatbot_settings for select to chatbot_app
  using (public.is_org_member(organization_id));
create policy chatbot_settings_admin_write on public.chatbot_settings for all to chatbot_app
  using (public.is_org_admin(organization_id)) with check (public.is_org_admin(organization_id));

create policy knowledge_sources_member_select on public.knowledge_sources for select to chatbot_app
  using (public.is_org_member(organization_id));
create policy knowledge_sources_admin_write on public.knowledge_sources for all to chatbot_app
  using (public.is_org_admin(organization_id)) with check (public.is_org_admin(organization_id));

create policy assignments_member_select on public.chatbot_knowledge_assignments for select to chatbot_app
  using (public.is_org_member(organization_id));
create policy assignments_admin_write on public.chatbot_knowledge_assignments for all to chatbot_app
  using (public.is_org_admin(organization_id)) with check (public.is_org_admin(organization_id));

create policy knowledge_documents_member_select on public.knowledge_documents for select to chatbot_app
  using (public.is_org_member(organization_id));
create policy knowledge_documents_admin_write on public.knowledge_documents for all to chatbot_app
  using (public.is_org_admin(organization_id)) with check (public.is_org_admin(organization_id));

-- Chunks are written only by the trusted ingestion service (owner role).
create policy document_chunks_member_select on public.document_chunks for select to chatbot_app
  using (public.is_org_member(organization_id));

-- Conversations are written only by the trusted server. Members may read them.
create policy chat_sessions_member_select on public.chat_sessions for select to chatbot_app
  using (public.is_org_member(organization_id));
create policy messages_member_select on public.messages for select to chatbot_app
  using (public.is_org_member(organization_id));

-- API key metadata is visible to admins only. Keys are created by trusted server code (hashing happens there).
create policy api_keys_admin_select on public.api_keys for select to chatbot_app
  using (public.is_org_admin(organization_id));
create policy api_keys_admin_update on public.api_keys for update to chatbot_app
  using (public.is_org_admin(organization_id)) with check (public.is_org_admin(organization_id));
create policy api_keys_admin_delete on public.api_keys for delete to chatbot_app
  using (public.is_org_admin(organization_id));

create policy audit_logs_admin_select on public.audit_logs for select to chatbot_app
  using (public.is_org_admin(organization_id));

create policy usage_records_member_select on public.usage_records for select to chatbot_app
  using (public.is_org_member(organization_id));
