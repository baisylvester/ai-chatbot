/** GET /api/v1/embed/config?chatbotId=cb_… — public widget settings for an allowed website. */
import { resolveForOrigin, toPublicConfig } from "@chatbot/core";
import { withTrustedContext } from "@chatbot/database";
import { getPool } from "@/lib/db";
import { apiError, corsHeaders, errorResponse, platformOrigins, preflight, requestOrigin } from "@/lib/public-api";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/public-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

export async function GET(request: Request) {
  const origin = requestOrigin(request);
  const headers = corsHeaders(origin);
  if (!rateLimit(`embed-config:${clientIp(request)}`, 60, 60_000).ok) return apiError(429, "rate_limited", "Too many requests", headers);
  const chatbotId = new URL(request.url).searchParams.get("chatbotId") ?? "";
  try {
    const bot = await withTrustedContext(getPool(), (db) => resolveForOrigin(db, chatbotId, origin, platformOrigins(request)));
    return Response.json(toPublicConfig(bot), { headers: { ...headers, "Cache-Control": "private, max-age=60" } });
  } catch (err) {
    return errorResponse(err, headers);
  }
}
