import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createPool, withTrustedContext, withUserContext } from "@chatbot/database";
import { migrate } from "@chatbot/database/src/migrate.ts";
import {
  createChatbot,
  createOrganization,
  createWebsite,
  createWidgetSession,
  createWorkspace,
  deleteConversation,
  getAnalytics,
  getConversation,
  getRetention,
  listConversations,
  purgeExpiredData,
  recordWidgetRefusal,
  setRetention,
  upsertUser,
  visitorHash,
  type Chatbot,
} from "../src/index.ts";

const secret = "a".repeat(40);

describe("visitorHash", () => {
  it("is stable per organization, differs across organizations, and rejects junk ids", () => {
    const id = "abcdefghijklmnopqrstuv";
    expect(visitorHash(secret, "org-1", id)).toBe(visitorHash(secret, "org-1", id));
    expect(visitorHash(secret, "org-1", id)).not.toBe(visitorHash(secret, "org-2", id));
    expect(visitorHash(secret, "org-1", id)).not.toContain(id);
    expect(visitorHash(secret, "org-1", "short")).toBeNull();
    expect(visitorHash(secret, "org-1", undefined)).toBeNull();
  });
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("analytics", () => {
  let pool: pg.Pool;
  const owner = { id: crypto.randomUUID(), email: `an-${Date.now()}@test.invalid`, name: "Owner" };
  const viewer = { id: crypto.randomUUID(), email: `av-${Date.now()}@test.invalid`, name: "Viewer" };
  const orgIds: string[] = [];
  let orgId = "";
  let botA: Chatbot, botB: Chatbot, botOther: Chatbot;
  let siteA = "";
  let oldSession = "";
  let recentSession = "";
  const trusted = <T>(fn: (db: pg.PoolClient) => Promise<T>) => withTrustedContext(pool, fn);
  const as = <T>(user: { id: string }, fn: (db: pg.PoolClient) => Promise<T>) => withUserContext(pool, user.id, fn);
  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  async function conversation(bot: Chatbot, opts: { visitor?: string; source?: string; ageDays?: number; citations?: boolean }) {
    return trusted(async (db) => {
      let id: string;
      if (opts.source === "api") {
        id = (await db.query("insert into chat_sessions (organization_id, chatbot_id, source) values ($1, $2, 'api') returning id", [bot.organization_id, bot.id])).rows[0].id;
      } else {
        id = (await createWidgetSession(db, bot, "https://shop.example", secret, Date.now(), opts.visitor)).sessionId;
      }
      const at = `now() - interval '${opts.ageDays ?? 0} days'`;
      await db.query(`update chat_sessions set created_at = ${at} where id = $1`, [id]);
      await db.query(`insert into messages (organization_id, chat_session_id, role, content, created_at) values ($1, $2, 'user', 'Hello there', ${at})`, [bot.organization_id, id]);
      await db.query(
        `insert into messages (organization_id, chat_session_id, role, content, provider, model, citations, created_at) values ($1, $2, 'assistant', 'Hi!', 'openai', 'gpt-4.1-mini', $3, ${at})`,
        [bot.organization_id, id, JSON.stringify(opts.citations ? [{ n: 1, title: "Doc", sourceUrl: null, snippet: "s" }] : [])],
      );
      await db.query(
        `insert into usage_records (organization_id, chatbot_id, chat_session_id, source, provider, model, prompt_tokens, completion_tokens, status, latency_ms, created_at)
         values ($1, $2, $3, $4, 'openai', 'gpt-4.1-mini', 1000, 200, 'ok', 800, ${at})`,
        [bot.organization_id, bot.id, id, opts.source ?? "widget"],
      );
      return id;
    });
  }

  beforeAll(async () => {
    await migrate(url!, () => undefined);
    pool = createPool(url!, 2);
    await trusted(async (db) => {
      await upsertUser(db, owner);
      await upsertUser(db, viewer);
    });
    const org = await trusted((db) => createOrganization(db, owner.id, { name: "Analytics", slug: `an-${Date.now()}` }));
    const other = await trusted((db) => createOrganization(db, owner.id, { name: "Other", slug: `an-o-${Date.now()}` }));
    orgIds.push(org.id, other.id);
    orgId = org.id;
    await trusted((db) => db.query("insert into organization_members values ($1, $2, 'viewer')", [org.id, viewer.id]));
    [botA, botB, botOther] = await as(owner, async (db) => {
      const ws = await createWorkspace(db, { organizationId: org.id, name: "W", slug: "ws" });
      const a = await createWebsite(db, { workspaceId: ws.id, name: "Shop", domains: ["shop.example"] });
      const b = await createWebsite(db, { workspaceId: ws.id, name: "Blog", domains: ["blog.example"] });
      siteA = a.id;
      const ows = await createWorkspace(db, { organizationId: other.id, name: "W", slug: "ws" });
      const o = await createWebsite(db, { workspaceId: ows.id, name: "Other", domains: ["other.example"] });
      return [
        await createChatbot(db, { websiteId: a.id, settings: { name: "Shop bot", model: "m" } }),
        await createChatbot(db, { websiteId: b.id, settings: { name: "Blog bot", model: "m" } }),
        await createChatbot(db, { websiteId: o.id, settings: { name: "Other bot", model: "m" } }),
      ];
    });
    const visitor = "visitor-aaaaaaaaaaaaaaaa";
    recentSession = await conversation(botA, { visitor, citations: true });
    await conversation(botA, { visitor });
    await conversation(botB, { visitor: "visitor-bbbbbbbbbbbbbbbb", source: "widget" });
    await conversation(botB, { source: "api" });
    oldSession = await conversation(botA, { visitor, ageDays: 40 });
    await conversation(botOther, { visitor });
    await trusted(async (db) => {
      await db.query(
        `insert into usage_records (organization_id, chatbot_id, source, provider, model, status, error) values ($1, $2, 'widget', 'anthropic', 'claude-haiku-4-5', 'error', 'down')`,
        [orgId, botA.id],
      );
      await db.query(
        `insert into usage_records (organization_id, chatbot_id, source, kind, provider, model, audio_seconds) values ($1, $2, 'widget', 'realtime', 'openai', 'gpt-realtime', 90), ($1, $2, 'widget', 'stt', 'openai', 'x', 30)`,
        [orgId, botA.id],
      );
      await recordWidgetRefusal(db, botA.public_id, "https://evil.example", "origin_not_allowed");
      await recordWidgetRefusal(db, "cb_doesnotexist000000000", "https://evil.example", "origin_not_allowed");
    });
  }, 90_000);

  afterAll(async () => {
    if (!pool) return;
    await trusted(async (db) => {
      await db.query("delete from organizations where id = any($1)", [orgIds]);
      await db.query("delete from users where id = any($1)", [[owner.id, viewer.id]]);
    });
    await pool.end();
  });

  it("totals the organization's activity in range, excluding other organizations and older data", async () => {
    const r = await as(viewer, (db) => getAnalytics(db, { organizationId: orgId, from: daysAgo(29), to: today }));
    expect(r.totals).toMatchObject({
      conversations: 4,
      messages: 8,
      visitorMessages: 4,
      uniqueVisitors: 2,
      inputTokens: 4000,
      outputTokens: 800,
      modelRequests: 5,
      failedRequests: 1,
      answersWithSources: 1,
      assistantAnswers: 4,
      widgetRefusals: 1,
      costCoverage: "all",
    });
    expect(r.totals.voiceCallMinutes).toBeCloseTo(1.5);
    expect(r.totals.transcribedMinutes).toBeCloseTo(0.5);
    // 4 × (1000 in + 200 out) on gpt-4.1-mini = 4 × (0.0004 + 0.00032)
    expect(r.totals.estimatedCostUsd).toBeCloseTo(0.00288, 6);
    expect(r.daily).toHaveLength(30);
    expect(r.daily.at(-1)).toEqual({ date: today, conversations: 4, messages: 8 });
    expect(r.bySource).toEqual(expect.arrayContaining([{ source: "widget", conversations: 3 }, { source: "api", conversations: 1 }]));
    expect(r.byChatbot.map((b) => [b.name, b.conversations])).toEqual([["Blog bot", 2], ["Shop bot", 2]]); // ties sorted by name
    expect(r.refusals).toEqual([{ type: "widget_origin_refused", origin: "https://evil.example", count: 1 }]);
    const failing = r.byProvider.find((p) => p.provider === "anthropic");
    expect(failing).toMatchObject({ requests: 1, failed: 1 });
  });

  it("filters by website, chatbot and provider", async () => {
    const site = await as(owner, (db) => getAnalytics(db, { organizationId: orgId, from: daysAgo(29), to: today, websiteId: siteA }));
    expect(site.totals.conversations).toBe(2);
    expect(site.byWebsite.map((w) => w.name)).toEqual(["Shop"]);
    const bot = await as(owner, (db) => getAnalytics(db, { organizationId: orgId, from: daysAgo(29), to: today, chatbotId: botB.id }));
    expect(bot.totals.conversations).toBe(2);
    const provider = await as(owner, (db) => getAnalytics(db, { organizationId: orgId, from: daysAgo(29), to: today, provider: "anthropic" }));
    expect(provider.totals).toMatchObject({ modelRequests: 1, failedRequests: 1, inputTokens: 0, conversations: 4 });
    const wide = await as(owner, (db) => getAnalytics(db, { organizationId: orgId, from: daysAgo(60), to: today }));
    expect(wide.totals.conversations).toBe(5);
    await expect(as(owner, (db) => getAnalytics(db, { organizationId: orgId, from: today, to: daysAgo(5) }))).rejects.toMatchObject({ code: "invalid" });
  });

  it("shows nothing to non-members", async () => {
    const outsider = { id: crypto.randomUUID(), email: `ao-${Date.now()}@test.invalid`, name: "Out" };
    await trusted((db) => upsertUser(db, outsider));
    const r = await as(outsider, (db) => getAnalytics(db, { organizationId: orgId, from: daysAgo(29), to: today }));
    expect(r.totals.conversations).toBe(0);
    expect(r.byChatbot).toEqual([]);
    await trusted((db) => db.query("delete from users where id = $1", [outsider.id]));
  });

  it("lists and opens conversations with filters", async () => {
    const all = await as(viewer, (db) => listConversations(db, { organizationId: orgId }));
    expect(all.items).toHaveLength(5);
    expect(all.items[0]!.preview).toBe("Hello there");
    const api = await as(viewer, (db) => listConversations(db, { organizationId: orgId, source: "api" }));
    expect(api.items).toHaveLength(1);
    const detail = await as(viewer, (db) => getConversation(db, recentSession));
    expect(detail.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(detail.messages[1]!.citations[0]).toMatchObject({ title: "Doc" });
  });

  it("lets admins (not viewers) delete conversations", async () => {
    const victim = await conversation(botB, {});
    await expect(as(viewer, (userDb) => trusted((t) => deleteConversation(userDb, t, victim, viewer.id)))).rejects.toMatchObject({ code: "forbidden" });
    await as(owner, (userDb) => trusted((t) => deleteConversation(userDb, t, victim, owner.id)));
    await expect(as(owner, (db) => getConversation(db, victim))).rejects.toMatchObject({ code: "not_found" });
  });

  it("purges conversations older than the retention period only", async () => {
    await expect(as(viewer, (db) => setRetention(db, orgId, 30))).rejects.toMatchObject({ code: "forbidden" });
    await expect(as(owner, (db) => setRetention(db, orgId, 3))).rejects.toMatchObject({ code: "invalid" });
    await as(owner, (db) => setRetention(db, orgId, 30));
    expect(await as(owner, (db) => getRetention(db, orgId))).toBe(30);
    const result = await trusted((db) => purgeExpiredData(db, orgId));
    expect(result.conversations).toBe(1);
    await expect(as(owner, (db) => getConversation(db, oldSession))).rejects.toMatchObject({ code: "not_found" });
    await expect(as(owner, (db) => getConversation(db, recentSession))).resolves.toBeTruthy();
    // Usage counts survive the purge.
    const usage = await trusted(async (db) => (await db.query("select count(*)::int n from usage_records where organization_id = $1 and kind = 'chat'", [orgId])).rows[0].n);
    expect(usage).toBeGreaterThanOrEqual(6);
  });
});
