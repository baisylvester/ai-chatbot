/**
 * Public embedding and API access.
 *
 * Security model:
 *  - A public chatbot id (cb_…) only identifies a chatbot. It grants nothing on its own.
 *  - Browser widgets: the request Origin must match one of the website's allowed domains (re-checked
 *    on every request, so removing a domain takes effect immediately) and the chatbot must be active.
 *    A session token (HMAC-signed, short-lived) binds the session, chatbot and origin together.
 *    Origin checks stop other websites' browsers from using the chatbot; they cannot stop non-browser
 *    clients, which are limited by rate limits instead.
 *  - Server-to-server: private API keys (cbk_…), stored only as SHA-256 hashes, scoped to one organization.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { DbClient } from "@chatbot/database";
import { isOriginAllowed, publicChatbotIdSchema, type ChatbotSettings } from "@chatbot/shared";
import { z } from "zod";
import { DomainError, mapDbError, notFound } from "./errors.ts";
import { getOrganization, normalizeChatbot, type Chatbot } from "./services.ts";

export class EmbedError extends Error {
  readonly code: "unavailable" | "origin_not_allowed" | "invalid_token" | "session_expired" | "unauthorized";
  readonly status: number;
  constructor(code: EmbedError["code"], message: string, status: number) {
    super(message);
    this.name = "EmbedError";
    this.code = code;
    this.status = status;
  }
}

// ------------------------------------------------------------------ session tokens

export const SESSION_TTL_SECONDS = 2 * 60 * 60;

export interface EmbedTokenPayload {
  /** chat_sessions.id */
  sid: string;
  /** chatbots.id (internal uuid) */
  cid: string;
  /** organization id */
  org: string;
  /** Origin the session was created for */
  origin: string;
  /** Expiry, seconds since epoch */
  exp: number;
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

function hmac(secret: string, data: string) {
  return createHmac("sha256", secret).update(data).digest();
}

function assertSecret(secret: string | undefined): string {
  if (!secret || secret.length < 32) throw new Error("EMBED_TOKEN_SECRET must be set to at least 32 characters");
  return secret;
}

