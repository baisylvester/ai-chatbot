/** Real PostgreSQL tests for the native mail store. NATIVE_MAIL_TEST_DATABASE_URL must name a disposable
 * *_native_mail_test database with an EMPTY public schema. Only the users table and the mail migrations
 * are installed. Never point it at a shared or production database. */
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, withTrustedContext, type DbClient } from "@chatbot/database";
import {
  claimAction, cleanupNativeTransactions, consumeNativeCallback, countPendingActions, createAction, createNativeTransaction, finishNativeTransaction,
  getAction, listActions, lockNativeTransaction, markUncertain, recordNativeCallback, rejectPendingAction,
} from "../src/index.ts";

const url = process.env.NATIVE_MAIL_TEST_DATABASE_URL;
describe.skipIf(!url)("native mail store (PostgreSQL)", () => {
  let pool: ReturnType<typeof createPool>;
  const user = crypto.randomUUID(), other = crypto.randomUUID();
  const db = <T,>(fn: (client: DbClient) => Promise<T>) => withTrustedContext(pool, fn);
  const hex = (c: string) => c.repeat(64);
  const tx = (stateHash: string, userId = user) => db((c) => createNativeTransaction(c, userId, {
    chatbotPublicId: "cb_nativemailtest00001", stateHash, verifierChallenge: "a".repeat(43), pkceVerifier: "p".repeat(43),
  }));
  const queue = async (userId = user) => {
    await db((c) => createAction(c, userId, "send", "Send hi", { draftId: "d1", to: "a@example.com", subject: "Hi", preview: "Hi" }));
    return (await db((c) => listActions(c, userId, "pending")))[0]!.id;
  };

  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith("_native_mail_test")) throw new Error("Use a disposable *_native_mail_test database");
    pool = createPool(url!, 5);
    if ((await pool.query("select 1 from information_schema.tables where table_schema = 'public' limit 1")).rowCount) throw new Error("Refusing to initialize a non-empty database");
    const base = await readFile(new URL("../../database/migrations/0001_core_schema.sql", import.meta.url), "utf8");
    await pool.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    end $$;`);
    await pool.query(base.match(/create table public\.users \([\s\S]*?\n\);/)![0]);
    await pool.query(await readFile(new URL("../../database/migrations/20261112090000_mail_agent.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../../database/migrations/20261118090000_native_mail.sql", import.meta.url), "utf8"));
    await pool.query("insert into users (id, email) values ($1, 'one@example.test'), ($2, 'two@example.test')", [user, other]);
  });
  afterAll(async () => { await pool?.end(); });

  it("consumes a callback once and never after expiry", async () => {
    const created = await tx(hex("1"));
    const first = await db((c) => consumeNativeCallback(c, hex("1")));
    expect(first).toMatchObject({ id: created.id, userId: user, chatbotPublicId: "cb_nativemailtest00001" });
    expect(await db((c) => consumeNativeCallback(c, hex("1")))).toBeNull();
    const old = await tx(hex("2"));
    await pool.query("update mail_oauth_transactions set expires_at = now() - interval '2 hours' where id = $1", [old.id]);
    expect(await db((c) => consumeNativeCallback(c, hex("2")))).toBeNull();
    expect(await db((c) => cleanupNativeTransactions(c))).toBe(1);
  });

  it("lets only the owner lock a transaction and wipes the parked token on completion", async () => {
    const created = await tx(hex("3"));
    await db((c) => consumeNativeCallback(c, hex("3")));
    await db((c) => recordNativeCallback(c, created.id, { completionHash: hex("c"), sealedRefreshToken: "v1.sealed", email: "me@example.com" }));
    expect(await db((c) => lockNativeTransaction(c, other, created.id))).toBeNull();
    const locked = await db((c) => lockNativeTransaction(c, user, created.id));
    expect(locked).toMatchObject({ completionHash: hex("c"), sealedRefreshToken: "v1.sealed", completedAt: null });
    await db((c) => finishNativeTransaction(c, created.id));
    const done = await db((c) => lockNativeTransaction(c, user, created.id));
    expect(done!.completedAt).not.toBeNull(); expect(done!.sealedRefreshToken).toBeNull();
  });

  it("rejects only pending actions and isolates users", async () => {
    const id = await queue();
    expect(await db((c) => rejectPendingAction(c, other, id))).toBe(false);
    expect(await db((c) => getAction(c, other, id))).toBeNull();
    expect(await db((c) => claimAction(c, user, id))).not.toBeNull();
    expect(await db((c) => rejectPendingAction(c, user, id))).toBe(false); // processing is never flipped to rejected
    expect(await db((c) => markUncertain(c, user, id, "Gmail did not confirm"))).toBe(true);
    expect(await db((c) => getAction(c, user, id))).toMatchObject({ status: "uncertain", error: "Gmail did not confirm" });
    expect((await db((c) => listActions(c, user, "recent"))).map((a) => a.id)).toContain(id);
  });

  it("lets exactly one of many concurrent approvals claim an action", async () => {
    const id = await queue();
    const claims = await Promise.all(Array.from({ length: 5 }, () => db((c) => claimAction(c, user, id))));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await db((c) => countPendingActions(c, user))).toBe(0);
    const pending = await queue();
    expect(await db((c) => rejectPendingAction(c, user, pending))).toBe(true);
    expect(await db((c) => rejectPendingAction(c, user, pending))).toBe(false);
  });
});
