import { parseAddresses } from "../src/gmail.ts";
import { describe, expect, it, vi } from "vitest";
import {
  buildMime, cleanFilename, cleanLabelName, decodeAttachments, GmailClient, mailTools, markdownToHtml, markdownToPlain,
  MAX_OUTGOING_ATTACHMENT_BYTES, type MailApi,
} from "../src/index.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const tool = (name: string) => mailTools.find((item) => item.name === name)!;

describe("formatted email", () => {
  it("escapes everything before applying the Markdown subset", () => {
    const html = markdownToHtml("Hi <script>alert(1)</script> **team**\n\n- one\n- *two*\n\n[site](https://example.com) [bad](javascript:alert(1))");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<strong>team</strong>");
    expect(html).toContain("<ul><li>one</li><li><em>two</em></li></ul>");
    expect(html).toContain('<a href="https://example.com">site</a>');
    expect(html).not.toContain('href="javascript');
  });
  it("cannot break out of a link attribute", () => {
    expect(markdownToHtml('[x](https://a.co/"onmouseover="alert(1))')).not.toContain('"onmouseover');
  });
  it("keeps the plain alternative readable", () => {
    expect(markdownToPlain("**Hello** *there*\n# Title\n* item\n[docs](https://d.co)")).toBe("Hello there\nTitle\n- item\ndocs (https://d.co)");
  });
  it("builds multipart/alternative inside a multipart/mixed wrapper", () => {
    const mime = buildMime({ to: "a@b.co", subject: "Hi", body: "plain", html: "<p>x</p>", attachments: [{ filename: "r\"e\r\nport.pdf", mimeType: "application/pdf", bytes: Buffer.from("PDF") }] });
    expect(mime).toMatch(/Content-Type: multipart\/mixed; boundary="mix_/);
    expect(mime).toMatch(/Content-Type: multipart\/alternative; boundary="alt_/);
    expect(mime).toContain('Content-Disposition: attachment; filename="r_e__port.pdf"');
    expect(mime.split("\r\n").filter((line) => /^bcc:/i.test(line))).toEqual([]);
  });
});

describe("outgoing attachments", () => {
  it("rejects oversized, malformed and unsafe files", () => {
    expect(() => decodeAttachments([{ filename: "a", mimeType: "text/plain", data: "not base64!" }])).toThrow();
    const big = Buffer.alloc(MAX_OUTGOING_ATTACHMENT_BYTES + 1).toString("base64");
    expect(() => decodeAttachments([{ filename: "a", mimeType: "text/plain", data: big }])).toThrow(/10 MB/);
    expect(decodeAttachments([{ filename: "../x.txt", mimeType: "bad type", data: "aGk=" }])[0]).toMatchObject({ filename: "_x.txt", mimeType: "application/octet-stream" });
    expect(cleanFilename("..\\..\\evil.exe")).toBe("_.._evil.exe");
  });
  it("uploads drafts with attachments through the media endpoint", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => json({ id: "d9" }));
    const draft = await new GmailClient("t", fetcher as unknown as typeof fetch).createDraft({ to: "a@b.co", subject: "Files", body: "See attached", attachments: [{ filename: "a.txt", mimeType: "text/plain", data: "aGk=" }] });
    expect(draft.draftId).toBe("d9");
    expect(String(fetcher.mock.calls[0]![0])).toContain("/upload/gmail/v1/users/me/drafts?uploadType=multipart");
    expect(String(fetcher.mock.calls[0]![1]!.body)).toContain("Content-Type: message/rfc822");
  });
});

