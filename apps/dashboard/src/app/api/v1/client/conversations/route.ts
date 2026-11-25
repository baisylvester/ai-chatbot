import { createClientConversation, listClientConversations } from "@chatbot/core";
import { z } from "zod";
import { clientBot, clientPreflight, clientTrusted, withClientRequest } from "@/lib/client-api";
import { apiError, readJson } from "@/lib/public-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = clientPreflight;
export async function GET(request: Request) {
  return withClientRequest(request, async user => {
    const query = new URL(request.url).searchParams;
    const bot = await clientBot(request, query.get("chatbotId") ?? "", false, user.id);
    return Response.json(await clientTrusted(db => listClientConversations(db, user.id, bot, query.get("before") ?? undefined)));
  });
}
const createSchema = z.object({ id: z.uuid(), chatbotId: z.string().min(1).max(80) }).strict();
export async function POST(request: Request) {
  return withClientRequest(request, async user => {
    const body = createSchema.safeParse(await readJson(request, 4096));
    if (!body.success) return apiError(400, "invalid", "id (UUID) and chatbotId are required");
    const bot = await clientBot(request, body.data.chatbotId, true, user.id);
    return Response.json(await clientTrusted(db => createClientConversation(db, user.id, bot, body.data.id)));
  });
}
