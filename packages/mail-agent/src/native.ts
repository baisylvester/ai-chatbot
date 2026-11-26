/**
 * Storage for native (Android/iOS) mailbox management: single-use OAuth connection transactions and
 * the approval-request queries the native API needs. Trusted context only; every query is scoped by
 * the signed-in user's id, except the callback lookup, which is keyed by the unguessable state hash
 * and never reveals or changes another user's connection.
 */
import type { DbClient } from "@chatbot/database";
import type { MailAction } from "./store.ts";

export const NATIVE_TRANSACTION_TTL_SECONDS = 600;

export interface NativeTransaction {
  id: string;
  userId: string;
  chatbotPublicId: string;
  pkceVerifier: string;
  verifierChallenge: string;
  completionHash: string | null;
  sealedRefreshToken: string | null;
  email: string | null;
  error: string | null;
  expiresAt: Date;
  callbackAt: Date | null;
  completedAt: Date | null;
  provider: "gmail" | "outlook" | "gcal";
}

const TX = `id, user_id as "userId", chatbot_public_id as "chatbotPublicId", pkce_verifier as "pkceVerifier", verifier_challenge as "verifierChallenge",
  completion_hash as "completionHash", sealed_refresh_token as "sealedRefreshToken", email, error,
  expires_at as "expiresAt", callback_at as "callbackAt", completed_at as "completedAt", provider`;
const ACTION = `id, kind, summary, payload, status, error, created_at as "createdAt", resolved_at as "resolvedAt", scheduled_for as "scheduledFor", connection_id as "connectionId"`;

export interface NativeMailAction extends MailAction { resolvedAt: Date | null; scheduledFor?: Date | null }

/** Earliest and latest scheduled send, relative to the approval. */
export const MIN_SCHEDULE_SECONDS = 60;
export const MAX_SCHEDULE_DAYS = 60;

/**
 * Approves a waiting send for later, bound to the reviewed version. Only a pending send can be
 * scheduled, so a double tap or a second device cannot schedule it twice.
 */
export async function scheduleAction(db: DbClient, userId: string, actionId: string, sendAt: Date, version: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `update public.mail_actions set status = 'scheduled', scheduled_for = $3, approved_version = $4
     where id = $1 and user_id = $2 and status = 'pending' and kind = 'send'`,
    [actionId, userId, sendAt, version],
  );
  return (rowCount ?? 0) > 0;
}

/** Takes a scheduled send back to waiting for approval, before it is due and claimed. */
export async function unscheduleAction(db: DbClient, userId: string, actionId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `update public.mail_actions set status = 'pending', scheduled_for = null, approved_version = null
     where id = $1 and user_id = $2 and status = 'scheduled'`,
    [actionId, userId],
  );
  return (rowCount ?? 0) > 0;
}

export interface DueSend { id: string; userId: string; payload: unknown; approvedVersion: string; connectionId: string | null }

/** Claims due scheduled sends for this run: each one moves to `processing`, so only one runner sends it. */
export async function claimDueSends(db: DbClient, limit: number): Promise<DueSend[]> {
  const { rows } = await db.query<DueSend>(
    `update public.mail_actions set status = 'processing'
     where id in (select id from public.mail_actions where status = 'scheduled' and scheduled_for <= now()
                  order by scheduled_for asc limit $1 for update skip locked)
     returning id, user_id as "userId", payload, approved_version as "approvedVersion", connection_id as "connectionId"`,
    [limit],
  );
  return rows;
}

export async function createNativeTransaction(
  db: DbClient, userId: string,
  input: { chatbotPublicId: string; stateHash: string; verifierChallenge: string; pkceVerifier: string; provider?: "gmail" | "outlook" | "gcal" },
): Promise<{ id: string; expiresAt: Date }> {
  const { rows } = await db.query<{ id: string; expiresAt: Date }>(
    `insert into public.mail_oauth_transactions (user_id, chatbot_public_id, state_hash, verifier_challenge, pkce_verifier, expires_at, provider)
     values ($1, $6, $2, $3, $4, now() + make_interval(secs => $5), $7) returning id, expires_at as "expiresAt"`,
    [userId, input.stateHash, input.verifierChallenge, input.pkceVerifier, NATIVE_TRANSACTION_TTL_SECONDS, input.chatbotPublicId, input.provider ?? "gmail"],
  );
  return rows[0]!;
}

/**
 * Google's callback for a native transaction. Atomically marks the transaction as called back, so a
 * replayed callback URL finds nothing. Returns null when unknown, already used or expired.
 */
