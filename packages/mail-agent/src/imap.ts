/**
 * IMAP mailboxes (Yahoo, iCloud, Zoho, Fastmail, …) with an app password: reading and organizing over
 * IMAP (TLS, port 993), drafts in the Drafts folder, and sending an approved draft over SMTP.
 *
 * Message ids carry their folder: `<base64url folder>-<uid>`, so every id stays URL-safe and self-contained.
 * Labels are not available (IMAP has folders, not labels); the app hides them for these mailboxes.
 */
import {
  buildMime, cleanRecipients, decodeAttachments, GmailHttpError, htmlToText, MailAuthError, markdownToHtml, markdownToPlain,
  MAIL_ID, MAX_ATTACHMENT_BYTES, parseAddresses,
  type AttachmentFile, type DraftDetail, type DraftInput, type DraftResult, type MailContact, type MailLabel, type MailMessage,
  type MailSummary, type OrganizeAction,
} from "./gmail.ts";
import { attachmentsOf, findPartById, header, messageBody, parseMime, partText, type MimePart } from "./mime.ts";
import { parseMailQuery, type MailFolderKind, type ParsedQuery } from "./query.ts";
import { smtpSend } from "./smtp.ts";
import { cloudflareSockets, IMAP_PORTS, LineReader, validMailHost, type MailSocket, type SocketOpener } from "./socket.ts";
import type { ImapSettings } from "./store.ts";

/** Known providers, so most users only type their address and app password. */
export const IMAP_PRESETS: Record<string, ImapSettings & { name: string }> = {
  "yahoo.com": { name: "Yahoo", imapHost: "imap.mail.yahoo.com", imapPort: 993, smtpHost: "smtp.mail.yahoo.com", smtpPort: 465, username: "" },
  "ymail.com": { name: "Yahoo", imapHost: "imap.mail.yahoo.com", imapPort: 993, smtpHost: "smtp.mail.yahoo.com", smtpPort: 465, username: "" },
  "icloud.com": { name: "iCloud", imapHost: "imap.mail.me.com", imapPort: 993, smtpHost: "smtp.mail.me.com", smtpPort: 587, username: "" },
  "me.com": { name: "iCloud", imapHost: "imap.mail.me.com", imapPort: 993, smtpHost: "smtp.mail.me.com", smtpPort: 587, username: "" },
  "mac.com": { name: "iCloud", imapHost: "imap.mail.me.com", imapPort: 993, smtpHost: "smtp.mail.me.com", smtpPort: 587, username: "" },
  "aol.com": { name: "AOL", imapHost: "imap.aol.com", imapPort: 993, smtpHost: "smtp.aol.com", smtpPort: 465, username: "" },
  "zoho.com": { name: "Zoho", imapHost: "imap.zoho.com", imapPort: 993, smtpHost: "smtp.zoho.com", smtpPort: 465, username: "" },
  "fastmail.com": { name: "Fastmail", imapHost: "imap.fastmail.com", imapPort: 993, smtpHost: "smtp.fastmail.com", smtpPort: 465, username: "" },
  "gmx.com": { name: "GMX", imapHost: "imap.gmx.com", imapPort: 993, smtpHost: "mail.gmx.com", smtpPort: 587, username: "" },
};

/** The settings for an address: a preset for known domains, else the ones the user entered. */
export function imapSettingsFor(email: string, custom?: Partial<ImapSettings>): ImapSettings | null {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  const preset = IMAP_PRESETS[domain];
  const s = {
    imapHost: custom?.imapHost?.trim().toLowerCase() || preset?.imapHost || "",
    imapPort: custom?.imapPort ?? preset?.imapPort ?? 993,
    smtpHost: custom?.smtpHost?.trim().toLowerCase() || preset?.smtpHost || "",
    smtpPort: custom?.smtpPort ?? preset?.smtpPort ?? 465,
    username: custom?.username?.trim() || email,
  };
  if (!validMailHost(s.imapHost) || !validMailHost(s.smtpHost) || !IMAP_PORTS.includes(s.imapPort) || ![465, 587].includes(s.smtpPort)) return null;
  return s;
}

