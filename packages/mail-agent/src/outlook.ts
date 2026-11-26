/**
 * Outlook / Microsoft 365 mailboxes through Microsoft Graph. Implements the same MailboxClient as Gmail:
 * folders map to Outlook's well-known folders, labels to Outlook categories, star to a follow-up flag.
 *
 * Every request asks for immutable ids, so a message keeps its id when it is moved (archive, trash).
 * Graph ids are base64 with "=" padding; the padding is dropped so ids stay URL-safe, and restored here.
 */
import {
  CALL_LIMIT_MESSAGE, cleanLabelName, cleanRecipients, decodeAttachments, GmailHttpError, htmlToText, LABEL_COLORS, MailAuthError,
  markdownToHtml, MAX_ATTACHMENT_BYTES, MAIL_ID, USER_LABEL_ID,
  type AttachmentFile, type DraftDetail, type DraftInput, type DraftResult, type FetchFn, type MailContact, type MailLabel, type MailMessage,
  type MailSummary, type MessageAttachment, type OrganizeAction,
} from "./gmail.ts";
import { parseMailQuery, type MailFolderKind, type ParsedQuery } from "./query.ts";

export interface MicrosoftOAuthConfig { clientId: string; clientSecret: string; tenant: string; redirectUri: string }

/** Read, organize, draft and send mail; offline_access for a refresh token; User.Read for the address. */
export const OUTLOOK_SCOPES = ["offline_access", "openid", "email", "User.Read", "Mail.ReadWrite", "Mail.Send"];
const GRAPH = "https://graph.microsoft.com/v1.0/me";
const authority = (config: MicrosoftOAuthConfig) => `https://login.microsoftonline.com/${encodeURIComponent(config.tenant)}/oauth2/v2.0`;

