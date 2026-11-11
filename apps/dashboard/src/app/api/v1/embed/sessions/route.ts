/**
 * POST /api/v1/embed/sessions  { chatbotId }
 * Starts a widget conversation for an allowed website and returns a short-lived session token.
 */
import { z } from "zod";
import { createWidgetSession, resolveForOrigin, toPublicConfig } from "@chatbot/core";
import { withTrustedContext } from "@chatbot/database";
import { getPool } from "@/lib/db";
import { apiError, clientIp, corsHeaders, embedSecret, errorResponse, platformOrigins, preflight, requestOrigin } from "@/lib/public-api";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

const bodySchema = z.object({ chatbotId: z.string().max(80) });

export async function POST(request: Request) {
  const origin = requestOrigin(request);
  const headers = corsHeaders(origin);
  const limited = rateLimit(`embed-session:${clientIp(request)}`, 10, 60_000);
  if (!limited.ok) return apiError(429, "rate_limited", "Too many new conversations. Try again shortly.", { ...headers, "Retry-After": String(limited.retryAfterSec) });

  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError(400, "invalid_request", "chatbotId is required", headers);
  try {
    const result = await withTrustedContext(getPool(), async (db) => {
      const bot = await resolveForOrigin(db, body.data.chatbotId, origin, platformOrigins(request));
      const session = await createWidgetSession(db, bot, origin!, embedSecret());
      return { ...session, config: toPublicConfig(bot) };
    });
    return Response.json({ token: result.token, expiresAt: result.expiresAt, config: result.config }, { headers });
  } catch (err) {
    return errorResponse(err, headers);
  }
}
