import "server-only";
import { authorizeWidgetMessage, DomainError, EmbedError, type Chatbot } from "@chatbot/core";
import { withTrustedContext } from "@chatbot/database";
import { VoiceError } from "@chatbot/voice-engine";
import { getPool } from "@/lib/db";
import { apiError, corsHeaders, embedSecret, errorResponse, platformOrigins, requestOrigin } from "@/lib/public-api";
import { rateLimit } from "@/lib/rate-limit";

export interface WidgetContext {
  bot: Chatbot;
  sessionId: string;
  origin: string | null;
  headers: Record<string, string>;
}

/**
 * Authorizes a widget request (session token + Origin, re-checked against the chatbot's domains)
 * and applies a per-session rate limit. Returns a Response when the request must be refused.
 */
export async function authorizeWidget(request: Request, limit: { key: string; max: number; windowMs: number }): Promise<WidgetContext | Response> {
  const origin = requestOrigin(request);
  const headers = corsHeaders(origin);
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!token) return apiError(401, "invalid_token", "Missing session token", headers);
  try {
    const { bot, sessionId } = await withTrustedContext(getPool(), (db) => authorizeWidgetMessage(db, token, origin, embedSecret(), platformOrigins(request)));
    const rl = await rateLimit(`${limit.key}:${sessionId}`, limit.max, limit.windowMs);
    if (!rl.ok) return apiError(429, "rate_limited", "Too many requests. Wait a moment.", { ...headers, "Retry-After": String(rl.retryAfterSec) });
    return { bot, sessionId, origin, headers };
  } catch (err) {
    return errorResponse(err, headers);
  }
}

/** Maps voice errors to public responses without leaking provider details. */
export function voiceErrorResponse(err: unknown, headers: Record<string, string>): Response {
  if (err instanceof VoiceError) {
    if (err.code === "invalid") return apiError(400, "invalid_request", err.message, headers);
    if (err.code === "unsupported") return apiError(400, "unsupported", "This voice feature isn't available for this chatbot.", headers);
    console.error("voice provider problem", err.message);
    return apiError(503, "voice_unavailable", "Voice isn't available right now. You can still type.", headers);
  }
  if (err instanceof DomainError || err instanceof EmbedError) return errorResponse(err, headers);
  console.error("voice error", err);
  return apiError(500, "server_error", "Something went wrong. Please try again.", headers);
}

export const trusted = <T,>(fn: Parameters<typeof withTrustedContext<T>>[1]) => withTrustedContext(getPool(), fn);
