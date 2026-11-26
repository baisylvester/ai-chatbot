/**
 * Gmail over its REST API with plain fetch (works on Node and Workers). Nothing here sends or
 * deletes mail on its own: the agent queues those for the mailbox owner's approval (see agent.ts).
 */
export type FetchFn = typeof fetch;

export interface GoogleOAuthConfig { clientId: string; clientSecret: string; redirectUri: string }

/** Read, label, draft and send. It cannot delete mail permanently. */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** The mailbox owner has to connect Gmail again (access revoked, expired or never granted). */
export class MailAuthError extends Error {
  constructor(message = "Gmail access has expired or was revoked. Connect Gmail again.") {
    super(message);
    this.name = "MailAuthError";
  }
}

/** A Gmail API answer that was not 2xx. `status` tells a definite refusal (4xx) from an unknown outcome (5xx). */
export class GmailHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Gmail request failed (${status})`);
    this.name = "GmailHttpError";
    this.status = status;
  }
}

/** `codeChallenge` (S256) adds PKCE for the native flow; the web flow omits it and is unchanged. */
export function googleAuthUrl(config: GoogleOAuthConfig, state: string, codeChallenge?: string): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPE,
    // offline + consent: Google only returns a refresh token on a fresh consent.
    access_type: "offline",
    prompt: "consent",
    state,
    ...(codeChallenge ? { code_challenge: codeChallenge, code_challenge_method: "S256" } : {}),
  }).toString();
  return url.toString();
}

async function tokenRequest(params: Record<string, string>, fetchFn: FetchFn) {
  const response = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    if (data.error === "invalid_grant") throw new MailAuthError();
    throw new Error(`Google token request failed (${response.status} ${String(data.error ?? "")})`.trim());
  }
  return data;
}

export async function exchangeCode(config: GoogleOAuthConfig, code: string, fetchFn: FetchFn = fetch, codeVerifier?: string) {
  const data = await tokenRequest({
    code, client_id: config.clientId, client_secret: config.clientSecret,
    redirect_uri: config.redirectUri, grant_type: "authorization_code",
    ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
  }, fetchFn);
  const scope = String(data.scope ?? "");
  if (!scope.split(" ").includes(GMAIL_SCOPE)) throw new MailAuthError("Gmail permission was not granted. Tick the Gmail box on Google's consent screen.");
  if (typeof data.refresh_token !== "string" || typeof data.access_token !== "string") throw new MailAuthError("Google did not return a long-lived token. Try connecting again.");
  return { refreshToken: data.refresh_token, accessToken: data.access_token, scope };
}

export async function refreshAccessToken(config: GoogleOAuthConfig, refreshToken: string, fetchFn: FetchFn = fetch): Promise<string> {
  const data = await tokenRequest({
    refresh_token: refreshToken, client_id: config.clientId, client_secret: config.clientSecret, grant_type: "refresh_token",
  }, fetchFn);
  if (typeof data.access_token !== "string") throw new Error("Google did not return an access token");
  return data.access_token;
}

/** Best effort: the connection is removed locally whether or not Google accepts the revocation. */
export async function revokeToken(token: string, fetchFn: FetchFn = fetch): Promise<void> {
  await fetchFn("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  }).catch(() => undefined);
}

/** `labelIds` lists only the user's own labels (Gmail ids `Label_…`), never system labels. */
export interface MailSummary { id: string; threadId: string; from: string; subject: string; date: string; snippet: string; unread: boolean; starred: boolean; labelIds?: string[] }
/** A file attached to a received message. `partId` addresses it inside that message. */
export interface MessageAttachment { partId: string; filename: string; mimeType: string; size: number }
export interface MailMessage extends MailSummary { to: string; body: string; truncated: boolean; attachments?: MessageAttachment[] }
export interface MailLabel { id: string; name: string; color: string | null }
export interface AttachmentFile { filename: string; mimeType: string; bytes: Uint8Array }
/** A file to attach to a new draft. `data` is standard or url-safe base64. */
export interface OutgoingAttachment { filename: string; mimeType: string; data: string }
/** `format: "markdown"` renders a limited, escaped Markdown subset as the HTML part; the plain part stays readable. */
export interface DraftInput { to: string; subject: string; body: string; replyToMessageId?: string; format?: "plain" | "markdown"; attachments?: OutgoingAttachment[] }
export interface DraftResult { draftId: string; to: string; subject: string }
export interface DraftAttachment { filename: string; mimeType: string; size: number }
/** A Gmail draft as it is now, for review before sending. `messageId` changes whenever the draft is edited. */
export interface DraftDetail { draftId: string; messageId: string; to: string[]; cc: string[]; bcc: string[]; subject: string; body: string; attachments: DraftAttachment[] }
export type OrganizeAction = "archive" | "move_to_inbox" | "mark_read" | "mark_unread" | "star" | "unstar" | "mark_spam";

/** What the agent needs from a mailbox. GmailClient implements it; tests use a fake. */
export interface MailApi {
  search(query: string, max: number): Promise<MailSummary[]>;
  read(id: string): Promise<MailMessage>;
  createDraft(input: DraftInput): Promise<DraftResult>;
  organize(ids: string[], action: OrganizeAction): Promise<void>;
  /** The user's own labels. */
  labels(): Promise<MailLabel[]>;
  /** Adds and removes user labels only; system labels (INBOX, TRASH, SPAM…) are refused. */
  relabel(ids: string[], add: string[], remove: string[]): Promise<void>;
  createLabel(name: string): Promise<MailLabel>;
  /** People from the user's recent mail, most frequent first. */
  contacts(self: string): Promise<MailContact[]>;
  /** Summaries for known ids (pinned messages); deleted messages are left out. */
  pinnedSummaries(ids: string[]): Promise<MailSummary[]>;
  /** Renames or recolors one of the user's own labels. */
  updateLabel(id: string, change: { name?: string; color?: string | null }): Promise<MailLabel>;
  /** Deletes one of the user's own labels; the messages themselves are kept. */
  deleteLabel(id: string): Promise<void>;
  attachment(messageId: string, partId: string): Promise<AttachmentFile>;
}

interface Part { partId?: string; mimeType?: string; filename?: string; body?: { data?: string; size?: number; attachmentId?: string }; parts?: Part[]; headers?: { name: string; value: string }[] }
interface RawMessage { id: string; threadId: string; snippet?: string; labelIds?: string[]; payload?: Part }

const MAX_BODY_CHARS = 6000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

const header = (message: RawMessage, name: string) =>
  message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");

function findPart(part: Part | undefined, mimeType: string): string | null {
  if (!part) return null;
  if (part.mimeType === mimeType && part.body?.data) return decode(part.body.data);
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return null;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function messageText(message: RawMessage): string {
  const plain = findPart(message.payload, "text/plain");
  if (plain?.trim()) return plain.trim();
  const html = findPart(message.payload, "text/html");
  return html ? htmlToText(html) : message.snippet ?? "";
}

/** Draft bodies shown for approval are complete; this only guards against absurd payloads. */
const MAX_DRAFT_BODY_CHARS = 100_000;

function attachmentsOf(part: Part | undefined, out: DraftAttachment[] = []): DraftAttachment[] {
  if (!part) return out;
  if (part.filename) out.push({ filename: part.filename, mimeType: part.mimeType ?? "application/octet-stream", size: part.body?.size ?? 0 });
  for (const child of part.parts ?? []) attachmentsOf(child, out);
  return out;
}

const addressList = (value: string) => value.split(",").map((item) => item.trim()).filter(Boolean);

/** Gmail's ids for labels the user created. System labels never match. */
export const USER_LABEL_ID = /^Label_[0-9A-Za-z_-]{1,60}$/;
/** Part ids are dotted numbers ("1", "0.2"). */
export const PART_ID = /^[0-9]{1,3}(\.[0-9]{1,3}){0,6}$/;
/** Attachments the server will download in one request (Gmail allows 25 MB per message). */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
/** Total size of files attached to one new draft. */
export const MAX_OUTGOING_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_OUTGOING_ATTACHMENTS = 10;

function messageAttachments(part: Part | undefined, out: MessageAttachment[] = []): MessageAttachment[] {
  if (!part) return out;
  if (part.filename && part.partId && PART_ID.test(part.partId)) {
    out.push({ partId: part.partId, filename: part.filename, mimeType: part.mimeType ?? "application/octet-stream", size: part.body?.size ?? 0 });
  }
  for (const child of part.parts ?? []) messageAttachments(child, out);
  return out;
}

function findPartById(part: Part | undefined, partId: string): Part | null {
  if (!part) return null;
  if (part.partId === partId) return part;
  for (const child of part.parts ?? []) {
    const found = findPartById(child, partId);
    if (found) return found;
  }
  return null;
}

function summarize(message: RawMessage): MailSummary {
  return {
    id: message.id, threadId: message.threadId,
    from: header(message, "From"), subject: header(message, "Subject") || "(no subject)", date: header(message, "Date"),
    snippet: message.snippet ?? "", unread: message.labelIds?.includes("UNREAD") ?? false,
    starred: message.labelIds?.includes("STARRED") ?? false,
    labelIds: (message.labelIds ?? []).filter((id) => USER_LABEL_ID.test(id)),
  };
}

/** Background colors Gmail accepts for labels, each with its readable text color. */
export const LABEL_COLORS: Record<string, string> = {
  "#fb4c2f": "#ffffff", "#ffad47": "#ffffff", "#fad165": "#000000", "#16a766": "#ffffff", "#43d692": "#ffffff",
  "#4a86e8": "#ffffff", "#2da2bb": "#ffffff", "#a479e2": "#ffffff", "#f691b3": "#ffffff", "#666666": "#ffffff",
};

/** A label name Gmail will accept and that cannot smuggle control characters. */
export function cleanLabelName(name: string): string {
  const value = name.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!value || value.length > 100) throw new Error("A label name needs 1 to 100 characters");
  if (/^(inbox|sent|drafts?|spam|trash|starred|important|unread|chat|category_.*)$/i.test(value)) throw new Error("That name is reserved by Gmail");
  return value;
}

/** Thrown when one request has used its share of Gmail calls. The agent passes the text on to the model. */
export const CALL_LIMIT_MESSAGE = "This request has used all the mailbox lookups allowed for one question. Answer with what you already have and tell the user to ask again for the rest.";

const BATCH_URL = "https://gmail.googleapis.com/batch/gmail/v1";
const METADATA_QUERY = "format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date";

export interface MailContact { name: string; email: string }
/** Every "Name <address>" or bare address in an address header. */
export function parseAddresses(value: string): MailContact[] {
  const out: MailContact[] = [];
  for (const match of value.matchAll(/(?:"?([^"<>,]*?)"?\s*<([^<>\s]+@[^<>\s]+)>)|([^\s<>,;"]+@[^\s<>,;"]+)/g)) {
    const email = (match[2] ?? match[3] ?? "").trim().toLowerCase();
    if (ADDRESS.test(email)) out.push({ name: (match[1] ?? "").trim().slice(0, 100), email });
  }
  return out;
}

/** One multipart body asking for the metadata of every id. Gmail answers all of them in a single response. */
export function buildBatchBody(ids: string[], boundary: string): string {
  const parts = ids.map((id, index) =>
    `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <item${index}>\r\n\r\nGET /gmail/v1/users/me/messages/${id}?${METADATA_QUERY}\r\n\r\n`);
  return `${parts.join("")}--${boundary}--\r\n`;
}

/** The messages in a batch response, keyed by id. Parts that failed (deleted mail, rate limits) are left out. */
export function parseBatchResponse(body: string, boundary: string): Map<string, RawMessage> {
  const found = new Map<string, RawMessage>();
  for (const part of body.split(`--${boundary}`)) {
    const status = part.match(/HTTP\/[\d.]+ (\d{3})/);
    if (!status || status[1] !== "200") continue;
    const start = part.indexOf("{", status.index);
    const end = part.lastIndexOf("}");
    if (start < 0 || end < start) continue;
    try {
      const message = JSON.parse(part.slice(start, end + 1)) as RawMessage;
      if (typeof message.id === "string") found.set(message.id, message);
    } catch {
      // A part that is not JSON is skipped like any other failed part.
    }
  }
  return found;
}

/** Extracts the address from `Name <a@b.c>` or returns the input when it already is one. */
export function addressOf(value: string): string {
  return (value.match(/<([^<>]+)>/)?.[1] ?? value).trim();
}

/** Recipients as a clean comma-separated list. Throws on anything that is not an email address. */
export function cleanRecipients(to: string): string {
  const list = to.split(/[,;]/).map((item) => addressOf(item)).filter(Boolean);
  if (!list.length || list.length > 20 || list.some((item) => !ADDRESS.test(item))) throw new Error("Recipients must be valid email addresses");
  return list.join(", ");
}

const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
const encodeHeader = (value: string) =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;

const wrap76 = (base64: string) => base64.replace(/.{76}/g, "$&\r\n");
const base64Utf8 = (text: string) => wrap76(Buffer.from(text, "utf8").toString("base64"));

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Inline Markdown on already-escaped text: links (http, https, mailto only), bold, italic, code. */
function inlineMarkdown(escaped: string): string {
  return escaped
    .replace(/\[([^\]\n]{1,300})\]\(((?:https?:\/\/|mailto:)[^\s)"<>]{1,2000})\)/g, (_m, text: string, href: string) => `<a href="${href}">${text}</a>`)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?=$|[^\w*])/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_([^_\n]+)_(?=$|[^\w])/g, "$1<em>$2</em>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");
}

/**
 * A small, safe Markdown subset as email HTML: paragraphs, line breaks, headings (#, ##, ###), bullet
 * and numbered lists, bold, italic, inline code and links. Everything is escaped first, so the input
 * can never add tags, attributes or scripts of its own.
 */
export function markdownToHtml(markdown: string): string {
  const blocks: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  let paragraph: string[] = [];
  const flushParagraph = () => { if (paragraph.length) blocks.push(`<p>${paragraph.join("<br>")}</p>`); paragraph = []; };
  const flushList = () => { if (list) blocks.push(`<${list.tag}>${list.items.map((item) => `<li>${item}</li>`).join("")}</${list.tag}>`); list = null; };
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d{1,3}[.)]\s+(.*)$/);
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    if (bullet || numbered) {
      flushParagraph();
      const tag = bullet ? "ul" : "ol";
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push(inlineMarkdown(escapeHtml((bullet ?? numbered)![1]!)));
      continue;
    }
    flushList();
    if (heading) {
      flushParagraph();
      const level = heading[1]!.length + 1;
      blocks.push(`<h${level}>${inlineMarkdown(escapeHtml(heading[2]!))}</h${level}>`);
      continue;
    }
    paragraph.push(inlineMarkdown(escapeHtml(line)));
  }
  flushParagraph(); flushList();
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">${blocks.join("\n")}</div>`;
}

