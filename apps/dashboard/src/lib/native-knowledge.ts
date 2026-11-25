import "server-only";
import { DomainError, knowledgeStateForChatbot, type Chatbot } from "@chatbot/core";
import { clientBot, clientTrusted } from "@/lib/client-api";

type ClientChatbot = Chatbot & { nativePersonalAssistant?: boolean };

/** Trusted deployment configuration selects an already-published chatbot, never all tenant knowledge. */
export async function sharedKnowledgeChatbot(request: Request, userId: string): Promise<ClientChatbot | null> {
  const publicId = process.env.NATIVE_KNOWLEDGE_CHATBOT_ID?.trim();
  if (!publicId) return null;
  try {
    const source = await clientBot(request, publicId, true, userId);
    // Personal assistants contain private account state and cannot become a platform-wide knowledge source.
    if (source.nativePersonalAssistant) throw new DomainError("forbidden", "A private assistant cannot be shared as a knowledge source.");
    return source;
  } catch (error) {
    if (error instanceof DomainError) throw new DomainError("conflict", "The linked knowledge base is unavailable. Please try again later.", "knowledge_unavailable");
    throw error;
  }
}

/** Evaluated on every request so source assignment, reprocessing and deletion stay in sync with web chat. */
export async function knowledgeChatbotForClient(request: Request, userId: string, assistant: ClientChatbot): Promise<ClientChatbot> {
  if (!assistant.nativePersonalAssistant) return assistant;
  return await sharedKnowledgeChatbot(request, userId) ?? assistant;
}

export async function clientKnowledgeState(request: Request, userId: string, assistant: ClientChatbot) {
  try {
    const source = await knowledgeChatbotForClient(request, userId, assistant);
    const state = await clientTrusted(db => knowledgeStateForChatbot(db, source));
    return { ...state, state: state.readyDocuments > 0 && state.chunks > 0 ? "ready" : state.processingDocuments > 0 ? "processing" : "empty",
      sourceChatbotId: source.public_id, sourceName: source.settings.name, shared: source.id !== assistant.id };
  } catch (error) {
    if (error instanceof DomainError && error.reason === "knowledge_unavailable") return { state: "unavailable" };
    throw error;
  }
}
