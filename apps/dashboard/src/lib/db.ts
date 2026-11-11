import "server-only";
import { createPool } from "@chatbot/database";
import type pg from "pg";

// One pool per server process (survives dev hot reloads). Uses the pooled URL (Supabase transaction pooler).
const globalForDb = globalThis as unknown as { chatbotPool?: pg.Pool };

export function getPool(): pg.Pool {
  if (process.env.CLOUDFLARE_WORKERS === "1") {
    // Workers sockets only trust public CAs, and Supabase signs with its own. Hyperdrive holds that CA
    // and the credentials, so connect through its binding (set by OpenNext on the request context).
    const context = (globalThis as Record<symbol, unknown>)[Symbol.for("__cloudflare-context__")] as
      { env?: { HYPERDRIVE?: { connectionString?: string } } } | undefined;
    const url = context?.env?.HYPERDRIVE?.connectionString ?? process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    // Workers forbid sharing sockets across requests. Release each transaction's socket,
    // including direct pool.query calls, instead of retaining it in a process-wide pool.
    return createPool(url, 1, { maxUses: 1 });
  }
  if (!globalForDb.chatbotPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    globalForDb.chatbotPool = createPool(url, Number(process.env.DATABASE_POOL_MAX) || 10);
  }
  return globalForDb.chatbotPool;
}
