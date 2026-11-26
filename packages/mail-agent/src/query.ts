/**
 * The app and the agent search with Gmail's syntax. Outlook and IMAP mailboxes understand a subset of
 * it, parsed here into a provider-neutral form. Anything not understood becomes free text.
 */
export type MailFolderKind = "inbox" | "sent" | "drafts" | "spam" | "trash" | "archive" | "all";

export interface ParsedQuery {
  folder: MailFolderKind;
  unread?: boolean;
  starred?: boolean;
  attachments?: boolean;
  from?: string;
  to?: string;
  subject?: string;
  /** Category / label names (Outlook categories; ignored by IMAP). */
  labels: string[];
  after?: Date;
  before?: Date;
  /** Remaining words, searched in sender, subject and body. */
  text: string;
}

const UNIT_MS: Record<string, number> = { d: 86_400_000, m: 30 * 86_400_000, y: 365 * 86_400_000 };

function date(value: string): Date | undefined {
  if (/^\d{9,11}$/.test(value)) return new Date(Number(value) * 1000);
  const m = value.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : undefined;
}

/** Splits into terms, keeping quoted phrases (with or without an operator prefix) together. */
function terms(query: string): string[] {
  return [...query.matchAll(/-?[a-z_]+:"[^"]*"|-?[a-z_]+:\([^)]*\)|"[^"]*"|\S+/gi)].map((m) => m[0]);
}

export function parseMailQuery(query: string, now = new Date()): ParsedQuery {
  const out: ParsedQuery = { folder: "all", labels: [], text: "" };
  const words: string[] = [];
  let folderSet = false;
  const exclusions = new Set<string>();
  for (const raw of terms(query.replace(/[()]/g, " ").replace(/\bOR\b/g, " "))) {
    const negated = raw.startsWith("-");
    const term = negated ? raw.slice(1) : raw;
    const [op, ...rest] = term.split(":");
    const value = rest.join(":").replace(/^"|"$/g, "").trim();
    const key = rest.length ? op!.toLowerCase() : "";
    if (key === "in") {
      if (negated) { exclusions.add(value.toLowerCase()); continue; }
      const folder = ({ inbox: "inbox", sent: "sent", drafts: "drafts", draft: "drafts", spam: "spam", junk: "spam", trash: "trash", anywhere: "all", archive: "archive" } as const)[value.toLowerCase() as "inbox"];
      if (folder && !folderSet) { out.folder = folder; folderSet = true; }
    } else if (key === "is" && !negated) {
      if (value === "unread") out.unread = true;
      else if (value === "read") out.unread = false;
      else if (value === "starred" || value === "flagged") out.starred = true;
    } else if (key === "has" && value === "attachment" && !negated) out.attachments = true;
    else if (key === "from" && !negated) out.from = value;
    else if (key === "to" && !negated) out.to = value;
    else if (key === "subject" && !negated) out.subject = value;
    else if (key === "label" && !negated) out.labels.push(value);
    else if ((key === "after" || key === "newer") && !negated) out.after = date(value);
    else if ((key === "before" || key === "older") && !negated) out.before = date(value);
    else if (key === "newer_than" && !negated) {
      const m = value.match(/^(\d{1,4})([dmy])$/);
      if (m) out.after = new Date(now.getTime() - Number(m[1]) * UNIT_MS[m[2]!]!);
    } else if (key === "older_than" && !negated) {
      const m = value.match(/^(\d{1,4})([dmy])$/);
      if (m) out.before = new Date(now.getTime() - Number(m[1]) * UNIT_MS[m[2]!]!);
    } else if (!negated && !key) words.push(term.replace(/^"|"$/g, ""));
  }
  // The app's Archive folder is "not in inbox, sent, drafts, trash or spam".
  if (!folderSet && ["inbox", "sent", "drafts", "trash", "spam"].every((f) => exclusions.has(f))) out.folder = "archive";
  out.text = words.join(" ").trim().slice(0, 200);
  return out;
}
