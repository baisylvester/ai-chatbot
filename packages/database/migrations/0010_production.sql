-- Production readiness (Phase 8).

-- Shared fixed-window rate limiting across all server instances. UNLOGGED: fast, not replicated,
-- and emptied after a crash (acceptable for rate-limit counters). Trusted server code only.
create unlogged table public.rate_limits (
  key text primary key,
  window_start timestamptz not null default now(),
  count integer not null default 0
);
alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from chatbot_app;

/** Counts one hit; returns whether it is within `p_limit` for the current window. Atomic. */
create or replace function public.rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer)
returns table (allowed boolean, retry_after integer)
language sql
volatile
set search_path = ''
as $$
  insert into public.rate_limits as r (key, window_start, count)
  values (p_key, now(), 1)
  on conflict (key) do update set
    window_start = case when r.window_start <= now() - make_interval(secs => p_window_seconds) then now() else r.window_start end,
    count = case when r.window_start <= now() - make_interval(secs => p_window_seconds) then 1 else r.count + 1 end
  returning r.count <= p_limit,
    greatest(0, ceil(extract(epoch from (r.window_start + make_interval(secs => p_window_seconds) - now()))))::integer;
$$;
revoke all on function public.rate_limit_hit(text, integer, integer) from public;

-- Maintenance lookups.
create index ingestion_jobs_queued_idx on public.ingestion_jobs (created_at) where status in ('queued', 'running');
create index voice_sessions_active_idx on public.voice_sessions (started_at) where status = 'active';
