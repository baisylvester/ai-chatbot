/** POST /api/v1/embed/voice/transcribe — multipart { audio: File, durationMs? } → { text } (standard voice mode). */
import { transcribeForWidget } from "@chatbot/core";
import { MAX_AUDIO_BYTES } from "@chatbot/voice-engine";
import { apiError, bodyTooLarge, preflight } from "@/lib/public-api";
import { authorizeWidget, trusted, voiceErrorResponse } from "@/lib/widget-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export async function POST(request: Request) {
  const ctx = await authorizeWidget(request, { key: "voice-stt", max: 20, windowMs: 60_000 });
  if (ctx instanceof Response) return ctx;
  // Check the declared size before reading the multipart body.
  if (bodyTooLarge(request, MAX_AUDIO_BYTES + 64 * 1024)) return apiError(413, "too_large", "The recording is too long", ctx.headers);
  const form = await request.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!(audio instanceof File) || audio.size === 0) return apiError(400, "invalid_request", "No audio was received", ctx.headers);
  if (audio.size > MAX_AUDIO_BYTES) return apiError(413, "too_large", "The recording is too long", ctx.headers);
  if (audio.type && !audio.type.startsWith("audio/")) return apiError(400, "invalid_request", "Unsupported audio type", ctx.headers);
  try {
    const result = await transcribeForWidget(trusted, {
      bot: ctx.bot,
      sessionId: ctx.sessionId,
      audio: new Uint8Array(await audio.arrayBuffer()),
      mimeType: audio.type || "audio/webm",
      durationMs: Number(form?.get("durationMs") ?? 0) || undefined,
      env: process.env,
    });
    return Response.json(result, { headers: ctx.headers });
  } catch (err) {
    return voiceErrorResponse(err, ctx.headers);
  }
}
