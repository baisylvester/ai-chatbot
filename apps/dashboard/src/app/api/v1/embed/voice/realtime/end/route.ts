/** POST /api/v1/embed/voice/realtime/end — { voiceSessionId, transcript, failed? } records the call. */
import { z } from "zod";
import { endRealtimeSession } from "@chatbot/core";
import { apiError, preflight } from "@/lib/public-api";
import { authorizeWidget, trusted, voiceErrorResponse } from "@/lib/widget-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const bodySchema = z.object({ voiceSessionId: z.string().max(80), transcript: z.unknown().optional(), failed: z.boolean().optional() });

export async function POST(request: Request) {
  const ctx = await authorizeWidget(request, { key: "voice-end", max: 10, windowMs: 60_000 });
  if (ctx instanceof Response) return ctx;
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError(400, "invalid_request", "voiceSessionId is required", ctx.headers);
  try {
    const result = await endRealtimeSession(trusted, {
      bot: ctx.bot,
      sessionId: ctx.sessionId,
      voiceSessionId: body.data.voiceSessionId,
      transcript: body.data.transcript ?? [],
      failed: body.data.failed,
    });
    return Response.json(result, { headers: ctx.headers });
  } catch (err) {
    return voiceErrorResponse(err, ctx.headers);
  }
}
