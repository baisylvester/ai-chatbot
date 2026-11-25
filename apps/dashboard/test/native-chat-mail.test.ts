import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ run: vi.fn(), ready: vi.fn(), model: vi.fn(), role: vi.fn(), personal: vi.fn(), setup: vi.fn(), retrieve: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/client-api", () => ({
  clientPreflight: vi.fn(), clientTrusted: async (fn: (db: object) => unknown) => fn({}),
  clientBot: async (_request: Request, publicId: string) => publicId === "cb_shared" ? ({id:"shared",organization_id:"published-org",nativePersonalAssistant:false,settings:{name:"Shared"}}) : ({ id: "bot", organization_id: "org", nativePersonalAssistant: mocks.personal(), settings: { provider: "anthropic" } }),
  clientError: (status: number, code: string, message: string, reason: string) => Response.json({ error: { code, message, reason } }, { status }),
  withClientRequest: async (_request: Request, fn: (user: { id: string }) => Promise<Response>) => fn({ id: "user" }),
}));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@chatbot/database", () => ({ withUserContext: async (_pool: unknown, _user: string, fn: (db: object) => unknown) => fn({}) }));
vi.mock("@chatbot/core", async original => ({
  ...await original<typeof import("@chatbot/core")>(),
  getClientConversation: async () => ({ chatbotId: "cb_test" }),
  getChatbot: vi.fn(), getOrganization: mocks.role,
  runClientConversationTurn: mocks.run,
}));
vi.mock("@/lib/knowledge", () => ({ retrieverFor: mocks.retrieve }));
vi.mock("@/lib/mail-agent", () => ({
  agentModel: mocks.model, EMAIL_MANAGER_NOTE: "mail safety", emailManagerReady: mocks.ready,
  emailManagerTool: () => ({ name: "email_manager" }),
  mailSetup: mocks.setup,
}));
import { POST } from "../src/app/api/v1/client/conversations/[conversationId]/messages/route";
const request = (emailManager: boolean) => new Request("https://platform.test/api/v1/client/conversations/c/messages", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ requestId: "97d2ea7c-aadb-4bac-8774-036d1c861c29", message: "Find an email", emailManager }),
});
beforeEach(() => {
  vi.stubEnv("NATIVE_KNOWLEDGE_CHATBOT_ID", "");
  vi.clearAllMocks(); mocks.ready.mockResolvedValue(true); mocks.role.mockResolvedValue({ role: "owner" });
  mocks.personal.mockReturnValue(false); mocks.setup.mockReturnValue({ provider: "openai-compatible", model: "qwen3:8b", modelReady: true });
  mocks.model.mockReturnValue("configured-mail-model");
  mocks.retrieve.mockReturnValue(async () => []);
  mocks.run.mockImplementation(async function* () { yield { type: "done", turn: { status: "completed", text: "done" } }; });
});
afterEach(() => vi.unstubAllEnvs());
it.each([true,false])("uses shared live knowledge while keeping the private conversation and mailbox capability %s", async enabled => {
  vi.stubEnv("NATIVE_KNOWLEDGE_CHATBOT_ID","cb_shared"); mocks.personal.mockReturnValue(true);
  await POST(request(enabled), {params:Promise.resolve({conversationId:"c"})});
  expect(mocks.retrieve).toHaveBeenCalledWith(expect.objectContaining({id:"shared",organization_id:"published-org"}));
  const options=mocks.run.mock.calls[0]![0];
  expect(options.chatbot.id).toBe("bot");expect(options.userId).toBe("user");expect(options.emailManager).toBe(enabled);
  expect(options.tools?.length ?? 0).toBe(enabled?1:0);
});
it("runs mail mode with its configured provider even when the public chatbot selects another provider", async () => {
  expect((await POST(request(true), { params: Promise.resolve({ conversationId: "c" }) })).status).toBe(200);
  const options = mocks.run.mock.calls[0]![0];
  expect(options.candidates[0]).toMatchObject({ provider: "openai-compatible", model: "qwen3:8b" });
  expect(options.candidates[0].create()).toBe("configured-mail-model");
  expect(options.tools).toEqual([{ name: "email_manager" }]);
});
it("keeps normal chat on the chatbot's own model without mailbox tools", async () => {
  await POST(request(false), { params: Promise.resolve({ conversationId: "c" }) });
  const options = mocks.run.mock.calls[0]![0];
  expect(options.candidates).toBeUndefined(); expect(options.tools).toBeUndefined();
  expect(mocks.ready).not.toHaveBeenCalled(); expect(mocks.model).not.toHaveBeenCalled();
});
it("uses the live assistant provider for a personal conversation without granting Gmail tools", async () => {
  mocks.personal.mockReturnValue(true);
  mocks.ready.mockResolvedValue(false);
  const response = await POST(request(false), { params: Promise.resolve({ conversationId: "c" }) });
  expect(response.status).toBe(200);
  const options = mocks.run.mock.calls[0]![0];
  expect(options.candidates[0]).toMatchObject({ provider: "openai-compatible", model: "qwen3:8b" });
  expect(options.candidates[0].create()).toBe("configured-mail-model");
  expect(options.tools).toBeUndefined(); expect(options.emailManager).toBe(false);
  expect(options.toolNote).toContain("general questions");
  expect(mocks.ready).not.toHaveBeenCalled(); expect(mocks.role).not.toHaveBeenCalled();
});
it("returns a definite unavailable response before claiming a personal turn when the provider is missing", async () => {
  mocks.personal.mockReturnValue(true); mocks.setup.mockReturnValue({modelReady:false});
  expect((await POST(request(false), {params:Promise.resolve({conversationId:"c"})})).status).toBe(503);
  expect(mocks.run).not.toHaveBeenCalled();
});
it("refuses disconnected mailboxes before starting a generation", async () => {
  mocks.ready.mockResolvedValue(false);
  expect((await POST(request(true), { params: Promise.resolve({ conversationId: "c" }) })).status).toBe(409);
  expect(mocks.run).not.toHaveBeenCalled();
});
it("refuses non-admin members before opening mailbox tools", async () => {
  mocks.role.mockResolvedValue({ role: "member" });
  await expect(POST(request(true), { params: Promise.resolve({ conversationId: "c" }) })).rejects.toMatchObject({ code: "forbidden" });
  expect(mocks.ready).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
});
