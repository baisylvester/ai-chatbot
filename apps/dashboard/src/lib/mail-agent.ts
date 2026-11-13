import "server-only";
import { createChatModel, isProviderConfigured } from "@chatbot/ai-providers";
import { DomainError } from "@chatbot/core";
import { withTrustedContext, type DbClient } from "@chatbot/database";
import {
  addNotification, buildDigest, decryptSecret, deletePushSubscription, dueConnections, getConnection, GmailClient,
  listPushEndpoints, MailAuthError, markRevoked, refreshAccessToken, sendPush, touchChecked,
  type GoogleOAuthConfig, type MailConnection, type VapidKeys,
} from "@chatbot/mail-agent";
import { providerSchema, type Provider } from "@chatbot/shared";
import { getPool } from "@/lib/db";
import { log } from "@/lib/log";

/** Google's alias for its current Flash model. Override with MAIL_AGENT_MODEL (and MAIL_AGENT_PROVIDER). */
export const DEFAULT_AGENT_MODEL = "gemini-flash-latest";

export interface MailSetup {
  oauth: GoogleOAuthConfig | null;
  tokenSecret: string | null;
  provider: Provider;
  model: string;
  modelReady: boolean;
  vapid: VapidKeys | null;
  /** Names (never values) of the variables still needed before a mailbox can be connected and used. */
  missing: string[];
}

export function mailSetup(): MailSetup {
  const env = process.env;
  const platform = (env.NEXT_PUBLIC_PLATFORM_URL ?? "").replace(/\/+$/, "");
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const tokenSecret = env.MAIL_TOKEN_SECRET && env.MAIL_TOKEN_SECRET.length >= 32 ? env.MAIL_TOKEN_SECRET : null;
  const provider = providerSchema.catch("gemini").parse(env.MAIL_AGENT_PROVIDER?.trim() || "gemini");
  const modelReady = isProviderConfigured(provider, env);
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  return {
    oauth: clientId && clientSecret && platform ? { clientId, clientSecret, redirectUri: `${platform}/api/agent/gmail/callback` } : null,
    tokenSecret,
    provider,
    model: env.MAIL_AGENT_MODEL?.trim() || DEFAULT_AGENT_MODEL,
    modelReady,
    vapid: publicKey && privateKey ? { publicKey, privateKey, subject: env.VAPID_SUBJECT?.trim() || platform } : null,
    missing: [
      ...(clientId ? [] : ["GOOGLE_OAUTH_CLIENT_ID"]),
      ...(clientSecret ? [] : ["GOOGLE_OAUTH_CLIENT_SECRET"]),
      ...(tokenSecret ? [] : ["MAIL_TOKEN_SECRET"]),
      ...(modelReady ? [] : [provider === "gemini" ? "GOOGLE_GENERATIVE_AI_API_KEY" : `the ${provider} provider key`]),
    ],
  };
}

export function agentModel(maxOutputTokens: number) {
  const { provider, model } = mailSetup();
  return createChatModel({ provider, model, temperature: 0.2, maxOutputTokens }, process.env);
}

/** Mail tables are closed to the RLS role; every query in the store is filtered by the user's id. */
export const mailDb = <T>(fn: (db: DbClient) => Promise<T>) => withTrustedContext(getPool(), fn);

/**
 * Gmail requests one mailbox session may make. Cloudflare allows 50 outgoing requests per incoming
 * one on the free plan; this leaves room for the model calls and the token refresh. Past the limit
 * the agent is told to answer with what it has, instead of the whole request failing.
 */
const GMAIL_CALLS_PER_REQUEST = 30;

/** Opens the user's mailbox with a fresh access token, or explains why it can't. */
export async function openMailbox(userId: string): Promise<{ connection: MailConnection; gmail: GmailClient }> {
  const { oauth, tokenSecret } = mailSetup();
  if (!oauth || !tokenSecret) throw new DomainError("invalid", "Gmail is not set up on this server yet.");
  const connection = await mailDb((db) => getConnection(db, userId));
  if (!connection) throw new DomainError("not_found", "Connect Gmail first.");
  if (connection.status !== "active") throw new DomainError("forbidden", "Gmail access has expired or was revoked. Connect Gmail again.");
  let refreshToken: string;
  try {
    refreshToken = await decryptSecret(connection.refreshTokenEnc, tokenSecret);
  } catch {
    // MAIL_TOKEN_SECRET changed: the stored token can never be read again.
    await mailDb((db) => markRevoked(db, userId));
    throw new DomainError("forbidden", "Gmail has to be connected again.");
  }
  try {
    return { connection, gmail: new GmailClient(await refreshAccessToken(oauth, refreshToken), fetch, GMAIL_CALLS_PER_REQUEST) };
  } catch (err) {
    if (!(err instanceof MailAuthError)) throw err;
    await mailDb((db) => markRevoked(db, userId));
    throw new DomainError("forbidden", err.message);
  }
}

/** Mailboxes checked per maintenance run. Keeps one run well inside the platform's outgoing-request limit. */
const CHECKS_PER_RUN = 3;

/**
 * Looks for unread inbox mail that arrived since the last check, writes one notification about it and
 * wakes the user's devices. Runs from the maintenance cron (every 10 minutes).
 */
export async function runMailChecks(): Promise<{ mailboxesChecked: number; notificationsSent: number }> {
  const setup = mailSetup();
  const result = { mailboxesChecked: 0, notificationsSent: 0 };
  if (!setup.oauth || !setup.tokenSecret) return result;
  const model = setup.modelReady ? agentModel(1024) : null;
  for (const connection of await mailDb((db) => dueConnections(db, CHECKS_PER_RUN))) {
    const startedAt = new Date();
    try {
      const { gmail } = await openMailbox(connection.userId);
      const since = Math.floor((connection.lastCheckedAt ?? new Date(startedAt.getTime() - 10 * 60_000)).getTime() / 1000);
      const mails = await gmail.search(`in:inbox is:unread after:${since}`, 5);
      await mailDb((db) => touchChecked(db, connection.id, startedAt));
      result.mailboxesChecked++;
      if (!mails.length) continue;
      const digest = await buildDigest(model, mails);
      const endpoints = await mailDb(async (db) => {
        await addNotification(db, connection.userId, digest.title, digest.body);
        return listPushEndpoints(db, connection.userId);
      });
      result.notificationsSent++;
      if (!setup.vapid) continue;
      for (const endpoint of endpoints) {
        if ((await sendPush(endpoint, setup.vapid)) === "gone") await mailDb((db) => deletePushSubscription(db, endpoint));
      }
    } catch (err) {
      // A revoked mailbox is already marked and skipped next time; others retry on the next run.
      log.warn("mail_check.failed", { error: err });
    }
  }
  return result;
}
