-- Harden the helper's name resolution and keep Supabase extensions outside its exposed public schema.
alter function public.current_app_user_id() set search_path = '';

do $$
begin
  -- Plain Postgres/Neon installs keep their original vector location and search path.
  if exists (select 1 from pg_roles where rolname = 'anon')
     and exists (select 1 from pg_namespace where nspname = 'extensions') then
    alter extension vector set schema extensions;
    -- Dashboard queries run as this restricted role, inheriting the connection's search_path.
    grant usage on schema extensions to chatbot_app;
    if to_regtype('vector') is null then
      raise exception 'The connection search_path must include extensions for vector queries';
    end if;
  end if;
end
$$;
