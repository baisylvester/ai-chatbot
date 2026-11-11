-- Knowledge ingestion and retrieval (Phase 4).

-- A knowledge source is a named collection; each document has its own type and status.
alter table public.knowledge_sources
  drop column source_type,
  drop column status,
  add column description text check (char_length(description) <= 500);

-- Documents keep their extracted text so they can be re-chunked / re-embedded (reprocessing) without
-- the original file. Original binaries can move to object storage later (storage_key).
alter table public.knowledge_documents
  add column source_type text not null default 'text' check (source_type in ('file', 'url', 'text')),
  add column source_url text,
  add column mime_type text,
  add column size_bytes integer check (size_bytes >= 0),
  add column content text,
  add column char_count integer check (char_count >= 0),
  add column chunk_count integer not null default 0 check (chunk_count >= 0),
  add column embedding_model text,
  add column processed_at timestamptz,
  add column updated_at timestamptz not null default now();

-- Vectors from different embedding models are not comparable; retrieval filters on this.
alter table public.document_chunks
  add column embedding_model text,
  add column token_estimate integer check (token_estimate >= 0);

create index document_chunks_model_idx on public.document_chunks (organization_id, embedding_model);

-- Background ingestion work. Written and processed only by trusted server code.
create table public.ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  document_id uuid not null references public.knowledge_documents (id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index ingestion_jobs_status_idx on public.ingestion_jobs (status, created_at);
create index ingestion_jobs_document_idx on public.ingestion_jobs (document_id, created_at desc);

alter table public.ingestion_jobs enable row level security;
grant select on public.ingestion_jobs to chatbot_app;
create policy ingestion_jobs_member_select on public.ingestion_jobs for select to chatbot_app
  using (public.is_org_member(organization_id));

-- Messages already have a citations jsonb column (0001); retrieval stats per turn go to usage analytics later.
