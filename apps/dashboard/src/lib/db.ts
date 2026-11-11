import "server-only";
import { createPool } from "@chatbot/database";
import type pg from "pg";

// One pool per server process (survives dev hot reloads). Uses the pooled Neon URL.
const globalForDb = globalThis as unknown as { chatbotPool?: pg.Pool };

export function getPool(): pg.Pool {
  if (!globalForDb.chatbotPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    globalForDb.chatbotPool = createPool(url, 5);
  }
  return globalForDb.chatbotPool;
}
