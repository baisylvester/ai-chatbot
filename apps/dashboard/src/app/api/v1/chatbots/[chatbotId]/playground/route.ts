/**
 * POST /api/v1/chatbots/:chatbotId/playground
 * Streams a test conversation for organization owners/admins as Server-Sent Events.
 * Body: { message: string, sessionId?: string }
 * Events: session, sources, start, token, done, error (each `data:` is JSON).
 */
import { z } from "zod";
import { DomainError, getChatbot, getOrganization, MAX_USER_MESSAGE_CHARS, runConversationTurn, type TurnEvent } from "@chatbot/core";
import { withTrustedContext, withUserContext } from "@chatbot/database";
import { getPool } from "@/lib/db";
import { retrieverFor } from "@/lib/knowledge";
import { rateLimit } from "@/lib/rate-limit";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  message: z.string().trim().min(1, "Type a message first").max(MAX_USER_MESSAGE_CHARS),
  sessionId: z.uuid().optional(),
});

const json = (status: number, error: string, headers?: Record<string, string>) =>
  Response.json({ error }, { status, headers });

/** What the browser sees. Admin playground: provider error messages are shown to help fix configuration. */
function toClientEvent(e: TurnEvent): { event: string; data: unknown } {
  switch (e.type) {
    case "session":
      return { event: "session", data: { sessionId: e.sessionId } };
    case "sources":
      return { event: "sources", data: { citations: e.citations } };
    case "start":
      return { event: "start", data: { provider: e.provider, model: e.model } };
    case "token":
      return { event: "token", data: { text: e.text } };
    case "done":
      return {
        event: "done",
        data: { provider: e.provider, model: e.model, usage: e.usage, latencyMs: e.latencyMs, failedAttempts: e.failedAttempts },
      };
    case "error": {
      const message =
        e.reason === "unavailable"
          ? "No model could answer. Check the provider settings below."
          : e.reason === "interrupted"
            ? "The reply was interrupted."
            : "Cancelled.";
      return { event: "error", data: { reason: e.reason, message, failedAttempts: e.failedAttempts } };
    }
  }
}

export async function POST(request: Request, ctx: { params: Promise<{ chatbotId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return json(401, "Sign in to use the playground");

  const limited = rateLimit(`playground:${user.id}`, 20, 60_000);
  if (!limited.ok) return json(429, "Too many messages. Wait a moment and try again.", { "Retry-After": String(limited.retryAfterSec) });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json(400, parsed.error.issues[0]?.message ?? "Invalid request");

  const { chatbotId } = await ctx.params;
  const pool = getPool();
  let chatbot;
  try {
    // RLS context: proves the user belongs to the chatbot's organization.
    chatbot = await withUserContext(pool, user.id, async (db) => {
      const bot = await getChatbot(db, chatbotId);
      const org = await getOrganization(db, bot.organization_id);
      if (org.role !== "owner" && org.role !== "admin") {
        throw new DomainError("forbidden", "Only owners and admins can use the playground");
      }
      return bot;
    });
  } catch (err) {
    if (err instanceof DomainError) return json(err.code === "forbidden" ? 403 : 404, err.message);
    throw err;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (event: string, data: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          open = false; // client went away; keep running so the turn is still persisted
        }
      };
      try {
        for await (const e of runConversationTurn({
          trusted: (fn) => withTrustedContext(pool, fn),
          chatbot,
          message: parsed.data.message,
          sessionId: parsed.data.sessionId,
          source: "playground",
          createdBy: user.id,
          env: process.env,
          signal: request.signal,
          retrieve: retrieverFor(chatbot),
        })) {
          const { event, data } = toClientEvent(e);
          send(event, data);
        }
      } catch (err) {
        if (err instanceof DomainError) send("error", { reason: err.code, message: err.message, failedAttempts: [] });
        else {
          console.error("playground turn failed", err);
          send("error", { reason: "server", message: "Something went wrong. Please try again.", failedAttempts: [] });
        }
      } finally {
        if (open) controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
