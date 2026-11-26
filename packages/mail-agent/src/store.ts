/**
 * Mail agent storage. These tables belong to one user each and hold an encrypted mailbox token, so the
 * RLS-restricted role has no access to them at all. Call these from a trusted context only, and always
 * with the signed-in user's id: every query here is scoped by `user_id`.
 */
import type { DbClient } from "@chatbot/database";
import type { ActionKind, SendPayload, TrashPayload } from "./agent.ts";

export type MailProvider = "gmail" | "outlook" | "imap";
/** Non-secret IMAP/SMTP settings; the password itself is encrypted in `refreshTokenEnc`. */
export interface ImapSettings { imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; username: string }
export interface MailConnection {
  id: string; userId: string; provider: MailProvider; email: string; refreshTokenEnc: string; status: "active" | "revoked";
  notify: boolean; lastCheckedAt: Date | null; selectedAt: Date; settings: ImapSettings | null;
}
export interface MailAction { id: string; kind: ActionKind; summary: string; payload: SendPayload | TrashPayload; status: string; error: string | null; createdAt: Date; connectionId?: string | null }
export interface MailNotification { id: string; title: string; body: string; createdAt: Date }

const CONNECTION = `id, user_id as "userId", provider, email, refresh_token_enc as "refreshTokenEnc", status, notify,
  last_checked_at as "lastCheckedAt", selected_at as "selectedAt", settings`;
const ACTION = `id, kind, summary, payload, status, error, created_at as "createdAt", connection_id as "connectionId"`;

/**
 * One of the user's mailboxes: [connectionId] when given (null if it is not theirs), otherwise the
 * selected mailbox (the one selected most recently).
 */
export async function getConnection(db: DbClient, userId: string, connectionId?: string | null): Promise<MailConnection | null> {
  const { rows } = connectionId
    ? await db.query<MailConnection>(`select ${CONNECTION} from public.mail_connections where user_id = $1 and id = $2`, [userId, connectionId])
    : await db.query<MailConnection>(`select ${CONNECTION} from public.mail_connections where user_id = $1 order by selected_at desc, id limit 1`, [userId]);
  return rows[0] ?? null;
}

/** Every mailbox of the user, the selected one first. */
export async function listConnections(db: DbClient, userId: string): Promise<MailConnection[]> {
  const { rows } = await db.query<MailConnection>(`select ${CONNECTION} from public.mail_connections where user_id = $1 order by selected_at desc, id limit 20`, [userId]);
  return rows;
}

/** Most mailboxes one user can connect. */
export const MAX_MAILBOXES = 10;

/**
 * Adds a mailbox, or refreshes the credentials of the same address with the same provider. The saved
 * mailbox becomes the selected one. Returns its id, or null when the user already has MAX_MAILBOXES.
 */
