import pg from "pg";
import { z } from "zod";

export type DbClient = pg.PoolClient;

/**
 * pg currently treats sslmode=require/prefer/verify-ca as verify-full and warns that this will change.
 * Pin verify-full explicitly so behaviour stays strict (certificate + hostname checks) and the warning goes away.
 */
export function withStrictSsl(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    const mode = url.searchParams.get("sslmode");
    if (mode === "require" || mode === "prefer" || mode === "verify-ca") url.searchParams.set("sslmode", "verify-full");
    return url.toString();
  } catch {
    return connectionString;
  }
}

/**
 * Timeouts keep one slow or stuck request from blocking everyone: waiting for a free connection
 * fails after 10s, and any single statement is cancelled after 30s.
 */
export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({
    connectionString: withStrictSsl(connectionString),
    max,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
  });
}

const userIdSchema = z.uuid();

/**
 * Runs `fn` in a transaction as the RLS-restricted `chatbot_app` role with `app.user_id` set,
 * so row-level security limits every query to the given user's organizations.
 * Use this for all user-initiated dashboard and API requests.
 */
export async function withUserContext<T>(pool: pg.Pool, userId: string, fn: (db: DbClient) => Promise<T>): Promise<T> {
  const id = userIdSchema.parse(userId);
  return inTransaction(pool, async (db) => {
    await db.query("set local role chatbot_app");
    await db.query("select set_config('app.user_id', $1, true)", [id]);
    return fn(db);
  });
}

/**
 * Runs `fn` in a transaction as the owner role, which bypasses RLS.
 * Only for trusted server work (ingestion, writing conversations, creating organizations).
 * Callers must scope every query by organization_id themselves.
 */
export async function withTrustedContext<T>(pool: pg.Pool, fn: (db: DbClient) => Promise<T>): Promise<T> {
  return inTransaction(pool, fn);
}

async function inTransaction<T>(pool: pg.Pool, fn: (db: DbClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
