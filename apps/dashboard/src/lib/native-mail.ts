import "server-only";
/**
 * Native (Android/iOS) mailbox management over the signed-in client API. Every function here runs for a
 * user already verified by `withClientRequest` from their Supabase access token; nothing trusts cookies.
 *
 * Safety rules preserved from the web Assistant page:
 *  - only organization owners/admins of the chatbot may connect a mailbox for the email manager;
 *  - each user only ever sees and changes their own mailbox and their own approval requests;
 *  - sending and trashing happen only here, on an explicit approval bound to the content reviewed
 *    (`version`), through the same atomic `pending → processing` claim the web uses.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DomainError, getOrganization, type Chatbot } from "@chatbot/core";
import { withUserContext } from "@chatbot/database";
import {
  claimAction, claimDueSends, cleanupNativeTransactions, consumeNativeCallback, countPendingActions, createNativeTransaction, decryptSecret, deleteConnection,
  encryptSecret, exchangeCode, findNativeTransactionByState, finishAction, finishNativeTransaction, getAction, getConnection, GmailClient,
  GmailHttpError, googleAuthUrl, listActions, lockNativeTransaction, MailAuthError, markUncertain, recordNativeCallback, rejectPendingAction,
  MAX_SCHEDULE_DAYS, MIN_SCHEDULE_SECONDS, revokeToken, saveConnection, scheduleAction, unscheduleAction, type DraftDetail, type MailSummary, type NativeMailAction, type SendPayload, type TrashPayload,
} from "@chatbot/mail-agent";
import { clientError } from "@/lib/client-api";
import { getPool } from "@/lib/db";
import { log } from "@/lib/log";
import { mailDb, mailSetup, openMailbox } from "@/lib/mail-agent";

export const DEFAULT_NATIVE_RETURN_URI = "chatbotmail://oauth/gmail";

const sha256hex = (value: string) => createHash("sha256").update(value).digest("hex");
const sha256b64url = (value: string) => createHash("sha256").update(value).digest("base64url");
const randomToken = () => randomBytes(32).toString("base64url");
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// ------------------------------------------------------------------ status and eligibility

export type MailRole = "owner" | "admin" | "member" | null;

/** The caller's role in the chatbot's organization. A non-member is `null`, never an error. */
export async function mailRole(userId: string, bot: Chatbot): Promise<MailRole> {
  try {
    const org = await withUserContext(getPool(), userId, (db) => getOrganization(db, bot.organization_id));
    return org.role === "owner" || org.role === "admin" ? org.role : "member";
  } catch (err) {
    if (err instanceof DomainError && err.code === "not_found") return null;
    throw err;
  }
}

export interface MailStatus {
  provider: "gmail";
  serverReady: boolean;
  eligible: boolean;
  role: MailRole;
  connection: { email: string; status: "active" | "revoked" } | null;
  pendingApprovals: number;
}

export async function mailStatus(userId: string, bot: Chatbot): Promise<MailStatus> {
  const setup = mailSetup();
  const role = await mailRole(userId, bot);
  const { connection, pending } = await mailDb(async (db) => ({
    connection: await getConnection(db, userId),
    pending: await countPendingActions(db, userId),
  }));
  return {
    provider: "gmail",
    serverReady: !!setup.oauth && !!setup.tokenSecret && setup.modelReady,
    eligible: role === "owner" || role === "admin",
    role,
    connection: connection ? { email: connection.email, status: connection.status } : null,
    pendingApprovals: pending,
  };
}

// ------------------------------------------------------------------ connect

export const VERIFIER_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export async function startNativeConnect(userId: string, bot: Chatbot, verifierChallenge: string): Promise<Response> {
  const role = await mailRole(userId, bot);
  if (role !== "owner" && role !== "admin") {
    return clientError(403, "forbidden", "Only owners and admins of this chatbot's organization can connect a mailbox.", "mail_role_required");
  }
  const { oauth, tokenSecret } = mailSetup();
  if (!oauth || !tokenSecret) return clientError(503, "unavailable", "Gmail is not set up on this server yet.", "mail_not_configured");
  const state = randomToken();
  const pkceVerifier = randomToken();
  const tx = await mailDb(async (db) => {
    await cleanupNativeTransactions(db);
    return createNativeTransaction(db, userId, { chatbotPublicId: bot.public_id, stateHash: sha256hex(state), verifierChallenge, pkceVerifier });
  });
  return Response.json({
    transactionId: tx.id,
    authorizationUrl: googleAuthUrl(oauth, state, sha256b64url(pkceVerifier)),
    expiresAt: new Date(tx.expiresAt).toISOString(),
  });
}

