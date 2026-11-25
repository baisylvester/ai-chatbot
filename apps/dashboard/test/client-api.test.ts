import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ claims: vi.fn(), cookie: vi.fn(), upsert: vi.fn(), bot: vi.fn(), nativeOwner: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getClaims: mocks.claims } }) }));
vi.mock("@/lib/auth/server", () => ({ supabaseConfig: () => ({ url: "https://auth.example", key: "public-key" }) }));
vi.mock("@/lib/session", () => ({ getCurrentUser: mocks.cookie }));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@chatbot/database", () => ({ withTrustedContext: async (_: unknown, fn: (db: object) => unknown) => fn({query: mocks.nativeOwner}) }));
vi.mock("@chatbot/core", async importOriginal => {
  const core = await importOriginal<typeof import("@chatbot/core")>();
  return { ...core, upsertUser: mocks.upsert, loadBot: mocks.bot };
});
import { authenticateClient, clientBot, withClientRequest } from "../src/lib/client-api";
import { authNext } from "../src/lib/auth-next";

beforeEach(() => { vi.clearAllMocks(); mocks.nativeOwner.mockResolvedValue({rows:[]}); mocks.cookie.mockResolvedValue({ id: "cookie-user" }); });
describe("client authentication", () => {
  it("verifies an explicit bearer token and never falls back to cookie identity", async () => {
    mocks.claims.mockResolvedValue({ data: { claims: { sub: "user-id", email: "user@example.test", iss: "https://auth.example/auth/v1", aud: "authenticated" } }, error: null });
    expect(await authenticateClient(new Request("https://platform.test/api/v1/client/conversations", { headers: { Authorization: "Bearer user-token" } }))).toMatchObject({ id: "user-id" });
    expect(mocks.claims).toHaveBeenCalledWith("user-token"); expect(mocks.cookie).not.toHaveBeenCalled();
  });
  it("rejects invalid tokens and tokens from another issuer", async () => {
    for (const result of [{ data: null, error: new Error("invalid") }, { data: { claims: { sub: "u", email: "u@example.test", iss: "https://other.example/auth/v1", aud: "authenticated" } }, error: null }]) {
      mocks.claims.mockResolvedValue(result);
      expect((await authenticateClient(new Request("https://platform.test/api", { headers: { Authorization: "Bearer invalid" } })) as Response).status).toBe(401);
    }
    expect(mocks.cookie).not.toHaveBeenCalled(); expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it("rejects cross-origin cookie writes and allows same-origin writes", async () => {
    expect((await authenticateClient(new Request("https://platform.test/api", { method: "POST", headers: { Origin: "https://other.test" } })) as Response).status).toBe(403);
    expect(mocks.cookie).not.toHaveBeenCalled();
    expect(await authenticateClient(new Request("https://platform.test/api", { method: "POST", headers: { Origin: "https://platform.test" } }))).toMatchObject({ id: "cookie-user" });
  });
  it("retains website allowlists while supporting native requests without Origin", async () => {
    mocks.bot.mockResolvedValue({ status: "active", domains: ["allowed.test"] });
    await expect(clientBot(new Request("https://platform.test/api"), "cb_test")).resolves.toMatchObject({ status: "active" });
    await expect(clientBot(new Request("https://platform.test/api", { headers: { Origin: "https://blocked.test" } }), "cb_test")).rejects.toMatchObject({ code: "forbidden" });
  });
  it("marks even authentication errors private and uncacheable", async () => {
    mocks.claims.mockResolvedValue({ data: null, error: new Error("invalid") });
    const response = await withClientRequest(new Request("https://platform.test/api", { headers: { Authorization: "Bearer invalid" } }), async () => Response.json({}));
    expect(response.status).toBe(401); expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("vary")).toContain("Authorization");
  });
});
it("allows only a known chat path as the sign-in destination", () => {
  expect(authNext("/chat/cb_abcdefghijklmnop")).toBe("/chat/cb_abcdefghijklmnop");
  for (const path of ["//evil.test", "/\\evil.test", "https://evil.test", "/chat/cb_abcdefghijklmnop?next=evil", null]) expect(authNext(path)).toBe("/orgs");
});
it("adds a machine-readable reason to domain errors without changing code or status", async () => {
  const { DomainError } = await import("@chatbot/core");
  mocks.claims.mockResolvedValue({ data: { claims: { sub: "user-id", email: "user@example.test", iss: "https://auth.example/auth/v1", aud: "authenticated" } }, error: null });
  const request = () => new Request("https://platform.test/api", { headers: { Authorization: "Bearer user-token" } });
  const busy = await withClientRequest(request(), async () => { throw new DomainError("conflict", "Another reply is running", "conversation_busy"); });
  expect(busy.status).toBe(409); expect(await busy.json()).toEqual({ error: { code: "conflict", message: "Another reply is running", reason: "conversation_busy" } });
  const plain = await withClientRequest(request(), async () => { throw new DomainError("conflict", "Plain"); });
  expect(await plain.json()).toEqual({ error: { code: "conflict", message: "Plain" } });
});

it("keeps native personal assistants private even when another user knows their public ID", async () => {
  mocks.bot.mockResolvedValue({id:"bot",status:"active",domains:[]});
  mocks.nativeOwner.mockResolvedValue({rows:[{user_id:"owner"}]});
  const request=new Request("https://platform.test/api");
  await expect(clientBot(request,"cb_personal",true,"other-user")).rejects.toMatchObject({code:"not_found"});
  await expect(clientBot(request,"cb_personal",true,"owner")).resolves.toMatchObject({id:"bot",nativePersonalAssistant:true});
});
