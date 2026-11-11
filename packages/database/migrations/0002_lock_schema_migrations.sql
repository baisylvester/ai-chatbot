-- 0001 granted chatbot_app access to "all tables in schema public", which included the runner's
-- schema_migrations bookkeeping table. Only the owner role should touch it.
revoke all on public.schema_migrations from chatbot_app;
alter table public.schema_migrations enable row level security;
