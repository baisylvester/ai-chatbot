import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  org: vi.fn(), open: vi.fn(), setup: vi.fn(),
  getAction: vi.fn(), claim: vi.fn(), schedule: vi.fn(), unschedule: vi.fn(), due: vi.fn(), finish: vi.fn(), uncertain: vi.fn(), reject: vi.fn(),
  lock: vi.fn(), save: vi.fn(), finishTx: vi.fn(), findTx: vi.fn(), consume: vi.fn(), record: vi.fn(), create: vi.fn(), exchange: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getClaims: vi.fn() } }) }));
vi.mock("@/lib/auth/server", () => ({ supabaseConfig: () => ({ url: "https://auth.example", key: "public-key" }) }));
vi.mock("@/lib/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/mail-agent", () => ({ mailDb: (fn: (db: object) => unknown) => fn({}), mailSetup: m.setup, openMailbox: m.open }));
vi.mock("@chatbot/database", () => ({
  withTrustedContext: async (_: unknown, fn: (db: object) => unknown) => fn({}),
  withUserContext: async (_: unknown, __: string, fn: (db: object) => unknown) => fn({}),
}));
vi.mock("@chatbot/core", async (importOriginal) => ({ ...(await importOriginal<typeof import("@chatbot/core")>()), getOrganization: m.org }));
vi.mock("@chatbot/mail-agent", async (importOriginal) => {
  const real = await importOriginal<typeof import("@chatbot/mail-agent")>();
  class FakeGmail { async profile() { return { email: "me@example.com" }; } }
  return {
    ...real, GmailClient: FakeGmail, exchangeCode: m.exchange,
    getAction: m.getAction, claimAction: m.claim, finishAction: m.finish, markUncertain: m.uncertain, rejectPendingAction: m.reject,
    scheduleAction: m.schedule, unscheduleAction: m.unschedule, claimDueSends: m.due,
    lockNativeTransaction: m.lock, saveConnection: m.save, finishNativeTransaction: m.finishTx, findNativeTransactionByState: m.findTx,
    consumeNativeCallback: m.consume, recordNativeCallback: m.record, createNativeTransaction: m.create, cleanupNativeTransactions: vi.fn(),
    countPendingActions: vi.fn(async () => 0), getConnection: vi.fn(async () => null),
  };
});

import { DomainError, type Chatbot } from "@chatbot/core";
import { GmailHttpError, MailAuthError, type DraftDetail } from "@chatbot/mail-agent";
import {
  approveAction, classifyGmailFailure, runScheduledSends, unscheduleSend, validSendAt, completeNativeConnect, handleNativeCallback, nativeReturnUri, rejectAction, sendVersion, startNativeConnect, trashVersion,
} from "../src/lib/native-mail";

const USER = "00000000-0000-4000-8000-000000000001";
const ACTION = "00000000-0000-4000-8000-0000000000aa";
const TX = "00000000-0000-4000-8000-0000000000bb";
const bot = { id: "bot", organization_id: "org", public_id: "cb_abcdefghijklmnop" } as unknown as Chatbot;
const draft: DraftDetail = { draftId: "d1", messageId: "m1", to: ["ana@example.com"], cc: [], bcc: [], subject: "Hi", body: "Full body", attachments: [] };
const sendAction = (status = "pending") => ({ id: ACTION, kind: "send", summary: "Send", payload: { draftId: "d1", to: "ana@example.com", subject: "Hi", preview: "Full" }, status, error: null, createdAt: new Date(), resolvedAt: null });
const sha256hex = (v: string) => createHash("sha256").update(v).digest("hex");
const sha256b64url = (v: string) => createHash("sha256").update(v).digest("base64url");

