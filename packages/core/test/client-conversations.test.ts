/** Real PostgreSQL tests. CLIENT_SYNC_TEST_DATABASE_URL must name a disposable *_client_sync_test
 * database with an EMPTY public schema. Only the relevant original schema is installed, so this
 * suite also runs on plain PostgreSQL without pgvector or any external AI service. */
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { FakeStreamingChatModel } from "@langchain/core/utils/testing";
import { AIMessage } from "@langchain/core/messages";
import { createPool, withTrustedContext, withUserContext } from "@chatbot/database";
import { chatbotSettingsSchema } from "@chatbot/shared";
import { claimClientTurn, createClientConversation, deleteClientConversation, getClientConversation, listClientConversations, listClientMessages, recoverClientTurns, runClientConversationTurn, type Chatbot } from "../src/index.ts";

const url = process.env.CLIENT_SYNC_TEST_DATABASE_URL;
describe.skipIf(!url)("private client conversations (PostgreSQL)", () => {
  let pool: pg.Pool;
  const user = crypto.randomUUID(), peer = crypto.randomUUID(), outsider = crypto.randomUUID();
  const org = crypto.randomUUID(), workspace = crypto.randomUUID(), website = crypto.randomUUID(), botId = crypto.randomUUID();
  const bot: Chatbot = { id: botId, public_id: "cb_clientsynctest00000000001", organization_id: org, workspace_id: workspace, website_id: website, status: "active", settings: chatbotSettingsSchema.parse({ name: "Sync test", model: "fake" }) };
  const trusted = <T,>(fn: (db: pg.PoolClient) => Promise<T>) => withTrustedContext(pool, fn);
  const fresh = () => trusted(db => createClientConversation(db, user, bot, crypto.randomUUID()));
  const run = (sessionId: string, requestId: string, message = "Hello", create = () => new FakeStreamingChatModel({ responses: [new AIMessage("A saved reply")] })) => runClientConversationTurn({
    trusted, chatbot: bot, userId: user, sessionId, requestId, message, env: {}, candidates: [{ provider: "openai", model: "fake", create }],
  });
  async function collect(events: ReturnType<typeof run>) { const result = []; for await (const event of events) result.push(event); return result; }

  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith("_client_sync_test")) throw new Error("Use a disposable *_client_sync_test database");
    pool = createPool(url!, 5);
    const tables = await pool.query("select 1 from information_schema.tables where table_schema = 'public' limit 1");
    if (tables.rowCount) throw new Error("Refusing to initialize a non-empty database");
    const base = await readFile(new URL("../../database/migrations/0001_core_schema.sql", import.meta.url), "utf8");
    const section = (start: string, end: string) => base.slice(base.indexOf(start), base.indexOf(end));
    await pool.query(section("do $$", "-- ---------------------------------------------------------------- identity & tenancy"));
    for (const table of ["users", "organizations", "organization_members", "workspaces", "websites", "website_domains", "chatbots", "chatbot_settings", "chat_sessions", "messages", "usage_records"]) {
      const sql = base.match(new RegExp(`create table public\\.${table} \\([\\s\\S]*?\\n\\);`))?.[0];
      if (!sql) throw new Error(`Missing original schema for ${table}`);
      await pool.query(sql);
    }
    await pool.query(section("create or replace function public.is_org_member", "-- ---------------------------------------------------------------- privileges"));
    await pool.query(`grant usage on schema public to chatbot_app; grant select on chat_sessions, messages to chatbot_app;
      alter table chat_sessions enable row level security; alter table messages enable row level security;
      create policy chat_sessions_member_select on chat_sessions for select to chatbot_app using (public.is_org_member(organization_id));
      create policy messages_member_select on messages for select to chatbot_app using (public.is_org_member(organization_id));`);
    await pool.query(await readFile(new URL("../../database/migrations/0004_conversation_usage.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../../database/migrations/20261117090000_client_conversations.sql", import.meta.url), "utf8"));
    for (const [id, email] of [[user, "owner@client.invalid"], [peer, "admin@client.invalid"], [outsider, "other@client.invalid"]]) await pool.query("insert into users(id,email) values ($1,$2)", [id,email]);
    await pool.query("insert into organizations(id,name,slug) values ($1,'Client test','client-test')", [org]);
    await pool.query("insert into organization_members(organization_id,user_id,role) values ($1,$2,'admin')", [org,peer]);
    await pool.query("insert into workspaces(id,organization_id,name,slug) values ($1,$2,'Workspace','workspace')", [workspace,org]);
    await pool.query("insert into websites(id,organization_id,workspace_id,name) values ($1,$2,$3,'Website')", [website,org,workspace]);
    await pool.query("insert into chatbots(id,organization_id,workspace_id,website_id,public_id,status) values ($1,$2,$3,$4,$5,'active')", [botId,org,workspace,website,bot.public_id]);
    await pool.query("insert into chatbot_settings(chatbot_id,organization_id,settings) values ($1,$2,$3)", [botId,org,JSON.stringify(bot.settings)]);
  }, 30000);
  afterAll(async () => { await pool?.end(); });

  it("creates idempotently, keeps conversations independent of token expiry, and rejects owner takeover", async () => {
    const c = await fresh();
    expect((await trusted(db => createClientConversation(db, user, bot, c.id))).id).toBe(c.id);
    expect((await pool.query("select expires_at from chat_sessions where id = $1", [c.id])).rows[0].expires_at).toBeNull();
    await expect(trusted(db => createClientConversation(db, outsider, bot, c.id))).rejects.toMatchObject({ code: "not_found" });
    expect((await trusted(db => listClientConversations(db, outsider, bot))).conversations).toEqual([]);
  });
  it("protects private messages from other users, including organization admins, at the DB policy", async () => {
    const c = await fresh(); await collect(run(c.id, crypto.randomUUID()));
    await expect(trusted(db => listClientMessages(db, peer, c.id))).rejects.toMatchObject({ code: "not_found" });
    const other = await withUserContext(pool, peer, db => db.query("select id from messages where chat_session_id = $1", [c.id]));
    expect(other.rowCount).toBe(0);
    const own = await withUserContext(pool, user, db => db.query("select id from messages where chat_session_id = $1", [c.id]));
    expect(own.rowCount).toBe(2);
  });
  it("emits completion only after persistence and replays a request without invoking the model again", async () => {
    const c = await fresh(), request = crypto.randomUUID(); let calls = 0;
    const model = () => { calls++; return new FakeStreamingChatModel({ responses: [new AIMessage("A saved reply")] }); };
    for await (const event of run(c.id, request, "Hi", model)) if (event.type === "done") {
      expect(event.turn.status).toBe("completed");
      const page = await trusted(db => listClientMessages(db, user, c.id));
      expect(page.messages).toHaveLength(2); expect(page.conversation.lastTurn?.status).toBe("completed");
    }
    const replay = await collect(run(c.id, request, "Hi", model));
    expect(replay).toHaveLength(1); expect(replay[0]).toMatchObject({ type: "done", turn: { status: "completed" } }); expect(calls).toBe(1);
    await expect(collect(run(c.id, request, "Changed", model))).rejects.toMatchObject({ code: "conflict" });
    expect((await trusted(db => listClientMessages(db, user, c.id))).messages).toHaveLength(2);
  });
  it("serializes concurrent devices without holding a connection during generation", async () => {
    const c = await fresh(); const first = run(c.id, crypto.randomUUID());
    expect((await first.next()).value).toMatchObject({ type: "accepted" });
    await expect(collect(run(c.id, crypto.randomUUID()))).rejects.toMatchObject({ code: "conflict" });
    await collect(first);
    expect((await trusted(db => listClientMessages(db, user, c.id))).messages).toHaveLength(2);
  });
  it("releases a claim when a streaming consumer stops immediately after acceptance", async () => {
    const c = await fresh(); const events = run(c.id,crypto.randomUUID()); await events.next(); await events.return(undefined);
    expect((await trusted(db => getClientConversation(db,user,c.id))).lastTurn?.status).toBe("interrupted");
    await collect(run(c.id,crypto.randomUUID()));
  });
  it("paginates messages without duplicates or skipped committed revisions", async () => {
    const c = await fresh();
    await trusted(async db => { for (let n = 0; n < 205; n++) await db.query("insert into messages(organization_id,chat_session_id,role,content) values ($1,$2,'user',$3)", [org,c.id,`Message ${n}`]); });
    const all = []; let cursor = "0";
    for (;;) { const page = await trusted(db => listClientMessages(db,user,c.id,cursor)); all.push(...page.messages); cursor = page.nextCursor; if (!page.hasMore) break; }
    expect(all).toHaveLength(205); expect(new Set(all.map(message => message.id)).size).toBe(205); expect(cursor).toBe("205");
    const writer = await pool.connect();
    try {
      await writer.query("begin"); await writer.query("insert into messages(organization_id,chat_session_id,role,content) values ($1,$2,'user','not committed yet')",[org,c.id]);
      expect((await trusted(db => listClientMessages(db,user,c.id,cursor))).nextCursor).toBe("205");
      await writer.query("commit");
      const next = await trusted(db => listClientMessages(db,user,c.id,cursor)); expect(next.messages).toHaveLength(1); expect(next.nextCursor).toBe("206");
    } finally { await writer.query("rollback"); writer.release(); }
  });
  it("preserves microseconds when paginating tightly spaced conversation timestamps", async () => {
    for (let n=0; n<60; n++) {
      const c = await trusted(db => createClientConversation(db,outsider,bot,crypto.randomUUID()));
      await pool.query("update chat_sessions set created_at = '2026-11-01T00:00:00.123000Z'::timestamptz + $2 * interval '1 microsecond' where id = $1",[c.id,n]);
    }
    const first = await trusted(db => listClientConversations(db,outsider,bot));
    const second = await trusted(db => listClientConversations(db,outsider,bot,first.nextCursor!));
    expect(first.conversations).toHaveLength(50); expect(second.conversations).toHaveLength(10);
    expect(new Set([...first.conversations,...second.conversations].map(c=>c.id)).size).toBe(60);
  });
  it("never lets an expired generation write over a newer turn", async () => {
    const c = await fresh(), request = crypto.randomUUID(); const first = run(c.id, request);
    await first.next();
    await pool.query("update client_turns set lease_expires_at = now() - interval '1 minute' where chat_session_id = $1", [c.id]);
    await trusted(db => recoverClientTurns(db));
    const next = await trusted(db => claimClientTurn(db,user,c.id,crypto.randomUUID(),"New turn",false));
    await expect(collect(first)).rejects.toMatchObject({ code: "conflict" });
    expect((await pool.query("select status from client_turns where id = $1",[next.id])).rows[0].status).toBe("running");
    const replay = await collect(run(c.id, request)); expect(replay[0]).toMatchObject({ type: "done", turn: { status: "interrupted" } });
  });
  it("records model failures and does not rerun them on an ambiguous retry", async () => {
    const c = await fresh(), request = crypto.randomUUID(); let calls = 0;
    const fail = () => { calls++; return new FakeStreamingChatModel({ thrownErrorString: "provider secret detail" }); };
    const first = await collect(run(c.id,request,"Hello",fail));
    expect(first.at(-1)).toMatchObject({ type:"done", turn:{status:"failed"} });
    expect(JSON.stringify(first)).not.toContain("provider secret detail");
    await collect(run(c.id,request,"Hello",fail)); expect(calls).toBe(1);
  });
  it("deletes the owner's transcript and turn records, and denies cross-account deletion", async () => {
    const c = await fresh(); await collect(run(c.id,crypto.randomUUID()));
    await expect(trusted(db => deleteClientConversation(db,peer,c.id))).rejects.toMatchObject({code:"not_found"});
    await trusted(db => deleteClientConversation(db,user,c.id));
    await expect(trusted(db => getClientConversation(db,user,c.id))).rejects.toMatchObject({code:"not_found"});
    expect((await pool.query("select 1 from client_turns where chat_session_id=$1",[c.id])).rowCount).toBe(0);
  });
});
