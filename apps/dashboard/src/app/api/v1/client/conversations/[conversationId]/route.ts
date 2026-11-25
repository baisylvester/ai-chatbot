import { deleteClientConversation, getClientConversation } from "@chatbot/core";
import { clientBot, clientPreflight, clientTrusted, withClientRequest } from "@/lib/client-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = clientPreflight;
type Context = { params: Promise<{ conversationId: string }> };
export async function GET(request: Request, { params }: Context) {
  return withClientRequest(request, async user => {
    const id = (await params).conversationId;
    const conversation = await clientTrusted(db => getClientConversation(db, user.id, id));
    await clientBot(request, conversation.chatbotId, false, user.id);
    return Response.json(conversation);
  });
}
export async function DELETE(request: Request, { params }: Context) {
  return withClientRequest(request, async user => {
    const id = (await params).conversationId;
    const conversation = await clientTrusted(db => getClientConversation(db, user.id, id));
    await clientBot(request, conversation.chatbotId, false, user.id);
    await clientTrusted(db => deleteClientConversation(db, user.id, id));
    return new Response(null, { status: 204 });
  });
}
