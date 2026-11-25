-- One server-provisioned personal mail assistant per verified platform user.
create table public.native_accounts (
  user_id uuid primary key references public.users(id) on delete cascade,
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  chatbot_id uuid not null unique references public.chatbots(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.native_accounts enable row level security;
revoke all on public.native_accounts from public, anon, authenticated, chatbot_app;
-- Authenticated application routes scope every trusted lookup to the verified user.
