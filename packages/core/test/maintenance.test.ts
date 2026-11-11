import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createPool, withTrustedContext, withUserContext } from "@chatbot/database";
import { migrate } from "@chatbot/database/src/migrate.ts";
import { mockEmbedder } from "@chatbot/rag-engine";
import {
  addDocument,
  createChatbot,
  createKnowledgeSource,
  createOrganization,
  createWebsite,
  createWidgetSession,
  createWorkspace,
  enqueueIngestion,
  getDocument,
  recoverStuckJobs,
  runMaintenance,
  upsertUser,
  type Chatbot,
} from "../src/index.ts";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("production infrastructure", () => {
  let pool: pg.Pool;
  const owner = { id: crypto.randomUUID(), email: `mt-${Date.now()}@test.invalid`, name: "Owner" };
  let orgId = "";
  let bot: Chatbot;
  const trusted = <T>(fn: (db: pg.PoolClient) => Promise<T>) => withTrustedContext(pool, fn);
  const as = <T>(fn: (db: pg.PoolClient) => Promise<T>) => withUserContext(pool, owner.id, fn);
  const hit = (key: string, limit: number, secs: number) =>
    trusted(async (db) => (await db.query<{ allowed: boolean; retry_after: number }>("select * from rate_limit_hit($1, $2, $3)", [key, limit, secs])).rows[0]!);

  beforeAll(async () => {
    await migrate(url!, () => undefined);
    pool = createPool(url!, 3);
    await trusted((db) => upsertUser(db, owner));
    const org = await trusted((db) => createOrganization(db, owner.id, { name: "Maint", slug: `mt-${Date.now()}` }));
    orgId = org.id;
    bot = await as(async (db) => {
      const ws = await createWorkspace(db, { organizationId: org.id, name: "W", slug: "ws" });
      const site = await createWebsite(db, { workspaceId: ws.id, name: "S", domains: ["mt.example"] });
      return createChatbot(db, { websiteId: site.id, settings: { name: "B", model: "m" } });
    });
  }, 60_000);

  afterAll(async () => {
    if (!pool) return;
    await trusted(async (db) => {
      await db.query("delete from organizations where id = $1", [orgId]);
      await db.query("delete from users where id = $1", [owner.id]);
    });
    await pool.end();
  });

  it("rate limits atomically across callers and resets after the window", async () => {
    const key = `test:${crypto.randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 5 }, () => hit(key, 3, 60)));
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    const blocked = results.find((r) => !r.allowed)!;
    expect(blocked.retry_after).toBeGreaterThan(0);
    expect(blocked.retry_after).toBeLessThanOrEqual(60);

    const short = `test:${crypto.randomUUID()}`;
    expect((await hit(short, 1, 1)).allowed).toBe(true);
    expect((await hit(short, 1, 1)).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 1200));
    expect((await hit(short, 1, 1)).allowed).toBe(true);
  });

  it("is not callable by the application role", async () => {
    await expect(as((db) => db.query("select * from rate_limit_hit('x', 1, 1)"))).rejects.toThrow(/permission denied/);
    await expect(as((db) => db.query("select * from rate_limits"))).rejects.toThrow(/permission denied/);
  });

  it("requeues stuck jobs, gives up after 3 attempts, and processes waiting jobs", async () => {
    const source = await as((db) => createKnowledgeSource(db, { chatbotId: bot.id, name: "Docs" }));
    const stuckDoc = await as((db) => addDocument(db, { sourceId: source.id, kind: "text", title: "Stuck", content: "Crashed mid-way through processing." }));
    const deadDoc = await as((db) => addDocument(db, { sourceId: source.id, kind: "text", title: "Dead", content: "Failed three times already." }));
    const waitingDoc = await as((db) => addDocument(db, { sourceId: source.id, kind: "text", title: "Waiting", content: "Never picked up after upload." }));
    await trusted(async (db) => {
      const stuck = await enqueueIngestion(db, stuckDoc);
      const dead = await enqueueIngestion(db, deadDoc);
      await enqueueIngestion(db, waitingDoc);
      await db.query("update ingestion_jobs set status = 'running', attempts = 1, started_at = now() - interval '20 minutes' where id = $1", [stuck]);
      await db.query("update ingestion_jobs set status = 'running', attempts = 3, started_at = now() - interval '20 minutes' where id = $1", [dead]);
      await db.query("update ingestion_jobs set created_at = now() - interval '10 minutes' where document_id = $1", [waitingDoc.id]);
      await db.query("update knowledge_documents set status = 'processing' where id = any($1)", [[stuckDoc.id, deadDoc.id]]);
    });

    expect(await trusted((db) => recoverStuckJobs(db))).toEqual({ requeued: 1, abandoned: 1 });
    expect((await as((db) => getDocument(db, deadDoc.id))).status).toBe("failed");
    expect((await as((db) => getDocument(db, stuckDoc.id))).status).toBe("pending");

    // The requeued job was created just now, so only the long-waiting one is processed this round.
    const result = await runMaintenance(trusted, { embedder: mockEmbedder(), queuedOlderThanSeconds: 120 });
    expect(result.processedJobs).toEqual({ succeeded: 1, failed: 0, skipped: 0 });
    expect((await as((db) => getDocument(db, waitingDoc.id))).status).toBe("ready");

    const second = await runMaintenance(trusted, { embedder: mockEmbedder(), queuedOlderThanSeconds: 0 });
    expect(second.processedJobs.succeeded).toBe(1);
    expect((await as((db) => getDocument(db, stuckDoc.id))).status).toBe("ready");
  }, 60_000);

  it("closes abandoned voice calls and prunes old rate-limit rows", async () => {
    const { sessionId } = await trusted((db) => createWidgetSession(db, bot, "https://mt.example", "z".repeat(40)));
    await trusted(async (db) => {
      await db.query(
        `insert into voice_sessions (organization_id, chatbot_id, chat_session_id, mode, provider, model, started_at)
         values ($1, $2, $3, 'realtime', 'openai', 'gpt-realtime', now() - interval '5 hours')`,
        [orgId, bot.id, sessionId],
      );
      await db.query("insert into rate_limits (key, window_start, count) values ($1, now() - interval '2 days', 5)", [`old:${crypto.randomUUID()}`]);
    });
    const result = await runMaintenance(trusted, { embedder: null });
    expect(result.closedVoiceSessions).toBeGreaterThanOrEqual(1);
    expect(result.prunedRateLimits).toBeGreaterThanOrEqual(1);
    const open = await trusted(async (db) => (await db.query("select count(*)::int n from voice_sessions where organization_id = $1 and status = 'active'", [orgId])).rows[0].n);
    expect(open).toBe(0);
    // The abandoned call is billed, capped at an hour.
    const billed = await trusted(async (db) => (await db.query("select audio_seconds::int s, error from usage_records where chat_session_id = $1 and kind = 'realtime'", [sessionId])).rows);
    expect(billed).toEqual([{ s: 3600, error: "call end not reported; duration estimated" }]);
  });
});