let gmail: { getDraft: ReturnType<typeof vi.fn>; summaries: ReturnType<typeof vi.fn>; sendDraft: ReturnType<typeof vi.fn>; trash: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.clearAllMocks();
  gmail = { getDraft: vi.fn(async () => draft), summaries: vi.fn(), sendDraft: vi.fn(async () => undefined), trash: vi.fn(async () => undefined) };
  m.open.mockResolvedValue({ connection: { id: "conn-1", email: "me@example.com" }, gmail });
  m.save.mockResolvedValue("conn-1");
  m.setup.mockReturnValue({ oauth: { clientId: "client", clientSecret: "secret", redirectUri: "https://platform.test/api/agent/gmail/callback" }, tokenSecret: "0123456789abcdef0123456789abcdef-test", modelReady: true });
  m.getAction.mockResolvedValue(sendAction());
});

describe("approval versions", () => {
  it("changes when the reviewed draft changes and ignores trash id order", () => {
    expect(sendVersion(draft)).toMatch(/^[0-9a-f]{64}$/);
    expect(sendVersion({ ...draft, body: "Edited" })).not.toBe(sendVersion(draft));
    expect(sendVersion({ ...draft, messageId: "m2" })).not.toBe(sendVersion(draft));
    expect(sendVersion({ ...draft, bcc: ["x@example.com"] })).not.toBe(sendVersion(draft));
    expect(trashVersion(["b", "a"])).toBe(trashVersion(["a", "b"]));
    expect(trashVersion(["a"])).not.toBe(trashVersion(["a", "b"]));
  });
});

describe("approve", () => {
  it("refuses a stale version without claiming or sending", async () => {
    await expect(approveAction(USER, ACTION, sendVersion({ ...draft, body: "What I reviewed" }))).rejects.toMatchObject({ code: "conflict", reason: "stale_approval" });
    expect(m.claim).not.toHaveBeenCalled(); expect(gmail.sendDraft).not.toHaveBeenCalled();
  });
  it("refuses when the draft is gone", async () => {
    gmail.getDraft.mockResolvedValue(null);
    await expect(approveAction(USER, ACTION, "0".repeat(64))).rejects.toMatchObject({ reason: "draft_missing" });
    expect(m.claim).not.toHaveBeenCalled();
  });
  it("reports already_handled for a non-pending action or a lost claim race, and never sends", async () => {
    m.getAction.mockResolvedValueOnce(sendAction("done"));
    await expect(approveAction(USER, ACTION, sendVersion(draft))).rejects.toMatchObject({ reason: "already_handled" });
    m.claim.mockResolvedValue(null);
    await expect(approveAction(USER, ACTION, sendVersion(draft))).rejects.toMatchObject({ reason: "already_handled" });
    expect(gmail.sendDraft).not.toHaveBeenCalled();
  });
  it("sends once on a matching version and marks it done", async () => {
    m.claim.mockResolvedValue(sendAction("processing"));
    m.getAction.mockResolvedValueOnce(sendAction()).mockResolvedValueOnce(sendAction("done"));
    const result = await approveAction(USER, ACTION, sendVersion(draft));
    expect(gmail.sendDraft).toHaveBeenCalledTimes(1); expect(gmail.sendDraft).toHaveBeenCalledWith("d1");
    expect(m.finish).toHaveBeenCalledWith({}, USER, ACTION, "done");
    expect(result.action.status).toBe("done");
  });
  it.each([
    ["network error", new TypeError("fetch failed"), "uncertain"],
    ["Gmail 503", new GmailHttpError(503), "uncertain"],
    ["Gmail 400", new GmailHttpError(400), "failed"],
    ["revoked", new MailAuthError(), "failed"],
  ])("records %s as %s and never retries", async (_, error, outcome) => {
    m.claim.mockResolvedValue(sendAction("processing"));
    gmail.sendDraft.mockRejectedValue(error);
    await approveAction(USER, ACTION, sendVersion(draft));
    expect(gmail.sendDraft).toHaveBeenCalledTimes(1);
    if (outcome === "uncertain") { expect(m.uncertain).toHaveBeenCalled(); expect(m.finish).not.toHaveBeenCalled(); }
    else { expect(m.finish).toHaveBeenCalledWith({}, USER, ACTION, "failed", expect.any(String)); expect(m.uncertain).not.toHaveBeenCalled(); }
  });
  it("classifies Gmail failures", () => {
    expect(classifyGmailFailure(new GmailHttpError(429))).toBe("failed");
    expect(classifyGmailFailure(new GmailHttpError(500))).toBe("uncertain");
    expect(classifyGmailFailure(new DOMException("aborted", "AbortError"))).toBe("uncertain");
  });
});

