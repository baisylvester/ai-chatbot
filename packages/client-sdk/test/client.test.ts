import { afterEach, describe, expect, it, vi } from "vitest";
import { clientEvents, SyncedChatClient } from "../src/index.ts";

afterEach(() => vi.unstubAllGlobals());
const requestId = "28995d8f-33d3-47c0-8c51-a678de512576";
const turn = { requestId, status: "completed", text: "Hello", citations: [], error: null };
const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

describe("native-compatible client", () => {
  it("gets a fresh user token per request and omits cookies", async () => {
    const fetch = vi.fn().mockImplementation(async () => Response.json({ conversations: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetch);
    const token = vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("refreshed");
    const client = new SyncedChatClient({ apiUrl: "https://platform.example/", getAccessToken: token });
    await client.listConversations("cb_test"); await client.listConversations("cb_test");
    expect(fetch.mock.calls[0]![1].headers.get("Authorization")).toBe("Bearer first");
    expect(fetch.mock.calls[1]![1].headers.get("Authorization")).toBe("Bearer refreshed");
    expect(fetch.mock.calls.every(call => call[1].credentials === "omit" && call[1].cache === "no-store")).toBe(true);
  });
  it("does not fall back to another account's cookies when token refresh fails", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const client = new SyncedChatClient({ apiUrl: "", getAccessToken: async () => null });
    await expect(client.listConversations("cb_test")).rejects.toMatchObject({ status: 401 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects a response belonging to an account switched in another tab", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ conversations: [{ title: "Other account" }] }, { headers: { "X-Authenticated-User": "other-user" } })));
    await expect(new SyncedChatClient({ apiUrl: "", expectedUserId: "original-user" }).listConversations("cb_test")).rejects.toMatchObject({ code: "account_changed", status: 401 });
  });
  it("keeps a caller's request id unchanged and requires a persisted completion", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(event("token", { type: "token", text: "Hello" }) + event("done", { type: "done", turn })));
    vi.stubGlobal("fetch", fetch);
    const onEvent = vi.fn();
    await expect(new SyncedChatClient({ apiUrl: "" }).send("conversation", { requestId, message: "Hi" }, onEvent)).resolves.toEqual(turn);
    expect(JSON.parse(fetch.mock.calls[0]![1].body).requestId).toBe(requestId);
    expect(onEvent.mock.calls[0]![0]).toMatchObject({ type: "token", text: "Hello" });
    expect(onEvent.mock.calls.at(-1)![0]).toEqual({ type: "done", turn });
  });
  it("reports an abruptly closed stream and never retries an ambiguous send", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(event("token", { type: "token", text: "partial" })));
    vi.stubGlobal("fetch", fetch);
    await expect(new SyncedChatClient({ apiUrl: "" }).send("conversation", { requestId, message: "Hi" })).rejects.toMatchObject({ code: "interrupted" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects completion for a different request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(event("done", { turn: { ...turn, requestId: "wrong" } }))));
    await expect(new SyncedChatClient({ apiUrl: "" }).send("conversation", { requestId, message: "Hi" })).rejects.toMatchObject({ code: "protocol_error" });
  });
  it("surfaces HTTP conflicts without retrying", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ error: { code: "conflict", message: "Another reply is running" } }, { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    await expect(new SyncedChatClient({ apiUrl: "" }).send("conversation", { requestId, message: "Hi" })).rejects.toMatchObject({ status: 409, code: "conflict" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

it("parses SSE when every byte, including UTF-8 and CRLF, arrives separately", async () => {
  const bytes = new TextEncoder().encode('event: token\r\ndata: {"text":"你好"}\r\n\r\n');
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  const events = [];
  for await (const item of clientEvents(stream)) events.push(item);
  expect(events).toEqual([{ event: "token", data: { text: "你好" } }]);
  expect(stream.locked).toBe(false);
});
