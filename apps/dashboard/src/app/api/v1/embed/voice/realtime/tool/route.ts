/** POST /api/v1/embed/voice/realtime/tool — { voiceSessionId, name, arguments } → { output } for the realtime model. */
import { z } from "zod";
import { runRealtimeTool } from "@chatbot/core";
import { retrieverFor } from "@/lib/knowledge";
import { apiError, preflight } from "@/lib/public-api";
import { authorizeWidget, trusted, voiceErrorResponse } from "@/lib/widget-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const bodySchema = z.object({ voiceSessionId: z.string().max(80), name: z.string().max(80), arguments: z.string().max(4000) });

export async function POST(request: Request) {
  const ctx = await authorizeWidget(request, { key: "voice-tool", max: 30, windowMs: 60_000 });
  if (ctx instanceof Response) return ctx;
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError(400, "invalid_request", "Invalid tool call", ctx.headers);
  let args: unknown = {};
  try {
    args = JSON.parse(body.data.arguments || "{}");
  } catch {
    args = {};
  }
  try {
    const result = await runRealtimeTool(trusted, {
      bot: ctx.bot,
      sessionId: ctx.sessionId,
      voiceSessionId: body.data.voiceSessionId,
      name: body.data.name,
      args,
      retrieve: retrieverFor(ctx.bot),
    });
    return Response.json(
      { output: result.output, citations: result.citations.map(({ n, title, sourceUrl, snippet }) => ({ n, title, sourceUrl, snippet })) },
      { headers: ctx.headers },
    );
  } catch (err) {
    return voiceErrorResponse(err, ctx.headers);
  }
}