describe("scheduled send", () => {
  const later = () => new Date(Date.now() + 3_600_000);
  it("validates the send time window", () => {
    const now = new Date("2026-11-25T00:00:00Z");
    expect(validSendAt(new Date("2026-11-25T00:00:30Z"), now)).toBe(false);
    expect(validSendAt(new Date("2026-11-25T01:00:00Z"), now)).toBe(true);
    expect(validSendAt(new Date("2027-03-01T00:00:00Z"), now)).toBe(false);
    expect(validSendAt(new Date("invalid"), now)).toBe(false);
  });
  it("schedules with the reviewed version and never sends now", async () => {
    m.schedule.mockResolvedValue(true);
    m.getAction.mockResolvedValueOnce(sendAction()).mockResolvedValueOnce({ ...sendAction("scheduled"), scheduledFor: later() });
    const result = await approveAction(USER, ACTION, sendVersion(draft), later());
    expect(m.schedule).toHaveBeenCalledWith({}, USER, ACTION, expect.any(Date), sendVersion(draft));
    expect(m.claim).not.toHaveBeenCalled(); expect(gmail.sendDraft).not.toHaveBeenCalled();
    expect(result.action.status).toBe("scheduled"); expect(result.action.scheduledFor).toMatch(/Z$/);
  });
  it("refuses a stale version or a time in the past before scheduling", async () => {
    await expect(approveAction(USER, ACTION, sendVersion({ ...draft, body: "old" }), later())).rejects.toMatchObject({ reason: "stale_approval" });
    await expect(approveAction(USER, ACTION, sendVersion(draft), new Date(Date.now() - 1000))).rejects.toMatchObject({ reason: "schedule_invalid" });
    expect(m.schedule).not.toHaveBeenCalled();
  });
  it("sends a due draft only when it still matches the approved version", async () => {
    m.due.mockResolvedValue([
      { id: "a1", userId: USER, payload: { draftId: "d1" }, approvedVersion: sendVersion(draft) },
      { id: "a2", userId: USER, payload: { draftId: "d1" }, approvedVersion: sendVersion({ ...draft, body: "approved text" }) },
    ]);
    const result = await runScheduledSends();
    expect(gmail.sendDraft).toHaveBeenCalledTimes(1);
    expect(m.finish).toHaveBeenCalledWith({}, USER, "a1", "done");
    expect(m.finish).toHaveBeenCalledWith({}, USER, "a2", "failed", expect.stringContaining("changed after you approved"));
    expect(result).toEqual({ scheduledSent: 1, scheduledFailed: 1 });
  });
  it("records an unconfirmed scheduled send as uncertain", async () => {
    m.due.mockResolvedValue([{ id: "a1", userId: USER, payload: { draftId: "d1" }, approvedVersion: sendVersion(draft) }]);
    gmail.sendDraft.mockRejectedValue(new GmailHttpError(503));
    await runScheduledSends();
    expect(m.uncertain).toHaveBeenCalled(); expect(m.finish).not.toHaveBeenCalled();
  });
  it("unschedules only a scheduled send", async () => {
    m.unschedule.mockResolvedValue(false); m.getAction.mockResolvedValue(sendAction("done"));
    await expect(unscheduleSend(USER, ACTION)).rejects.toMatchObject({ reason: "already_handled" });
    m.unschedule.mockResolvedValue(true); m.getAction.mockResolvedValue(sendAction("pending"));
    expect((await unscheduleSend(USER, ACTION)).action.status).toBe("pending");
  });
});

