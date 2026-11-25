import { toPublicConfig } from "@chatbot/core";
import { clientBot, clientPreflight, withClientRequest } from "@/lib/client-api";
import { clientKnowledgeState } from "@/lib/native-knowledge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = clientPreflight;
export async function GET(request: Request, { params }: { params: Promise<{ chatbotId: string }> }) {
  return withClientRequest(request, async user => {
    const bot = await clientBot(request, (await params).chatbotId, true, user.id);
    return Response.json({ ...toPublicConfig(bot), knowledge: await clientKnowledgeState(request, user.id, bot) });
  });
}
