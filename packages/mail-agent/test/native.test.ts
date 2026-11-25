import { describe, expect, it } from "vitest";
import { describeActionState, exchangeCode, GmailClient, GmailHttpError, googleAuthUrl, GMAIL_SCOPE, MailAuthError } from "../src/index.ts";

const config = { clientId: "id", clientSecret: "secret", redirectUri: "https://platform.test/api/agent/gmail/callback" };
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("PKCE", () => {
  it("adds S256 PKCE only when asked, leaving the web URL unchanged", () => {
    const web = new URL(googleAuthUrl(config, "state"));
    expect(web.searchParams.has("code_challenge")).toBe(false);
    const native = new URL(googleAuthUrl(config, "state", "challenge"));
    expect(native.searchParams.get("code_challenge")).toBe("challenge");
    expect(native.searchParams.get("code_challenge_method")).toBe("S256");
    expect(native.searchParams.get("redirect_uri")).toBe(config.redirectUri);
  });
  it("sends the code verifier with the exchange", async () => {
    let sent = "";
    const fetchFn = (async (_url: string, init: RequestInit) => { sent = String(init.body); return json({ access_token: "a", refresh_token: "r", scope: GMAIL_SCOPE }); }) as unknown as typeof fetch;
    await exchangeCode(config, "code", fetchFn, "verifier");
    expect(new URLSearchParams(sent).get("code_verifier")).toBe("verifier");
    await exchangeCode(config, "code", fetchFn);
    expect(new URLSearchParams(sent).has("code_verifier")).toBe(false);
  });
});

describe("drafts and errors", () => {
  it("reads the complete draft with recipients and attachments", async () => {
    const long = "x".repeat(15_000);
    const fetchFn = (async () => json({ id: "d1", message: { id: "m9", threadId: "t", payload: { mimeType: "multipart/mixed", headers: [
      { name: "To", value: "Ana <ana@example.com>, bo@example.com" }, { name: "Cc", value: "cc@example.com" }, { name: "Bcc", value: "" }, { name: "Subject", value: "Report" },
    ], parts: [
      { mimeType: "text/plain", body: { data: b64(`Hello\n${long}`) } },
      { mimeType: "application/pdf", filename: "report.pdf", body: { attachmentId: "att", size: 1234 } },
    ] } } })) as unknown as typeof fetch;
    const draft = await new GmailClient("token", fetchFn).getDraft("d1");
    expect(draft).toMatchObject({ draftId: "d1", messageId: "m9", to: ["Ana <ana@example.com>", "bo@example.com"], cc: ["cc@example.com"], bcc: [], subject: "Report",
      attachments: [{ filename: "report.pdf", mimeType: "application/pdf", size: 1234 }] });
    expect(draft!.body.length).toBe(long.length + 6); // not truncated to the 6,000-character read limit
  });
  it("returns null for a draft that no longer exists and throws typed errors otherwise", async () => {
    const status = (code: number) => (async () => json({}, code)) as unknown as typeof fetch;
    expect(await new GmailClient("t", status(404)).getDraft("d1")).toBeNull();
    const error = await new GmailClient("t", status(503)).getDraft("d1").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GmailHttpError); expect((error as GmailHttpError).status).toBe(503);
    expect((error as Error).message).toBe("Gmail request failed (503)");
    await expect(new GmailClient("t", status(401)).getDraft("d1")).rejects.toBeInstanceOf(MailAuthError);
  });
  it("reports messages Gmail no longer has", async () => {
    const fetchFn = (async (url: string) => url.includes("/gone") ? json({}, 404)
      : json({ id: "a1", threadId: "t", snippet: "hi", payload: { headers: [{ name: "From", value: "x@example.com" }, { name: "Subject", value: "S" }] } })) as unknown as typeof fetch;
    const result = await new GmailClient("t", fetchFn).summaries(["a1", "gone"]);
    expect(result.messages.map((m) => m.id)).toEqual(["a1"]); expect(result.missing).toEqual(["gone"]);
  });
  it("describes uncertain outcomes without claiming success or failure", () => {
    expect(describeActionState({ kind: "send", status: "uncertain" })).toContain("may or may not");
    expect(describeActionState({ kind: "trash", status: "uncertain" })).toContain("may or may not");
  });
});
