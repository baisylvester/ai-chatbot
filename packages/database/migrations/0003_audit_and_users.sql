-- Audit writes from user context. chatbot_app has no INSERT policy on audit_logs (so users cannot forge
-- entries); this SECURITY DEFINER function records the action with the *current* user as actor,
-- and only for organizations the user belongs to.
create or replace function public.write_audit(
  org uuid,
  p_action text,
  p_target_type text,
  p_target_id text,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.current_app_user_id() is null or not public.is_org_member(org) then
    raise exception 'not a member of organization %', org using errcode = '42501';
  end if;
  insert into public.audit_logs (organization_id, actor_id, action, target_type, target_id, metadata)
  values (org, public.current_app_user_id(), p_action, p_target_type, p_target_id, coalesce(p_metadata, '{}'::jsonb));
end;
$$;

revoke all on function public.write_audit(uuid, text, text, text, jsonb) from public;
grant execute on function public.write_audit(uuid, text, text, text, jsonb) to chatbot_app;

-- public.users.id mirrors the Neon Auth user id (neon_auth."user".id, uuid). Rows are upserted by
-- trusted server code after a session is verified; the default generator is no longer used.
alter table public.users alter column id drop default;