describe("labels", () => {
  it("lists only user labels and refuses system labels in relabel", async () => {
    const fetcher = vi.fn(async () => json({ labels: [{ id: "INBOX", name: "INBOX", type: "system" }, { id: "Label_5", name: "Work", type: "user", color: { backgroundColor: "#ff0000" } }] }));
    const client = new GmailClient("t", fetcher as unknown as typeof fetch);
    expect(await client.labels()).toEqual([{ id: "Label_5", name: "Work", color: "#ff0000" }]);
    await expect(client.relabel(["m1"], ["TRASH"], [])).rejects.toThrow(/own labels/);
    await expect(client.relabel(["m1"], [], ["INBOX"])).rejects.toThrow(/own labels/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("validates label names", () => {
    expect(cleanLabelName("  Clients\n")).toBe("Clients");
    expect(() => cleanLabelName("Trash")).toThrow();
    expect(() => cleanLabelName("x".repeat(101))).toThrow();
  });
  it("the agent resolves names and never creates labels implicitly", async () => {
    const relabel = vi.fn(async () => undefined);
    const mail = { labels: async () => [{ id: "Label_1", name: "Clients", color: null }], relabel } as unknown as MailApi;
    await tool("label_mail").run({ ids: ["m1"], add: ["clients"] }, { mail } as never);
    expect(relabel).toHaveBeenCalledWith(["m1"], ["Label_1"], []);
    await expect(tool("label_mail").run({ ids: ["m1"], add: ["Unknown"] }, { mail } as never)).rejects.toThrow(/No label named/);
  });
  it("renames and recolors only user labels with Gmail's palette", async () => {
    const fetcher = vi.fn(async () => json({ id: "Label_5", name: "Clients", color: { backgroundColor: "#16a766" } }));
    const client = new GmailClient("t", fetcher as unknown as typeof fetch);
    expect(await client.updateLabel("Label_5", { name: "Clients", color: "#16A766" })).toEqual({ id: "Label_5", name: "Clients", color: "#16a766" });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/labels\/Label_5$/);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ name: "Clients", color: { backgroundColor: "#16a766", textColor: "#ffffff" } });
    await expect(client.updateLabel("Label_5", { color: "#123456" })).rejects.toThrow(/available label colors/);
    await expect(client.updateLabel("INBOX", { name: "x" })).rejects.toThrow(/own labels/);
    await expect(client.deleteLabel("TRASH")).rejects.toThrow(/own labels/);
    await expect(client.updateLabel("Label_5", { name: "Spam" })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("deletes a user label with DELETE", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    await new GmailClient("t", fetcher as unknown as typeof fetch).deleteLabel("Label_5");
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe("DELETE");
  });
  it("the agent edits a label by name and has no delete tool", async () => {
    const updateLabel = vi.fn(async (id: string, change: { name?: string }) => ({ id, name: change.name ?? "Clients", color: null }));
    const mail = { labels: async () => [{ id: "Label_1", name: "Clients", color: null }], updateLabel } as unknown as MailApi;
    await tool("edit_label").run({ label: "clients", newName: "Customers", color: "none" }, { mail } as never);
    expect(updateLabel).toHaveBeenCalledWith("Label_1", { name: "Customers", color: null });
    expect(tool("delete_label")).toBeUndefined();
  });
});

describe("received attachments", () => {
  const message = {
    id: "m1", threadId: "t1",
    payload: { parts: [
      { partId: "0", mimeType: "text/plain", body: { data: Buffer.from("hello").toString("base64url") } },
      { partId: "1", mimeType: "application/pdf", filename: "Terms.pdf", body: { attachmentId: "ATT_1", size: 3 } },
    ] },
  };
  it("lists attachments when reading and downloads by part id", async () => {
    const fetcher = vi.fn(async (url: string) => url.includes("/attachments/") ? json({ data: Buffer.from("PDF").toString("base64url") }) : json(message));
    const client = new GmailClient("t", fetcher as unknown as typeof fetch);
    expect((await client.read("m1")).attachments).toEqual([{ partId: "1", filename: "Terms.pdf", mimeType: "application/pdf", size: 3 }]);
    const file = await client.attachment("m1", "1");
    expect(Buffer.from(file.bytes).toString()).toBe("PDF");
    await expect(client.attachment("m1", "../1")).rejects.toThrow();
  });
  it("the agent reads document text and says when a file cannot be read", async () => {
    const mail = { attachment: async () => ({ filename: "a.pdf", mimeType: "application/pdf", bytes: new Uint8Array([1]) }) } as unknown as MailApi;
    const read = await tool("read_attachment").run({ messageId: "m1", partId: "1" }, { mail, extractText: async () => "Contract text" } as never);
    expect(read.result).toMatchObject({ text: "Contract text", truncated: false });
    const image = await tool("read_attachment").run({ messageId: "m1", partId: "1" }, { mail, extractText: async () => null } as never);
    expect(image.result).toMatchObject({ readable: false });
  });
});

describe("pinned summaries", () => {
  it("returns nothing when every pinned message was deleted", async () => {
    let call = 0;
    const fetcher = vi.fn(async () => {
      call++;
      if (call === 1) return new Response("--b\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 404 Not Found\r\n\r\n{}\r\n--b--", { status: 200, headers: { "content-type": "multipart/mixed; boundary=b" } });
      return new Response("{}", { status: 404 });
    });
    expect(await new GmailClient("t", fetcher as unknown as typeof fetch).pinnedSummaries(["m1", "m2"])).toEqual([]);
  });
  it("ignores invalid ids without calling Gmail", async () => {
    const fetcher = vi.fn();
    expect(await new GmailClient("t", fetcher as unknown as typeof fetch).pinnedSummaries(["../x"])).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("drafts with mailbox files", () => {
  it("copies the referenced attachments into the draft and still waits for approval", async () => {
    const createDraft = vi.fn(async (input: { to: string; subject: string }) => ({ draftId: "d1", to: input.to, subject: input.subject }));
    const attachment = vi.fn(async () => ({ filename: "Terms.pdf", mimeType: "application/pdf", bytes: new Uint8Array([1, 2, 3]) }));
    const queueAction = vi.fn(async () => undefined);
    const out = await tool("draft_email").run(
      { to: "ana@example.test", subject: "Terms", body: "Attached.", attachFrom: [{ messageId: "m1", partId: "1" }] },
      { mail: { createDraft, attachment } as unknown as MailApi, queueAction } as never);
    expect(attachment).toHaveBeenCalledWith("m1", "1");
    expect(createDraft.mock.calls[0]![0]).toMatchObject({ attachments: [{ filename: "Terms.pdf", mimeType: "application/pdf", data: "AQID" }] });
    expect(queueAction).toHaveBeenCalledOnce();
    expect((out.result as { sent: boolean }).sent).toBe(false);
  });
  it("refuses more than 10 MB of mailbox files before creating anything", async () => {
    const createDraft = vi.fn();
    const attachment = vi.fn(async () => ({ filename: "big.bin", mimeType: "application/octet-stream", bytes: new Uint8Array(6 * 1024 * 1024) }));
    await expect(tool("draft_email").run(
      { to: "ana@example.test", subject: "Files", body: "x", attachFrom: [{ messageId: "m1", partId: "1" }, { messageId: "m2", partId: "1" }] },
      { mail: { createDraft, attachment } as unknown as MailApi, queueAction: vi.fn() } as never)).rejects.toThrow(/10 MB/);
    expect(createDraft).not.toHaveBeenCalled();
  });
});

describe("contact suggestions", () => {
  it("parses named and bare addresses", () => {
    expect(parseAddresses('"Ana Cruz" <Ana@Example.test>, bob@example.test, Team <team@example.test>')).toEqual([
      { name: "Ana Cruz", email: "ana@example.test" }, { name: "", email: "bob@example.test" }, { name: "Team", email: "team@example.test" }]);
  });
  it("ranks people the user wrote to first and skips the user and no-reply senders", async () => {
    const meta = (id: string, headers: Record<string, string>) => ({ id, threadId: id, payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) } });
    const parts = [
      meta("a", { From: "Me <me@example.test>", To: "Ana Cruz <ana@example.test>, bob@example.test" }),
      meta("b", { From: "Bob B <bob@example.test>", To: "me@example.test" }),
      meta("c", { From: "noreply@shop.test", To: "me@example.test" }),
      meta("d", { From: "Me <me@example.test>", To: "ana@example.test" }),
    ];
    const batch = parts.map((p) => `--b
Content-Type: application/http

HTTP/1.1 200 OK
Content-Type: application/json

${JSON.stringify(p)}
`).join("") + "--b--";
    const fetcher = vi.fn(async (url: string) => String(url).includes("batch")
      ? new Response(batch, { status: 200, headers: { "content-type": "multipart/mixed; boundary=b" } })
      : json({ messages: parts.map((p) => ({ id: p.id })) }));
    const contacts = await new GmailClient("t", fetcher as unknown as typeof fetch).contacts("Me@example.test");
    expect(contacts).toEqual([{ name: "Ana Cruz", email: "ana@example.test" }, { name: "Bob B", email: "bob@example.test" }]);
  });
});