export function outlookAuthUrl(config: MicrosoftOAuthConfig, state: string, codeChallenge: string): string {
  const url = new URL(`${authority(config)}/authorize`);
  url.search = new URLSearchParams({
    client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code", response_mode: "query",
    scope: OUTLOOK_SCOPES.join(" "), state, prompt: "select_account", code_challenge: codeChallenge, code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

async function outlookToken(config: MicrosoftOAuthConfig, params: Record<string, string>, fetchFn: FetchFn) {
  const response = await fetchFn(`${authority(config)}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, scope: OUTLOOK_SCOPES.join(" "), ...params }),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status === 400 || response.status === 401) throw new MailAuthError("Outlook access has expired or was revoked. Connect Outlook again.");
  if (!response.ok || typeof data.access_token !== "string") throw new Error(`Microsoft sign-in failed (${response.status})`);
  const scope = String(data.scope ?? "").toLowerCase();
  if (!scope.includes("mail.readwrite") || !scope.includes("mail.send")) throw new MailAuthError("Outlook mail permission was not granted. Accept every permission on Microsoft's consent screen.");
  return { accessToken: data.access_token, refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : null };
}

export async function exchangeOutlookCode(config: MicrosoftOAuthConfig, code: string, codeVerifier: string, fetchFn: FetchFn = fetch) {
  const tokens = await outlookToken(config, { grant_type: "authorization_code", code, redirect_uri: config.redirectUri, code_verifier: codeVerifier }, fetchFn);
  if (!tokens.refreshToken) throw new MailAuthError("Microsoft did not return a long-lived token. Try connecting again.");
  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
}

/** Microsoft rotates refresh tokens: the caller stores `refreshToken` when it changed. */
export async function refreshOutlookToken(config: MicrosoftOAuthConfig, refreshToken: string, fetchFn: FetchFn = fetch) {
  return outlookToken(config, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchFn);
}

const WELL_KNOWN: Record<Exclude<MailFolderKind, "all">, string> = {
  inbox: "inbox", sent: "sentitems", drafts: "drafts", spam: "junkemail", trash: "deleteditems", archive: "archive",
};
/** Outlook's category colors (preset0…preset24) for the app's label palette, and back. */
const PRESET_FOR: Record<string, string> = {
  "#fb4c2f": "preset0", "#ffad47": "preset1", "#fad165": "preset3", "#16a766": "preset4", "#43d692": "preset5",
  "#4a86e8": "preset7", "#2da2bb": "preset6", "#a479e2": "preset8", "#f691b3": "preset9", "#666666": "preset12",
};
const COLOR_FOR = Object.fromEntries(Object.entries(PRESET_FOR).map(([hex, preset]) => [preset, hex]));

const SELECT = "id,conversationId,subject,from,receivedDateTime,sentDateTime,bodyPreview,isRead,flag,categories,hasAttachments";
const MAX_BODY_CHARS = 6000;
/** Graph's simple attachment upload takes files up to 3 MB; larger ones would need an upload session. */
const MAX_SIMPLE_ATTACHMENT = 3 * 1024 * 1024;

interface GraphAddress { emailAddress?: { name?: string; address?: string } }
interface GraphMessage {
  id: string; conversationId?: string; changeKey?: string; subject?: string; from?: GraphAddress; receivedDateTime?: string; sentDateTime?: string;
  bodyPreview?: string; isRead?: boolean; flag?: { flagStatus?: string }; categories?: string[]; hasAttachments?: boolean;
  toRecipients?: GraphAddress[]; ccRecipients?: GraphAddress[]; bccRecipients?: GraphAddress[]; replyTo?: GraphAddress[];
  body?: { contentType?: string; content?: string }; isDraft?: boolean;
}
interface GraphAttachment { id: string; name?: string; contentType?: string; size?: number; isInline?: boolean; contentBytes?: string; "@odata.type"?: string }

/** URL-safe id for the app: Graph's "=" padding removed. */
export const toAppId = (graphId: string) => graphId.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
/** Graph id back from the app's form. Graph accepts the URL-safe alphabet; only the padding is restored. */
export const toGraphId = (appId: string) => appId + "=".repeat((4 - (appId.length % 4)) % 4);
const labelId = (name: string) => `Label_${Buffer.from(name, "utf8").toString("base64url")}`;
const labelName = (id: string) => Buffer.from(id.slice("Label_".length), "base64url").toString("utf8");
const person = (a?: GraphAddress) => {
  const name = a?.emailAddress?.name?.trim(); const address = a?.emailAddress?.address?.trim() ?? "";
  return name && name !== address ? `${name} <${address}>` : address;
};
const odataString = (value: string) => `'${value.replace(/'/g, "''")}'`;

export class OutlookClient {
  private calls = 0;
  private readonly accessToken: string;
  private readonly fetchFn: FetchFn;
  private readonly maxCalls: number;

  constructor(accessToken: string, fetchFn: FetchFn = fetch, maxCalls = Number.POSITIVE_INFINITY) {
    this.accessToken = accessToken; this.fetchFn = fetchFn; this.maxCalls = maxCalls;
  }

  private spend(): void {
    if (this.calls >= this.maxCalls) throw new Error(CALL_LIMIT_MESSAGE);
    this.calls++;
  }

  /** `path` is relative to /me, or a full Graph URL from a nextLink (checked to stay on Graph). */
  private async call<T>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    this.spend();
    const url = path.startsWith("https://") ? path : `${GRAPH}${path}`;
    if (!url.startsWith(`${GRAPH}/`) && !url.startsWith(`${GRAPH}?`)) throw new Error("Invalid page");
    const response = await this.fetchFn(url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${this.accessToken}`, Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"',
        ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers,
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (response.status === 401) throw new MailAuthError("Outlook access has expired or was revoked. Connect Outlook again.");
    if (!response.ok) throw new GmailHttpError(response.status);
    return (response.status === 204 || response.status === 202 ? {} : await response.json()) as T;
  }

  private id(appId: string): string {
    if (!MAIL_ID.test(appId)) throw new Error("Invalid message id");
    return encodeURIComponent(toGraphId(appId));
  }

  private async categoryNames(): Promise<Map<string, { id: string; name: string; color: string }>> {
    const data = await this.call<{ value?: { id: string; displayName: string; color?: string }[] }>("/outlook/masterCategories");
    return new Map((data.value ?? []).map((c) => [c.displayName, { id: c.id, name: c.displayName, color: c.color ?? "none" }]));
  }

  private summarize(m: GraphMessage): MailSummary {
    const date = m.receivedDateTime ?? m.sentDateTime;
    return {
      id: toAppId(m.id), threadId: m.conversationId ? toAppId(m.conversationId).slice(0, 200) : toAppId(m.id),
      from: person(m.from), subject: m.subject ?? "", date: date ? new Date(date).toUTCString() : "",
      snippet: (m.bodyPreview ?? "").slice(0, 300), unread: m.isRead === false, starred: m.flag?.flagStatus === "flagged",
      labelIds: (m.categories ?? []).map(labelId).filter((id) => USER_LABEL_ID.test(id)),
    };
  }

  private messagesUrl(q: ParsedQuery, top: number, labelIdFilter?: string): string {
    const base = q.folder === "all" ? "/messages" : `/mailFolders/${WELL_KNOWN[q.folder]}/messages`;
    const params = new URLSearchParams({ $top: String(top), $select: SELECT });
    const filters: string[] = [];
    if (q.unread !== undefined) filters.push(`isRead eq ${!q.unread}`);
    if (q.starred) filters.push("flag/flagStatus eq 'flagged'");
    if (q.attachments) filters.push("hasAttachments eq true");
    if (q.after) filters.push(`receivedDateTime ge ${q.after.toISOString()}`);
    if (q.before) filters.push(`receivedDateTime lt ${q.before.toISOString()}`);
    for (const name of [...q.labels, ...(labelIdFilter ? [labelName(labelIdFilter)] : [])]) filters.push(`categories/any(c:c eq ${odataString(name)})`);
    const words = [q.from && `from:${q.from}`, q.to && `to:${q.to}`, q.subject && `subject:${q.subject}`, q.text].filter(Boolean).join(" ");
    if (words) {
      // Graph cannot combine $search with $orderby; results come back by relevance-then-date.
      params.set("$search", `"${words.replace(/"/g, "")}"`);
      if (filters.length) params.set("$filter", filters.join(" and "));
    } else {
      if (filters.length) params.set("$filter", filters.join(" and "));
      // Graph refuses $orderby on a property that is not the first in $filter; filtered lists keep its default order.
      if (!filters.length) params.set("$orderby", "receivedDateTime desc");
    }
    // OData wants %20 for spaces; URLSearchParams would send "+".
    return `${base}?${params.toString().replace(/\+/g, "%20")}`;
  }

  async profile(): Promise<{ email: string }> {
    const me = await this.call<{ mail?: string; userPrincipalName?: string }>("?$select=mail,userPrincipalName");
    return { email: (me.mail || me.userPrincipalName || "").toLowerCase() };
  }

  async search(query: string, max: number): Promise<MailSummary[]> {
    const data = await this.call<{ value?: GraphMessage[] }>(this.messagesUrl(parseMailQuery(query), Math.min(Math.max(1, max), 10)));
    return (data.value ?? []).map((m) => this.summarize(m));
  }

  async listPage(query: string, pageToken?: string, labelId?: string): Promise<{ messages: MailSummary[]; nextCursor: string | null }> {
    if (labelId && !USER_LABEL_ID.test(labelId)) throw new Error("Invalid label id");
    const data = await this.call<{ value?: GraphMessage[]; "@odata.nextLink"?: string }>(pageToken ?? this.messagesUrl(parseMailQuery(query), 20, labelId));
    const next = data["@odata.nextLink"];
    return { messages: (data.value ?? []).map((m) => this.summarize(m)), nextCursor: next && next.length <= 2048 && next.startsWith(`${GRAPH}/`) ? next : null };
  }

  async contacts(self: string): Promise<MailContact[]> {
    const me = self.toLowerCase();
    const score = new Map<string, { contact: MailContact; weight: number }>();
    const add = (a: GraphAddress | undefined, weight: number) => {
      const email = a?.emailAddress?.address?.trim().toLowerCase();
      if (!email || email === me || /^(no-?reply|do-?not-?reply|mailer-daemon)@/i.test(email)) return;
      const entry = score.get(email) ?? { contact: { name: a?.emailAddress?.name?.trim() ?? "", email }, weight: 0 };
      entry.weight += weight;
      score.set(email, entry);
    };
    const since = new Date(Date.now() - 365 * 86_400_000).toISOString();
    const sent = await this.call<{ value?: GraphMessage[] }>(`/mailFolders/sentitems/messages?$top=50&$select=toRecipients,ccRecipients&$filter=sentDateTime ge ${since}`);
    for (const m of sent.value ?? []) for (const a of [...(m.toRecipients ?? []), ...(m.ccRecipients ?? [])]) add(a, 2);
    const inbox = await this.call<{ value?: GraphMessage[] }>(`/mailFolders/inbox/messages?$top=50&$select=from&$filter=receivedDateTime ge ${since}`);
    for (const m of inbox.value ?? []) add(m.from, 1);
    return [...score.values()].sort((a, b) => b.weight - a.weight).slice(0, 300).map((e) => e.contact);
  }

  async summaries(ids: string[]): Promise<{ messages: MailSummary[]; missing: string[] }> {
    const messages: MailSummary[] = []; const missing: string[] = [];
    for (const id of ids.slice(0, 50)) {
      try { messages.push(this.summarize(await this.call<GraphMessage>(`/messages/${this.id(id)}?$select=${SELECT}`))); } catch (err) {
        if (err instanceof GmailHttpError && err.status === 404) missing.push(id); else throw err;
      }
    }
    return { messages, missing };
  }

  async pinnedSummaries(ids: string[]): Promise<MailSummary[]> {
    return (await this.summaries(ids.filter((id) => MAIL_ID.test(id)))).messages;
  }

  private async attachmentList(messageId: string): Promise<GraphAttachment[]> {
    const data = await this.call<{ value?: GraphAttachment[] }>(`/messages/${this.id(messageId)}/attachments?$select=id,name,contentType,size,isInline`);
    return (data.value ?? []).filter((a) => !a.isInline && a.name);
  }

  async read(id: string): Promise<MailMessage> {
    const m = await this.call<GraphMessage>(`/messages/${this.id(id)}?$select=${SELECT},toRecipients,body`);
    const raw = m.body?.content ?? "";
    const text = m.body?.contentType === "html" ? htmlToText(raw) : raw;
    const attachments: MessageAttachment[] = m.hasAttachments
      ? (await this.attachmentList(id)).map((a, index) => ({ partId: String(index), filename: a.name ?? "file", mimeType: a.contentType ?? "application/octet-stream", size: a.size ?? 0 }))
      : [];
    return {
      ...this.summarize(m), to: (m.toRecipients ?? []).map(person).join(", "),
      body: text.slice(0, MAX_BODY_CHARS), truncated: text.length > MAX_BODY_CHARS, attachments,
    };
  }

  /** The partId is the attachment's position in the message's (non-inline) attachment list. */
  async attachment(messageId: string, partId: string): Promise<AttachmentFile> {
    if (!/^\d{1,3}$/.test(partId)) throw new Error("Invalid attachment");
    const target = (await this.attachmentList(messageId))[Number(partId)];
    if (!target) throw new GmailHttpError(404);
    if ((target.size ?? 0) > MAX_ATTACHMENT_BYTES) throw new Error("This attachment is larger than 15 MB. Open it in Outlook.");
    const file = await this.call<GraphAttachment>(`/messages/${this.id(messageId)}/attachments/${encodeURIComponent(target.id)}`);
    if (!file.contentBytes) throw new Error("This attachment cannot be downloaded (it may be a linked item). Open it in Outlook.");
    return { filename: target.name ?? "file", mimeType: target.contentType ?? "application/octet-stream", bytes: new Uint8Array(Buffer.from(file.contentBytes, "base64")) };
  }

  async labels(): Promise<MailLabel[]> {
    return [...(await this.categoryNames()).values()]
      .map((c) => ({ id: labelId(c.name), name: c.name, color: COLOR_FOR[c.color] ?? null }))
      .filter((l) => USER_LABEL_ID.test(l.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async createLabel(name: string): Promise<MailLabel> {
    const clean = cleanLabelName(name);
    if (!USER_LABEL_ID.test(labelId(clean))) throw new Error("This label name is too long for Outlook");
    try {
      await this.call("/outlook/masterCategories", { method: "POST", body: { displayName: clean, color: "preset7" } });
    } catch (err) {
      if (err instanceof GmailHttpError && err.status === 409) throw new GmailHttpError(409);
      throw err;
    }
    return { id: labelId(clean), name: clean, color: COLOR_FOR.preset7 ?? null };
  }

  /** Outlook categories keep their name for life; only the color can change. */
  async updateLabel(id: string, change: { name?: string; color?: string | null }): Promise<MailLabel> {
    if (!USER_LABEL_ID.test(id)) throw new Error("Only your own labels can be changed");
    const name = labelName(id);
    if (change.name !== undefined && cleanLabelName(change.name) !== name) throw new Error("Outlook categories cannot be renamed. Create a new label instead");
    const category = (await this.categoryNames()).get(name);
    if (!category) throw new GmailHttpError(404);
    const color = change.color?.toLowerCase() ?? null;
    if (color !== null && !LABEL_COLORS[color]) throw new Error("Choose one of the available label colors");
    const preset = color ? PRESET_FOR[color]! : "none";
    await this.call(`/outlook/masterCategories/${encodeURIComponent(category.id)}`, { method: "PATCH", body: { color: preset } });
    return { id, name, color: COLOR_FOR[preset] ?? null };
  }

  async deleteLabel(id: string): Promise<void> {
    if (!USER_LABEL_ID.test(id)) throw new Error("Only your own labels can be deleted");
    const category = (await this.categoryNames()).get(labelName(id));
    if (!category) throw new GmailHttpError(404);
    await this.call(`/outlook/masterCategories/${encodeURIComponent(category.id)}`, { method: "DELETE" });
  }

  async relabel(ids: string[], add: string[], remove: string[]): Promise<void> {
    const labels = [...add, ...remove];
    if (!labels.length || labels.length > 20 || labels.some((id) => !USER_LABEL_ID.test(id))) throw new Error("Only your own labels can be added or removed");
    if (add.some((id) => remove.includes(id))) throw new Error("A label cannot be added and removed at once");
    const adding = add.map(labelName); const removing = new Set(remove.map(labelName));
    for (const id of ids.slice(0, 25)) {
      const m = await this.call<GraphMessage>(`/messages/${this.id(id)}?$select=categories`);
      const next = [...new Set([...(m.categories ?? []).filter((c) => !removing.has(c)), ...adding])];
      await this.call(`/messages/${this.id(id)}`, { method: "PATCH", body: { categories: next } });
    }
  }

  async organize(ids: string[], action: OrganizeAction): Promise<void> {
    for (const id of ids.slice(0, 50)) {
      const path = `/messages/${this.id(id)}`;
      switch (action) {
        case "archive": await this.call(`${path}/move`, { method: "POST", body: { destinationId: "archive" } }); break;
        case "move_to_inbox": await this.call(`${path}/move`, { method: "POST", body: { destinationId: "inbox" } }); break;
        case "mark_spam": await this.call(`${path}/move`, { method: "POST", body: { destinationId: "junkemail" } }); break;
        case "mark_read": await this.call(path, { method: "PATCH", body: { isRead: true } }); break;
        case "mark_unread": await this.call(path, { method: "PATCH", body: { isRead: false } }); break;
        case "star": await this.call(path, { method: "PATCH", body: { flag: { flagStatus: "flagged" } } }); break;
        case "unstar": await this.call(path, { method: "PATCH", body: { flag: { flagStatus: "notFlagged" } } }); break;
      }
    }
  }

  /** Moves to Deleted Items (recoverable), like Gmail's Trash. */
  async trash(ids: string[]): Promise<void> {
    for (const id of ids.slice(0, 50)) await this.call(`/messages/${this.id(id)}/move`, { method: "POST", body: { destinationId: "deleteditems" } });
  }

  async createDraft(input: DraftInput): Promise<DraftResult> {
    const attachments = decodeAttachments(input.attachments);
    if (attachments.some((file) => file.bytes.byteLength > MAX_SIMPLE_ATTACHMENT)) throw new Error("Outlook drafts take files up to 3 MB each. Attach smaller files.");
    const markdown = input.format === "markdown";
    const body = markdown ? { contentType: "html", content: markdownToHtml(input.body) } : { contentType: "text", content: input.body };
    let draft: GraphMessage;
    if (input.replyToMessageId) {
      // createReply fills the recipients and subject from the original message.
      draft = await this.call<GraphMessage>(`/messages/${this.id(input.replyToMessageId)}/createReply`, { method: "POST", body: {} });
      const patch: Record<string, unknown> = { body };
      if (input.to.trim()) patch.toRecipients = cleanRecipients(input.to).split(", ").map((address) => ({ emailAddress: { address } }));
      if (input.subject.trim()) patch.subject = input.subject.replace(/[\r\n]+/g, " ").trim();
      draft = await this.call<GraphMessage>(`/messages/${encodeURIComponent(draft.id)}`, { method: "PATCH", body: patch });
    } else {
      const to = cleanRecipients(input.to);
      draft = await this.call<GraphMessage>("/messages", {
        method: "POST",
        body: { subject: input.subject.replace(/[\r\n]+/g, " ").trim(), body, toRecipients: to.split(", ").map((address) => ({ emailAddress: { address } })) },
      });
    }
    for (const file of attachments) {
      await this.call(`/messages/${encodeURIComponent(draft.id)}/attachments`, {
        method: "POST",
        body: { "@odata.type": "#microsoft.graph.fileAttachment", name: file.filename, contentType: file.mimeType, contentBytes: file.bytes.toString("base64") },
      });
    }
    return { draftId: toAppId(draft.id), to: (draft.toRecipients ?? []).map((a) => a.emailAddress?.address ?? "").filter(Boolean).join(", "), subject: draft.subject ?? "" };
  }

  /** The draft as it is now; `messageId` is Outlook's change key, which changes on every edit. */
  async getDraft(draftId: string): Promise<DraftDetail | null> {
    let m: GraphMessage;
    try {
      m = await this.call<GraphMessage>(`/messages/${this.id(draftId)}?$select=id,changeKey,isDraft,subject,toRecipients,ccRecipients,bccRecipients,body,hasAttachments`);
    } catch (err) {
      if (err instanceof GmailHttpError && err.status === 404) return null;
      throw err;
    }
    if (!m.isDraft) return null; // already sent
    const list = (a?: GraphAddress[]) => (a ?? []).map((x) => x.emailAddress?.address ?? "").filter(Boolean);
    const files = m.hasAttachments ? await this.attachmentList(draftId) : [];
    const raw = m.body?.content ?? "";
    return {
      draftId, messageId: m.changeKey ?? m.id, to: list(m.toRecipients), cc: list(m.ccRecipients), bcc: list(m.bccRecipients),
      subject: m.subject ?? "", body: (m.body?.contentType === "html" ? htmlToText(raw) : raw).slice(0, 100_000),
      attachments: files.map((f) => ({ filename: f.name ?? "file", mimeType: f.contentType ?? "application/octet-stream", size: f.size ?? 0 })),
    };
  }

  async sendDraft(draftId: string): Promise<void> {
    await this.call(`/messages/${this.id(draftId)}/send`, { method: "POST" });
  }
}
