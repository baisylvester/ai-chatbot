import { getClientConversation, getChatbot, getOrganization, DomainError, listClientMessages, runClientConversationTurn } from "@chatbot/core";
import { withUserContext } from "@chatbot/database";
import type { ClientTurn } from "@chatbot/shared";
import { z } from "zod";
import { clientBot, clientError, clientPreflight, clientTrusted, withClientRequest } from "@/lib/client-api";
import { getPool } from "@/lib/db";
import { retrieverFor } from "@/lib/knowledge";
import { knowledgeChatbotForClient } from "@/lib/native-knowledge";
import { agentModel, EMAIL_MANAGER_NOTE, emailManagerReady, emailManagerTool, mailSetup } from "@/lib/mail-agent";
import { apiError, readJson, sse, sseHeaders } from "@/lib/public-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export const OPTIONS = clientPreflight;
type Context = { params: Promise<{ conversationId: string }> };
export async function GET(request: Request, { params }: Context) {
  return withClientRequest(request, async user => {
    const page = await clientTrusted(async db => listClientMessages(db, user.id, (await params).conversationId, new URL(request.url).searchParams.get("after") ?? "0"));
    await clientBot(request, page.conversation.chatbotId, false, user.id);
    return Response.json(page);
  });
}
const sendSchema = z.object({ requestId: z.uuid(), message: z.string().trim().min(1).max(4000), stream: z.boolean().optional(), emailManager: z.boolean().optional() }).strict();
const PERSONAL_ASSISTANT_NOTE = "You are the signed-in user's personal AI assistant for general questions, ideas, planning and writing as well as email. Answer general questions directly without accessing the mailbox. Use relevant retrieved knowledge and cite it for source-specific facts. For general questions unrelated to that material, you may answer from general knowledge without citing unrelated sources. If the user explicitly asks for a fact from the knowledge base and it is not present, say you do not have that information. Only use mailbox tools when the user's request needs their actual email. If mailbox tools are unavailable, you can still help with general questions and supplied text; explain that Gmail must be connected before reading or changing mail. Never invent mailbox facts or claim an email was sent. Sending and moving messages to Trash require explicit approval in the app.";
export async function POST(request: Request, { params }: Context) {
  return withClientRequest(request, async user => {
    const body = sendSchema.safeParse(await readJson(request, 32768));
    if (!body.success) return apiError(400, "invalid", "requestId (UUID) and message (1–4000 characters) are required");
    const id = (await params).conversationId;
    const conversation = await clientTrusted(db => getClientConversation(db, user.id, id));
    const bot = await clientBot(request, conversation.chatbotId, true, user.id);
    const useMail = body.data.emailManager === true;
    if (useMail) {
      // Mail remains an explicit, owner/admin-only capability, scoped to the caller's mailbox.
      await withUserContext(getPool(), user.id, async db => {
        await getChatbot(db, bot.id);
        const org = await getOrganization(db, bot.organization_id);
        if (org.role !== "owner" && org.role !== "admin") throw new DomainError("forbidden", "Only owners and admins can use mailbox tools", "mail_role_required");
      });
      if (!(await emailManagerReady(user.id))) return clientError(409, "conflict", "Connect Gmail on the Assistant page before using mailbox tools", "mailbox_not_connected");
    }
    // Personal assistants use the deployed assistant provider even if an older mapping retained a PC-local chatbot model.
    // This does not grant mailbox access: that capability still requires the explicit request and checks above.
    const assistantModel = useMail || bot.nativePersonalAssistant ? mailSetup() : null;
    if (assistantModel && !assistantModel.modelReady) return clientError(503, "unavailable", "The AI assistant is temporarily unavailable. Please try again later.");
    const knowledgeBot = await knowledgeChatbotForClient(request, user.id, bot);
    const events = runClientConversationTurn({
      trusted: clientTrusted, chatbot: bot, userId: user.id, sessionId: id,
      requestId: body.data.requestId, message: body.data.message, emailManager: useMail,
      env: process.env, retrieve: retrieverFor(knowledgeBot),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(240000)]),
      toolNote: [bot.nativePersonalAssistant ? PERSONAL_ASSISTANT_NOTE : "", useMail ? EMAIL_MANAGER_NOTE : ""].filter(Boolean).join("\n") || undefined,
      ...(useMail ? { tools: [emailManagerTool(user.id)] } : {}),
      ...(assistantModel ? {
        candidates: [{ provider: assistantModel.provider, model: assistantModel.model, create: () => agentModel(4096) }],
      } : {}),
    });
    // Claim before returning a stream so conflicts and invalid owners receive normal HTTP errors.
    const first = await events.next();
    if (!body.data.stream) {
      let turn: ClientTurn | null = !first.done && first.value.type === "done" ? first.value.turn : null;
      for await (const event of events) if (event.type === "done") turn = event.turn;
      if (!turn) return apiError(502, "interrupted", "The reply was interrupted. Refresh the conversation.");
      return Response.json({ turn });
    }
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (type: string, data: unknown) => { try { controller.enqueue(sse(type, data)); } catch { /* peer disconnected */ } };
        try {
          if (!first.done) send(first.value.type, first.value);
          for await (const event of events) send(event.type, event);
        } catch {
          send("error", { code: "interrupted", message: "The reply was interrupted. Refresh the conversation before retrying." });
        } finally { try { controller.close(); } catch { /* peer disconnected */ } }
      },
    });
    return new Response(stream, { headers: sseHeaders });
  });
}
