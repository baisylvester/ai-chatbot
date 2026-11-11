import "server-only";
import { DomainError, EmbedError } from "@chatbot/core";

/** Consistent error body for public endpoints: { error: { code, message } }. */
export function apiError(status: number, code: string, message: string, headers: HeadersInit = {}) {
  return Response.json({ error: { code, message } }, { status, headers });
}

export function errorResponse(err: unknown, headers: HeadersInit = {}) {
  if (err instanceof EmbedError) return apiError(err.status, err.code, err.message, headers);
  if (err instanceof DomainError) {
    const status = err.code === "not_found" ? 404 : err.code === "forbidden" ? 403 : err.code === "conflict" ? 409 : 400;
    return apiError(status, err.code, err.message, headers);
  }
  console.error("public API error", err);
  return apiError(500, "server_error", "Something went wrong. Please try again.", headers);
}

/**
 * CORS for widget endpoints. The response echoes the request Origin; whether that origin may use a
 * given chatbot is decided by the endpoint itself (domain allowlist). No cookies are ever accepted.
 */
export function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export function preflight(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });
}

/** The platform's own origin; its iframe page may use any active chatbot. */
export function platformOrigins(request: Request): string[] {
  const own = new URL(request.url).origin;
  const configured = process.env.NEXT_PUBLIC_PLATFORM_URL ? new URL(process.env.NEXT_PUBLIC_PLATFORM_URL).origin : null;
  return configured && configured !== own ? [own, configured] : [own];
}

/**
 * The calling page's origin. Browsers omit the Origin header on same-origin GET requests (e.g. the
 * platform's own iframe page loading its config), so a request the browser marks as same-origin
 * via Sec-Fetch-Site is attributed to the platform's own origin.
 */
export function requestOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (origin) return origin;
  return request.headers.get("sec-fetch-site") === "same-origin" ? new URL(request.url).origin : null;
}

/** Best-effort client IP for rate limiting (first X-Forwarded-For hop when behind a proxy). */
export function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local";
}

export function embedSecret(): string | undefined {
  return process.env.EMBED_TOKEN_SECRET;
}

export function sse(event: string, data: unknown) {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export const sseHeaders = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
};
