import { describe, expect, it } from "vitest";
import { ChatClient, readSse } from "../src/client.ts";

function streamOf(chunks: string[]) {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

describe("readSse", () => {
  it("parses events split across chunks and ignores malformed data", async () => {
    const events = [];
    for await (const e of readSse(streamOf(['event: tok', 'en\ndata: {"text":"Hel"}\n\n', "event: token\r\ndata: {bad json}\r\n\r\n", 'event: done\ndata: {}\n\n']))) {
      events.push(e);
    }
    expect(events).toEqual([
      { event: "token", data: { text: "Hel" } },
      { event: "done", data: {} },
    ]);
  });
});

describe("ChatClient", () => {
  const sessionStorageStub = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    sessionStorage: {
      getItem: (k: string) => sessionStorageStub.get(k) ?? null,
      setItem: (k: string, v: string) => void sessionStorageStub.set(k, v),
      removeItem: (k: string) => void sessionStorageStub.delete(k),
    },
  };

  it("creates a session, streams a reply, and never sends cookies", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/sessions")) return Response.json({ token: "tok", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      return new Response(streamOf(['event: sources\ndata: {"citations":[{"n":1,"title":"Doc","sourceUrl":null,"snippet":"s"}]}\n\n', 'event: token\ndata: {"text":"Hi"}\n\n', "event: done\ndata: {}\n\n"]), {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const client = new ChatClient({ apiUrl: "https://platform.example/", chatbotId: "cb_abcdefghijklmnop" });
    let text = "";
    let sources = 0;
    let done = false;
    await client.send("hello", { onToken: (t) => (text += t), onSources: (c) => (sources = c.length), onDone: () => (done = true), onError: () => undefined });
    expect({ text, sources, done }).toEqual({ text: "Hi", sources: 1, done: true });
    expect(calls.map((c) => c.url)).toEqual(["https://platform.example/api/v1/embed/sessions", "https://platform.example/api/v1/embed/messages"]);
    expect(calls.every((c) => c.init?.credentials === "omit")).toBe(true);
    expect((calls[1]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("starts a new session once when the old one has expired", async () => {
    sessionStorageStub.clear();
    let sessions = 0;
    let messages = 0;
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/sessions")) {
        sessions++;
        return Response.json({ token: `t${sessions}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      }
      messages++;
      if (messages === 1) return Response.json({ error: { code: "session_expired", message: "expired" } }, { status: 401 });
      return new Response(streamOf(['event: token\ndata: {"text":"ok"}\n\n', "event: done\ndata: {}\n\n"]));
    }) as typeof fetch;
    const client = new ChatClient({ apiUrl: "https://platform.example", chatbotId: "cb_abcdefghijklmnop" });
    let text = "";
    await client.send("hi", { onToken: (t) => (text += t), onDone: () => undefined, onError: (m) => (text = `ERR ${m}`) });
    expect({ text, sessions, messages }).toEqual({ text: "ok", sessions: 2, messages: 2 });
  });

  it("surfaces API error messages (e.g. domain not allowed)", async () => {
    sessionStorageStub.clear();
    globalThis.fetch = (async () =>
      Response.json({ error: { code: "origin_not_allowed", message: "This website is not allowed to use this chatbot" } }, { status: 403 })) as unknown as typeof fetch;
    const client = new ChatClient({ apiUrl: "https://platform.example", chatbotId: "cb_abcdefghijklmnop" });
    let error = "";
    await client.send("hi", { onToken: () => undefined, onDone: () => undefined, onError: (m) => (error = m) });
    expect(error).toBe("This website is not allowed to use this chatbot");
  });
});