describe("reject", () => {
  it("only declines pending requests", async () => {
    m.reject.mockResolvedValue(false); m.getAction.mockResolvedValue(sendAction("processing"));
    await expect(rejectAction(USER, ACTION)).rejects.toMatchObject({ reason: "already_handled" });
    m.reject.mockResolvedValue(true); m.getAction.mockResolvedValue(sendAction("rejected"));
    expect((await rejectAction(USER, ACTION)).action.status).toBe("rejected");
    m.getAction.mockResolvedValue(null);
    await expect(rejectAction(USER, ACTION)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("connect", () => {
  const challenge = sha256b64url("app-verifier-0123456789-0123456789-0123456789");
  it("refuses members and non-members with mail_role_required", async () => {
    m.org.mockResolvedValueOnce({ role: "member" });
    let response = await startNativeConnect(USER, bot, challenge);
    expect(response.status).toBe(403); expect((await response.json()).error.reason).toBe("mail_role_required");
    m.org.mockRejectedValueOnce(new DomainError("not_found", "Organization not found"));
    response = await startNativeConnect(USER, bot, challenge);
    expect(response.status).toBe(403);
    expect(m.create).not.toHaveBeenCalled();
  });
  it("refuses when Gmail is not configured", async () => {
    m.org.mockResolvedValue({ role: "owner" }); m.setup.mockReturnValue({ oauth: null, tokenSecret: null, modelReady: false });
    expect((await startNativeConnect(USER, bot, challenge)).status).toBe(503);
  });
  it("creates a transaction with PKCE and stores only the state's hash", async () => {
    m.org.mockResolvedValue({ role: "admin" });
    m.create.mockResolvedValue({ id: TX, expiresAt: new Date(Date.now() + 600_000) });
    const body = await (await startNativeConnect(USER, bot, challenge)).json();
    const url = new URL(body.authorizationUrl);
    const stored = m.create.mock.calls[0]![2];
    expect(body.transactionId).toBe(TX);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(sha256b64url(stored.pkceVerifier));
    expect(stored.stateHash).toBe(sha256hex(url.searchParams.get("state")!));
    expect(stored).toMatchObject({ verifierChallenge: challenge, chatbotPublicId: "cb_abcdefghijklmnop" });
  });
});

describe("complete", () => {
  const verifier = "v".repeat(43), code = "c".repeat(43);
  const tx = (over: object = {}) => ({
    id: TX, userId: USER, provider: "gmail", chatbotPublicId: "cb_abcdefghijklmnop", verifierChallenge: sha256b64url(verifier), completionHash: sha256hex(code),
    sealedRefreshToken: "v1.sealed", email: "me@example.com", error: null, expiresAt: new Date(Date.now() + 60_000), callbackAt: new Date(), completedAt: null, ...over,
  });
  const input = { transactionId: TX, code, verifier };
  it.each([
    ["another user's or unknown transaction", null, {}, "transaction_not_found"],
    ["a wrong verifier", tx(), { verifier: "w".repeat(43) }, "verification_failed"],
    ["a wrong completion code", tx(), { code: "d".repeat(43) }, "verification_failed"],
    ["an expired transaction", tx({ expiresAt: new Date(Date.now() - 1000) }), {}, "transaction_expired"],
    ["a replay", tx({ completedAt: new Date() }), {}, "already_completed"],
    ["Google denial", tx({ error: "denied" }), {}, "oauth_denied"],
    ["a pending callback", tx({ callbackAt: null, completionHash: null, sealedRefreshToken: null }), {}, "callback_pending"],
  ])("refuses %s", async (_, row, override, reason) => {
    m.lock.mockResolvedValue(row);
    const outcome = await completeNativeConnect(USER, { ...input, ...override });
    expect(outcome).toMatchObject({ ok: false, reason });
    expect(m.save).not.toHaveBeenCalled();
  });
  it("saves the connection once for the transaction's own user", async () => {
    m.lock.mockResolvedValue(tx());
    expect(await completeNativeConnect(USER, input)).toEqual({ ok: true, chatbotPublicId: "cb_abcdefghijklmnop" });
    expect(m.lock).toHaveBeenCalledWith({}, USER, TX);
    expect(m.save).toHaveBeenCalledWith({}, USER, "me@example.com", "v1.sealed", "gmail");
    expect(m.finishTx).toHaveBeenCalledWith({}, TX);
  });
});

describe("native callback", () => {
  const params = (q: Record<string, string>) => new URLSearchParams(q);
  it("leaves unknown states to the browser flow", async () => {
    m.findTx.mockResolvedValue(null);
    expect(await handleNativeCallback(params({ state: "web-state", code: "x" }))).toBeNull();
  });
  it("redirects to the app with only the transaction id and a one-time code", async () => {
    m.findTx.mockResolvedValue({ id: TX });
    m.consume.mockResolvedValue({ id: TX, pkceVerifier: "p".repeat(43) });
    m.exchange.mockResolvedValue({ accessToken: "ya29.ACCESS-TOKEN", refreshToken: "1//REFRESH-TOKEN", scope: "" });
    const response = (await handleNativeCallback(params({ state: "s", code: "google-code" })))!;
    const location = response.headers.get("location")!;
    expect(response.status).toBe(302);
    expect(location.startsWith("chatbotmail://oauth/gmail?")).toBe(true);
    for (const secret of ["ACCESS-TOKEN", "REFRESH-TOKEN", "google-code", "sealed"]) expect(location).not.toContain(secret);
    const code = new URL(location).searchParams.get("code")!;
    expect(new URL(location).searchParams.get("tx")).toBe(TX);
    expect(m.exchange).toHaveBeenCalledWith(expect.anything(), "google-code", expect.anything(), "p".repeat(43));
    const recorded = m.record.mock.calls[0]![2];
    expect(recorded.completionHash).toBe(sha256hex(code));
    expect(recorded.sealedRefreshToken).not.toContain("REFRESH-TOKEN");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("refuses a replayed or expired callback", async () => {
    m.findTx.mockResolvedValue({ id: TX }); m.consume.mockResolvedValue(null);
    const location = (await handleNativeCallback(params({ state: "s", code: "c" })))!.headers.get("location")!;
    expect(new URL(location).searchParams.get("error")).toBe("expired"); expect(m.exchange).not.toHaveBeenCalled();
  });
  it("reports a denial to the app", async () => {
    m.findTx.mockResolvedValue({ id: TX }); m.consume.mockResolvedValue({ id: TX, pkceVerifier: "p".repeat(43) });
    const location = (await handleNativeCallback(params({ state: "s", error: "access_denied" })))!.headers.get("location")!;
    expect(new URL(location).searchParams.get("error")).toBe("denied");
    expect(m.record).toHaveBeenCalledWith({}, TX, { error: "denied" });
  });
  it("accepts only custom-scheme or https return URIs", () => {
    expect(nativeReturnUri({})).toBe("chatbotmail://oauth/gmail");
    expect(nativeReturnUri({ MAIL_NATIVE_RETURN_URI: "https://platform.test/app/mail" })).toBe("https://platform.test/app/mail");
    expect(nativeReturnUri({ MAIL_NATIVE_RETURN_URI: "myapp://cb" })).toBe("myapp://cb");
    for (const bad of ["http://evil.test/", "javascript:alert(1)", "https://x.test/?a=1", "not a url"]) expect(nativeReturnUri({ MAIL_NATIVE_RETURN_URI: bad })).toBe("chatbotmail://oauth/gmail");
  });
});
