/**
 * POST /api/v1/embed/voice/realtime — starts a realtime voice call.
 * Returns a short-lived provider client secret (never the API key) for the browser's WebRTC offer.
 */
import { startRealtimeSession } from "@chatbot/core";
import { preflight } from "@/lib/public-api";
import { authorizeWidget, trusted, voiceErrorResponse } from "@/lib/widget-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export async function POST(request: Request) {
  const ctx = await authorizeWidget(request, { key: "voice-rt", max: 5, windowMs: 60_000 });
  if (ctx instanceof Response) return ctx;
  try {
    const call = await startRealtimeSession(trusted, { bot: ctx.bot, sessionId: ctx.sessionId, env: process.env });
    return Response.json(
      { voiceSessionId: call.voiceSessionId, clientSecret: call.clientSecret, expiresAt: call.expiresAt, callsUrl: call.callsUrl, model: call.model, voice: call.voice },
      { headers: { ...ctx.headers, "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return voiceErrorResponse(err, ctx.headers);
  }
}
