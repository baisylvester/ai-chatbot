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

export function googleAuthUrl(config: GoogleOAuthConfig, state: string): string {
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

export async function exchangeCode(config: GoogleOAuthConfig, code: string, fetchFn: FetchFn = fetch) {
  const data = await tokenRequest({
    code, client_id: config.clientId, client_secret: config.clientSecret,
    redirect_uri: config.redirectUri, grant_type: "authorization_code",
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

export interface MailSummary { id: string; threadId: string; from: string; subject: string; date: string; snippet: string; unread: boolean }
export interface MailMessage extends MailSummary { to: string; body: string; truncated: boolean }
export interface DraftInput { to: string; subject: string; body: string; replyToMessageId?: string }
export interface DraftResult { draftId: string; to: string; subject: string }
export type OrganizeAction = "archive" | "mark_read" | "mark_unread" | "star" | "unstar";

/** What the agent needs from a mailbox. GmailClient implements it; tests use a fake. */
export interface MailApi {
  search(query: string, max: number): Promise<MailSummary[]>;
  read(id: string): Promise<MailMessage>;
  createDraft(input: DraftInput): Promise<DraftResult>;
  organize(ids: string[], action: OrganizeAction): Promise<void>;
}

interface Part { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: { name: string; value: string }[] }
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

function summarize(message: RawMessage): MailSummary {
  return {
    id: message.id, threadId: message.threadId,
    from: header(message, "From"), subject: header(message, "Subject") || "(no subject)", date: header(message, "Date"),
    snippet: message.snippet ?? "", unread: message.labelIds?.includes("UNREAD") ?? false,
  };
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

/** An RFC 5322 plain-text message. Header values are single lines, so input cannot add headers. */
export function buildMime(input: { to: string; subject: string; body: string; inReplyTo?: string; references?: string }): string {
  const lines = [
    `To: ${cleanRecipients(input.to)}`,
    `Subject: ${encodeHeader(oneLine(input.subject).slice(0, 300))}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${oneLine(input.inReplyTo)}`, `References: ${oneLine(input.references || input.inReplyTo)}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(input.body, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
  ];
  return lines.join("\r\n");
}

const LABEL_CHANGES: Record<OrganizeAction, { addLabelIds?: string[]; removeLabelIds?: string[] }> = {
  archive: { removeLabelIds: ["INBOX"] },
  mark_read: { removeLabelIds: ["UNREAD"] },
  mark_unread: { addLabelIds: ["UNREAD"] },
  star: { addLabelIds: ["STARRED"] },
  unstar: { removeLabelIds: ["STARRED"] },
};

export class GmailClient implements MailApi {
  private readonly accessToken: string;
  private readonly fetchFn: FetchFn;

  constructor(accessToken: string, fetchFn: FetchFn = fetch) {
    this.accessToken = accessToken;
    this.fetchFn = fetchFn;
  }

  private async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await this.fetchFn(`${API}${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${this.accessToken}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (response.status === 401) throw new MailAuthError();
    if (!response.ok) throw new Error(`Gmail request failed (${response.status})`);
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
    const list = await this.call<{ messages?: { id: string }[] }>(`/messages?${params}`);
    return Promise.all((list.messages ?? []).map(async ({ id }) => summarize(await this.call<RawMessage>(
      `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
    ))));
  }

  async read(id: string): Promise<MailMessage> {
    const message = await this.call<RawMessage>(`/messages/${this.checkIds([id])[0]}?format=full`);
    const text = messageText(message);
    return { ...summarize(message), to: header(message, "To"), body: text.slice(0, MAX_BODY_CHARS), truncated: text.length > MAX_BODY_CHARS };
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
    const raw = Buffer.from(buildMime({ to: recipients, subject, body: input.body, inReplyTo, references }), "utf8").toString("base64url");
    const draft = await this.call<{ id: string }>("/drafts", { method: "POST", body: { message: { raw, ...(threadId ? { threadId } : {}) } } });
    return { draftId: draft.id, to: recipients, subject: oneLine(subject) };
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