export async function consumeNativeCallback(db: DbClient, stateHash: string): Promise<NativeTransaction | null> {
  const { rows } = await db.query<NativeTransaction>(
    `update public.mail_oauth_transactions set callback_at = now()
     where state_hash = $1 and callback_at is null and completed_at is null and expires_at > now() returning ${TX}`,
    [stateHash],
  );
  return rows[0] ?? null;
}

/** Whether a state hash names a native transaction at all (used or not), to tell native callbacks from web ones. */
export async function findNativeTransactionByState(db: DbClient, stateHash: string): Promise<{ id: string } | null> {
  const { rows } = await db.query<{ id: string }>("select id from public.mail_oauth_transactions where state_hash = $1", [stateHash]);
  return rows[0] ?? null;
}

/** After Google's callback: park the encrypted token and the completion code's hash, or the failure. */
export async function recordNativeCallback(
  db: DbClient, id: string, result: { completionHash: string; sealedRefreshToken: string; email: string } | { error: string },
): Promise<void> {
  if ("error" in result) {
    await db.query("update public.mail_oauth_transactions set error = $2 where id = $1", [id, result.error.slice(0, 100)]);
    return;
  }
  await db.query(
    "update public.mail_oauth_transactions set completion_hash = $2, sealed_refresh_token = $3, email = $4 where id = $1",
    [id, result.completionHash, result.sealedRefreshToken, result.email],
  );
}

/** Locks the caller's own transaction for completion. Returns null when it is not theirs or unknown. */
export async function lockNativeTransaction(db: DbClient, userId: string, id: string): Promise<NativeTransaction | null> {
  const { rows } = await db.query<NativeTransaction>(
    `select ${TX} from public.mail_oauth_transactions where id = $1 and user_id = $2 for update`, [id, userId],
  );
  return rows[0] ?? null;
}

/** Marks a locked transaction complete and wipes the parked token: it can never be completed twice. */
export async function finishNativeTransaction(db: DbClient, id: string): Promise<void> {
  await db.query(
    "update public.mail_oauth_transactions set completed_at = now(), sealed_refresh_token = null, pkce_verifier = repeat('x', 43) where id = $1", [id],
  );
}

/** Removes transactions that expired more than an hour ago, with any token parked on them. */
export async function cleanupNativeTransactions(db: DbClient): Promise<number> {
  return (await db.query("delete from public.mail_oauth_transactions where expires_at < now() - interval '1 hour'")).rowCount ?? 0;
}

export async function getAction(db: DbClient, userId: string, actionId: string): Promise<NativeMailAction | null> {
  const { rows } = await db.query<NativeMailAction>(`select ${ACTION} from public.mail_actions where id = $1 and user_id = $2`, [actionId, userId]);
  return rows[0] ?? null;
}

/** `pending`: everything still waiting, including approved sends scheduled for later. `recent`: the newest 50 of the last 7 days, whatever their state. */
export async function listActions(db: DbClient, userId: string, filter: "pending" | "recent"): Promise<NativeMailAction[]> {
  const { rows } = await db.query<NativeMailAction>(
    filter === "pending"
      ? `select ${ACTION} from public.mail_actions where user_id = $1 and status in ('pending', 'scheduled') order by created_at desc limit 50`
      : `select ${ACTION} from public.mail_actions where user_id = $1 and created_at > now() - interval '7 days' order by created_at desc limit 50`,
    [userId],
  );
  return rows;
}

export async function countPendingActions(db: DbClient, userId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>("select count(*)::int as n from public.mail_actions where user_id = $1 and status = 'pending'", [userId]);
  return rows[0]?.n ?? 0;
}

/** Declines a request that is still waiting. Never touches one that is already being executed. */
export async function rejectPendingAction(db: DbClient, userId: string, actionId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "update public.mail_actions set status = 'rejected', resolved_at = now() where id = $1 and user_id = $2 and status in ('pending', 'scheduled')",
    [actionId, userId],
  );
  return (rowCount ?? 0) > 0;
}

/** A claimed request whose Gmail call ended without a definite answer. It is never retried automatically. */
export async function markUncertain(db: DbClient, userId: string, actionId: string, error: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "update public.mail_actions set status = 'uncertain', error = $3, resolved_at = now() where id = $1 and user_id = $2 and status = 'processing'",
    [actionId, userId, error.slice(0, 300)],
  );
  return (rowCount ?? 0) > 0;
}
