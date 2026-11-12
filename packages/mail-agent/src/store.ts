/**
 * Mail agent storage. These tables belong to one user each and hold an encrypted mailbox token, so the
 * RLS-restricted role has no access to them at all. Call these from a trusted context only, and always
 * with the signed-in user's id: every query here is scoped by `user_id`.
 */
import type { DbClient } from "@chatbot/database";
import type { ActionKind, SendPayload, TrashPayload } from "./agent.ts";

export interface MailConnection { id: string; userId: string; email: string; refreshTokenEnc: string; status: "active" | "revoked"; notify: boolean; lastCheckedAt: Date | null }
export interface MailAction { id: string; kind: ActionKind; summary: string; payload: SendPayload | TrashPayload; status: string; error: string | null; createdAt: Date }
export interface MailNotification { id: string; title: string; body: string; createdAt: Date }

const CONNECTION = `id, user_id as "userId", email, refresh_token_enc as "refreshTokenEnc", status, notify, last_checked_at as "lastCheckedAt"`;
const ACTION = `id, kind, summary, payload, status, error, created_at as "createdAt"`;

export async function getConnection(db: DbClient, userId: string): Promise<MailConnection | null> {
  const { rows } = await db.query<MailConnection>(`select ${CONNECTION} from public.mail_connections where user_id = $1`, [userId]);
  return rows[0] ?? null;
}

/** One mailbox per user: connecting again replaces the previous one. */
export async function saveConnection(db: DbClient, userId: string, email: string, refreshTokenEnc: string): Promise<void> {
  await db.query(
    `insert into public.mail_connections (user_id, email, refresh_token_enc, last_checked_at) values ($1, $2, $3, now())
     on conflict (user_id) do update set email = excluded.email, refresh_token_enc = excluded.refresh_token_enc,
       status = 'active', last_checked_at = now(), updated_at = now()`,
    [userId, email, refreshTokenEnc],
  );
}

/** Removes the mailbox with everything queued for it. Notifications and push subscriptions go too. */
export async function deleteConnection(db: DbClient, userId: string): Promise<void> {
  await db.query("delete from public.mail_actions where user_id = $1", [userId]);
  await db.query("delete from public.mail_notifications where user_id = $1", [userId]);
  await db.query("delete from public.push_subscriptions where user_id = $1", [userId]);
  await db.query("delete from public.mail_connections where user_id = $1", [userId]);
}

export async function markRevoked(db: DbClient, userId: string): Promise<void> {
  await db.query("update public.mail_connections set status = 'revoked', updated_at = now() where user_id = $1", [userId]);
}

export async function setNotify(db: DbClient, userId: string, notify: boolean): Promise<void> {
  await db.query("update public.mail_connections set notify = $2, updated_at = now() where user_id = $1", [userId, notify]);
}

/** Mailboxes due for a new-mail check, longest-waiting first. */
export async function dueConnections(db: DbClient, limit: number, minAgeSeconds = 540): Promise<MailConnection[]> {
  const { rows } = await db.query<MailConnection>(
    `select ${CONNECTION} from public.mail_connections
     where status = 'active' and notify and (last_checked_at is null or last_checked_at < now() - make_interval(secs => $2))
     order by last_checked_at asc nulls first limit $1`,
    [limit, minAgeSeconds],
  );
  return rows;
}

export async function touchChecked(db: DbClient, connectionId: string, at: Date): Promise<void> {
  await db.query("update public.mail_connections set last_checked_at = $2 where id = $1", [connectionId, at]);
}

export async function createAction(db: DbClient, userId: string, kind: ActionKind, summary: string, payload: SendPayload | TrashPayload): Promise<void> {
  await db.query("insert into public.mail_actions (user_id, kind, summary, payload) values ($1, $2, $3, $4)", [userId, kind, summary.slice(0, 500), JSON.stringify(payload)]);
}

export async function listPendingActions(db: DbClient, userId: string): Promise<MailAction[]> {
  const { rows } = await db.query<MailAction>(
    `select ${ACTION} from public.mail_actions where user_id = $1 and status = 'pending' order by created_at desc limit 50`, [userId],
  );
  return rows;
}

/**
 * Takes a pending action for execution. Only one caller can win, so a double tap on Approve
 * can never send an email twice. Returns null when it was already handled or is not this user's.
 */
export async function claimAction(db: DbClient, userId: string, actionId: string): Promise<MailAction | null> {
  const { rows } = await db.query<MailAction>(
    `update public.mail_actions set status = 'processing' where id = $1 and user_id = $2 and status = 'pending' returning ${ACTION}`,
    [actionId, userId],
  );
  return rows[0] ?? null;
}

export async function finishAction(db: DbClient, userId: string, actionId: string, status: "done" | "failed" | "rejected", error?: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `update public.mail_actions set status = $3, error = $4, resolved_at = now()
     where id = $1 and user_id = $2 and status in ('pending', 'processing')`,
    [actionId, userId, status, error?.slice(0, 300) ?? null],
  );
  return (rowCount ?? 0) > 0;
}

export async function addNotification(db: DbClient, userId: string, title: string, body: string): Promise<void> {
  await db.query("insert into public.mail_notifications (user_id, title, body) values ($1, $2, $3)", [userId, title.slice(0, 120), body.slice(0, 500)]);
}

export async function listNotifications(db: DbClient, userId: string, limit = 10): Promise<MailNotification[]> {
  const { rows } = await db.query<MailNotification>(
    `select id, title, body, created_at as "createdAt" from public.mail_notifications where user_id = $1 order by created_at desc limit $2`, [userId, limit],
  );
  return rows;
}

/** Notifications not yet shown on a device, marked as shown. Called by the service worker after a push. */
export async function takeUndelivered(db: DbClient, userId: string): Promise<MailNotification[]> {
  const { rows } = await db.query<MailNotification>(
    `update public.mail_notifications set delivered_at = now()
     where id in (select id from public.mail_notifications where user_id = $1 and delivered_at is null order by created_at desc limit 3)
     returning id, title, body, created_at as "createdAt"`,
    [userId],
  );
  return rows;
}

export async function savePushSubscription(db: DbClient, userId: string, endpoint: string): Promise<void> {
  await db.query(
    `insert into public.push_subscriptions (user_id, endpoint) values ($1, $2)
     on conflict (endpoint) do update set user_id = excluded.user_id`,
    [userId, endpoint],
  );
}

export async function deletePushSubscription(db: DbClient, endpoint: string, userId?: string): Promise<void> {
  await db.query("delete from public.push_subscriptions where endpoint = $1 and ($2::uuid is null or user_id = $2::uuid)", [endpoint, userId ?? null]);
}

export async function listPushEndpoints(db: DbClient, userId: string): Promise<string[]> {
  const { rows } = await db.query<{ endpoint: string }>("select endpoint from public.push_subscriptions where user_id = $1 order by created_at desc limit 10", [userId]);
  return rows.map((row) => row.endpoint);
}