export async function saveConnection(
  db: DbClient, userId: string, email: string, refreshTokenEnc: string, provider: MailProvider = "gmail", settings: ImapSettings | null = null,
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.mail_connections (user_id, provider, email, refresh_token_enc, settings, last_checked_at, selected_at)
     select $1, $4, $2, $3, $5, now(), now()
     where (select count(*) from public.mail_connections where user_id = $1) < ${MAX_MAILBOXES}
        or exists (select 1 from public.mail_connections where user_id = $1 and provider = $4 and lower(email) = lower($2))
     on conflict (user_id, provider, lower(email)) do update set email = excluded.email, refresh_token_enc = excluded.refresh_token_enc,
       settings = excluded.settings, status = 'active', last_checked_at = now(), selected_at = now(), updated_at = now()
     returning id`,
    [userId, email, refreshTokenEnc, provider, settings ? JSON.stringify(settings) : null],
  );
  return rows[0]?.id ?? null;
}

/** Makes one of the user's mailboxes the selected one. False when it is not theirs. */
export async function selectConnection(db: DbClient, userId: string, connectionId: string): Promise<boolean> {
  const { rowCount } = await db.query("update public.mail_connections set selected_at = now() where user_id = $1 and id = $2", [userId, connectionId]);
  return (rowCount ?? 0) > 0;
}

/**
 * Removes one mailbox (or, without [connectionId], every mailbox) with the requests queued for it and
 * its pins. When no mailbox is left, notifications and push subscriptions go too.
 */
export async function deleteConnection(db: DbClient, userId: string, connectionId?: string): Promise<void> {
  const targets = connectionId ? [connectionId] : (await listConnections(db, userId)).map((c) => c.id);
  for (const id of targets) {
    const { rows } = await db.query<{ email: string }>("delete from public.mail_connections where user_id = $1 and id = $2 returning email", [userId, id]);
    const email = rows[0]?.email;
    // Pins are kept per address; drop them unless another provider still serves the same address.
    if (email) await db.query(
      `delete from public.mail_pins where user_id = $1 and mailbox = lower($2)
       and not exists (select 1 from public.mail_connections where user_id = $1 and lower(email) = lower($2))`, [userId, email]);
  }
  const { rows } = await db.query("select 1 from public.mail_connections where user_id = $1 limit 1", [userId]);
  if (!rows.length) {
    await db.query("delete from public.mail_actions where user_id = $1", [userId]);
    await db.query("delete from public.mail_notifications where user_id = $1", [userId]);
    await db.query("delete from public.push_subscriptions where user_id = $1", [userId]);
  }
}

export async function markRevoked(db: DbClient, userId: string, connectionId?: string): Promise<void> {
  if (connectionId) await db.query("update public.mail_connections set status = 'revoked', updated_at = now() where user_id = $1 and id = $2", [userId, connectionId]);
  else await db.query("update public.mail_connections set status = 'revoked', updated_at = now() where user_id = $1", [userId]);
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

export async function createAction(db: DbClient, userId: string, kind: ActionKind, summary: string, payload: SendPayload | TrashPayload, connectionId?: string): Promise<void> {
  await db.query("insert into public.mail_actions (user_id, kind, summary, payload, connection_id) values ($1, $2, $3, $4, $5)",
    [userId, kind, summary.slice(0, 500), JSON.stringify(payload), connectionId ?? null]);
}

export async function listPendingActions(db: DbClient, userId: string): Promise<MailAction[]> {
  const { rows } = await db.query<MailAction>(
    `select ${ACTION} from public.mail_actions where user_id = $1 and status = 'pending' order by created_at desc limit 50`, [userId],
  );
  return rows;
}

/** The newest send and trash requests of the last day, whatever happened to them. */
export async function listRecentActions(db: DbClient, userId: string, limit = 8): Promise<MailAction[]> {
  const { rows } = await db.query<MailAction>(
    `select ${ACTION} from public.mail_actions
     where user_id = $1 and created_at > now() - interval '24 hours' order by created_at desc limit $2`, [userId, limit],
  );
  return rows;
}

/** What became of a send or trash request, in words a model can pass on to the user. */
export function describeActionState(action: Pick<MailAction, "kind" | "status">): string {
  const send = action.kind === "send";
  switch (action.status) {
    case "pending": return "waiting for the user's approval";
    case "scheduled": return "approved by the user to be sent later at a scheduled time: not sent yet";
    case "processing": return "approved by the user, in progress";
    case "done": return send ? "approved by the user: the email was sent" : "approved by the user: moved to Trash";
    case "rejected": return send ? "declined by the user: not sent, kept as a draft" : "declined by the user: not moved to Trash";
    case "uncertain": return send
      ? "approved by the user, but Gmail did not confirm it: the email may or may not have been sent (check the Sent folder)"
      : "approved by the user, but Gmail did not confirm it: the messages may or may not be in Trash";
    default: return send ? "approved by the user, but sending failed: not sent" : "approved by the user, but it failed: not moved to Trash";
  }
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

/** Most pins kept per mailbox; pinning more drops nothing silently, it is refused. */
export const MAX_PINS = 50;

export async function listPins(db: DbClient, userId: string, mailbox: string): Promise<string[]> {
  const { rows } = await db.query<{ message_id: string }>(
    `select message_id from public.mail_pins where user_id = $1 and mailbox = $2 order by pinned_at desc limit ${MAX_PINS}`, [userId, mailbox.toLowerCase()]);
  return rows.map((row) => row.message_id);
}

/** Returns false when the mailbox already has MAX_PINS pins. Pinning twice is a no-op. */
export async function addPin(db: DbClient, userId: string, mailbox: string, messageId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `insert into public.mail_pins (user_id, mailbox, message_id)
     select $1, $2, $3 where (select count(*) from public.mail_pins where user_id = $1 and mailbox = $2) < ${MAX_PINS}
        or exists (select 1 from public.mail_pins where user_id = $1 and mailbox = $2 and message_id = $3)
     on conflict do nothing`, [userId, mailbox.toLowerCase(), messageId]);
  if (rowCount) return true;
  const { rows } = await db.query(`select 1 from public.mail_pins where user_id = $1 and mailbox = $2 and message_id = $3`, [userId, mailbox.toLowerCase(), messageId]);
  return rows.length > 0;
}

export async function removePins(db: DbClient, userId: string, mailbox: string, messageIds: string[]): Promise<void> {
  if (!messageIds.length) return;
  await db.query(`delete from public.mail_pins where user_id = $1 and mailbox = $2 and message_id = any($3::text[])`, [userId, mailbox.toLowerCase(), messageIds]);
}

export interface CalendarConnection { userId: string; email: string; refreshTokenEnc: string }
export async function getCalendar(db: DbClient, userId: string): Promise<CalendarConnection | null> {
  const { rows } = await db.query<CalendarConnection>(`select user_id as "userId", email, refresh_token_enc as "refreshTokenEnc" from public.calendar_connections where user_id = $1`, [userId]);
  return rows[0] ?? null;
}
export async function saveCalendar(db: DbClient, userId: string, email: string, refreshTokenEnc: string): Promise<void> {
  await db.query(
    `insert into public.calendar_connections (user_id, email, refresh_token_enc) values ($1, $2, $3)
     on conflict (user_id) do update set email = excluded.email, refresh_token_enc = excluded.refresh_token_enc, updated_at = now()`, [userId, email, refreshTokenEnc]);
}
export async function deleteCalendar(db: DbClient, userId: string): Promise<void> {
  await db.query("delete from public.calendar_connections where user_id = $1", [userId]);
}

/** Replaces a mailbox's sealed secret (Microsoft rotates refresh tokens on use). */
export async function updateConnectionSecret(db: DbClient, userId: string, connectionId: string, refreshTokenEnc: string): Promise<void> {
  await db.query("update public.mail_connections set refresh_token_enc = $3, updated_at = now() where user_id = $1 and id = $2", [userId, connectionId, refreshTokenEnc]);
}

/** Most phones one user can register for push. Older tokens are dropped first. */
const MAX_FCM_TOKENS = 10;
export async function saveFcmToken(db: DbClient, userId: string, token: string, platform: "android" | "ios" = "android"): Promise<void> {
  // A token moves to the account now signed in on that phone.
  await db.query(
    `insert into public.fcm_tokens (token, user_id, platform) values ($1, $2, $3)
     on conflict (token) do update set user_id = excluded.user_id, platform = excluded.platform, updated_at = now()`, [token, userId, platform]);
  await db.query(
    `delete from public.fcm_tokens where user_id = $1 and token not in
       (select token from public.fcm_tokens where user_id = $1 order by updated_at desc limit ${MAX_FCM_TOKENS})`, [userId]);
}
export async function deleteFcmToken(db: DbClient, userId: string, token: string): Promise<void> {
  await db.query("delete from public.fcm_tokens where user_id = $1 and token = $2", [userId, token]);
}
export async function dropFcmToken(db: DbClient, token: string): Promise<void> {
  await db.query("delete from public.fcm_tokens where token = $1", [token]);
}
export async function listFcmTokens(db: DbClient, userId: string): Promise<string[]> {
  const { rows } = await db.query<{ token: string }>("select token from public.fcm_tokens where user_id = $1", [userId]);
  return rows.map((row) => row.token);
}