interface Response { text: string; literals: Uint8Array[] }
interface Folder { name: string; flags: string[] }

const quote = (value: string) => {
  if (/[\r\n\0]/.test(value)) throw new Error("Invalid value");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
};
const ascii = (value: string) => /^[\x20-\x7e]*$/.test(value);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const imapDate = (d: Date) => `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
const encodeId = (folder: string, uid: number) => `${Buffer.from(folder, "utf8").toString("base64url")}-${uid}`;
function decodeId(id: string): { folder: string; uid: number } {
  const i = id.lastIndexOf("-");
  if (!MAIL_ID.test(id) || i <= 0 || !/^\d{1,10}$/.test(id.slice(i + 1))) throw new Error("Invalid message id");
  return { folder: Buffer.from(id.slice(0, i), "base64url").toString("utf8"), uid: Number(id.slice(i + 1)) };
}
const LABELS_UNAVAILABLE = "Labels are not available for this mailbox (IMAP has folders, not labels).";
const PAGE = 20;
const MAX_BODY_CHARS = 6000;
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

/** Text of a FETCH item: `BODY[...]` literal content, or an atom/list after a key like `UID`. */
function literalFor(r: Response, key: RegExp): Uint8Array | null {
  const m = r.text.match(new RegExp(`${key.source}(?:<\\d+>)? \\u0000(\\d+)\\u0000`, "i"));
  return m ? r.literals[Number(m[1])] ?? null : null;
}

export class ImapClient {
  private socket: MailSocket | null = null;
  private reader: LineReader | null = null;
  private tag = 0;
  private selected: string | null = null;
  private capabilities = new Set<string>();
  private folders: Folder[] | null = null;

  private readonly settings: ImapSettings;
  private readonly email: string;
  private readonly password: string;
  private readonly open: SocketOpener;

  constructor(settings: ImapSettings, email: string, password: string, open: SocketOpener = cloudflareSockets) {
    this.settings = settings; this.email = email; this.password = password; this.open = open;
  }

  // ------------------------------------------------------------------ protocol

  private async connect(): Promise<void> {
    if (this.socket) return;
    if (!ascii(this.password) || !ascii(this.settings.username)) throw new MailAuthError("Use an app password made of plain letters and digits.");
    this.socket = await this.open(this.settings.imapHost, this.settings.imapPort, "on");
    this.reader = new LineReader(this.socket);
    const greeting = await this.reader.line();
    if (!/^\* (OK|PREAUTH)/i.test(greeting)) throw new Error("The mail server refused the connection");
    const login = await this.run(`LOGIN ${quote(this.settings.username)} ${quote(this.password)}`, false);
    if (!login.ok) throw new MailAuthError("The mail server refused the address or app password. Create a new app password and connect again.");
    const caps = (await this.run("CAPABILITY")).untagged.find((r) => /^\* CAPABILITY /i.test(r.text));
    this.capabilities = new Set((caps?.text ?? "").toUpperCase().split(" ").slice(2));
  }

  /** Runs one command; with `strict`, a NO/BAD answer throws. Literals in `parts` wait for the server's "+". */
  private async run(command: string | (string | Uint8Array)[], strict = true): Promise<{ ok: boolean; status: string; untagged: Response[] }> {
    if (!this.socket || !this.reader) throw new Error("Not connected");
    const tag = `a${++this.tag}`;
    const parts = typeof command === "string" ? [command] : command;
    let first = true;
    for (const part of parts) {
      if (typeof part === "string") { await this.socket.write(first ? `${tag} ${part}` : part); first = false; continue; }
      await this.socket.write(`{${part.length}}\r\n`);
      const cont = await this.reader.line();
      if (!cont.startsWith("+")) throw new GmailHttpError(400);
      await this.socket.write(part);
    }
    await this.socket.write("\r\n");
    const untagged: Response[] = [];
    for (;;) {
      let line = await this.reader.line();
      if (line.startsWith(`${tag} `)) {
        const status = line.slice(tag.length + 1);
        const ok = /^OK\b/i.test(status);
        if (!ok && strict) throw new GmailHttpError(/^NO\b/i.test(status) ? 400 : 500);
        return { ok, status, untagged };
      }
      const response: Response = { text: "", literals: [] };
      for (;;) {
        const lit = line.match(/\{(\d{1,9})\}$/);
        if (!lit) { response.text += line; break; }
        const size = Number(lit[1]);
        if (size > MAX_MESSAGE_BYTES) throw new Error("This message is too large to open here");
        response.text += `${line.slice(0, -lit[0].length)}\u0000${response.literals.length}\u0000`;
        response.literals.push(await this.reader.bytes(size));
        line = await this.reader.line();
      }
      untagged.push(response);
    }
  }

  private async listFolders(): Promise<Folder[]> {
    if (this.folders) return this.folders;
    await this.connect();
    const { untagged } = await this.run('LIST "" "*"');
    this.folders = untagged.flatMap((r) => {
      const m = r.text.match(/^\* LIST \(([^)]*)\) (?:"(?:[^"\\]|\\.)*"|NIL) (.*)$/i);
      if (!m) return [];
      let name = m[2]!.trim();
      const lit = name.match(/^\u0000(\d+)\u0000$/);
      if (lit) name = new TextDecoder().decode(r.literals[Number(lit[1])]);
      else if (name.startsWith('"')) name = name.slice(1, -1).replace(/\\(.)/g, "$1");
      return [{ name, flags: m[1]!.toLowerCase().split(/\s+/) }];
    });
    return this.folders;
  }

  /** The folder for an app folder, by RFC 6154 special-use flag, then by common names. */
  private async folder(kind: Exclude<MailFolderKind, "all"> | "all"): Promise<string> {
    if (kind === "inbox") return "INBOX";
    const folders = await this.listFolders();
    const flag = { sent: "\\sent", drafts: "\\drafts", spam: "\\junk", trash: "\\trash", archive: "\\archive", all: "\\all" }[kind];
    const byFlag = folders.find((f) => f.flags.includes(flag));
    if (byFlag) return byFlag.name;
    const names: Record<string, RegExp> = {
      sent: /^(.*[/.])?(sent|sent items|sent messages|sent mail)$/i, drafts: /^(.*[/.])?drafts?$/i, spam: /^(.*[/.])?(junk|spam|bulk|bulk mail|junk e-?mail)$/i,
      trash: /^(.*[/.])?(trash|deleted|deleted items|deleted messages)$/i, archive: /^(.*[/.])?(archive|archives)$/i, all: /^$/,
    };
    const byName = folders.find((f) => names[kind]!.test(f.name));
    if (byName) return byName.name;
    if (kind === "all") return "INBOX";
    throw new Error(`This mailbox has no ${kind} folder.`);
  }

  private async select(folder: string, writable = false): Promise<void> {
    await this.connect();
    const key = `${writable ? "w" : "r"}:${folder}`;
    if (this.selected === key || this.selected === `w:${folder}`) return;
    await this.run(`${writable ? "SELECT" : "EXAMINE"} ${quote(folder)}`);
    this.selected = key;
  }

  private criteria(q: ParsedQuery): (string | Uint8Array)[] {
    const out: (string | Uint8Array)[] = [];
    const add = (key: string, value: string) => {
      if (ascii(value)) out.push(` ${key} ${quote(value)}`);
      else { out.push(` ${key} `); out.push(new TextEncoder().encode(value)); }
    };
    if (q.unread === true) out.push(" UNSEEN");
    if (q.unread === false) out.push(" SEEN");
    if (q.starred) out.push(" FLAGGED");
    if (q.after) out.push(` SINCE ${imapDate(q.after)}`);
    if (q.before) out.push(` BEFORE ${imapDate(q.before)}`);
    if (q.from) add("FROM", q.from);
    if (q.to) add("TO", q.to);
    if (q.subject) add("SUBJECT", q.subject);
    if (q.text) add("TEXT", q.text);
    if (!out.length) out.push(" ALL");
    // Non-ASCII search terms need the UTF-8 charset.
    return out.some((p) => typeof p !== "string") ? [" CHARSET UTF-8", ...out] : out;
  }

  private async searchUids(folder: string, q: ParsedQuery): Promise<number[]> {
    await this.select(folder);
    const [first, ...rest] = this.criteria(q);
    const { untagged } = await this.run([`UID SEARCH${first as string}`, ...rest]);
    return untagged.flatMap((r) => (/^\* SEARCH/i.test(r.text) ? r.text.replace(/^\* SEARCH/i, "").trim().split(/\s+/).filter(Boolean).map(Number) : []))
      .filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => b - a);
  }

  private snippet(raw: Uint8Array | null): string {
    if (!raw) return "";
    const text = new TextDecoder("latin1").decode(raw)
      .replace(/^--.*$/gm, " ").replace(/^[A-Za-z-]+:.*$/gm, " ").replace(/=\r?\n/g, "")
      .replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    return /^[A-Za-z0-9+/=\s]{120,}$/.test(text) ? "" : text.slice(0, 200);
  }

  private async fetchSummaries(folder: string, uids: number[]): Promise<MailSummary[]> {
    if (!uids.length) return [];
    await this.select(folder);
    const { untagged } = await this.run(`UID FETCH ${uids.join(",")} (UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE)] BODY.PEEK[TEXT]<0.600>)`);
    const found = new Map<number, MailSummary>();
    for (const r of untagged) {
      const uid = Number(r.text.match(/\bUID (\d+)/i)?.[1]);
      if (!uid) continue;
      const flags = (r.text.match(/\bFLAGS \(([^)]*)\)/i)?.[1] ?? "").toLowerCase();
      const headers = parseMime(literalFor(r, /BODY\[HEADER\.FIELDS \([^)]*\)\]/) ?? new Uint8Array());
      const internal = r.text.match(/INTERNALDATE "([^"]+)"/i)?.[1];
      const date = header(headers, "date") || (internal ? new Date(internal.replace(/^(\d+)-(\w+)-(\d+)/, "$2 $1 $3")).toUTCString() : "");
      const id = encodeId(folder, uid);
      found.set(uid, {
        id, threadId: id, from: header(headers, "from"), subject: header(headers, "subject"), date,
        snippet: this.snippet(literalFor(r, /BODY\[TEXT\]/)), unread: !flags.includes("\\seen"), starred: flags.includes("\\flagged"), labelIds: [],
      });
    }
    return uids.flatMap((uid) => (found.has(uid) ? [found.get(uid)!] : []));
  }

  private async fetchRaw(id: string): Promise<{ folder: string; uid: number; raw: Uint8Array }> {
    const { folder, uid } = decodeId(id);
    await this.select(folder);
    const { untagged } = await this.run(`UID FETCH ${uid} (UID RFC822.SIZE BODY.PEEK[])`);
    const r = untagged.find((x) => new RegExp(`\\bUID ${uid}\\b`).test(x.text));
    const raw = r ? literalFor(r, /BODY\[\]/) : null;
    if (!raw) throw new GmailHttpError(404);
    return { folder, uid, raw };
  }

  private async moveUids(folder: string, uids: number[], destination: string): Promise<void> {
    if (!uids.length || folder === destination) return;
    await this.select(folder, true);
    if (this.capabilities.has("MOVE")) { await this.run(`UID MOVE ${uids.join(",")} ${quote(destination)}`); return; }
    await this.run(`UID COPY ${uids.join(",")} ${quote(destination)}`);
    await this.deleteUids(folder, uids);
  }

  private async deleteUids(folder: string, uids: number[]): Promise<void> {
    await this.select(folder, true);
    await this.run(`UID STORE ${uids.join(",")} +FLAGS.SILENT (\\Deleted)`);
    await this.run(this.capabilities.has("UIDPLUS") ? `UID EXPUNGE ${uids.join(",")}` : "EXPUNGE");
  }

  private group(ids: string[]): Map<string, number[]> {
    const groups = new Map<string, number[]>();
    for (const id of ids.slice(0, 50)) { const { folder, uid } = decodeId(id); groups.set(folder, [...(groups.get(folder) ?? []), uid]); }
    return groups;
  }

  /** Signs in and lists the folders: used once when the mailbox is connected. */
  async verify(): Promise<void> {
    await this.listFolders();
  }

  // ------------------------------------------------------------------ MailboxClient

  async profile(): Promise<{ email: string }> { return { email: this.email.toLowerCase() }; }

  async search(query: string, max: number): Promise<MailSummary[]> {
    const q = parseMailQuery(query);
    const folder = await this.folder(q.folder);
    return this.fetchSummaries(folder, (await this.searchUids(folder, q)).slice(0, Math.min(Math.max(1, max), 10)));
  }

  /** The cursor is the offset into the folder's matching messages, newest first. */
  async listPage(query: string, pageToken?: string, labelId?: string): Promise<{ messages: MailSummary[]; nextCursor: string | null }> {
    if (labelId) throw new Error(LABELS_UNAVAILABLE);
    const offset = pageToken && /^o:\d{1,6}$/.test(pageToken) ? Number(pageToken.slice(2)) : 0;
    const q = parseMailQuery(query);
    const folder = await this.folder(q.folder);
    const uids = await this.searchUids(folder, q);
    const page = uids.slice(offset, offset + PAGE);
    return { messages: await this.fetchSummaries(folder, page), nextCursor: offset + PAGE < uids.length ? `o:${offset + PAGE}` : null };
  }

  async contacts(self: string): Promise<MailContact[]> {
    const me = self.toLowerCase();
    const score = new Map<string, { contact: MailContact; weight: number }>();
    const since: ParsedQuery = { folder: "all", labels: [], text: "", after: new Date(Date.now() - 365 * 86_400_000) };
    for (const [kind, weight, fields] of [["sent", 2, ["to", "cc"]], ["inbox", 1, ["from"]]] as const) {
      let folder: string;
      try { folder = await this.folder(kind); } catch { continue; }
      const uids = (await this.searchUids(folder, since)).slice(0, 50);
      if (!uids.length) continue;
      const { untagged } = await this.run(`UID FETCH ${uids.join(",")} (UID BODY.PEEK[HEADER.FIELDS (FROM TO CC)])`);
      for (const r of untagged) {
        const headers = parseMime(literalFor(r, /BODY\[HEADER\.FIELDS \([^)]*\)\]/) ?? new Uint8Array());
        for (const contact of fields.flatMap((f) => parseAddresses(header(headers, f)))) {
          if (contact.email === me || /^(no-?reply|do-?not-?reply|mailer-daemon)@/i.test(contact.email)) continue;
          const entry = score.get(contact.email) ?? { contact, weight: 0 };
          if (!entry.contact.name && contact.name) entry.contact = contact;
          entry.weight += weight;
          score.set(contact.email, entry);
        }
      }
    }
    return [...score.values()].sort((a, b) => b.weight - a.weight).slice(0, 300).map((e) => e.contact);
  }

  async summaries(ids: string[]): Promise<{ messages: MailSummary[]; missing: string[] }> {
    const messages: MailSummary[] = [];
    for (const [folder, uids] of this.group(ids)) {
      try { messages.push(...await this.fetchSummaries(folder, uids)); } catch (err) { if (!(err instanceof GmailHttpError)) throw err; }
    }
    const found = new Set(messages.map((m) => m.id));
    return { messages: ids.flatMap((id) => messages.filter((m) => m.id === id)), missing: ids.filter((id) => !found.has(id)) };
  }

  async pinnedSummaries(ids: string[]): Promise<MailSummary[]> {
    return (await this.summaries(ids.filter((id) => MAIL_ID.test(id)))).messages;
  }

  async read(id: string): Promise<MailMessage> {
    const { folder, uid, raw } = await this.fetchRaw(id);
    const root = parseMime(raw);
    const [summary] = await this.fetchSummaries(folder, [uid]);
    const body = messageBody(root);
    const text = body.html ? htmlToText(body.text) : body.text;
    return {
      ...(summary ?? { id, threadId: id, from: header(root, "from"), subject: header(root, "subject"), date: header(root, "date"), snippet: "", unread: false, starred: false, labelIds: [] }),
      to: header(root, "to"), body: text.slice(0, MAX_BODY_CHARS), truncated: text.length > MAX_BODY_CHARS,
      attachments: attachmentsOf(root).map((p) => ({ partId: p.partId, filename: p.filename!, mimeType: p.contentType, size: p.body.byteLength })),
    };
  }

  async attachment(messageId: string, partId: string): Promise<AttachmentFile> {
    const { raw } = await this.fetchRaw(messageId);
    const part = findPartById(parseMime(raw), partId);
    if (!part?.filename) throw new GmailHttpError(404);
    if (part.body.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("This attachment is larger than 15 MB. Open it in your mail app.");
    return { filename: part.filename, mimeType: part.contentType, bytes: part.body };
  }

  async labels(): Promise<MailLabel[]> { return []; }
  async createLabel(_name: string): Promise<MailLabel> { throw new Error(LABELS_UNAVAILABLE); }
  async updateLabel(_id: string, _change: { name?: string; color?: string | null }): Promise<MailLabel> { throw new Error(LABELS_UNAVAILABLE); }
  async deleteLabel(_id: string): Promise<void> { throw new Error(LABELS_UNAVAILABLE); }
  async relabel(_ids: string[], _add: string[], _remove: string[]): Promise<void> { throw new Error(LABELS_UNAVAILABLE); }

  async organize(ids: string[], action: OrganizeAction): Promise<void> {
    for (const [folder, uids] of this.group(ids)) {
      const flags = async (op: "+" | "-", flag: string) => { await this.select(folder, true); await this.run(`UID STORE ${uids.join(",")} ${op}FLAGS.SILENT (${flag})`); };
      switch (action) {
        case "mark_read": await flags("+", "\\Seen"); break;
        case "mark_unread": await flags("-", "\\Seen"); break;
        case "star": await flags("+", "\\Flagged"); break;
        case "unstar": await flags("-", "\\Flagged"); break;
        case "archive": await this.moveUids(folder, uids, await this.folder("archive")); break;
        case "move_to_inbox": await this.moveUids(folder, uids, "INBOX"); break;
        case "mark_spam": await this.moveUids(folder, uids, await this.folder("spam")); break;
      }
    }
  }

  /** Moves to the Trash folder (recoverable), like Gmail's Trash. */
  async trash(ids: string[]): Promise<void> {
    const trash = await this.folder("trash");
    for (const [folder, uids] of this.group(ids)) await this.moveUids(folder, uids, trash);
  }

  async createDraft(input: DraftInput): Promise<DraftResult> {
    let to = input.to; let subject = input.subject; let inReplyTo: string | undefined; let references: string | undefined;
    if (input.replyToMessageId) {
      const original = parseMime((await this.fetchRaw(input.replyToMessageId)).raw);
      inReplyTo = header(original, "message-id") || undefined;
      references = [header(original, "references"), inReplyTo].filter(Boolean).join(" ") || undefined;
      to ||= header(original, "reply-to") || header(original, "from");
      const s = header(original, "subject");
      subject ||= /^re:/i.test(s) ? s : `Re: ${s}`;
    }
    const recipients = cleanRecipients(to);
    const markdown = input.format === "markdown";
    const messageId = `<${crypto.randomUUID()}@mail-assistant>`;
    const mime = [
      `From: ${this.email}`, `Date: ${new Date().toUTCString()}`, `Message-ID: ${messageId}`,
      buildMime({
        to: recipients, subject, inReplyTo, references, attachments: decodeAttachments(input.attachments),
        body: markdown ? markdownToPlain(input.body) : input.body, html: markdown ? markdownToHtml(input.body) : undefined,
      }),
    ].join("\r\n");
    const drafts = await this.folder("drafts");
    await this.connect();
    const appended = await this.run([`APPEND ${quote(drafts)} (\\Draft \\Seen) `, new TextEncoder().encode(mime)]);
    let uid = Number(appended.status.match(/APPENDUID \d+ (\d+)/i)?.[1]);
    if (!uid) {
      this.selected = null;
      await this.select(drafts);
      const { untagged } = await this.run(`UID SEARCH HEADER Message-ID ${quote(messageId)}`);
      uid = Math.max(0, ...untagged.flatMap((r) => r.text.replace(/^\* SEARCH/i, "").trim().split(/\s+/).map(Number).filter(Boolean)));
    }
    if (!uid) throw new Error("The draft was saved but could not be found again. Check the Drafts folder.");
    return { draftId: encodeId(drafts, uid), to: recipients, subject: subject.replace(/[\r\n]+/g, " ").trim() };
  }

  /** An edited draft gets a new UID in IMAP, so the old one is reported missing. `messageId` is the UID. */
  async getDraft(draftId: string): Promise<DraftDetail | null> {
    let root: MimePart; let uid: number;
    try { const fetched = await this.fetchRaw(draftId); root = parseMime(fetched.raw); uid = fetched.uid; } catch (err) {
      if (err instanceof GmailHttpError && err.status === 404) return null;
      throw err;
    }
    const list = (name: string) => parseAddresses(header(root, name)).map((c) => c.email);
    const body = messageBody(root);
    return {
      draftId, messageId: String(uid), to: list("to"), cc: list("cc"), bcc: list("bcc"), subject: header(root, "subject"),
      body: (body.html ? htmlToText(body.text) : body.text).slice(0, 100_000),
      attachments: attachmentsOf(root).map((p) => ({ filename: p.filename!, mimeType: p.contentType, size: p.body.byteLength })),
    };
  }

  /**
   * Sends the draft exactly as stored (Bcc removed from the headers), files a copy in Sent unless the
   * provider does that itself, then removes the draft.
   */
  async sendDraft(draftId: string): Promise<void> {
    const { folder, uid, raw } = await this.fetchRaw(draftId);
    const root = parseMime(raw);
    const recipients = [...new Set(["to", "cc", "bcc"].flatMap((name) => parseAddresses(header(root, name)).map((c) => c.email)))];
    let text = new TextDecoder("latin1").decode(raw);
    const split = text.search(/\r?\n\r?\n/);
    const headers = text.slice(0, split).replace(/^Bcc:.*(\r?\n[ \t].*)*\r?\n?/gim, "");
    text = headers + text.slice(split);
    const mime = new Uint8Array(Buffer.from(text, "latin1"));
    await smtpSend(this.open, { host: this.settings.smtpHost, port: this.settings.smtpPort, username: this.settings.username, password: this.password }, this.email, recipients, text);
    // Sent: providers that file SMTP mail themselves would get a duplicate.
    if (!/(^|\.)(gmail|googlemail|office365|outlook|icloud|me)\.com$/.test(this.settings.smtpHost.replace(/^smtp\.(mail\.)?/, ""))) {
      try { await this.run([`APPEND ${quote(await this.folder("sent"))} (\\Seen) `, mime]); } catch { /* the email was sent; filing a copy is best effort */ }
    }
    try { await this.deleteUids(folder, [uid]); } catch { /* sent; a leftover draft is harmless */ }
  }
}

