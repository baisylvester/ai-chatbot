import { describe, expect, it, vi } from "vitest";
import { parseMailQuery } from "../src/query.ts";
import { attachmentsOf, header, messageBody, parseMime } from "../src/mime.ts";
import { OutlookClient, toAppId, toGraphId } from "../src/outlook.ts";
import { ImapClient, imapSettingsFor } from "../src/imap.ts";
import { smtpData, smtpSend } from "../src/smtp.ts";
import { validMailHost, type MailSocket } from "../src/socket.ts";

describe("Gmail-style queries for other providers", () => {
  it("reads the app's folder queries", () => {
    expect(parseMailQuery("in:inbox is:unread")).toMatchObject({ folder: "inbox", unread: true });
    expect(parseMailQuery("-in:inbox -in:sent -in:drafts -in:trash -in:spam")).toMatchObject({ folder: "archive" });
    expect(parseMailQuery("in:sent (invoice from:ana@example.test)")).toMatchObject({ folder: "sent", from: "ana@example.test", text: "invoice" });
    expect(parseMailQuery("is:starred has:attachment label:\"Big Clients\"")).toMatchObject({ folder: "all", starred: true, attachments: true, labels: ["Big Clients"] });
  });
  it("turns relative dates into dates", () => {
    const now = new Date("2026-11-26T00:00:00Z");
    expect(parseMailQuery("newer_than:2d", now).after?.toISOString()).toBe("2026-11-24T00:00:00.000Z");
    expect(parseMailQuery("after:2026/11/01").after?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("MIME", () => {
  const raw = (s: string) => new TextEncoder().encode(s.replace(/\n/g, "\r\n"));
  it("parses encoded headers, the text part and attachments with IMAP part numbers", () => {
    const root = parseMime(raw(`From: =?UTF-8?B?QW7DoQ==?= <ana@example.test>
Subject: =?ISO-8859-1?Q?Caf=E9_plan?=
Content-Type: multipart/mixed; boundary="b1"

--b1
Content-Type: multipart/alternative; boundary="b2"

--b2
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

Hello =E2=9C=93 soft=
 break
--b2
Content-Type: text/html

<p>Hello</p>
--b2--
--b1
Content-Type: application/pdf; name="terms.pdf"
Content-Disposition: attachment; filename="terms.pdf"
Content-Transfer-Encoding: base64

AQID
--b1--
`));
    expect(header(root, "from")).toBe("Aná <ana@example.test>");
    expect(header(root, "subject")).toBe("Café plan");
    expect(messageBody(root)).toEqual({ text: "Hello ✓ soft break", html: false });
    const [file] = attachmentsOf(root);
    expect(file).toMatchObject({ partId: "2", filename: "terms.pdf", contentType: "application/pdf" });
    expect([...file!.body]).toEqual([1, 2, 3]);
  });
  it("numbers a single-part message as part 1", () => {
    expect(parseMime(raw("Subject: x\n\nbody")).partId).toBe("1");
  });
});

describe("Outlook", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  it("keeps Graph ids URL-safe and reversible", () => {
    expect(toAppId("AAMkAD-x_y==")).toBe("AAMkAD-x_y");
    expect(toGraphId("AAMkAD-x_y")).toBe("AAMkAD-x_y==");
  });
  it("lists a folder with filters and maps messages to summaries", async () => {
    const fetcher = vi.fn(async (_url: string) => json({ value: [{
      id: "AAMkAA==", subject: "Invoice", from: { emailAddress: { name: "Ana", address: "ana@example.test" } }, receivedDateTime: "2026-11-20T10:00:00Z",
      bodyPreview: "Please pay", isRead: false, flag: { flagStatus: "flagged" }, categories: ["Clients"],
    }] }));
    const page = await new OutlookClient("t", fetcher as unknown as typeof fetch).listPage("in:inbox is:unread");
    const url = decodeURIComponent(String(fetcher.mock.calls[0]![0]));
    expect(url).toContain("/mailFolders/inbox/messages");
    expect(url).toContain("isRead eq false");
    expect(page.messages[0]).toMatchObject({ id: "AAMkAA", from: "Ana <ana@example.test>", unread: true, starred: true, labelIds: [expect.stringMatching(/^Label_/)] });
    expect(page.nextCursor).toBeNull();
  });
  it("never follows a next link off Microsoft Graph", async () => {
    const fetcher = vi.fn();
    await expect(new OutlookClient("t", fetcher as unknown as typeof fetch).listPage("in:inbox", "https://evil.example/steal")).rejects.toThrow(/Invalid page/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("trash moves to Deleted Items and a 401 asks to reconnect", async () => {
    const fetcher = vi.fn(async () => json({}, 201));
    await new OutlookClient("t", fetcher as unknown as typeof fetch).trash(["AAMkAA"]);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/messages/AAMkAA%3D%3D/move");
    expect(JSON.parse(init.body as string)).toEqual({ destinationId: "deleteditems" });
    const denied = vi.fn(async () => json({}, 401));
    await expect(new OutlookClient("t", denied as unknown as typeof fetch).profile()).rejects.toThrow(/Connect Outlook again/);
  });
});

/** A scripted IMAP/SMTP server: each answer is sent after the client writes something. */
function fakeServer(script: (written: string) => string | undefined, greeting: string) {
  const sent: string[] = [];
  const queue: Uint8Array[] = [new TextEncoder().encode(greeting)];
  let waiting: ((v: Uint8Array | null) => void) | null = null;
  const push = (s: string) => { const b = new TextEncoder().encode(s); if (waiting) { const w = waiting; waiting = null; w(b); } else queue.push(b); };
  const socket: MailSocket = {
    async write(data) { const text = typeof data === "string" ? data : new TextDecoder().decode(data); sent.push(text); const answer = script(text); if (answer) push(answer); },
    read: () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise((r) => { waiting = r; })),
    startTls() { return socket; },
    async close() {},
  };
  return { socket, sent };
}

describe("IMAP", () => {
  const settings = imapSettingsFor("me@yahoo.com")!;
  it("uses provider presets and refuses internal hosts", () => {
    expect(settings).toMatchObject({ imapHost: "imap.mail.yahoo.com", smtpPort: 465, username: "me@yahoo.com" });
    expect(imapSettingsFor("me@company.test", { imapHost: "localhost", smtpHost: "smtp.company.com" })).toBeNull();
    expect(validMailHost("10.0.0.1")).toBe(false);
    expect(validMailHost("mail.example.org")).toBe(true);
    expect(validMailHost("mail.example")).toBe(false);
  });
  it("signs in, searches the inbox newest first and reads headers", async () => {
    const header = "From: Ana <ana@example.test>\r\nSubject: Hello\r\nDate: Wed, 25 Nov 2026 10:00:00 +0000\r\n\r\n";
    const { socket, sent } = fakeServer((w) => {
      const tag = w.match(/^(a\d+) /)?.[1];
      if (!tag) return undefined;
      if (w.includes(" LOGIN ")) return `${tag} OK logged in\r\n`;
      if (w.includes(" CAPABILITY")) return `* CAPABILITY IMAP4rev1 MOVE UIDPLUS\r\n${tag} OK\r\n`;
      if (w.includes(" EXAMINE ")) return `${tag} OK [READ-ONLY]\r\n`;
      if (w.includes(" UID SEARCH")) return `* SEARCH 3 9 5\r\n${tag} OK\r\n`;
      if (w.includes(" UID FETCH")) return `* 1 FETCH (UID 9 FLAGS (\\Flagged) BODY[HEADER.FIELDS (FROM TO CC SUBJECT DATE)] {${header.length}}\r\n${header} BODY[TEXT]<0> {11}\r\nHi there...)\r\n${tag} OK\r\n`;
      return `${tag} OK\r\n`;
    }, "* OK ready\r\n");
    const client = new ImapClient(settings, "me@yahoo.com", "app-pass", async () => socket);
    const page = await client.listPage("in:inbox is:unread");
    expect(sent.find((w) => w.includes("UID SEARCH"))).toContain("UNSEEN");
    expect(sent.find((w) => w.includes("UID FETCH"))).toContain("UID FETCH 9,5,3 ");
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({ from: "Ana <ana@example.test>", subject: "Hello", starred: true, unread: true, snippet: "Hi there..." });
    expect(page.messages[0]!.id).toMatch(/^[A-Za-z0-9_-]+-9$/);
    await expect(client.labels()).resolves.toEqual([]);
    await expect(client.relabel(["x-1"], ["Label_a"], [])).rejects.toThrow(/not available/);
  });
  it("a refused password asks for a new app password", async () => {
    const { socket } = fakeServer((w) => { const tag = w.match(/^(a\d+) /)?.[1]; return tag ? `${tag} NO [AUTHENTICATIONFAILED] Invalid\r\n` : undefined; }, "* OK\r\n");
    await expect(new ImapClient(settings, "me@yahoo.com", "bad", async () => socket).verify()).rejects.toThrow(/app password/);
  });
});

describe("SMTP", () => {
  it("dot-stuffs lines and terminates the data", () => {
    expect(smtpData("a\n.b\nc")).toBe("a\r\n..b\r\nc\r\n.\r\n");
  });
  it("authenticates and sends to every recipient", async () => {
    const { socket, sent } = fakeServer((w) => {
      if (w.startsWith("EHLO")) return "250-hi\r\n250 AUTH PLAIN\r\n";
      if (w.startsWith("AUTH PLAIN")) return "235 ok\r\n";
      if (w.startsWith("MAIL FROM") || w.startsWith("RCPT TO")) return "250 ok\r\n";
      if (w.startsWith("DATA")) return "354 go\r\n";
      if (w.endsWith("\r\n.\r\n")) return "250 queued\r\n";
      return undefined;
    }, "220 smtp ready\r\n");
    await smtpSend(async () => socket, { host: "smtp.mail.yahoo.com", port: 465, username: "me@yahoo.com", password: "p" }, "me@yahoo.com", ["a@x.test", "b@x.test"], "Subject: hi\r\n\r\nbody");
    expect(sent.filter((w) => w.startsWith("RCPT TO"))).toEqual(["RCPT TO:<a@x.test>\r\n", "RCPT TO:<b@x.test>\r\n"]);
  });
});
