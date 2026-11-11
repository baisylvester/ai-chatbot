/**
 * Integration tests for the tenant services. Runs only when TEST_DATABASE_URL points at a throwaway
 * database (for example a Neon branch); it applies migrations and creates/deletes test rows.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createPool, withTrustedContext, withUserContext } from "@chatbot/database";
import { migrate } from "@chatbot/database/src/migrate.ts";
import {
  addDomain,
  createChatbot,
  createOrganization,
  createWebsite,
  createWorkspace,
  DomainError,
  getChatbot,
  listOrganizations,
  listWebsites,
  setChatbotStatus,
  updateChatbotSettings,
  upsertUser,
} from "../src/index.ts";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("tenant services", () => {
  let pool: pg.Pool;
  const alice = { id: crypto.randomUUID(), email: `alice-${Date.now()}@test.invalid`, name: "Alice" };
  const bob = { id: crypto.randomUUID(), email: `bob-${Date.now()}@test.invalid`, name: "Bob" };
  const orgIds: string[] = [];
  const as = <T>(user: { id: string }, fn: (db: pg.PoolClient) => Promise<T>) => withUserContext(pool, user.id, fn);

  beforeAll(async () => {
    await migrate(url!, () => undefined);
    pool = createPool(url!, 2);
    await withTrustedContext(pool, async (db) => {
      await upsertUser(db, alice);
      await upsertUser(db, bob);
    });
  });

  afterAll(async () => {
    if (!pool) return;
    await withTrustedContext(pool, async (db) => {
      await db.query("delete from organizations where id = any($1)", [orgIds]);
      await db.query("delete from users where id = any($1)", [[alice.id, bob.id]]);
    });
    await pool.end();
  });

  it("creates the full hierarchy for the owner and hides it from others", async () => {
    const slug = `acme-${Date.now()}`;
    const org = await withTrustedContext(pool, (db) => createOrganization(db, alice.id, { name: "Acme", slug }));
    orgIds.push(org.id);

    const ws = await as(alice, (db) => createWorkspace(db, { organizationId: org.id, name: "Main", slug: "main" }));
    const site = await as(alice, (db) =>
      createWebsite(db, { workspaceId: ws.id, name: "Shop", domains: ["Shop.Example.com", "shop.example.com"] }),
    );
    expect(site.domains.map((d) => d.domain)).toEqual(["shop.example.com"]);

    const bot = await as(alice, (db) =>
      createChatbot(db, { websiteId: site.id, settings: { name: "Helper", model: "gpt-4.1-mini" } }),
    );
    expect(bot.public_id).toMatch(/^cb_/);
    expect(bot.settings.welcomeMessage).toBeTruthy();

    expect((await as(alice, listOrganizations)).map((o) => o.id)).toContain(org.id);
    expect((await as(bob, listOrganizations)).map((o) => o.id)).not.toContain(org.id);
    await expect(as(bob, (db) => getChatbot(db, bot.id))).rejects.toMatchObject({ code: "not_found" });
    await expect(as(bob, (db) => listWebsites(db, ws.id))).resolves.toEqual([]);
  });

  it("refuses to create children under another tenant's parent", async () => {
    const org = await withTrustedContext(pool, (db) =>
      createOrganization(db, alice.id, { name: "Private", slug: `private-${Date.now()}` }),
    );
    orgIds.push(org.id);
    const ws = await as(alice, (db) => createWorkspace(db, { organizationId: org.id, name: "W", slug: "ws" }));

    await expect(as(bob, (db) => createWorkspace(db, { organizationId: org.id, name: "X", slug: "xx" }))).rejects.toMatchObject(
      { code: "not_found" },
    );
    await expect(
      as(bob, (db) => createWebsite(db, { workspaceId: ws.id, name: "Evil", domains: ["evil.example"] })),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("lets viewers read but not write", async () => {
    const org = await withTrustedContext(pool, (db) =>
      createOrganization(db, alice.id, { name: "Team", slug: `team-${Date.now()}` }),
    );
    orgIds.push(org.id);
    await withTrustedContext(pool, (db) =>
      db.query("insert into organization_members values ($1, $2, 'viewer')", [org.id, bob.id]),
    );
    const ws = await as(alice, (db) => createWorkspace(db, { organizationId: org.id, name: "W", slug: "ws" }));
    const site = await as(alice, (db) => createWebsite(db, { workspaceId: ws.id, name: "S", domains: ["team.example"] }));
    const bot = await as(alice, (db) => createChatbot(db, { websiteId: site.id, settings: { name: "B", model: "m" } }));

    await expect(as(bob, (db) => getChatbot(db, bot.id))).resolves.toMatchObject({ id: bot.id });
    await expect(as(bob, (db) => createWorkspace(db, { organizationId: org.id, name: "X", slug: "xx" }))).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(as(bob, (db) => addDomain(db, site.id, "other.example"))).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      as(bob, (db) => updateChatbotSettings(db, bot.id, { name: "Hacked", model: "m" })),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(as(bob, (db) => setChatbotStatus(db, bot.id, "active"))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects invalid input before touching the database", async () => {
    await expect(
      withTrustedContext(pool, (db) => createOrganization(db, alice.id, { name: "Bad", slug: "Not A Slug" })),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("rejects duplicate organization slugs with a conflict", async () => {
    const slug = `dupe-${Date.now()}`;
    const org = await withTrustedContext(pool, (db) => createOrganization(db, alice.id, { name: "A", slug }));
    orgIds.push(org.id);
    await expect(
      withTrustedContext(pool, (db) => createOrganization(db, bob.id, { name: "B", slug })),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("records audit entries with the acting user", async () => {
    const rows = await withTrustedContext(pool, async (db) =>
      (
        await db.query<{ action: string }>(
          "select action from audit_logs where actor_id = $1 and organization_id = any($2)",
          [alice.id, orgIds],
        )
      ).rows.map((r) => r.action),
    );
    expect(rows).toEqual(expect.arrayContaining(["organization.create", "workspace.create", "website.create", "chatbot.create"]));
  });
});
