-- Make document titles searchable: keyword search now covers each chunk's document title as well as
-- its text (the title is stored in chunk metadata at ingestion). Requires PostgreSQL 17+ (Neon: yes).
drop index if exists public.document_chunks_fts_idx;
alter table public.document_chunks
  alter column fts set expression as (to_tsvector('simple', coalesce(metadata->>'title', '') || ' ' || content));
create index document_chunks_fts_idx on public.document_chunks using gin (fts);
