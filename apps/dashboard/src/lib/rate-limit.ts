import "server-only";
import { getPool } from "@/lib/db";
import { log } from "@/lib/log";

/**
 * Fixed-window rate limiting shared by every server instance (Postgres `rate_limit_hit`).
 * If the database can't be reached, falls back to a per-process in-memory window so requests
 * are still limited. Set RATE_LIMIT_STORE=memory to use only the in-memory limiter (tests, single box).
 */
export type RateLimitResult = { ok: boolean; retryAfterSec: number };

const windows = new Map<string, { start: number; count: number }>();

export function rateLimitMemory(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || now - w.start >= windowMs) {
    windows.set(key, { start: now, count: 1 });
    if (windows.size > 10_000) {
      for (const [k, v] of windows) if (now - v.start >= windowMs) windows.delete(k);
    }
    return { ok: true, retryAfterSec: 0 };
  }
  if (w.count >= limit) return { ok: false, retryAfterSec: Math.ceil((w.start + windowMs - now) / 1000) };
  w.count++;
  return { ok: true, retryAfterSec: 0 };
}

let lastFallbackLog = 0;

export async function rateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  if (process.env.RATE_LIMIT_STORE === "memory") return rateLimitMemory(key, limit, windowMs);
  try {
    const { rows } = await getPool().query<{ allowed: boolean; retry_after: number }>(
      "select allowed, retry_after from public.rate_limit_hit($1, $2, $3)",
      [key.slice(0, 200), limit, Math.max(1, Math.round(windowMs / 1000))],
    );
    const row = rows[0];
    return row ? { ok: row.allowed, retryAfterSec: row.allowed ? 0 : row.retry_after } : rateLimitMemory(key, limit, windowMs);
  } catch (err) {
    if (Date.now() - lastFallbackLog > 60_000) {
      lastFallbackLog = Date.now();
      log.warn("rate_limit.fallback_memory", { error: err });
    }
    return rateLimitMemory(key, limit, windowMs);
  }
}