/** The plain-text alternative of a Markdown body: markers removed, link targets kept in brackets. */
export function markdownToPlain(markdown: string): string {
  return markdown.replace(/\r\n?/g, "\n")
    .replace(/\[([^\]\n]{1,300})\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, "$1 ($2)")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?=$|[^\w*])/g, "$1$2")
    .replace(/(^|[^\w])_([^_\n]+)_(?=$|[^\w])/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^#{1,3}\s+/gm, "")
    .replace(/^\s*[*•]\s+/gm, "- ");
}

const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;

/** A filename safe for a MIME header and for the recipient's disk: no paths, quotes or control characters. */
export function cleanFilename(name: string): string {
  const base = name.replace(/[\u0000-\u001f\u007f"\\/:*?<>|]/g, "_").replace(/^\.+/, "").trim().slice(0, 200);
  return base || "attachment";
}

/** Decodes and checks the files for a new draft. Throws a user-facing error on anything unacceptable. */
export function decodeAttachments(files: OutgoingAttachment[] = []): { filename: string; mimeType: string; bytes: Buffer }[] {
  if (files.length > MAX_OUTGOING_ATTACHMENTS) throw new Error(`Attach at most ${MAX_OUTGOING_ATTACHMENTS} files`);
  let total = 0;
  return files.map((file) => {
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(file.data)) throw new Error("An attachment could not be read");
    const bytes = Buffer.from(file.data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (!bytes.length) throw new Error("An attachment is empty");
    total += bytes.length;
    if (total > MAX_OUTGOING_ATTACHMENT_BYTES) throw new Error("Attachments can total at most 10 MB");
    return { filename: cleanFilename(file.filename), mimeType: MIME_TYPE.test(file.mimeType) ? file.mimeType.toLowerCase() : "application/octet-stream", bytes };
  });
}

/** RFC 2231 filename parameter, readable by every mail client for any characters. */
const filenameParam = (name: string) =>
  /^[\x20-\x7e]*$/.test(name) ? `filename="${name}"` : `filename*=UTF-8''${encodeURIComponent(name)}`;

/**
 * An RFC 5322 message. Header values are single lines, so input cannot add headers. Plain text by
 * default; `html` adds a multipart/alternative HTML part and `attachments` a multipart/mixed wrapper.
 */
export function buildMime(input: {
  to: string; subject: string; body: string; inReplyTo?: string; references?: string;
  html?: string; attachments?: { filename: string; mimeType: string; bytes: Buffer }[];
}): string {
  const headers = [
    `To: ${cleanRecipients(input.to)}`,
    `Subject: ${encodeHeader(oneLine(input.subject).slice(0, 300))}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${oneLine(input.inReplyTo)}`, `References: ${oneLine(input.references || input.inReplyTo)}`] : []),
    "MIME-Version: 1.0",
  ];
  const textPart = ['Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", base64Utf8(input.body)].join("\r\n");
  let bodyPart = textPart;
  if (input.html) {
    const boundary = `alt_${crypto.randomUUID()}`;
    const htmlPart = ['Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", base64Utf8(input.html)].join("\r\n");
    bodyPart = [`Content-Type: multipart/alternative; boundary="${boundary}"`, "", `--${boundary}`, textPart, `--${boundary}`, htmlPart, `--${boundary}--`].join("\r\n");
  }
  if (!input.attachments?.length) return [...headers, bodyPart].join("\r\n");
  const boundary = `mix_${crypto.randomUUID()}`;
  const files = input.attachments.map((file) => [
    `Content-Type: ${file.mimeType}; name="${cleanFilename(file.filename).replace(/[^\x20-\x7e]/g, "_")}"`,
    `Content-Disposition: attachment; ${filenameParam(cleanFilename(file.filename))}`,
    "Content-Transfer-Encoding: base64", "", wrap76(file.bytes.toString("base64")),
  ].join("\r\n"));
  return [
    ...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
    `--${boundary}`, bodyPart, ...files.flatMap((file) => [`--${boundary}`, file]), `--${boundary}--`,
  ].join("\r\n");
}

const LABEL_CHANGES: Record<OrganizeAction, { addLabelIds?: string[]; removeLabelIds?: string[] }> = {
  archive: { removeLabelIds: ["INBOX"] },
  move_to_inbox: { addLabelIds: ["INBOX"], removeLabelIds: ["SPAM"] },
  mark_spam: { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] },
  mark_read: { removeLabelIds: ["UNREAD"] },
  mark_unread: { addLabelIds: ["UNREAD"] },
  star: { addLabelIds: ["STARRED"] },
  unstar: { removeLabelIds: ["STARRED"] },
};

export class GmailClient implements MailApi {
  private readonly accessToken: string;
  private readonly fetchFn: FetchFn;

  private readonly maxCalls: number;
  private calls = 0;

  /**
   * `maxCalls` caps the Gmail requests this client makes. Hosts such as Cloudflare Workers allow a
   * fixed number of outgoing requests per incoming one; past it every request fails, the model's too.
   */
  constructor(accessToken: string, fetchFn: FetchFn = fetch, maxCalls = Number.POSITIVE_INFINITY) {
    this.accessToken = accessToken;
    this.fetchFn = fetchFn;
    this.maxCalls = maxCalls;
  }

  private spend(): void {
    if (this.calls >= this.maxCalls) throw new Error(CALL_LIMIT_MESSAGE);
    this.calls++;
  }

  private async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    this.spend();
    const response = await this.fetchFn(`${API}${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${this.accessToken}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (response.status === 401) throw new MailAuthError();
    if (!response.ok) throw new GmailHttpError(response.status);
    return (response.status === 204 ? {} : await response.json()) as T;
  }

  private checkIds(ids: string[]): string[] {
    if (!ids.length || ids.length > 50 || ids.some((id) => !ID.test(id))) throw new Error("Invalid message id");
    return ids;
  }

  async profile(): Promise<{ email: string }> {
    const data = await this.call<{ emailAddress: string }>("/profile");
    return { email: data.emailAddress };
  }

  async search(query: string, max: number): Promise<MailSummary[]> {
    const params = new URLSearchParams({ q: query, maxResults: String(Math.min(Math.max(1, max), 10)) });
    if (/\bin:(trash|spam|anywhere)\b/i.test(query)) params.set("includeSpamTrash", "true");
    const list = await this.call<{ messages?: { id: string }[] }>(`/messages?${params}`);
    const ids = (list.messages ?? []).map(({ id }) => id).filter((id) => ID.test(id));
    if (!ids.length) return [];
    if (ids.length === 1) return [summarize(await this.call<RawMessage>(`/messages/${ids[0]}?${METADATA_QUERY}`))];
    // One batch request instead of one request per message: a search costs two requests, whatever its size.
    const found = await this.batchMetadata(ids);
    return ids.flatMap((id) => { const message = found.get(id); return message ? [summarize(message)] : []; });
  }

  /** Cursor-based native mailbox browsing; cursors are opaque Gmail tokens. */
  async listPage(query: string, pageToken?: string, labelId?: string): Promise<{ messages: MailSummary[]; nextCursor: string | null }> {
    const params = new URLSearchParams({ q: query, maxResults: "20" });
    if (pageToken) params.set("pageToken", pageToken);
    if (labelId) {
      if (!USER_LABEL_ID.test(labelId)) throw new Error("Invalid label id");
      params.set("labelIds", labelId);
    }
    if (/\bin:(trash|spam|anywhere)\b/i.test(query)) params.set("includeSpamTrash", "true");
    const page = await this.call<{ messages?: { id: string }[]; nextPageToken?: string }>(`/messages?${params}`);
    const ids = (page.messages ?? []).map(m => m.id).filter(id => ID.test(id));
    const found = ids.length ? await this.batchMetadata(ids) : new Map<string, RawMessage>();
    return { messages: ids.flatMap(id => { const m = found.get(id); return m ? [summarize(m)] : []; }), nextCursor: page.nextPageToken ?? null };
  }

  /**
   * People in the user's recent mail (up to 100 messages from the last year in Sent and Inbox), most
   * frequent first; people the user wrote to count double. The app filters this list as the user types.
   */
  async contacts(self: string): Promise<MailContact[]> {
    const params = new URLSearchParams({ q: "newer_than:1y (in:sent OR in:inbox) -in:spam -in:trash", maxResults: "100" });
    const page = await this.call<{ messages?: { id: string }[] }>(`/messages?${params}`);
    const ids = (page.messages ?? []).map((m) => m.id).filter((id) => ID.test(id));
    if (!ids.length) return [];
    const found = await this.batchMetadata(ids);
    const me = self.toLowerCase();
    const score = new Map<string, { contact: MailContact; weight: number }>();
    for (const message of found.values()) {
      const sent = parseAddresses(header(message, "From")).some((c) => c.email === me);
      const people = sent ? ["To", "Cc"].flatMap((name) => parseAddresses(header(message, name))) : parseAddresses(header(message, "From"));
      for (const contact of people) {
        if (contact.email === me || /^(no-?reply|do-?not-?reply|mailer-daemon)@/i.test(contact.email)) continue;
        const entry = score.get(contact.email) ?? { contact, weight: 0 };
        if (!entry.contact.name && contact.name) entry.contact = contact;
        entry.weight += sent ? 2 : 1;
        score.set(contact.email, entry);
      }
    }
    return [...score.values()].sort((a, b) => b.weight - a.weight).slice(0, 300).map((entry) => entry.contact);
  }

  /** Summaries for known message ids, in the given order. Messages that no longer exist are left out. */
  async pinnedSummaries(ids: string[]): Promise<MailSummary[]> {
    const valid = ids.filter((id) => ID.test(id)).slice(0, 50);
    if (!valid.length) return [];
    let found: Map<string, RawMessage>;
    try { found = await this.batchMetadata(valid); } catch (err) {
      // Every pinned message deleted looks like an all-failed batch; one plain read tells the two apart.
      if (err instanceof Error && err.message.startsWith("Gmail could not load")) {
        try { await this.call(`/messages/${valid[0]}?format=minimal`); } catch (inner) { if (inner instanceof GmailHttpError && inner.status === 404) return []; }
      }
      throw err;
    }
    return valid.flatMap((id) => { const message = found.get(id); return message ? [summarize(message)] : []; });
  }

  private async batchMetadata(ids: string[]): Promise<Map<string, RawMessage>> {
    this.spend();
    const boundary = `batch_${crypto.randomUUID()}`;
    const response = await this.fetchFn(BATCH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.accessToken}`, "Content-Type": `multipart/mixed; boundary=${boundary}` },
      body: buildBatchBody(ids, boundary),
    });
    if (response.status === 401) throw new MailAuthError();
    if (!response.ok) throw new GmailHttpError(response.status);
    const replyBoundary = response.headers.get("content-type")?.match(/boundary="?([^";]+)"?/)?.[1];
    if (!replyBoundary) throw new Error("Gmail returned an unreadable batch response");
    const found = parseBatchResponse(await response.text(), replyBoundary);
    // Every part failing (for example all rate limited) is an error, not an empty mailbox.
    if (!found.size) throw new Error("Gmail could not load the messages it found. Try again.");
    return found;
  }

  async read(id: string): Promise<MailMessage> {
    const message = await this.call<RawMessage>(`/messages/${this.checkIds([id])[0]}?format=full`);
    const text = messageText(message);
    return {
      ...summarize(message), to: header(message, "To"), body: text.slice(0, MAX_BODY_CHARS), truncated: text.length > MAX_BODY_CHARS,
      attachments: messageAttachments(message.payload),
    };
  }

  async labels(): Promise<MailLabel[]> {
    const data = await this.call<{ labels?: { id: string; name: string; type?: string; color?: { backgroundColor?: string } }[] }>("/labels");
    return (data.labels ?? [])
      .filter((label) => label.type === "user" && USER_LABEL_ID.test(label.id))
      .map((label) => ({ id: label.id, name: label.name, color: /^#[0-9a-f]{6}$/i.test(label.color?.backgroundColor ?? "") ? label.color!.backgroundColor! : null }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async createLabel(name: string): Promise<MailLabel> {
    const label = await this.call<{ id: string; name: string }>("/labels", {
      method: "POST", body: { name: cleanLabelName(name), labelListVisibility: "labelShow", messageListVisibility: "show" },
    });
    return { id: label.id, name: label.name, color: null };
  }

  async updateLabel(id: string, change: { name?: string; color?: string | null }): Promise<MailLabel> {
    if (!USER_LABEL_ID.test(id)) throw new Error("Only your own labels can be changed");
    const body: Record<string, unknown> = {};
    if (change.name !== undefined) body.name = cleanLabelName(change.name);
    if (change.color !== undefined) {
      const color = change.color?.toLowerCase() ?? null;
      if (color !== null && !LABEL_COLORS[color]) throw new Error("Choose one of the available label colors");
      // Gmail removes a color when both values are absent from an explicit color object.
      body.color = color ? { backgroundColor: color, textColor: LABEL_COLORS[color] } : { backgroundColor: null, textColor: null };
    }
    if (!Object.keys(body).length) throw new Error("Nothing to change");
    const label = await this.call<{ id: string; name: string; color?: { backgroundColor?: string } }>(`/labels/${id}`, { method: "PATCH", body });
    const bg = label.color?.backgroundColor ?? "";
    return { id: label.id, name: label.name, color: /^#[0-9a-f]{6}$/i.test(bg) ? bg : null };
  }

  async deleteLabel(id: string): Promise<void> {
    if (!USER_LABEL_ID.test(id)) throw new Error("Only your own labels can be deleted");
    await this.call(`/labels/${id}`, { method: "DELETE" });
  }

  async relabel(ids: string[], add: string[], remove: string[]): Promise<void> {
    const labels = [...add, ...remove];
    if (!labels.length || labels.length > 20 || labels.some((id) => !USER_LABEL_ID.test(id))) throw new Error("Only your own labels can be added or removed");
    if (add.some((id) => remove.includes(id))) throw new Error("A label cannot be added and removed at once");
    await this.call("/messages/batchModify", { method: "POST", body: { ids: this.checkIds(ids), addLabelIds: add, removeLabelIds: remove } });
  }

  /** The bytes of one attachment, refusing anything over MAX_ATTACHMENT_BYTES. */
  async attachment(messageId: string, partId: string): Promise<AttachmentFile> {
    if (!PART_ID.test(partId)) throw new Error("Invalid attachment");
    const id = this.checkIds([messageId])[0]!;
    const message = await this.call<RawMessage>(`/messages/${id}?format=full`);
    const part = findPartById(message.payload, partId);
    if (!part?.filename) throw new GmailHttpError(404);
    if ((part.body?.size ?? 0) > MAX_ATTACHMENT_BYTES) throw new Error("This attachment is larger than 15 MB. Open it in Gmail.");
    let data = part.body?.data;
    if (!data && part.body?.attachmentId) {
      if (!/^[A-Za-z0-9_-]{1,4096}$/.test(part.body.attachmentId)) throw new Error("Invalid attachment");
      data = (await this.call<{ data?: string }>(`/messages/${id}/attachments/${part.body.attachmentId}`)).data;
    }
    const bytes = new Uint8Array(Buffer.from(data ?? "", "base64url"));
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("This attachment is larger than 15 MB. Open it in Gmail.");
    return { filename: cleanFilename(part.filename), mimeType: MIME_TYPE.test(part.mimeType ?? "") ? part.mimeType!.toLowerCase() : "application/octet-stream", bytes };
  }

  async createDraft(input: DraftInput): Promise<DraftResult> {
    let { to, subject } = input;
    let threadId: string | undefined, inReplyTo: string | undefined, references: string | undefined;
    if (input.replyToMessageId) {
      const original = await this.call<RawMessage>(
        `/messages/${this.checkIds([input.replyToMessageId])[0]}?format=metadata&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References`,
      );
      threadId = original.threadId;
      inReplyTo = header(original, "Message-ID") || undefined;
      references = [header(original, "References"), inReplyTo].filter(Boolean).join(" ") || undefined;
      to ||= header(original, "Reply-To") || header(original, "From");
      const originalSubject = header(original, "Subject");
      subject ||= /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`;
    }
    const recipients = cleanRecipients(to);
    const attachments = decodeAttachments(input.attachments);
    const markdown = input.format === "markdown";
    const mime = buildMime({
      to: recipients, subject, inReplyTo, references, attachments,
      body: markdown ? markdownToPlain(input.body) : input.body,
      html: markdown ? markdownToHtml(input.body) : undefined,
    });
    // Gmail's JSON endpoint takes small messages only; larger ones go through the media upload endpoint.
    const draft = attachments.length
      ? await this.uploadDraft(mime, threadId)
      : await this.call<{ id: string }>("/drafts", { method: "POST", body: { message: { raw: Buffer.from(mime, "utf8").toString("base64url"), ...(threadId ? { threadId } : {}) } } });
    return { draftId: draft.id, to: recipients, subject: oneLine(subject) };
  }

  private async uploadDraft(mime: string, threadId?: string): Promise<{ id: string }> {
    this.spend();
    const boundary = `upload_${crypto.randomUUID()}`;
    const body = [
      `--${boundary}`, "Content-Type: application/json; charset=UTF-8", "", JSON.stringify({ message: threadId ? { threadId } : {} }),
      `--${boundary}`, "Content-Type: message/rfc822", "", mime, `--${boundary}--`, "",
    ].join("\r\n");
    const response = await this.fetchFn("https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=multipart", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.accessToken}`, "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    if (response.status === 401) throw new MailAuthError();
    if (!response.ok) throw new GmailHttpError(response.status);
    return (await response.json()) as { id: string };
  }

  /** The draft as it is in Gmail now, or null when it no longer exists (sent or deleted). */
  async getDraft(draftId: string): Promise<DraftDetail | null> {
    let draft: { id: string; message?: RawMessage };
    try {
      draft = await this.call(`/drafts/${this.checkIds([draftId])[0]}?format=full`);
    } catch (err) {
      if (err instanceof GmailHttpError && err.status === 404) return null;
      throw err;
    }
    const message = draft.message;
    if (!message) return null;
    const plain = findPart(message.payload, "text/plain");
    const html = plain?.trim() ? null : findPart(message.payload, "text/html");
    const body = (plain?.trim() ? plain.trim() : html ? htmlToText(html) : message.snippet ?? "").slice(0, MAX_DRAFT_BODY_CHARS);
    return {
      draftId: draft.id, messageId: message.id,
      to: addressList(header(message, "To")), cc: addressList(header(message, "Cc")), bcc: addressList(header(message, "Bcc")),
      subject: header(message, "Subject"), body, attachments: attachmentsOf(message.payload),
    };
  }

  /** Sender, subject, date and snippet of each id; ids Gmail no longer has are reported in `missing`. */
  async summaries(ids: string[]): Promise<{ messages: MailSummary[]; missing: string[] }> {
    this.checkIds(ids);
    const messages: MailSummary[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      try {
        messages.push(summarize(await this.call<RawMessage>(`/messages/${id}?${METADATA_QUERY}`)));
      } catch (err) {
        if (err instanceof GmailHttpError && err.status === 404) missing.push(id);
        else throw err;
      }
    }
    return { messages, missing };
  }

  async sendDraft(draftId: string): Promise<void> {
    await this.call("/drafts/send", { method: "POST", body: { id: this.checkIds([draftId])[0] } });
  }

  async organize(ids: string[], action: OrganizeAction): Promise<void> {
    await this.call("/messages/batchModify", { method: "POST", body: { ids: this.checkIds(ids), ...LABEL_CHANGES[action] } });
  }

  /** Moves messages to Trash, where Gmail keeps them for 30 days. */
  async trash(ids: string[]): Promise<void> {
    for (const id of this.checkIds(ids)) await this.call(`/messages/${id}/trash`, { method: "POST" });
  }
}