/** Where Google's callback sends the browser back to the app. Only a custom scheme or https is accepted. */
export function nativeReturnUri(env: Record<string, string | undefined> = process.env): string {
  const configured = env.MAIL_NATIVE_RETURN_URI?.trim();
  if (!configured) return DEFAULT_NATIVE_RETURN_URI;
  try {
    const url = new URL(configured);
    const custom = /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !["http:", "https:", "javascript:", "data:", "file:", "blob:", "intent:", "content:"].includes(url.protocol);
    if ((url.protocol === "https:" || custom) && !url.search && !url.hash && !url.username && !url.password) return configured;
  } catch { /* fall through */ }
  log.warn("mail.native_return_uri_invalid", {});
  return DEFAULT_NATIVE_RETURN_URI;
}

function nativeRedirect(params: Record<string, string>): Response {
  const target = new URL(nativeReturnUri());
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return new Response(null, { status: 302, headers: { Location: target.toString(), "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
}

/**
 * Google's callback for a state that belongs to a native transaction. Returns null when the state is
 * not a native one, so the caller continues with the browser (cookie) flow unchanged.
 * The redirect carries only the transaction id and a one-time completion code, never a Google token.
 */
export async function handleNativeCallback(params: URLSearchParams): Promise<Response | null> {
  const state = params.get("state");
  if (!state || state.length > 200) return null;
  const stateHash = sha256hex(state);
  const known = await mailDb((db) => findNativeTransactionByState(db, stateHash));
  if (!known) return null;
  const tx = await mailDb((db) => consumeNativeCallback(db, stateHash));
  if (!tx) return nativeRedirect({ tx: known.id, error: "expired" });
  const fail = async (error: "denied" | "permission" | "failed") => {
    await mailDb((db) => recordNativeCallback(db, tx.id, { error }));
    return nativeRedirect({ tx: tx.id, error });
  };
  const code = params.get("code");
  if (params.get("error") || !code) return fail("denied");
  const { oauth, tokenSecret } = mailSetup();
  if (!oauth || !tokenSecret) return fail("failed");
  try {
    const tokens = await exchangeCode(oauth, code, fetch, tx.pkceVerifier);
    const { email } = await new GmailClient(tokens.accessToken).profile();
    const sealedRefreshToken = await encryptSecret(tokens.refreshToken, tokenSecret);
    const completion = randomToken();
    await mailDb((db) => recordNativeCallback(db, tx.id, { completionHash: sha256hex(completion), sealedRefreshToken, email }));
    return nativeRedirect({ tx: tx.id, code: completion });
  } catch (err) {
    log.warn("mail.native_connect_failed", { error: err });
    return fail(err instanceof MailAuthError ? "permission" : "failed");
  }
}

type CompleteOutcome =
  | { ok: true; chatbotPublicId: string }
  | { ok: false; status: number; code: string; message: string; reason: string };

/** Saves the connection only for the transaction's own user presenting both the completion code and the verifier. */
export async function completeNativeConnect(userId: string, input: { transactionId: string; code: string; verifier: string }, now = new Date()): Promise<CompleteOutcome> {
  const fail = (status: number, code: string, message: string, reason: string): CompleteOutcome => ({ ok: false, status, code, message, reason });
  return mailDb(async (db) => {
    const tx = await lockNativeTransaction(db, userId, input.transactionId);
    if (!tx) return fail(404, "not_found", "This connection attempt was not found. Start again.", "transaction_not_found");
    if (tx.completedAt) return fail(409, "conflict", "This connection attempt was already completed.", "already_completed");
    if (new Date(tx.expiresAt).getTime() <= now.getTime()) return fail(410, "expired", "This connection attempt expired. Start again.", "transaction_expired");
    if (tx.error) return fail(400, "invalid", tx.error === "denied" ? "Google access was not granted." : tx.error === "permission" ? "Gmail permission was not granted. Tick the Gmail box on Google's consent screen." : "Google could not connect this mailbox. Try again.", `oauth_${tx.error}`);
    if (!tx.callbackAt || !tx.completionHash || !tx.sealedRefreshToken || !tx.email) return fail(409, "conflict", "Finish signing in with Google first.", "callback_pending");
    if (!safeEqual(sha256hex(input.code), tx.completionHash) || !safeEqual(sha256b64url(input.verifier), tx.verifierChallenge)) {
      return fail(400, "invalid", "This connection could not be verified. Start again from the app.", "verification_failed");
    }
    await saveConnection(db, userId, tx.email, tx.sealedRefreshToken);
    await finishNativeTransaction(db, tx.id);
    log.info("mail.connected", { userId, via: "native" });
    return { ok: true, chatbotPublicId: tx.chatbotPublicId };
  });
}

// ------------------------------------------------------------------ disconnect

export async function disconnectMailbox(userId: string): Promise<void> {
  const { tokenSecret } = mailSetup();
  const connection = await mailDb((db) => getConnection(db, userId));
  if (connection && tokenSecret) {
    const token = await decryptSecret(connection.refreshTokenEnc, tokenSecret).catch(() => null);
    if (token) await revokeToken(token);
  }
  await mailDb((db) => deleteConnection(db, userId));
  log.info("mail.disconnected", { userId, via: "native" });
}

// ------------------------------------------------------------------ approval requests

export interface ActionItem {
  id: string; kind: "send" | "trash"; summary: string; status: string; error: string | null;
  createdAt: string; resolvedAt: string | null; to: string | null; subject: string | null; messageCount: number | null;
  /** When an approved send is due; null unless `status` is `scheduled`. */
  scheduledFor: string | null;
}

const iso = (value: Date | string | null) => (value === null ? null : new Date(value).toISOString());

export function toActionItem(action: NativeMailAction): ActionItem {
  const send = action.kind === "send" ? (action.payload as SendPayload) : null;
  const trash = action.kind === "trash" ? (action.payload as TrashPayload) : null;
  return {
    id: action.id, kind: action.kind, summary: action.summary, status: action.status, error: action.error,
    createdAt: iso(action.createdAt)!, resolvedAt: iso(action.resolvedAt ?? null),
    to: send?.to ?? null, subject: send?.subject ?? null, messageCount: trash ? trash.ids.length : null,
    scheduledFor: action.status === "scheduled" ? iso(action.scheduledFor ?? null) : null,
  };
}

export async function listActionItems(userId: string, filter: "pending" | "recent"): Promise<ActionItem[]> {
  return (await mailDb((db) => listActions(db, userId, filter))).map(toActionItem);
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

/** The reviewed content's fingerprint. Any edit to the draft (new Gmail message id) or target set changes it. */
export function sendVersion(draft: DraftDetail): string {
  return sha256hex(canonical({
    kind: "send", draftId: draft.draftId, messageId: draft.messageId, to: draft.to, cc: draft.cc, bcc: draft.bcc,
    subject: draft.subject, body: draft.body, attachments: draft.attachments,
  }));
}
export function trashVersion(ids: string[]): string {
  return sha256hex(canonical({ kind: "trash", ids: [...ids].sort() }));
}

interface Mailbox { connection: { email: string }; gmail: Pick<GmailClient, "getDraft" | "summaries" | "sendDraft" | "trash"> }

/** Opens the mailbox, tagging failures with a machine-readable reason. */
async function mailbox(userId: string): Promise<Mailbox> {
  try {
    return await openMailbox(userId);
  } catch (err) {
    if (err instanceof DomainError) {
      const reason = err.code === "not_found" ? "mailbox_not_connected" : err.code === "forbidden" ? "mailbox_revoked" : "mail_not_configured";
      throw new DomainError(err.code === "invalid" ? "conflict" : err.code, err.message, reason);
    }
    throw err;
  }
}

const actionNotFound = () => new DomainError("not_found", "This request was not found.", "action_not_found");

export async function actionDetail(userId: string, actionId: string) {
  const action = await mailDb((db) => getAction(db, userId, actionId));
  if (!action) throw actionNotFound();
  const { connection, gmail } = await mailbox(userId);
  if (action.kind === "send") {
    const payload = action.payload as SendPayload;
    const draft = await gmail.getDraft(payload.draftId);
    return {
      action: toActionItem(action), account: connection.email, version: draft ? sendVersion(draft) : null,
      send: draft
        ? { draftId: draft.draftId, to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, body: draft.body, attachments: draft.attachments, draftExists: true }
        : { draftId: payload.draftId, to: payload.to.split(",").map((s) => s.trim()).filter(Boolean), cc: [], bcc: [], subject: payload.subject, body: payload.preview, attachments: [], draftExists: false },
      trash: null,
    };
  }
  const ids = (action.payload as TrashPayload).ids;
  const found = await gmail.summaries(ids);
  return {
    action: toActionItem(action), account: connection.email, version: trashVersion(ids), send: null,
    trash: { messages: found.messages.map((m: MailSummary) => ({ id: m.id, from: m.from, subject: m.subject, date: m.date, snippet: m.snippet })), missing: found.missing },
  };
}

/** A Gmail failure is definite (nothing happened) only on a 4xx answer or an auth/limit error raised before the request. */
export function classifyGmailFailure(err: unknown): "failed" | "uncertain" {
  if (err instanceof MailAuthError) return "failed";
  if (err instanceof GmailHttpError) return err.status >= 500 ? "uncertain" : "failed";
  if (err instanceof Error && err.message.startsWith("This request has used all the mailbox lookups")) return "failed";
  if (err instanceof Error && err.message === "Invalid message id") return "failed";
  return "uncertain";
}

/** Checks a requested send time: at least a minute ahead and at most MAX_SCHEDULE_DAYS away. */
export function validSendAt(sendAt: Date, now = new Date()): boolean {
  const ms = sendAt.getTime() - now.getTime();
  return Number.isFinite(ms) && ms >= MIN_SCHEDULE_SECONDS * 1000 && ms <= MAX_SCHEDULE_DAYS * 86_400_000;
}

export async function approveAction(userId: string, actionId: string, version: string, sendAt?: Date) {
  const existing = await mailDb((db) => getAction(db, userId, actionId));
  if (!existing) throw actionNotFound();
  if (existing.status !== "pending") throw new DomainError("conflict", "This request was already handled.", "already_handled");
  if (sendAt && existing.kind !== "send") throw new DomainError("invalid", "Only emails can be scheduled.", "schedule_invalid");
  if (sendAt && !validSendAt(sendAt)) throw new DomainError("invalid", `Choose a time between one minute and ${MAX_SCHEDULE_DAYS} days from now.`, "schedule_invalid");
  const { gmail } = await mailbox(userId);
  let current: string | null;
  if (existing.kind === "send") {
    const draft = await gmail.getDraft((existing.payload as SendPayload).draftId);
    if (!draft) throw new DomainError("conflict", "This draft no longer exists in Gmail. It may have been sent or deleted there.", "draft_missing");
    current = sendVersion(draft);
  } else current = trashVersion((existing.payload as TrashPayload).ids);
  if (!safeEqual(current, version)) {
    throw new DomainError("conflict", "This request changed since you reviewed it. Review it again before approving.", "stale_approval");
  }
  if (sendAt) {
    // The approval is stored with the reviewed version; the cron sends only that exact draft.
    const approved = current;
    const scheduled = await mailDb((db) => scheduleAction(db, userId, actionId, sendAt, approved));
    if (!scheduled) throw new DomainError("conflict", "This request was already handled.", "already_handled");
    log.info("agent.action_scheduled", { userId, via: "native" });
    return { action: toActionItem((await mailDb((db) => getAction(db, userId, actionId)))!) };
  }
  const action = await mailDb((db) => claimAction(db, userId, actionId));
  if (!action) throw new DomainError("conflict", "This request was already handled.", "already_handled");
  let done = 0;
  try {
    if (action.kind === "send") await gmail.sendDraft((action.payload as SendPayload).draftId);
    else for (const id of (action.payload as TrashPayload).ids) { await gmail.trash([id]); done++; }
    await mailDb((db) => finishAction(db, userId, actionId, "done"));
    log.info("agent.action_done", { userId, kind: action.kind, via: "native" });
  } catch (err) {
    const outcome = classifyGmailFailure(err);
    const total = action.kind === "trash" ? (action.payload as TrashPayload).ids.length : 0;
    const partial = action.kind === "trash" && done > 0 ? ` ${done} of ${total} messages were moved to Trash first.` : "";
    if (outcome === "uncertain") {
      const message = action.kind === "send"
        ? "Gmail did not confirm sending. The email may have been sent: check the Sent folder before trying again."
        : `Gmail did not confirm moving the messages to Trash.${partial}`;
      await mailDb((db) => markUncertain(db, userId, actionId, message));
    } else {
      const message = err instanceof MailAuthError ? err.message
        : action.kind === "send" ? "Gmail could not send this draft. It may have been changed or deleted in Gmail."
        : `Gmail could not move those messages to Trash.${partial}`;
      await mailDb((db) => finishAction(db, userId, actionId, "failed", message));
    }
    log.warn("agent.action_failed", { userId, kind: action.kind, outcome, via: "native" });
  }
  const final = await mailDb((db) => getAction(db, userId, actionId));
  return { action: toActionItem(final!) };
}

/** Returns a scheduled send to waiting for approval. The draft is untouched. */
export async function unscheduleSend(userId: string, actionId: string) {
  const result = await mailDb(async (db) => {
    const ok = await unscheduleAction(db, userId, actionId);
    return { ok, action: await getAction(db, userId, actionId) };
  });
  if (!result.action) throw actionNotFound();
  if (!result.ok) throw new DomainError("conflict", "This email is no longer scheduled. It may already have been sent.", "already_handled");
  return { action: toActionItem(result.action) };
}

/** Scheduled sends one maintenance run handles. Each costs a token refresh and two Gmail calls. */
const SENDS_PER_RUN = 5;

/**
 * Sends approved drafts whose time has come (maintenance cron, every 10 minutes). A draft edited in
 * Gmail after approval no longer matches the approved version and is not sent.
 */
export async function runScheduledSends(): Promise<{ scheduledSent: number; scheduledFailed: number }> {
  const result = { scheduledSent: 0, scheduledFailed: 0 };
  const { oauth, tokenSecret } = mailSetup();
  if (!oauth || !tokenSecret) return result;
  for (const due of await mailDb((db) => claimDueSends(db, SENDS_PER_RUN))) {
    const fail = async (message: string) => {
      result.scheduledFailed++;
      await mailDb((db) => finishAction(db, due.userId, due.id, "failed", message));
    };
    let gmail: Mailbox["gmail"];
    try {
      gmail = (await openMailbox(due.userId)).gmail;
    } catch (err) {
      await fail(err instanceof DomainError ? `Not sent at the scheduled time: ${err.message}` : "Not sent at the scheduled time: the mailbox could not be opened.");
      continue;
    }
    try {
      const draft = await gmail.getDraft((due.payload as SendPayload).draftId);
      if (!draft) { await fail("Not sent: the draft no longer exists in Gmail. It may have been sent or deleted there."); continue; }
      if (!safeEqual(sendVersion(draft), due.approvedVersion)) { await fail("Not sent: the draft was changed after you approved it. Review it again."); continue; }
      await gmail.sendDraft(draft.draftId);
      await mailDb((db) => finishAction(db, due.userId, due.id, "done"));
      result.scheduledSent++;
      log.info("agent.action_done", { userId: due.userId, kind: "send", via: "schedule" });
    } catch (err) {
      if (classifyGmailFailure(err) === "uncertain") {
        result.scheduledFailed++;
        await mailDb((db) => markUncertain(db, due.userId, due.id, "Gmail did not confirm sending at the scheduled time. The email may have been sent: check the Sent folder."));
      } else await fail(err instanceof MailAuthError ? err.message : "Gmail could not send this draft at the scheduled time.");
      log.warn("agent.action_failed", { userId: due.userId, kind: "send", via: "schedule" });
    }
  }
  return result;
}

export async function rejectAction(userId: string, actionId: string) {
  const rejected = await mailDb(async (db) => {
    const ok = await rejectPendingAction(db, userId, actionId);
    return { ok, action: await getAction(db, userId, actionId) };
  });
  if (!rejected.action) throw actionNotFound();
  if (!rejected.ok) throw new DomainError("conflict", "This request was already handled.", "already_handled");
  return { action: toActionItem(rejected.action) };
}
