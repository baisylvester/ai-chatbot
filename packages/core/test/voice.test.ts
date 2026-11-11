import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { createPool, withTrustedContext, withUserContext } from "@chatbot/database";
import { migrate } from "@chatbot/database/src/migrate.ts";
import {
  createChatbot,
  createOrganization,
  createWebsite,
  createWidgetSession,
  createWorkspace,
  endRealtimeSession,
  getChatbot,
  normalizeChatbot,
  realtimeInstructions,
  runRealtimeTool,
  startRealtimeSession,
  synthesizeForWidget,
  transcribeForWidget,
  updateChatbotSettings,
  upsertUser,
  type Chatbot,
} from "../src/index.ts";

describe("normalizeChatbot", () => {
  it("fills defaults for settings saved before newer fields existed", () => {
    const old = { id: "x", organization_id: "o", workspace_id: "w", website_id: "s", public_id: "cb_x", status: "active" as const, settings: { name: "Old", model: "m" } };
    const bot = normalizeChatbot(old as unknown as Chatbot);
    expect(bot.settings.voice.mode).toBe("off");
    expect(bot.settings.fallbacks).toEqual([]);
    expect(bot.settings.maxOutputTokens).toBe(1024);
  });
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("voice for widgets", () => {
  let pool: pg.Pool;
  const owner = { id: crypto.randomUUID(), email: `vo-${Date.now()}@test.invalid`, name: "Owner" };
  let orgId = "";
  let bot: Chatbot;
  let other: Chatbot;
  let sessionId = "";
  let otherSessionId = "";
  const env = { VOICE_MOCK: "1", OPENAI_API_KEY: "sk-test" };
  const secret = "s".repeat(40);
  const trusted = <T>(fn: (db: pg.PoolClient) => Promise<T>) => withTrustedContext(pool, fn);
  const as = <T>(fn: (db: pg.PoolClient) => Promise<T>) => withUserContext(pool, owner.id, fn);
  const setVoice = async (b: Chatbot, voice: Record<string, unknown>) =>
    as((db) => updateChatbotSettings(db, b.id, { ...b.settings, voice: { ...b.settings.voice, ...voice } }));

  beforeAll(async () => {
    await migrate(url!, () => undefined);
    pool = createPool(url!, 2);
    await trusted((db) => upsertUser(db, owner));
    const org = await trusted((db) => createOrganization(db, owner.id, { name: "Voice", slug: `voice-${Date.now()}` }));
    orgId = org.id;
    [bot, other] = await as(async (db) => {
      const ws = await createWorkspace(db, { organizationId: org.id, name: "W", slug: "ws" });
      const site = await createWebsite(db, { workspaceId: ws.id, name: "S", domains: ["voice.example"] });
      return [
        await createChatbot(db, { websiteId: site.id, settings: { name: "Voice bot", model: "m", systemPrompt: "Speak like a librarian." } }),
        await createChatbot(db, { websiteId: site.id, settings: { name: "Other", model: "m" } }),
      ];
    });
    sessionId = (await trusted((db) => createWidgetSession(db, bot, "https://voice.example", secret))).sessionId;
    otherSessionId = (await trusted((db) => createWidgetSession(db, other, "https://voice.example", secret))).sessionId;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!pool) return;
    await trusted(async (db) => {
      await db.query("delete from organizations where id = $1", [orgId]);
      await db.query("delete from users where id = $1", [owner.id]);
    });
    await pool.end();
  });

  it("refuses voice when it is turned off", async () => {
    await expect(transcribeForWidget(trusted, { bot, sessionId, audio: new Uint8Array([1]), mimeType: "audio/webm", env })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("transcribes and synthesizes in standard mode and records usage", async () => {
    await setVoice(bot, { mode: "standard", sttProvider: "mock", ttsProvider: "mock", ttsVoice: "tone" });
    bot = await as((db) => getChatbot(db, bot.id));
    expect(await transcribeForWidget(trusted, { bot, sessionId, audio: new Uint8Array([1, 2]), mimeType: "audio/webm", durationMs: 3200, env })).toEqual({
      text: "This is a mock transcript.",
    });
    const speech = await synthesizeForWidget(trusted, { bot, sessionId, text: "Hello [1]", env });
    expect(speech.mimeType).toBe("audio/wav");
    const usage = await trusted(async (db) =>
      (await db.query("select kind, provider, audio_seconds::float as audio_seconds, characters, status from usage_records where chat_session_id = $1 order by created_at", [sessionId])).rows,
    );
    expect(usage).toEqual([
      { kind: "stt", provider: "mock", audio_seconds: 3.2, characters: null, status: "ok" },
      { kind: "tts", provider: "mock", audio_seconds: null, characters: 9, status: "ok" },
    ]);
    // Realtime is a separate mode.
    await expect(startRealtimeSession(trusted, { bot, sessionId, env })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("runs a realtime call: secret, scoped knowledge tool, transcript and usage", async () => {
    await setVoice(bot, { mode: "realtime", realtimeModel: "gpt-realtime", realtimeVoice: "cedar" });
    bot = await as((db) => getChatbot(db, bot.id));
    const fetchMock = vi.fn(async () => Response.json({ value: "ek_test", expires_at: 1900000000 }));
    vi.stubGlobal("fetch", fetchMock);

    const call = await startRealtimeSession(trusted, { bot, sessionId, env });
    expect(call).toMatchObject({ clientSecret: "ek_test", voice: "cedar", model: "gpt-realtime" });
    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.session.instructions).toContain("Speak like a librarian.");
    expect(sent.session.tools[0].name).toBe("search_knowledge");
    expect(realtimeInstructions(bot)).toContain("spoken conversation");

    const retrieve = vi.fn(async () => [{ id: "c1", documentId: "d1", title: "Hours", sourceUrl: null, content: "Open 9 to 5", score: 1 }]);
    const tool = await runRealtimeTool(trusted, { bot, sessionId, voiceSessionId: call.voiceSessionId, name: "search_knowledge", args: { query: "hours" }, retrieve });
    expect(tool.output).toBe("[1] Hours\nOpen 9 to 5");
    expect(tool.citations[0]).toMatchObject({ n: 1, title: "Hours" });
    expect(retrieve).toHaveBeenCalledWith("hours");

    // Another chatbot's widget session can't use this call.
    await expect(
      runRealtimeTool(trusted, { bot: other, sessionId: otherSessionId, voiceSessionId: call.voiceSessionId, name: "search_knowledge", args: { query: "x" }, retrieve }),
    ).rejects.toMatchObject({ code: "not_found" });
    const unknown = await runRealtimeTool(trusted, { bot, sessionId, voiceSessionId: call.voiceSessionId, name: "delete_everything", args: {}, retrieve });
    expect(unknown.output).toContain("Unknown tool");

    const ended = await endRealtimeSession(trusted, {
      bot,
      sessionId,
      voiceSessionId: call.voiceSessionId,
      transcript: [
        { role: "user", text: "When are you open?" },
        { role: "assistant", text: "Nine to five." },
      ],
    });
    expect(ended.durationSeconds).toBeGreaterThanOrEqual(0);
    const stored = await trusted(async (db) => ({
      call: (await db.query("select status, tool_calls from voice_sessions where id = $1", [call.voiceSessionId])).rows[0],
      messages: (await db.query("select role, content from messages where chat_session_id = $1 order by created_at", [sessionId])).rows,
      usage: (await db.query("select kind, model, status from usage_records where chat_session_id = $1 and kind = 'realtime'", [sessionId])).rows,
    }));
    expect(stored.call).toEqual({ status: "ended", tool_calls: 2 });
    expect(stored.messages).toEqual([
      { role: "user", content: "When are you open?" },
      { role: "assistant", content: "Nine to five." },
    ]);
    expect(stored.usage).toEqual([{ kind: "realtime", model: "gpt-realtime", status: "ok" }]);

    expect(stored.messages.every((m: { content: string }) => m.content)).toBe(true);
    const provenance = await trusted(async (db) => (await db.query("select distinct provider from messages where chat_session_id = $1", [sessionId])).rows.map((r) => r.provider));
    expect(provenance).toEqual(["voice-transcript"]);

    // One live call per conversation, and a daily budget per organization.
    const first = await startRealtimeSession(trusted, { bot, sessionId, env });
    await expect(startRealtimeSession(trusted, { bot, sessionId, env })).rejects.toMatchObject({ code: "conflict" });
    await endRealtimeSession(trusted, { bot, sessionId, voiceSessionId: first.voiceSessionId, transcript: [] });
    await trusted((db) =>
      db.query("insert into usage_records (organization_id, chatbot_id, source, kind, provider, model, audio_seconds) values ($1, $2, 'widget', 'realtime', 'openai', 'gpt-realtime', 7300)", [bot.organization_id, bot.id]),
    );
    await expect(startRealtimeSession(trusted, { bot, sessionId, env })).rejects.toMatchObject({ code: "forbidden" });

    // A finished call can't be ended or used again.
    await expect(endRealtimeSession(trusted, { bot, sessionId, voiceSessionId: call.voiceSessionId, transcript: [] })).rejects.toMatchObject({ code: "not_found" });
  });
});
