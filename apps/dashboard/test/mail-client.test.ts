import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ query: vi.fn(), role: vi.fn(), open: vi.fn(), bot: vi.fn(), draft: vi.fn(), modify: vi.fn(), list: vi.fn(), read: vi.fn(), model: vi.fn(), shared: vi.fn(), retrieve: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/client-api", () => ({
  withClientRequest: (r: Request, f: (u: {id: string}) => unknown) => f({ id: "user-one" }),
  clientBot: m.bot,
  clientError: (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status }),
}));
vi.mock("@/lib/native-mail", () => ({ mailRole: m.role }));
vi.mock("@/lib/native-knowledge", () => ({ sharedKnowledgeChatbot: m.shared }));
vi.mock("@/lib/knowledge", () => ({ retrieverFor: () => m.retrieve }));
vi.mock("@/lib/mail-agent", () => ({
  mailDb: (f: (db: unknown) => unknown) => f({ query: m.query }),
  openMailbox: m.open, agentModel: () => ({ invoke: m.model }),
}));
import { assistWriting, claimDraft, listMailbox, mailboxQuery, modifyMailbox, saveMailboxDraft, writingInstruction, writingSchema } from "../src/lib/mail-client";
const requestId = "00000000-0000-4000-8000-000000000001";
function req(path: string, body?: object) {
  return new Request(`https://platform.test/api/v1/client/mail/${path}?chatbotId=cb_test`, { method: body ? "POST" : "GET", ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
}
const draft = { requestId, to: "ana@example.test", subject: "Status", body: "Hello" };
beforeEach(() => {
  vi.resetAllMocks(); m.role.mockResolvedValue("owner"); m.bot.mockResolvedValue({id:"bot"});
  m.shared.mockResolvedValue(null); m.retrieve.mockResolvedValue([]);
  m.open.mockResolvedValue({ connection: { id: "conn-1", email: "me@example.com" }, gmail: { createDraft: m.draft, organize: m.modify, listPage: m.list, read: m.read } });
  m.query.mockResolvedValue({ rowCount: 1, rows: [{ id: "action-one" }] });
  m.draft.mockResolvedValue({ draftId: "draft-one", to: draft.to, subject: draft.subject });
});
describe("mail client boundaries", () => {
  it("keeps OR expressions inside the selected folder", () => {
    expect(mailboxQuery("inbox", "from:ana OR from:bob")).toBe("in:inbox (from:ana OR from:bob)");
  });
  it("checks organization role before opening a mailbox", async () => {
    m.role.mockResolvedValue("member");
    await expect(listMailbox(req("messages"))).rejects.toMatchObject({code:"forbidden"});
    expect(m.open).not.toHaveBeenCalled();
  });
  it("passes cursor and scope to the mailbox of the authenticated user", async () => {
    m.list.mockResolvedValue({messages:[],nextCursor:"next"});
    await listMailbox(new Request("https://platform.test/mail?chatbotId=cb_test&folder=sent&query=invoice&cursor=page"));
    expect(m.open).toHaveBeenCalledWith("user-one", null);
    expect(m.list).toHaveBeenCalledWith("in:sent (invoice)", "page", undefined);
  });
  it("rejects invalid recipients before claiming or creating a draft", async () => {
    expect((await saveMailboxDraft(req("drafts", {...draft,to:"bad-address"}))).status).toBe(400);
    expect(m.query).not.toHaveBeenCalled(); expect(m.draft).not.toHaveBeenCalled();
  });
  it("claims a request before Gmail then queues a review without sending", async () => {
    expect((await saveMailboxDraft(req("drafts",draft))).status).toBe(201);
    expect(m.query.mock.invocationCallOrder[0]).toBeLessThan(m.draft.mock.invocationCallOrder[0]!);
    expect(m.query.mock.calls.some(([sql]) => sql.includes("mail_actions") && sql.includes("'send'"))).toBe(true);
  });
  it("reports missing storage as unavailable before creating any Gmail draft", async () => {
    m.query.mockRejectedValueOnce(Object.assign(new Error("missing relation"),{code:"42P01"}));
    expect((await saveMailboxDraft(req("drafts",draft))).status).toBe(503);
    expect(m.draft).not.toHaveBeenCalled();
  });
  it("replays a completed draft without calling Gmail again", async () => {
    m.query.mockResolvedValueOnce({rowCount:0,rows:[]});
    const { createHash } = await import("node:crypto");
    const {requestId:_,...input}=draft;
    m.query.mockResolvedValueOnce({rows:[{fingerprint:createHash("sha256").update(JSON.stringify(input)).digest("hex"),status:"completed",result:{draftId:"existing"}}]});
    expect(await (await saveMailboxDraft(req("drafts",draft))).json()).toEqual({draftId:"existing"});
    expect(m.draft).not.toHaveBeenCalled();
  });
  it("refuses uncertain and mismatched request replays", async () => {
    m.query.mockResolvedValueOnce({rowCount:0}).mockResolvedValueOnce({rows:[{fingerprint:"hash",status:"uncertain"}]});
    await expect(claimDraft("user-one",requestId,"hash")).rejects.toMatchObject({reason:"draft_uncertain"});
    m.query.mockResolvedValueOnce({rowCount:0}).mockResolvedValueOnce({rows:[{fingerprint:"other",status:"completed"}]});
    await expect(claimDraft("user-one",requestId,"hash")).rejects.toMatchObject({reason:"request_mismatch"});
  });
  it("marks an uncertain provider draft outcome and never retries automatically", async () => {
    m.draft.mockRejectedValue(new Error("timeout"));
    await expect(saveMailboxDraft(req("drafts",draft))).rejects.toThrow("timeout");
    expect(m.draft).toHaveBeenCalledTimes(1);
    expect(m.query.mock.calls.some(([sql]) => sql.includes("status='uncertain'"))).toBe(true);
  });
  it("queues Trash approval without performing a mailbox mutation", async () => {
    const result=await modifyMailbox(req("modify",{requestId,ids:["m1"],action:"trash"}));
    expect(await result.json()).toMatchObject({waitingForApproval:true});
    expect(m.modify).not.toHaveBeenCalled();
  });
});
describe("standalone AI writing", () => {
  it("grounds writing in the live published knowledge without giving it mailbox tools", async () => {
    m.shared.mockResolvedValue({id:"shared"});
    m.retrieve.mockResolvedValue([{title:"Company facts",content:"The internal project codename is Jadefinch."}]);
    m.model.mockResolvedValue({content:"Our project is Jadefinch."});
    await assistWriting(req("writing",{operation:"write",text:"Write about the project codename"}));
    expect(m.retrieve).toHaveBeenCalledWith("Write about the project codename");
    expect(m.model.mock.calls[0]![0][0].content).toContain("The internal project codename is Jadefinch.");
    expect(m.open).not.toHaveBeenCalled(); expect(m.draft).not.toHaveBeenCalled();
  });
  it("constrains the task and provides no mailbox tools", async () => {
    const input=writingSchema.parse({operation:"translate",text:"Hello",language:"Spanish"});
    expect(writingInstruction(input)).toContain("no mailbox tools");
    m.model.mockResolvedValue({content:"Hola"});
    expect(await (await assistWriting(req("writing",input))).json()).toEqual({text:"Hola"});
    expect(m.open).not.toHaveBeenCalled();
    expect(m.shared).not.toHaveBeenCalled();
  });
  it("rejects empty input and empty AI output", async () => {
    expect((await assistWriting(req("writing",{operation:"grammar",text:" "}))).status).toBe(400);
    m.model.mockResolvedValue({content:" "});
    expect((await assistWriting(req("writing",{operation:"grammar",text:"Hello"}))).status).toBe(502);
  });
});
