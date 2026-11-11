/**
 * POST /api/v1/embed/messages  (Authorization: Bearer <session token>)  { message }
 * Streams the chatbot's reply as Server-Sent Events: sources, token, done, error.
 * Public responses never include provider names, model ids or internal error details.
 */
import { z } from "zod";
import { authorizeWidgetMessage, MAX_USER_MESSAGE_CHARS, runConversationTurn } from "@chatbot/core";
import { withTrustedContext } from "@chatbot/database";
import { getPool } from "@/lib/db";
import { retrieverFor } from "@/lib/knowledge";
import { apiError, clientIp, corsHeaders, embedSecret, errorResponse, platformOrigins, preflight, requestOrigin, sse, sseHeaders } from "@/lib/public-api";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

const bodySchema = z.object({ message: z.string().trim().min(1, "Type a message first").max(MAX_USER_MESSAGE_CHARS) });

export async function POST(request: Request) {
  const origin = requestOrigin(request);
  const headers = corsHeaders(origin);
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!token) return apiError(401, "invalid_token", "Missing session token", headers);
  if (!rateLimit(`embed-msg-ip:${clientIp(request)}`, 60, 60_000).ok) return apiError(429, "rate_limited", "Too many messages. Wait a moment.", headers);

  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError(400, "invalid_request", body.error.issues[0]?.message ?? "Invalid request", headers);

  const pool = getPool();
  let auth;
  try {
    auth = await withTrustedContext(pool, (db) => authorizeWidgetMessage(db, token, origin, embedSecret(), platformOrigins(request)));
  } catch (err) {
    return errorResponse(err, headers);
  }
  if (!rateLimit(`embed-msg-session:${auth.sessionId}`, 20, 60_000).ok) {
    return apiError(429, "rate_limited", "Too many messages. Wait a moment.", headers);
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (event: string, data: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(sse(event, data));
        } catch {
          open = false;
        }
      };
      try {
        for await (const e of runConversationTurn({
          trusted: (fn) => withTrustedContext(pool, fn),
          chatbot: auth.bot,
          message: body.data.message,
          sessionId: auth.sessionId,
          source: "widget",
          origin: origin ?? undefined,
          env: process.env,
          signal: request.signal,
          retrieve: retrieverFor(auth.bot),
        })) {
          if (e.type === "sources") {
            send("sources", { citations: e.citations.map(({ n, title, sourceUrl, snippet }) => ({ n, title, sourceUrl, snippet })) });
          } else if (e.type === "token") send("token", { text: e.text });
          else if (e.type === "done") send("done", {});
          else if (e.type === "error") {
            send("error", {
              code: e.reason,
              message: e.reason === "interrupted" ? "The reply was interrupted. Please try again." : "The assistant is unavailable right now. Please try again later.",
            });
          }
        }
      } catch (err) {
        console.error("widget turn failed", err);
        send("error", { code: "server_error", message: "Something went wrong. Please try again." });
      } finally {
        if (open) controller.close();
      }
    },
  });
  return new Response(stream, { headers: { ...headers, ...sseHeaders } });
}
