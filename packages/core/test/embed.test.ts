import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createPool, withTrustedContext, withUserContext } from "@chatbot/database";
import { migrate } from "@chatbot/database/src/migrate.ts";
import {
  addDomain,
  authorizeWidgetMessage,
  createApiKey,
  createChatbot,
  createOrganization,
  createWebsite,
  createWidgetSession,
  createWorkspace,
  generateApiKey,
  listApiKeys,
  removeDomain,
  resolveApiKey,
  resolveForApiKey,
  resolveForOrigin,
  revokeApiKey,
  setChatbotStatus,
  signEmbedToken,
  upsertUser,
  verifyEmbedToken,
  type Chatbot,
} from "../src/index.ts";

const secret = "x".repeat(40);
const payload = {
  sid: "00000000-0000-4000-8000-000000000001",
  cid: "00000000-0000-4000-8000-000000000002",
  org: "00000000-0000-4000-8000-000000000003",
  origin: "https://shop.example.com",
  exp: Math.floor(Date.now() / 1000) + 60,
};

describe("embed tokens", () => {
  it("round-trips a signed token", () => {
    expect(verifyEmbedToken(signEmbedToken(payload, secret), secret)).toEqual(payload);
  });

  it("rejects tampering, wrong secrets, expiry and junk", () => {
    const token = signEmbedToken(payload, secret);
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...payload, origin: "https://evil.example" })).toString("base64url");
    expect(verifyEmbedToken(`${forged}.${sig}`, secret)).toBeNull();
    expect(verifyEmbedToken(token, "y".repeat(40))).toBeNull();
    expect(verifyEmbedToken(token, secret, (payload.exp + 1) * 1000)).toBeNull();
    expect(verifyEmbedToken(`${body}.${sig}.extra`, secret)).toBeNull();
    expect(verifyEmbedToken("not-a-token", secret)).toBeNull();
  });

  it("refuses to sign or verify with a weak secret", () => {
    expect(() => signEmbedToken(payload, "short")).toThrow(/EMBED_TOKEN_SECRET/);
    expect(() => verifyEmbedToken("a.b", undefined)).toThrow(/EMBED_TOKEN_SECRET/);
  });

  it("generates API keys that are never stored in plaintext", () => {
    const k = generateApiKey();
    expect(k.plaintext).toMatch(/^cbk_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    expect(k.plaintext.startsWith(k.prefix)).toBe(true);
    expect(k.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(k.hash).not.toContain(k.plaintext);
  });
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("embedding and API access", () => {
  let pool: pg.Pool;
  const owner = { id: crypto.randomUUID(), email: `em-${Date.now()}@test.invalid`, name: "Owner" };
  const orgIds: string[] = [];
  let bot: Chatbot;
  let siteId = "";
  let otherOrgId = "";
  const trusted = <T>(fn: (db: pg.PoolClient) => Promise<T>) => withTrustedContext(pool, fn);
  const as = <T>(fn: (db: pg.PoolClient) => Promise<T>) => withUserContext(pool, owner.id, fn);

  beforeAll(async () => {
    await migrate(url!, () => undefined);
    pool = createPool(url!, 2);
    await trusted((db) => upsertUser(db, owner));
    const org = await trusted((db) => createOrganization(db, owner.id, { name: "Embed", slug: `embed-${Date.now()}` }));
    const other = await trusted((db) => createOrganization(db, owner.id, { name: "Other", slug: `embed-o-${Date.now()}` }));
    orgIds.push(org.id, other.id);
    otherOrgId = other.id;
    bot = await as(async (db) => {
      const ws = await createWorkspace(db, { organizationId: org.id, name: "W", slug: "ws" });
      const site = await createWebsite(db, { workspaceId: ws.id, name: "Shop", domains: ["shop.example.com", "localhost"] });
      siteId = site.id;
      return createChatbot(db, { websiteId: site.id, settings: { name: "Helper", model: "m" } });
    });
  });

  afterAll(async () => {
    if (!pool) return;
    await trusted(async (db) => {
      await db.query("delete from organizations where id = any($1)", [orgIds]);
      await db.query("delete from users where id = $1", [owner.id]);
    });
    await pool.end();
  });

  it("serves only active chatbots, and only to allowed origins", async () => {
    await expect(trusted((db) => resolveForOrigin(db, bot.public_id, "https://shop.example.com"))).rejects.toMatchObject({ code: "unavailable" });
    await as((db) => setChatbotStatus(db, bot.id, "active"));

    await expect(trusted((db) => resolveForOrigin(db, bot.public_id, "https://shop.example.com"))).resolves.toMatchObject({ id: bot.id });
    await expect(trusted((db) => resolveForOrigin(db, bot.public_id, "https://www.shop.example.com"))).resolves.toBeTruthy();
    await expect(trusted((db) => resolveForOrigin(db, bot.public_id, "http://localhost:4020"))).resolves.toBeTruthy();
    await expect(trusted((db) => resolveForOrigin(db, bot.public_id, "http://shop.example.com"))).rejects.toMatchObject({ code: "origin_not_allowed" });
    await expect(trusted((db) => resolveForOrigin(db, bot.public_id, "https://evil.example"))).rejects.toMatchObject({ code: "origin_not_allowed" });
    await expect(trusted((db) => resolveForOrigin(db, bot.public_id, null))).rejects.toMatchObject({ code: "origin_not_allowed" });
    await expect(trusted((db) => resolveForOrigin(db, "cb_doesnotexist000000000", "https://shop.example.com"))).rejects.toMatchObject({ code: "unavailable" });
    // The platform's own origin (iframe page) is accepted when passed as trusted.
    await expect(trusted((db) => resolveForOrigin(db, bot.public_id, "http://localhost:3100", ["http://localhost:3100"]))).resolves.toBeTruthy();
  });

  it("issues widget sessions and authorizes messages only from the same origin", async () => {
    const origin = "https://shop.example.com";
    const resolved = await trusted((db) => resolveForOrigin(db, bot.public_id, origin));
    const { token, sessionId } = await trusted((db) => createWidgetSession(db, resolved, origin, secret));

    await expect(trusted((db) => authorizeWidgetMessage(db, token, origin, secret))).resolves.toMatchObject({ sessionId });
    await expect(trusted((db) => authorizeWidgetMessage(db, token, "https://evil.example", secret))).rejects.toMatchObject({ code: "origin_not_allowed" });
    await expect(trusted((db) => authorizeWidgetMessage(db, `${token}x`, origin, secret))).rejects.toMatchObject({ code: "invalid_token" });

    // Pausing the chatbot or removing the domain takes effect on the next message.
    await as((db) => setChatbotStatus(db, bot.id, "paused"));
    await expect(trusted((db) => authorizeWidgetMessage(db, token, origin, secret))).rejects.toMatchObject({ code: "unavailable" });
    await as((db) => setChatbotStatus(db, bot.id, "active"));

    await as((db) => addDomain(db, siteId, "temp.example.org"));
    const tempOrigin = "https://temp.example.org";
    const temp = await trusted((db) => createWidgetSession(db, resolved, tempOrigin, secret));
    await expect(trusted((db) => authorizeWidgetMessage(db, temp.token, tempOrigin, secret))).resolves.toBeTruthy();
    const domainId = await trusted(async (db) =>
      (await db.query("select id from website_domains where website_id = $1 and domain = 'temp.example.org'", [siteId])).rows[0].id,
    );
    await as((db) => removeDomain(db, siteId, domainId));
    await expect(trusted((db) => authorizeWidgetMessage(db, temp.token, tempOrigin, secret))).rejects.toMatchObject({ code: "origin_not_allowed" });

    // Expired sessions are refused even with a valid signature.
    await trusted((db) => db.query("update chat_sessions set expires_at = now() - interval '1 minute' where id = $1", [sessionId]));
    await expect(trusted((db) => authorizeWidgetMessage(db, token, origin, secret))).rejects.toMatchObject({ code: "session_expired" });
  });

  it("creates, resolves and revokes private API keys scoped to one organization", async () => {
    const created = await withUserContext(pool, owner.id, (userDb) =>
      trusted((trustedDb) => createApiKey(userDb, trustedDb, { organizationId: bot.organization_id, name: "Backend", createdBy: owner.id })),
    );
    const stored = await trusted(async (db) => (await db.query("select key_hash from api_keys where id = $1", [created.id])).rows[0].key_hash);
    expect(stored).not.toBe(created.plaintext);

    const resolved = await trusted((db) => resolveApiKey(db, created.plaintext));
    expect(resolved).toEqual({ keyId: created.id, organizationId: bot.organization_id });
    await expect(trusted((db) => resolveForApiKey(db, bot.public_id, bot.organization_id))).resolves.toMatchObject({ id: bot.id });
    await expect(trusted((db) => resolveForApiKey(db, bot.public_id, otherOrgId))).rejects.toMatchObject({ code: "unavailable" });

    const listed = await as((db) => listApiKeys(db, bot.organization_id));
    expect(listed[0]).toMatchObject({ id: created.id, name: "Backend", key_prefix: created.prefix });
    expect(JSON.stringify(listed)).not.toContain(created.plaintext);
    await expect(as((db) => db.query("select key_hash from api_keys"))).rejects.toThrow(/permission denied/);

    await as((db) => revokeApiKey(db, created.id));
    expect(await trusted((db) => resolveApiKey(db, created.plaintext))).toBeNull();
    expect(await trusted((db) => resolveApiKey(db, "cbk_notakey"))).toBeNull();
  });
});
