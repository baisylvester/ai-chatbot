import "server-only";
import { createClient } from "@supabase/supabase-js";
import { DomainError, loadBot, upsertUser, type Chatbot } from "@chatbot/core";
import { withTrustedContext } from "@chatbot/database";
import { isOriginAllowed } from "@chatbot/shared";
import { getPool } from "@/lib/db";
import { supabaseConfig } from "@/lib/auth/server";
import { getCurrentUser, type SessionUser } from "@/lib/session";
import { apiError, corsHeaders, platformOrigins } from "@/lib/public-api";
import { rateLimit } from "@/lib/rate-limit";

/** The public error body plus an optional machine-readable `reason` (additive; older clients ignore it). */
export function clientError(status: number, code: string, message: string, reason?: string, headers: HeadersInit = {}) {
  return Response.json({ error: { code, message, ...(reason ? { reason } : {}) } }, { status, headers });
}

export const clientTrusted = <T,>(fn: Parameters<typeof withTrustedContext<T>>[1]) => withTrustedContext(getPool(), fn);
export function clientHeaders(request: Request) {
  return { ...corsHeaders(request.headers.get("origin")), "Access-Control-Expose-Headers": "X-Authenticated-User", "Cache-Control": "private, no-store", Vary: "Origin, Authorization, Cookie" };
}
export function clientPreflight(request: Request) {
  return new Response(null, { status: 204, headers: { ...clientHeaders(request), "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS" } });
}

/** A bearer token is a verified Supabase user token, NEVER an organization API key or widget token. */
export async function authenticateClient(request: Request): Promise<SessionUser | Response> {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const token = /^Bearer (\S+)$/i.exec(authorization)?.[1];
    if (!token || token.length > 16000) return apiError(401, "unauthorized", "A valid user access token is required");
    const { url, key } = supabaseConfig();
    const auth = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const { data, error } = await auth.auth.getClaims(token);
    const c = data?.claims;
    if (error || !c?.sub || !c.email || c.iss !== `${url.replace(/\/$/, "")}/auth/v1` ||
      !(c.aud === "authenticated" || (Array.isArray(c.aud) && c.aud.includes("authenticated")))) {
      return apiError(401, "unauthorized", "Your sign-in expired. Sign in again.");
    }
    const user = { id: c.sub, email: c.email, name: typeof c.user_metadata?.name === "string" ? c.user_metadata.name : null };
    await clientTrusted(db => upsertUser(db, user));
    return user;
  }
  // Cookies are supported for the first-party web app only. Native and third-party web clients
  // must supply their own user token; cross-site cookies cannot authorize a request.
  const origin = request.headers.get("origin");
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site" ||
    (request.method !== "GET" && origin !== new URL(request.url).origin)) {
    return apiError(403, "forbidden", "Cross-site requests require a user access token");
  }
  return await getCurrentUser() ?? apiError(401, "unauthorized", "Sign in to continue");
}

/** Native HTTP requests do not have a web Origin. Browser origins retain the widget allowlist. */
export async function clientBot(request: Request, publicId: string, active = true, userId?: string): Promise<Chatbot & { nativePersonalAssistant: boolean }> {
  const bot = await clientTrusted(db => loadBot(db, "c.public_id = $1", publicId));
  if (!bot || (active && bot.status !== "active")) throw new DomainError("not_found", "Chatbot not available");
  const owner = await clientTrusted(async db => (await db.query<{ user_id: string }>("select user_id from native_accounts where chatbot_id=$1",[bot.id])).rows[0]);
  if (owner && owner.user_id !== userId) throw new DomainError("not_found", "Chatbot not available");
  const origin = request.headers.get("origin");
  if (origin && !platformOrigins(request).includes(origin) && !isOriginAllowed(origin, bot.domains)) {
    throw new DomainError("forbidden", "This website is not allowed to use this chatbot");
  }
  return { ...bot, nativePersonalAssistant: Boolean(owner) };
}

export async function withClientRequest(request: Request, handler: (user: SessionUser) => Promise<Response>): Promise<Response> {
  const headers = clientHeaders(request);
  let response: Response;
  let authenticatedUser: string | undefined;
  try {
    const user = await authenticateClient(request);
    if (user instanceof Response) response = user;
    else {
      authenticatedUser = user.id;
      const rl = await rateLimit(`client:${request.method}:${user.id}`, request.method === "GET" ? 120 : 20, 60_000);
      response = rl.ok ? await handler(user) : apiError(429, "rate_limited", "Too many requests. Wait a moment.", { "Retry-After": String(rl.retryAfterSec) });
    }
  } catch (err) {
    if (err instanceof DomainError) {
      response = clientError(({ not_found: 404, forbidden: 403, conflict: 409, invalid: 400 })[err.code], err.code, err.message, err.reason);
    } else {
      console.error("client API request failed", err instanceof Error ? err.name : "Unknown error");
      response = apiError(500, "server_error", "Something went wrong. Refresh the conversation before retrying.");
    }
  }
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  if (authenticatedUser) response.headers.set("X-Authenticated-User", authenticatedUser);
  return response;
}
