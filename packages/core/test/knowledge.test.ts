/**
 * Integration tests for knowledge ingestion and retrieval. Runs only when TEST_DATABASE_URL points at a
 * throwaway database (for example a Neon branch). Uses the mock embedder; no provider is called.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import { FakeStreamingChatModel } from "@langchain/core/utils/testing";
import { createPool, withTrustedContext, withUserContext } from "@chatbot/database";
import { migrate } from "@chatbot/database/src/migrate.ts";
import { mockEmbedder, type Embedder } from "@chatbot/rag-engine";
import {
  addDocument,
  createChatbot,
  createKnowledgeSource,
  createOrganization,
  createWebsite,
  createWorkspace,
  enqueueIngestion,
  getDocument,
  keywordQuery,
  listChatbotKnowledge,
  markForReprocessing,
  processIngestionJob,
  retrieveForChatbot,
  runConversationTurn,
  setGlobalSourceAssignment,
  upsertUser,
  type Chatbot,
  type TurnEvent,
} from "../src/index.ts";

const url = process.env.TEST_DATABASE_URL;
const embedder = mockEmbedder();

describe("keywordQuery", () => {
  it("ORs meaningful words and drops stopwords and short words", () => {
    expect(keywordQuery("What is the refund policy for shoes?")).toBe("refund | policy | shoes");
    expect(keywordQuery("a an the of")).toBeNull();
    expect(keywordQuery("Saan ang opisina?")).toBe("opisina");
  });
});

describe.skipIf(!url)("knowledge ingestion and retrieval", () => {
  let pool: pg.Pool;
  const owner = { id: crypto.randomUUID(), email: `kn-${Date.now()}@test.invalid`, name: "Owner" };
  const viewer = { id: crypto.randomUUID(), email: `kv-${Date.now()}@test.invalid`, name: "Viewer" };
  const orgIds: string[] = [];
  let botA: Chatbot, botB: Chatbot, botOther: Chatbot;
  const trusted = <T>(fn: (db: pg.PoolClient) => Promise<T>) => withTrustedContext(pool, fn);
  const as = <T>(user: { id: string }, fn: (db: pg.PoolClient) => Promise<T>) => withUserContext(pool, user.id, fn);

  async function ingest(doc: { id: string; organization_id: string }, deps: { embedder?: Embedder; fetchPage?: (u: string) => Promise<never> | Promise<{ url: string; title: string | null; text: string; contentType: string; bytes: number }> } = {}) {
    const jobId = await trusted((db) => enqueueIngestion(db, doc));
    return processIngestionJob(trusted, jobId, { embedder: deps.embedder ?? embedder, fetchPage: deps.fetchPage as never });
  }

  async function setupOrg(slug: string) {
    const org = await trusted((db) => createOrganization(db, owner.id, { name: slug, slug: `${slug}-${Date.now()}` }));
    orgIds.push(org.id);
    return as(owner, async (db) => {
      const ws = await createWorkspace(db, { organizationId: org.id, name: "W", slug: "ws" });
      const site = await createWebsite(db, { workspaceId: ws.id, name: "S", domains: [`${slug}.example`] });
      return { org, site };
    });
  }

  beforeAll(async () => {
    await migrate(url!, () => undefined);
    pool = createPool(url!, 3);
    await trusted(async (db) => {
      await upsertUser(db, owner);
      await upsertUser(db, viewer);
    });
    const { org, site } = await setupOrg("kn-main");
    await trusted((db) => db.query("insert into organization_members values ($1, $2, 'viewer')", [org.id, viewer.id]));
    [botA, botB] = await as(owner, async (db) => [
      await createChatbot(db, { websiteId: site.id, settings: { name: "A", model: "m" } }),
      await createChatbot(db, { websiteId: site.id, settings: { name: "B", model: "m" } }),
    ]);
    const other = await setupOrg("kn-other");
    botOther = await as(owner, (db) => createChatbot(db, { websiteId: other.site.id, settings: { name: "Other", model: "m" } }));
  });

  afterAll(async () => {
    if (!pool) return;
    await trusted(async (db) => {
      await db.query("delete from organizations where id = any($1)", [orgIds]);
      await db.query("delete from users where id = any($1)", [[owner.id, viewer.id]]);
    });
    await pool.end();
  });

  it("ingests a chatbot document and retrieves it only for that chatbot", async () => {
    const source = await as(owner, (db) => createKnowledgeSource(db, { chatbotId: botA.id, name: "Store FAQ" }));
    expect(source.scope).toBe("chatbot");
    const doc = await as(owner, (db) =>
      addDocument(db, {
        sourceId: source.id,
        kind: "text",
        title: "Opening hours",
        content: "Our Makati store is open Monday to Saturday from 9am to 6pm. We are closed on Sundays and holidays.",
      }),
    );
    expect(doc.status).toBe("pending");
    expect(await ingest(doc)).toBe("succeeded");

    const ready = await as(owner, (db) => getDocument(db, doc.id));
    expect(ready).toMatchObject({ status: "ready", embedding_model: "mock:hash-1536" });
    expect(ready.chunk_count).toBeGreaterThan(0);

    const q = "When is the Makati store open?";
    const queryVector = await embedder.embedQuery(q);
    const forA = await trusted((db) => retrieveForChatbot(db, botA, q, { embedder, queryVector, minSimilarity: 0 }));
    expect(forA[0]?.title).toBe("Opening hours");
    const forB = await trusted((db) => retrieveForChatbot(db, botB, q, { embedder, queryVector, minSimilarity: 0 }));
    expect(forB).toEqual([]);
    const forOtherOrg = await trusted((db) => retrieveForChatbot(db, botOther, q, { embedder, queryVector, minSimilarity: 0 }));
    expect(forOtherOrg).toEqual([]);
  });

  it("exposes global knowledge only after explicit assignment", async () => {
    const global = await as(owner, (db) => createKnowledgeSource(db, { organizationId: botA.organization_id, name: "Company policies" }));
    expect(global.scope).toBe("global");
    const doc = await as(owner, (db) =>
      addDocument(db, { sourceId: global.id, kind: "text", title: "Refunds", content: "Refunds are accepted within 30 days with the original receipt." }),
    );
    await ingest(doc);

    const q = "refund receipt days";
    expect(await trusted((db) => retrieveForChatbot(db, botB, q))).toEqual([]);
    await as(owner, (db) => setGlobalSourceAssignment(db, botB.id, global.id, true));
    expect((await trusted((db) => retrieveForChatbot(db, botB, q))).map((c) => c.title)).toEqual(["Refunds"]);
    expect(await trusted((db) => retrieveForChatbot(db, botA, q))).toEqual([]); // A was not assigned

    const knowledge = await as(owner, (db) => listChatbotKnowledge(db, botB.id));
    expect(knowledge.global.find((s) => s.id === global.id)?.assigned).toBe(true);

    await as(owner, (db) => setGlobalSourceAssignment(db, botB.id, global.id, false));
    expect(await trusted((db) => retrieveForChatbot(db, botB, q))).toEqual([]);
  });

  it("refuses to assign another organization's source or a chatbot-only source", async () => {
    const otherGlobal = await as(owner, (db) => createKnowledgeSource(db, { organizationId: botOther.organization_id, name: "Elsewhere" }));
    await expect(as(owner, (db) => setGlobalSourceAssignment(db, botA.id, otherGlobal.id, true))).rejects.toMatchObject({ code: "not_found" });
    const own = await as(owner, (db) => createKnowledgeSource(db, { chatbotId: botA.id, name: "A only" }));
    await expect(as(owner, (db) => setGlobalSourceAssignment(db, botB.id, own.id, true))).rejects.toMatchObject({ code: "invalid" });
  });

  it("detects duplicate content and lets viewers read but not add", async () => {
    const source = await as(owner, (db) => createKnowledgeSource(db, { chatbotId: botA.id, name: "Dupes" }));
    await as(owner, (db) => addDocument(db, { sourceId: source.id, kind: "text", title: "One", content: "Same text" }));
    await expect(as(owner, (db) => addDocument(db, { sourceId: source.id, kind: "text", title: "Two", content: "Same text" }))).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(as(viewer, (db) => addDocument(db, { sourceId: source.id, kind: "text", title: "V", content: "Viewer text" }))).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(as(viewer, (db) => listChatbotKnowledge(db, botA.id))).resolves.toBeTruthy();
  });

  it("fetches URL documents during ingestion and replaces chunks on reprocess", async () => {
    const source = await as(owner, (db) => createKnowledgeSource(db, { chatbotId: botA.id, name: "Website" }));
    const doc = await as(owner, (db) => addDocument(db, { sourceId: source.id, kind: "url", url: "https://shop.example/shipping" }));
    const fetchPage = async (u: string) => ({ url: u, title: "Shipping", text: "We ship nationwide within 3 to 5 business days.", contentType: "text/html", bytes: 120 });
    expect(await ingest(doc, { fetchPage })).toBe("succeeded");
    const ready = await as(owner, (db) => getDocument(db, doc.id));
    expect(ready).toMatchObject({ title: "Shipping", status: "ready", source_url: "https://shop.example/shipping" });

    await as(owner, (db) => markForReprocessing(db, doc.id));
    expect(await ingest(doc, { fetchPage })).toBe("succeeded");
    const chunks = await trusted(async (db) => (await db.query("select count(*)::int n from document_chunks where document_id = $1", [doc.id])).rows[0].n);
    expect(chunks).toBe(ready.chunk_count);
  });

  it("marks documents failed with a readable reason", async () => {
    const source = await as(owner, (db) => createKnowledgeSource(db, { chatbotId: botA.id, name: "Failing" }));
    const doc = await as(owner, (db) => addDocument(db, { sourceId: source.id, kind: "url", url: "https://down.example/" }));
    const { ExtractionError } = await import("@chatbot/rag-engine");
    const fetchPage = async () => {
      throw new ExtractionError("The page returned HTTP 503");
    };
    expect(await ingest(doc, { fetchPage: fetchPage as never })).toBe("failed");
    expect(await as(owner, (db) => getDocument(db, doc.id))).toMatchObject({ status: "failed", error: "The page returned HTTP 503" });

    const broken: Embedder = { modelId: "x", embedDocuments: async () => { throw new Error("socket hang up"); }, embedQuery: async () => [] };
    const doc2 = await as(owner, (db) => addDocument(db, { sourceId: source.id, kind: "text", title: "T", content: "Some text to embed" }));
    expect(await ingest(doc2, { embedder: broken })).toBe("failed");
    expect((await as(owner, (db) => getDocument(db, doc2.id))).error).toMatch(/Processing failed/);
  });

  it("adds retrieved sources to the prompt and stores citations with the reply", async () => {
    class Recording extends FakeStreamingChatModel {
      seen: BaseMessage[] = [];
      override async *_streamResponseChunks(messages: BaseMessage[]): AsyncGenerator<ChatGenerationChunk> {
        this.seen = messages;
        yield new ChatGenerationChunk({ text: "Open 9am to 6pm [1].", message: new AIMessageChunk("Open 9am to 6pm [1].") });
      }
    }
    const model = new Recording({});
    const events: TurnEvent[] = [];
    for await (const e of runConversationTurn({
      trusted,
      chatbot: botA,
      message: "What are the Makati store hours?",
      source: "playground",
      env: {},
      candidates: [{ provider: "openai", model: "fake", create: () => model }],
      retrieve: (q) => trusted((db) => retrieveForChatbot(db, botA, q)),
    })) {
      events.push(e);
    }
    const sources = events.find((e) => e.type === "sources") as Extract<TurnEvent, { type: "sources" }>;
    expect(sources.citations[0]).toMatchObject({ n: 1, title: "Opening hours" });
    const system = String(model.seen[0]!.content);
    expect(system).toContain("[1] Opening hours");
    expect(system).toContain("cite the passages");

    const sessionId = (events[0] as { sessionId: string }).sessionId;
    const stored = await trusted(async (db) =>
      (await db.query("select citations from messages where chat_session_id = $1 and role = 'assistant'", [sessionId])).rows[0].citations,
    );
    expect(stored[0]).toMatchObject({ n: 1, title: "Opening hours" });
  });
});
