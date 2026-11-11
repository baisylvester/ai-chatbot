/** POST /api/v1/embed/voice/speech — { text } → audio (standard voice mode). */
import { z } from "zod";
import { synthesizeForWidget } from "@chatbot/core";
import { MAX_TTS_CHARS } from "@chatbot/voice-engine";
import { apiError, preflight } from "@/lib/public-api";
import { authorizeWidget, trusted, voiceErrorResponse } from "@/lib/widget-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const bodySchema = z.object({ text: z.string().trim().min(1).max(MAX_TTS_CHARS * 2) });

export async function POST(request: Request) {
  const ctx = await authorizeWidget(request, { key: "voice-tts", max: 30, windowMs: 60_000 });
  if (ctx instanceof Response) return ctx;
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError(400, "invalid_request", "text is required", ctx.headers);
  try {
    const { audio, mimeType } = await synthesizeForWidget(trusted, { bot: ctx.bot, sessionId: ctx.sessionId, text: body.data.text, env: process.env });
    return new Response(new Uint8Array(audio), { headers: { ...ctx.headers, "Content-Type": mimeType, "Cache-Control": "no-store" } });
  } catch (err) {
    return voiceErrorResponse(err, ctx.headers);
  }
}
