import type { ClientConversation, ClientConversationPage, ClientMessagePage, ClientStreamEvent, ClientTurn } from "@chatbot/shared";
export type { ClientConversation, ClientConversationPage, ClientMessage, ClientMessagePage, ClientStreamEvent, ClientTurn } from "@chatbot/shared";

export class ClientApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.name = "ClientApiError"; this.status = status; this.code = code;
  }
}

/** SSE framing tolerates CRLF split across chunks and UTF-8 split across network packets. */
export async function* clientEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, "\n");
      if (buffer.length > 1048576) throw new ClientApiError(0, "protocol_error", "The server sent an oversized event");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of raw.split("\n")) {
          const field = line.indexOf(":");
          if (field < 0) continue;
          const name = line.slice(0, field);
          const value = line.slice(field + 1).replace(/^ /, "");
          if (name === "event") event = value;
          else if (name === "data") data.push(value);
        }
        if (data.length) {
          let parsed: unknown;
          try { parsed = JSON.parse(data.join("\n")); }
          catch { throw new ClientApiError(0, "protocol_error", "The server sent an invalid event"); }
          yield { event, data: parsed };
        }
      }
      if (done) return;
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Headless: no window, browser storage, React, or organization keys. */
export class SyncedChatClient {
  private readonly base: string;
  private readonly getAccessToken?: () => Promise<string | null>;
  private readonly expectedUserId?: string;
  constructor(options: { apiUrl: string; getAccessToken?: () => Promise<string | null>; expectedUserId?: string }) {
    this.base = options.apiUrl.replace(/\/+$/, "");
    this.getAccessToken = options.getAccessToken;
    this.expectedUserId = options.expectedUserId;
  }
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.getAccessToken) {
      const token = await this.getAccessToken();
      if (!token) throw new ClientApiError(401, "unauthorized", "Sign in to continue");
      headers.set("Authorization", `Bearer ${token}`);
    }
    const response = await fetch(`${this.base}/api/v1/client${path}`, {
      ...init, headers, credentials: this.getAccessToken ? "omit" : "same-origin", cache: "no-store",
    });
    if (response.ok && this.expectedUserId && response.headers.get("X-Authenticated-User") !== this.expectedUserId) {
      throw new ClientApiError(401, "account_changed", "Your account changed. Reload this page to continue.");
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
      throw new ClientApiError(response.status, body.error?.code ?? "http_error", body.error?.message ?? `Request failed (${response.status})`);
    }
    return response;
  }
  async listConversations(chatbotId: string, before?: string, signal?: AbortSignal): Promise<ClientConversationPage> {
    const query = new URLSearchParams({ chatbotId });
    if (before) query.set("before", before);
    return (await this.request(`/conversations?${query}`, { signal })).json();
  }
  async createConversation(chatbotId: string, id = crypto.randomUUID(), signal?: AbortSignal): Promise<ClientConversation> {
    return (await this.request("/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, chatbotId }), signal })).json();
  }
  async messages(id: string, after = "0", signal?: AbortSignal): Promise<ClientMessagePage> {
    return (await this.request(`/conversations/${encodeURIComponent(id)}/messages?after=${encodeURIComponent(after)}`, { signal })).json();
  }
  async deleteConversation(id: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/conversations/${encodeURIComponent(id)}`, { method: "DELETE", signal });
  }
  /** Keep requestId stable on an uncertain retry. Never automatically resend after a dropped stream. */
  async send(id: string, input: { requestId: string; message: string; emailManager?: boolean }, onEvent?: (event: ClientStreamEvent) => void, signal?: AbortSignal): Promise<ClientTurn> {
    const response = await this.request(`/conversations/${encodeURIComponent(id)}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, stream: true }), signal,
    });
    if (!response.body) throw new ClientApiError(0, "interrupted", "No reply stream was received. Refresh the conversation.");
    for await (const { event, data } of clientEvents(response.body)) {
      if (event === "error") {
        const error = data as { code?: string; message?: string };
        throw new ClientApiError(0, error.code ?? "interrupted", error.message ?? "The reply was interrupted. Refresh the conversation.");
      }
      if (event === "done") {
        const done = data as { turn?: ClientTurn };
        if (!done.turn || done.turn.requestId !== input.requestId || !["completed", "failed", "interrupted"].includes(done.turn.status)) {
          throw new ClientApiError(0, "protocol_error", "Invalid completion. Refresh the conversation.");
        }
        onEvent?.({ type: "done", turn: done.turn });
        return done.turn;
      }
      if (["accepted", "token", "sources", "tool"].includes(event)) onEvent?.(data as ClientStreamEvent);
    }
    throw new ClientApiError(0, "interrupted", "The connection ended before the reply was saved. Refresh the conversation before retrying.");
  }
}
