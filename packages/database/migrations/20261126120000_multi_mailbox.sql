-- Several mailboxes per user (Gmail, Outlook / Microsoft 365, IMAP). One of them is the selected
-- mailbox (latest selected_at): the AI assistant and requests without an explicit mailbox use it.
alter table public.mail_connections drop constraint if exists mail_connections_user_id_key;
alter table public.mail_connections drop constraint if exists mail_connections_provider_check;
alter table public.mail_connections add constraint mail_connections_provider_check check (provider in ('gmail', 'outlook', 'imap'));
alter table public.mail_connections add column if not exists selected_at timestamptz not null default now();
-- Non-secret provider settings (IMAP/SMTP hosts, ports and user name). Secrets stay in refresh_token_enc.
alter table public.mail_connections add column if not exists settings jsonb;
create unique index if not exists mail_connections_user_address_idx on public.mail_connections (user_id, provider, lower(email));
create index if not exists mail_connections_user_selected_idx on public.mail_connections (user_id, selected_at desc);

-- An approval request belongs to the mailbox it was drafted in; it is sent or trashed only there.
alter table public.mail_actions add column if not exists connection_id uuid references public.mail_connections (id) on delete cascade;
update public.mail_actions a set connection_id = c.id
  from public.mail_connections c where c.user_id = a.user_id and a.connection_id is null;

-- A connection attempt remembers which provider it is for.
alter table public.mail_oauth_transactions add column if not exists provider text not null default 'gmail'
  check (provider in ('gmail', 'outlook'));
