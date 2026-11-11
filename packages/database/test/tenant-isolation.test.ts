/**
 * Integration test for row-level security. Runs only when TEST_DATABASE_URL points at a throwaway
 * database (for example a Neon branch). It applies migrations and creates test rows there.
 * TEST_MIGRATIONS_DIR can point at an alternative migrations folder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createPool, withTrustedContext, withUserContext } from "../src/index.ts";
import { migrate } from "../src/migrate.ts";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("tenant isolation (RLS)", () => {
  let pool: pg.Pool;
  const ids = { userA: "", userB: "", orgA: "", orgB: "" };

  beforeAll(async () => {
    await migrate(url!, () => undefined, process.env.TEST_MIGRATIONS_DIR || undefined);
    pool = createPool(url!, 2);
    const suffix = Math.random().toString(36).slice(2, 10);
    await withTrustedContext(pool, async (db) => {
      const user = async (email: string) =>
        (await db.query<{ id: string }>("insert into users (id, email) values (gen_random_uuid(), $1) returning id", [email])).rows[0]!.id;
      const org = async (slug: string) =>
        (await db.query<{ id: string }>("insert into organizations (name, slug) values ($1, $1) returning id", [slug]))
          .rows[0]!.id;
      ids.userA = await user(`a-${suffix}@test.invalid`);
      ids.userB = await user(`b-${suffix}@test.invalid`);
      ids.orgA = await org(`org-a-${suffix}`);
      ids.orgB = await org(`org-b-${suffix}`);
      await db.query("insert into organization_members values ($1, $2, 'owner'), ($3, $4, 'viewer')", [
        ids.orgA,
        ids.userA,
        ids.orgB,
        ids.userB,
      ]);
    });
  });

  afterAll(async () => {
    if (!pool) return;
    await withTrustedContext(pool, async (db) => {
      await db.query("delete from organizations where id = any($1)", [[ids.orgA, ids.orgB]]);
      await db.query("delete from users where id = any($1)", [[ids.userA, ids.userB]]);
    });
    await pool.end();
  });

  it("members see only their own organization", async () => {
    const rows = await withUserContext(pool, ids.userA, async (db) =>
      (await db.query<{ id: string }>("select id from organizations where id = any($1)", [[ids.orgA, ids.orgB]])).rows,
    );
    expect(rows.map((r) => r.id)).toEqual([ids.orgA]);
  });

  it("owners can create workspaces in their organization but not in another", async () => {
    await withUserContext(pool, ids.userA, (db) =>
      db.query("insert into workspaces (organization_id, name, slug) values ($1, 'Main', 'main')", [ids.orgA]),
    );
    await expect(
      withUserContext(pool, ids.userA, (db) =>
        db.query("insert into workspaces (organization_id, name, slug) values ($1, 'X', 'x')", [ids.orgB]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("viewers cannot write", async () => {
    await expect(
      withUserContext(pool, ids.userB, (db) =>
        db.query("insert into workspaces (organization_id, name, slug) values ($1, 'X', 'x')", [ids.orgB]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("no user context means no rows", async () => {
    const rows = await withTrustedContext(pool, async (db) => {
      await db.query("set local role chatbot_app");
      return (await db.query("select id from organizations")).rows;
    });
    expect(rows).toEqual([]);
  });

  it("api key hashes are not readable by the app role", async () => {
    await expect(
      withUserContext(pool, ids.userA, (db) => db.query("select key_hash from api_keys")),
    ).rejects.toThrow(/permission denied/);
  });
});
