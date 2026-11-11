/**
 * Integration tests for conversation turns. Runs only when TEST_DATABASE_URL points at a throwaway
 * database (for example a Neon branch). Models are LangChain fakes; no provider is called.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import { FakeStreamingChatModel } from "@langchain/core/utils/testing";
import type { ModelCandidate } from "@chatbot/ai-engine";
import { createPool, withTrustedContext, withUserContext } from "@chatbot/database";
import { migrate } from "@chatbot/database/src/migrate.ts";
import {
  createChatbot,
  createOrganization,
  createWebsite,
  createWorkspace,
  modelCandidates,
  runConversationTurn,
  upsertUser,
  type Chatbot,
  type TurnEvent,
} from "../src/index.ts";

const url = process.env.TEST_DATABASE_URL;

/** Records the prompt it received and replies with fixed text plus usage. */
class Recording extends FakeStreamingChatModel {
  readonly reply: string;
  seen: BaseMessage[] = [];
  constructor(reply: string) {
    super({});
    this.reply = reply;
  }
  override async *_streamResponseChunks(messages: BaseMessage[]): AsyncGenerator<ChatGenerationChunk> {
    this.seen = messages;
    yield new ChatGenerationChunk({
      text: this.reply,
      message: new AIMessageChunk({
        content: this.reply,
        usage_metadata: { input_tokens: 40, output_tokens: 5, total_tokens: 45 },
      }),
    });
  }
}

