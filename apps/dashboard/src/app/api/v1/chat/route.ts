/**
 * POST /api/v1/chat — server-to-server chat for external applications.
 * Authorization: Bearer cbk_…  (private API key; never use it in browser code)
 * Body: { chatbotId: "cb_…", message: string, sessionId?: string, stream?: boolean }
 * Response (stream=false): { sessionId, reply, citations, usage }
 * Response (stream=true):  Server-Sent Events: session, sources, token, done, error
 * No CORS headers are sent, so browsers on other sites cannot call this endpoint.
 */
import { z } from "zod";
import { MAX_USER_MESSAGE_CHARS, resolveApiKey, resolveForApiKey, runConversationTurn, type Citation, type TurnEvent } from "@chatbot/core";
import { withTrustedContext } from "@chatbot/database";
import { getPool } from "@/lib/db";
import { retrieverFor } from "@/lib/knowledge";
import { apiError, errorResponse, sse, sseHeaders } from "@/lib/public-api";
import { readJson } from "@/lib/public-api";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  chatbotId: z.string().max(80),
  message: z.string().trim().min(1, "message is required").max(MAX_USER_MESSAGE_CHARS),
  sessionId: z.uuid().optional(),
  stream: z.boolean().optional(),
});

export async function POST(request: Request) {
  const key = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const pool = getPool();
  const apiKey = key ? await withTrustedContext(pool, (db) => resolveApiKey(db, key)) : null;
  if (!apiKey) return apiError(401, "unauthorized", "A valid API key is required (Authorization: Bearer cbk_…)");
  const limited = await rateLimit(`api:${apiKey.keyId}`, 120, 60_000);
  if (!limited.ok) return apiError(429, "rate_limited", "Rate limit exceeded", { "Retry-After": String(limited.retryAfterSec) });

  const body = bodySchema.safeParse(await readJson(request, 32_768));
  if (!body.success) return apiError(400, "invalid_request", body.error.issues[0]?.message ?? "Invalid request");

  let bot;
  try {
    bot = await withTrustedContext(pool, (db) => resolveForApiKey(db, body.data.chatbotId, apiKey.organizationId));
  } catch (err) {
    return errorResponse(err);
  }

  const turn = () =>
    runConversationTurn({
      trusted: (fn) => withTrustedContext(pool, fn),
      chatbot: bot,
      message: body.data.message,
      sessionId: body.data.sessionId,
      source: "api",
      env: process.env,
      signal: request.signal,
      retrieve: retrieverFor(bot),
    });

  if (!body.data.stream) {
    let sessionId = "";
    let reply = "";
    let citations: Citation[] = [];
    let usage: { inputTokens: number; outputTokens: number } | null = null;
    try {
      for await (const e of turn()) {
        if (e.type === "session") sessionId = e.sessionId;
        else if (e.type === "sources") citations = e.citations;
        else if (e.type === "token") reply += e.text;
        else if (e.type === "done") usage = e.usage;
        else if (e.type === "error") return apiError(502, e.reason, "The model could not answer. Please try again later.");
      }
    } catch (err) {
      return errorResponse(err);
    }
    return Response.json({ sessionId, reply, citations, usage });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(sse(event, data));
        } catch {
          /* client disconnected */
        }
      };
      try {
        for await (const e of turn() as AsyncGenerator<TurnEvent>) {
          if (e.type === "session") send("session", { sessionId: e.sessionId });
          else if (e.type === "sources") send("sources", { citations: e.citations });
          else if (e.type === "token") send("token", { text: e.text });
          else if (e.type === "done") send("done", { usage: e.usage });
          else if (e.type === "error") send("error", { code: e.reason, message: "The model could not answer." });
        }
      } catch (err) {
        const known = err instanceof Error && "code" in err;
        send("error", { code: known ? (err as { code: string }).code : "server_error", message: known ? err.message : "Something went wrong" });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });
  return new Response(stream, { headers: sseHeaders });
}
