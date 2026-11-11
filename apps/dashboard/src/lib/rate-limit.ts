import "server-only";

/**
 * Fixed-window, in-memory rate limiter. Good enough for one server process (local dev, a single
 * instance). With several instances each keeps its own counts; move this to Postgres or Redis
 * (e.g. Upstash) before scaling out.
 */
const windows = new Map<string, { start: number; count: number }>();

export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterSec: number } {
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
