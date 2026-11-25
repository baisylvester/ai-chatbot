import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ signup: vi.fn(), exchange: vi.fn(), set: vi.fn(), get: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ origin: "https://platform.example" }),
  cookies: async () => ({ set: mocks.set, get: mocks.get }),
}));
vi.mock("@/lib/auth/server", () => ({ createAuthClient: async () => ({ auth: { signUp: mocks.signup, exchangeCodeForSession: mocks.exchange } }) }));
import { signUpAction } from "../src/app/auth/actions";
import { GET } from "../src/app/auth/callback/route";

beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("NEXT_PUBLIC_PLATFORM_URL", "https://platform.example");
  mocks.signup.mockResolvedValue({ data: { session: null }, error: null }); mocks.exchange.mockResolvedValue({ error: null });
});
afterEach(() => vi.unstubAllEnvs());

it("preserves the exact configured callback URL while remembering a safe chat destination", async () => {
  const form = new FormData();
  for (const [name,value] of Object.entries({ name:"Test User", email:"test@example.test", password:"password123", next:"/chat/cb_abcdefghijklmnop" })) form.set(name,value);
  await signUpAction({},form);
  expect(mocks.signup.mock.calls[0]![0].options.emailRedirectTo).toBe("https://platform.example/auth/callback");
  expect(mocks.set).toHaveBeenCalledWith("chat-auth-next", "/chat/cb_abcdefghijklmnop", expect.objectContaining({ httpOnly:true, sameSite:"lax", path:"/auth/callback", maxAge:86400 }));
});
it("uses and clears the same-browser chat destination after confirmation", async () => {
  mocks.get.mockReturnValue({ value:"/chat/cb_abcdefghijklmnop" });
  const response = await GET(new NextRequest("https://platform.example/auth/callback?code=test-code"));
  expect(response.headers.get("location")).toBe("https://platform.example/chat/cb_abcdefghijklmnop");
  expect(mocks.set).toHaveBeenCalledWith("chat-auth-next", "", { path:"/auth/callback", maxAge:0 });
});
it("cannot turn the callback destination cookie into an external redirect", async () => {
  mocks.get.mockReturnValue({ value:"//outside.example" });
  const response = await GET(new NextRequest("https://platform.example/auth/callback?code=test-code"));
  expect(response.headers.get("location")).toBe("https://platform.example/orgs");
});
