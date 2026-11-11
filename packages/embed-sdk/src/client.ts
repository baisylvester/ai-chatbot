/** Framework-free client for the public widget API. No cookies; the session token travels in a header. */

export interface PublicConfig {
  chatbotId: string;
  name: string;
  welcomeMessage: string;
  suggestedQuestions: string[];
  theme: "light" | "dark" | "auto";
  position: "bottom-right" | "bottom-left";
  voice?: { mode: "off" | "standard" | "realtime"; autoSpeak: boolean };
}

export interface RealtimeStart {
  voiceSessionId: string;
  clientSecret: string;
  expiresAt: number;
  callsUrl: string;
  model: string;
  voice: string;
}

export interface Citation {
  n: number;
  title: string;
  sourceUrl: string | null;
  snippet: string;
}

export interface StoredMessage {
  role: "user" | "assistant";
  text: string;
  citations?: Citation[];
  error?: string;
}

export interface SendHandlers {
  onSources?(citations: Citation[]): void;
  onToken(text: string): void;
  onDone(): void;
  onError(message: string): void;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** Parses a text/event-stream body into (event, data) pairs. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = "message";
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) {
        try {
          yield { event, data: JSON.parse(data) as Record<string, unknown> };
        } catch {
          /* ignore malformed event */
        }
      }
    }
  }
}

async function asApiError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  return new ApiError(res.status, body.error?.code ?? "http_error", body.error?.message ?? `Request failed (${res.status})`);
}

/** Wraps sessionStorage, which can be unavailable (privacy modes, sandboxed frames). */
const store = {
  get<T>(key: string): T | null {
    try {
      const v = window.sessionStorage.getItem(key);
      return v ? (JSON.parse(v) as T) : null;
    } catch {
      return null;
    }
  },
  set(key: string, value: unknown) {
    try {
      window.sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable: the chat still works, it just won't survive a reload */
    }
  },
  remove(key: string) {
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

/**
 * A random id kept in this browser so the platform can count unique visitors. It contains no personal
 * data; the server stores only a keyed hash of it. Absent when storage is unavailable.
 */
function visitorId(): string | undefined {
  try {
    const key = "ai-chatbot:visitor";
    let id = window.localStorage.getItem(key);
    if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      window.localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return undefined;
  }
}

export class ChatClient {
  readonly apiUrl: string;
  readonly chatbotId: string;
  private token: string | null = null;
  private tokenExpires = 0;
  private readonly key: string;

  constructor(opts: { apiUrl: string; chatbotId: string }) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
    this.chatbotId = opts.chatbotId;
    this.key = `ai-chatbot:${this.chatbotId}`;
    const saved = store.get<{ token: string; expires: number }>(`${this.key}:session`);
    if (saved && saved.expires > Date.now() + 60_000) {
      this.token = saved.token;
      this.tokenExpires = saved.expires;
    }
  }

  async loadConfig(): Promise<PublicConfig> {
    const res = await fetch(`${this.apiUrl}/api/v1/embed/config?chatbotId=${encodeURIComponent(this.chatbotId)}`, {
      credentials: "omit",
    });
    if (!res.ok) throw await asApiError(res);
    return (await res.json()) as PublicConfig;
  }

  private async ensureSession(): Promise<string> {
    if (this.token && this.tokenExpires > Date.now() + 30_000) return this.token;
    const res = await fetch(`${this.apiUrl}/api/v1/embed/sessions`, {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatbotId: this.chatbotId, visitorId: visitorId() }),
    });
    if (!res.ok) throw await asApiError(res);
    const body = (await res.json()) as { token: string; expiresAt: string };
    this.token = body.token;
    this.tokenExpires = Date.parse(body.expiresAt);
    store.set(`${this.key}:session`, { token: this.token, expires: this.tokenExpires });
    return this.token;
  }

  history(): StoredMessage[] {
    return store.get<StoredMessage[]>(`${this.key}:history`) ?? [];
  }

  saveHistory(messages: StoredMessage[]) {
    store.set(`${this.key}:history`, messages.slice(-40));
  }

  /** Starts a fresh conversation (new session on the next message). */
  reset() {
    this.token = null;
    this.tokenExpires = 0;
    store.remove(`${this.key}:session`);
    store.remove(`${this.key}:history`);
  }

  /** Calls a session-authenticated endpoint, starting a new session once if the old one expired. */
  private async authed(path: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.ensureSession();
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      const res = await fetch(`${this.apiUrl}${path}`, { ...init, headers, credentials: "omit" });
      if (res.status === 401 && attempt === 0) {
        this.token = null;
        this.tokenExpires = 0;
        store.remove(`${this.key}:session`);
        continue;
      }
      if (!res.ok) throw await asApiError(res);
      return res;
    }
  }

  async transcribe(audio: Blob, durationMs: number): Promise<string> {
    const form = new FormData();
    form.append("audio", audio, "speech");
    form.append("durationMs", String(Math.round(durationMs)));
    const res = await this.authed("/api/v1/embed/voice/transcribe", { method: "POST", body: form });
    return String(((await res.json()) as { text?: string }).text ?? "");
  }

  async speak(text: string, signal?: AbortSignal): Promise<Blob> {
    const res = await this.authed("/api/v1/embed/voice/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    });
    return res.blob();
  }

  async startRealtime(): Promise<RealtimeStart> {
    const res = await this.authed("/api/v1/embed/voice/realtime", { method: "POST" });
    return (await res.json()) as RealtimeStart;
  }

  async realtimeTool(voiceSessionId: string, name: string, args: string): Promise<{ output: string; citations: Citation[] }> {
    const res = await this.authed("/api/v1/embed/voice/realtime/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voiceSessionId, name, arguments: args }),
    });
    return (await res.json()) as { output: string; citations: Citation[] };
  }

  async endRealtime(voiceSessionId: string, transcript: { role: "user" | "assistant"; text: string }[], failed = false): Promise<void> {
    await this.authed("/api/v1/embed/voice/realtime/end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voiceSessionId, transcript, failed }),
      keepalive: true,
    }).catch(() => undefined);
  }

  async send(message: string, handlers: SendHandlers, signal?: AbortSignal): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let token: string;
      try {
        token = await this.ensureSession();
      } catch (err) {
        handlers.onError(err instanceof ApiError ? err.message : "Can't reach the assistant. Check your connection.");
        return;
      }
      let res: Response;
      try {
        res = await fetch(`${this.apiUrl}/api/v1/embed/messages`, {
          method: "POST",
          credentials: "omit",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ message }),
          signal,
        });
      } catch (err) {
        handlers.onError((err as Error).name === "AbortError" ? "Stopped." : "Can't reach the assistant. Check your connection.");
        return;
      }
      if (res.status === 401 && attempt === 0) {
        // Session expired: start a new one and retry once.
        this.reset();
        continue;
      }
      if (!res.ok || !res.body) {
        handlers.onError((await asApiError(res)).message);
        return;
      }
      try {
        for await (const { event, data } of readSse(res.body)) {
          if (event === "sources") handlers.onSources?.(data.citations as Citation[]);
          else if (event === "token") handlers.onToken(String(data.text ?? ""));
          else if (event === "done") return handlers.onDone();
          else if (event === "error") return handlers.onError(String(data.message ?? "Something went wrong."));
        }
        handlers.onDone();
      } catch (err) {
        handlers.onError((err as Error).name === "AbortError" ? "Stopped." : "The connection was interrupted.");
      }
      return;
    }
  }
}
