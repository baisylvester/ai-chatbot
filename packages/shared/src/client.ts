/** Transport contract shared by web, Android and Apple clients. Cursors are decimal strings. */
export type ClientTurnStatus = "running" | "completed" | "failed" | "interrupted";
export interface ClientCitation { n: number; title: string; sourceUrl: string | null; snippet: string }
export interface ClientTurn {
  requestId: string;
  status: ClientTurnStatus;
  text: string;
  citations: ClientCitation[];
  error: string | null;
}
export interface ClientConversation {
  id: string;
  chatbotId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  revision: string;
  lastTurn: ClientTurn | null;
}
export interface ClientMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  citations: ClientCitation[];
  sequence: string;
  createdAt: string;
  requestId: string | null;
  status: ClientTurnStatus;
}
export interface ClientMessagePage {
  conversation: ClientConversation;
  messages: ClientMessage[];
  nextCursor: string;
  hasMore: boolean;
}
export interface ClientConversationPage {
  conversations: ClientConversation[];
  nextCursor: string | null;
}
export type ClientStreamEvent =
  | { type: "accepted"; requestId: string }
  | { type: "token"; text: string }
  | { type: "sources"; citations: ClientCitation[] }
  | { type: "tool"; name: string; phase: "start" | "end"; steps?: string[]; waiting?: number; failed?: boolean }
  | { type: "done"; turn: ClientTurn };
