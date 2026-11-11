-- Supabase exposes the public schema over its Data API (PostgREST) to the anon and authenticated roles,
-- and by default grants them every new table, sequence and function. This app never uses the Data API:
-- the server connects to Postgres directly, so remove those grants. All app tables keep RLS enabled;
-- schema access is removed as an additional boundary around this server-only data model.
-- No-op on databases without these roles (plain Postgres, Neon).
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke all on functions from %I', r);
      execute format('revoke usage on schema public from %I', r);
    end if;
  end loop;
  -- Functions are executable by PUBLIC unless revoked, and anon inherits PUBLIC. Without USAGE on the
  -- schema nothing in it is reachable. chatbot_app keeps its own explicit USAGE grant (0001).
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke usage on schema public from public;
  end if;
end
$$;