describe.skipIf(!url)("conversation turns", () => {
  let pool: pg.Pool;
  const owner = { id: crypto.randomUUID(), email: `conv-${Date.now()}@test.invalid`, name: "Owner" };
  let orgId = "";
  let botA: Chatbot;
  let botB: Chatbot;
  const trusted = <T>(fn: (db: pg.PoolClient) => Promise<T>) => withTrustedContext(pool, fn);

  async function run(bot: Chatbot, message: string, candidates: ModelCandidate[], sessionId?: string) {
    const events: TurnEvent[] = [];
    for await (const e of runConversationTurn({
      trusted,
      chatbot: bot,
      message,
      sessionId,
      source: "playground",
      createdBy: owner.id,
      env: {},
      candidates,
    })) {
      events.push(e);
    }
    return events;
  }

  beforeAll(async () => {
    await migrate(url!, () => undefined);
    pool = createPool(url!, 2);
    await trusted((db) => upsertUser(db, owner));
    const org = await trusted((db) => createOrganization(db, owner.id, { name: "Conv", slug: `conv-${Date.now()}` }));
    orgId = org.id;
    [botA, botB] = await withUserContext(pool, owner.id, async (db) => {
      const ws = await createWorkspace(db, { organizationId: org.id, name: "W", slug: "ws" });
      const site = await createWebsite(db, { workspaceId: ws.id, name: "S", domains: ["conv.example"] });
      return [
        await createChatbot(db, { websiteId: site.id, settings: { name: "A", model: "m", systemPrompt: "Be brief." } }),
        await createChatbot(db, { websiteId: site.id, settings: { name: "B", model: "m" } }),
      ];
    });
  });

  afterAll(async () => {
    if (!pool) return;
    await trusted(async (db) => {
      await db.query("delete from organizations where id = $1", [orgId]);
      await db.query("delete from users where id = $1", [owner.id]);
    });
    await pool.end();
  });

  it("creates a session, streams, and stores messages and usage", async () => {
    const model = new Recording("Hello there");
    const events = await run(botA, "Hi!", [{ provider: "openai", model: "fake", create: () => model }]);
    expect(events[0]).toMatchObject({ type: "session" });
    expect(events.at(-1)).toMatchObject({ type: "done", text: "Hello there", usage: { inputTokens: 40, outputTokens: 5 } });
    const sessionId = (events[0] as { sessionId: string }).sessionId;

    const stored = await trusted(async (db) => ({
      messages: (await db.query("select role, content, provider, model from messages where chat_session_id = $1 order by created_at", [sessionId])).rows,
      usage: (await db.query("select provider, model, prompt_tokens, completion_tokens, status, source from usage_records where chat_session_id = $1", [sessionId])).rows,
    }));
    expect(stored.messages).toEqual([
      { role: "user", content: "Hi!", provider: null, model: null },
      { role: "assistant", content: "Hello there", provider: "openai", model: "fake" },
    ]);
    expect(stored.usage).toEqual([
      { provider: "openai", model: "fake", prompt_tokens: 40, completion_tokens: 5, status: "ok", source: "playground" },
    ]);
  });

  it("sends earlier turns as history on the next message", async () => {
    const first = await run(botA, "My name is Ana.", [{ provider: "openai", model: "fake", create: () => new Recording("Nice to meet you, Ana.") }]);
    const sessionId = (first[0] as { sessionId: string }).sessionId;
    const model = new Recording("Your name is Ana.");
    await run(botA, "What is my name?", [{ provider: "openai", model: "fake", create: () => model }], sessionId);
    const contents = model.seen.map((m) => String(m.content));
    expect(contents[0]).toContain("Owner instructions:\nBe brief.");
    expect(contents.slice(1)).toEqual(["My name is Ana.", "Nice to meet you, Ana.", "What is my name?"]);
  });

  it("records failed attempts and the fallback that answered", async () => {
    const events = await run(botA, "Hello", [
      { provider: "anthropic", model: "down", create: () => new FakeStreamingChatModel({ thrownErrorString: "503 overloaded" }) },
      { provider: "openai", model: "fake", create: () => new Recording("Fallback reply") },
    ]);
    const sessionId = (events[0] as { sessionId: string }).sessionId;
    const usage = await trusted(async (db) =>
      (await db.query("select provider, status, error from usage_records where chat_session_id = $1 order by created_at, status", [sessionId])).rows,
    );
    expect(usage).toEqual(
      expect.arrayContaining([
        { provider: "anthropic", status: "error", error: "503 overloaded" },
        { provider: "openai", status: "ok", error: null },
      ]),
    );
  });

  it("rejects a session id that belongs to another chatbot", async () => {
    const events = await run(botA, "Hi", [{ provider: "openai", model: "fake", create: () => new Recording("ok") }]);
    const sessionOfA = (events[0] as { sessionId: string }).sessionId;
    await expect(
      run(botB, "Hi", [{ provider: "openai", model: "fake", create: () => new Recording("ok") }], sessionOfA),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects empty and oversized messages before storing anything", async () => {
    await expect(run(botA, "   ", [])).rejects.toMatchObject({ code: "invalid" });
    await expect(run(botA, "x".repeat(4001), [])).rejects.toMatchObject({ code: "invalid" });
  });

  it("reports an unconfigured provider as unavailable without throwing", async () => {
    const events: TurnEvent[] = [];
    for await (const e of runConversationTurn({
      trusted,
      chatbot: botB,
      message: "Hi",
      source: "playground",
      env: {},
    })) {
      events.push(e);
    }
    const last = events.at(-1);
    expect(last).toMatchObject({ type: "error", reason: "unavailable" });
    expect(JSON.stringify(last)).toContain("OpenAI is not configured");
  });
});

describe("modelCandidates", () => {
  it("lists primary then fallbacks, without duplicates", () => {
    const list = modelCandidates(
      {
        name: "x",
        systemPrompt: "",
        welcomeMessage: "",
        suggestedQuestions: [],
        provider: "openai",
        model: "a",
        temperature: 0.3,
        maxOutputTokens: 256,
        fallbacks: [
          { provider: "openai", model: "a" },
          { provider: "neon-gateway", model: "b" },
        ],
        position: "bottom-right",
        theme: "auto",
      },
      {},
    );
    expect(list.map((c) => `${c.provider}:${c.model}`)).toEqual(["openai:a", "neon-gateway:b"]);
  });
});