export function signEmbedToken(payload: EmbedTokenPayload, secret: string | undefined): string {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${b64url(hmac(assertSecret(secret), body))}`;
}

const payloadSchema = z.object({
  sid: z.uuid(),
  cid: z.uuid(),
  org: z.uuid(),
  origin: z.string().max(300),
  exp: z.number().int(),
});

/** Returns the payload if the signature is valid and not expired, otherwise null. */
export function verifyEmbedToken(token: string, secret: string | undefined, now = Date.now()): EmbedTokenPayload | null {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const expected = hmac(assertSecret(secret), body);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const r = payloadSchema.safeParse(parsed);
  if (!r.success || r.data.exp * 1000 <= now) return null;
  return r.data;
}

// ------------------------------------------------------------------ public chatbot resolution (trusted)

export interface PublicChatbotConfig {
  chatbotId: string;
  name: string;
  welcomeMessage: string;
  suggestedQuestions: string[];
  theme: ChatbotSettings["theme"];
  position: ChatbotSettings["position"];
  /** Only what the widget needs: which voice UI to show. Providers and models stay private. */
  voice: { mode: ChatbotSettings["voice"]["mode"]; autoSpeak: boolean };
}

export function toPublicConfig(bot: Chatbot): PublicChatbotConfig {
  const s = bot.settings;
  return {
    chatbotId: bot.public_id,
    name: s.name,
    welcomeMessage: s.welcomeMessage,
    suggestedQuestions: s.suggestedQuestions,
    theme: s.theme,
    position: s.position,
    voice: { mode: s.voice.mode, autoSpeak: s.voice.autoSpeak },
  };
}

export async function loadBot(db: DbClient, where: string, value: string): Promise<(Chatbot & { domains: string[] }) | null> {
  const row = (
    (
      await db.query<Chatbot & { domains: string[] }>(
        `select c.id, c.organization_id, c.workspace_id, c.website_id, c.public_id, c.status, s.settings,
           coalesce((select array_agg(d.domain) from website_domains d where d.website_id = c.website_id), '{}') as domains
         from chatbots c join chatbot_settings s on s.chatbot_id = c.id
         where ${where}`,
        [value],
      )
    ).rows[0] ?? null
  );
  return row ? normalizeChatbot(row) : null;
}

/**
 * Resolves a chatbot for a browser request: it must exist, be active, and the Origin must be allowed.
 * `trustedOrigins` are extra origins allowed for every chatbot (the platform itself, for the iframe page).
 * Unknown and inactive chatbots get the same error, so ids can't be probed.
 */
export async function resolveForOrigin(
  db: DbClient,
  publicId: string,
  origin: string | null,
  trustedOrigins: string[] = [],
): Promise<Chatbot & { domains: string[] }> {
  if (!publicChatbotIdSchema.safeParse(publicId).success) throw new EmbedError("unavailable", "This chatbot is not available", 404);
  const bot = await loadBot(db, "c.public_id = $1", publicId);
  if (!bot || bot.status !== "active") throw new EmbedError("unavailable", "This chatbot is not available", 404);
  if (!origin || !(trustedOrigins.includes(origin) || isOriginAllowed(origin, bot.domains))) {
    throw new EmbedError("origin_not_allowed", "This website is not allowed to use this chatbot", 403);
  }
  return bot;
}

/** Creates a widget session and its signed token. Trusted context. */
export async function createWidgetSession(
  db: DbClient,
  bot: Chatbot,
  origin: string,
  secret: string | undefined,
  now = Date.now(),
): Promise<{ token: string; sessionId: string; expiresAt: string }> {
  const exp = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  const row = (
    await db.query<{ id: string }>(
      `insert into chat_sessions (organization_id, chatbot_id, source, origin, expires_at)
       values ($1, $2, 'widget', $3, to_timestamp($4)) returning id`,
      [bot.organization_id, bot.id, origin.slice(0, 300), exp],
    )
  ).rows[0]!;
  const token = signEmbedToken({ sid: row.id, cid: bot.id, org: bot.organization_id, origin, exp }, secret);
  return { token, sessionId: row.id, expiresAt: new Date(exp * 1000).toISOString() };
}

/**
 * Validates a widget message request: token signature/expiry, matching Origin, chatbot still active,
 * origin still allowed, and the session still present. Trusted context.
 */
export async function authorizeWidgetMessage(
  db: DbClient,
  token: string,
  origin: string | null,
  secret: string | undefined,
  trustedOrigins: string[] = [],
): Promise<{ bot: Chatbot; sessionId: string }> {
  const payload = verifyEmbedToken(token, secret);
  if (!payload) throw new EmbedError("invalid_token", "Your chat session has expired. Please reload the chat.", 401);
  if (!origin || origin !== payload.origin) throw new EmbedError("origin_not_allowed", "This website is not allowed to use this chatbot", 403);
  const bot = await loadBot(db, "c.id = $1", payload.cid);
  if (!bot || bot.status !== "active" || bot.organization_id !== payload.org) {
    throw new EmbedError("unavailable", "This chatbot is not available", 404);
  }
  if (!(trustedOrigins.includes(origin) || isOriginAllowed(origin, bot.domains))) {
    throw new EmbedError("origin_not_allowed", "This website is not allowed to use this chatbot", 403);
  }
  const session = (
    await db.query("select 1 from chat_sessions where id = $1 and chatbot_id = $2 and source = 'widget' and expires_at > now()", [
      payload.sid,
      bot.id,
    ])
  ).rowCount;
  if (!session) throw new EmbedError("session_expired", "Your chat session has expired. Please reload the chat.", 401);
  return { bot, sessionId: payload.sid };
}

// ------------------------------------------------------------------ private API keys

export interface ApiKeySummary {
  id: string;
  name: string;
  key_prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const hashKey = (plaintext: string) => createHash("sha256").update(plaintext).digest("hex");

export function generateApiKey(): { plaintext: string; prefix: string; hash: string } {
  const prefix = randomBytes(6).toString("base64url").replace(/[-_]/g, "x").slice(0, 8);
  const secret = randomBytes(32).toString("base64url");
  const plaintext = `cbk_${prefix}_${secret}`;
  return { plaintext, prefix: `cbk_${prefix}`, hash: hashKey(plaintext) };
}

export async function listApiKeys(db: DbClient, orgId: string): Promise<ApiKeySummary[]> {
  return (
    await db.query<ApiKeySummary>(
      `select id, name, key_prefix, created_at, last_used_at, revoked_at from api_keys
       where organization_id = $1 order by revoked_at nulls first, created_at desc`,
      [orgId],
    )
  ).rows;
}

/**
 * Creates a private API key. The caller passes the user's RLS client to prove they are an owner/admin
 * and a trusted client for the insert (there is no RLS insert policy, so clients can't mint keys).
 * The plaintext is returned once and never stored.
 */
export async function createApiKey(
  userDb: DbClient,
  trustedDb: DbClient,
  input: { organizationId: string; name: string; createdBy: string },
): Promise<{ id: string; plaintext: string; prefix: string }> {
  const org = await getOrganization(userDb, input.organizationId);
  if (org.role !== "owner" && org.role !== "admin") throw new DomainError("forbidden", "Only owners and admins can create API keys");
  const name = input.name.trim();
  if (!name || name.length > 100) throw new DomainError("invalid", "Enter a name of up to 100 characters");
  const key = generateApiKey();
  try {
    const row = (
      await trustedDb.query<{ id: string }>(
        `insert into api_keys (organization_id, name, scope, key_prefix, key_hash, created_by)
         values ($1, $2, 'private', $3, $4, $5) returning id`,
        [org.id, name, key.prefix, key.hash, input.createdBy],
      )
    ).rows[0]!;
    await trustedDb.query(
      "insert into audit_logs (organization_id, actor_id, action, target_type, target_id) values ($1, $2, 'api_key.create', 'api_key', $3)",
      [org.id, input.createdBy, row.id],
    );
    return { id: row.id, plaintext: key.plaintext, prefix: key.prefix };
  } catch (err) {
    mapDbError(err);
  }
}

export async function revokeApiKey(db: DbClient, keyId: string): Promise<void> {
  const id = z.uuid().safeParse(keyId);
  if (!id.success) throw notFound("API key");
  const key = (await db.query<{ organization_id: string }>("select organization_id from api_keys where id = $1", [id.data])).rows[0];
  if (!key) throw notFound("API key");
  const r = await db.query("update api_keys set revoked_at = now() where id = $1 and revoked_at is null", [id.data]);
  if (r.rowCount === 0) throw new DomainError("forbidden", "You don't have permission to do that");
  await db.query("select public.write_audit($1, 'api_key.revoke', 'api_key', $2)", [key.organization_id, id.data]);
}

/** Resolves a bearer API key to its organization (trusted). Returns null for unknown or revoked keys. */
export async function resolveApiKey(db: DbClient, plaintext: string): Promise<{ keyId: string; organizationId: string } | null> {
  if (!/^cbk_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{40,}$/.test(plaintext)) return null;
  const row = (
    await db.query<{ id: string; organization_id: string }>(
      "update api_keys set last_used_at = now() where key_hash = $1 and revoked_at is null returning id, organization_id",
      [hashKey(plaintext)],
    )
  ).rows[0];
  return row ? { keyId: row.id, organizationId: row.organization_id } : null;
}

/** Resolves a chatbot for an API request: it must belong to the key's organization and be active. */
export async function resolveForApiKey(db: DbClient, publicId: string, organizationId: string): Promise<Chatbot> {
  if (!publicChatbotIdSchema.safeParse(publicId).success) throw new EmbedError("unavailable", "Chatbot not found", 404);
  const bot = await loadBot(db, "c.public_id = $1", publicId);
  if (!bot || bot.organization_id !== organizationId || bot.status !== "active") {
    throw new EmbedError("unavailable", "Chatbot not found or not active", 404);
  }
  return bot;
}
