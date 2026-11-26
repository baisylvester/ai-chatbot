/**
 * A small RFC 5322 / MIME parser for IMAP mailboxes: headers (with RFC 2047 encoded words), multipart
 * bodies, base64 and quoted-printable, and charsets through TextDecoder. Part numbers follow IMAP's
 * BODY[n.m] numbering, so an attachment's partId is the same here and on the server.
 */
export interface MimePart {
  /** IMAP part number ("1", "1.2"); "" for the top-level single part. */
  partId: string;
  headers: Map<string, string>;
  contentType: string;
  params: Record<string, string>;
  filename: string | null;
  /** Decoded bytes of a leaf part; empty for multiparts. */
  body: Uint8Array;
  children: MimePart[];
}

const latin1 = new TextDecoder("latin1");

function decodeCharset(bytes: Uint8Array, charset = "utf-8"): string {
  try { return new TextDecoder(charset.toLowerCase().replace(/^(x-|cp)(?=\d)/, "windows-"), { fatal: false }).decode(bytes); } catch { return new TextDecoder("utf-8").decode(bytes); }
}

/** RFC 2047 encoded words, e.g. =?UTF-8?B?...?= and =?ISO-8859-1?Q?...?=. */
export function decodeWords(value: string): string {
  return value.replace(/\?=\s+=\?/g, "?==?").replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset: string, enc: string, text: string) => {
    const bytes = enc.toUpperCase() === "B"
      ? new Uint8Array(Buffer.from(text, "base64"))
      : qpBytes(text.replace(/_/g, " "));
    return decodeCharset(bytes, charset.split("*")[0]);
  });
}

function qpBytes(text: string): Uint8Array {
  const out: number[] = [];
  const soft = text.replace(/=\r?\n/g, "");
  for (let i = 0; i < soft.length; i++) {
    const c = soft[i]!;
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) { out.push(parseInt(soft.slice(i + 1, i + 3), 16)); i += 2; }
    else out.push(soft.charCodeAt(i) & 0xff);
  }
  return new Uint8Array(out);
}

function parseHeaders(text: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of text.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(i + 1).trim());
  }
  return headers;
}

/** `type/subtype; a=b; c="d"` → type and parameters (RFC 2231 `name*=` handled for the simple case). */
function parseContentType(value: string | undefined): { type: string; params: Record<string, string> } {
  const [type, ...rest] = (value ?? "text/plain").split(";");
  const params: Record<string, string> = {};
  for (const item of rest.join(";").matchAll(/([\w*-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g)) {
    let key = item[1]!.toLowerCase(); let val = item[2]!.trim().replace(/^"|"$/g, "").replace(/\\(.)/g, "$1");
    if (key.endsWith("*")) {
      key = key.replace(/\*\d*\*?$/, "");
      const m = val.match(/^([^']*)'[^']*'(.*)$/);
      val = m ? decodeCharset(qpBytes(m[2]!.replace(/%([0-9A-Fa-f]{2})/g, "=$1")), m[1] || "utf-8") : decodeURIComponent(val.replace(/%(?![0-9A-Fa-f]{2})/g, "%25"));
      params[key] = (params[key] && /\*\d+\*?$/.test(item[1]!) ? params[key] : "") + val;
    } else if (!(key in params)) params[key] = val;
  }
  return { type: (type ?? "text/plain").trim().toLowerCase() || "text/plain", params };
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const CRLF2 = new Uint8Array([13, 10, 13, 10]);
const LF2 = new Uint8Array([10, 10]);

function splitHeader(raw: Uint8Array): { header: string; body: Uint8Array } {
  let end = indexOf(raw, CRLF2); let skip = 4;
  const lf = indexOf(raw, LF2);
  if (end < 0 || (lf >= 0 && lf < end)) { end = lf; skip = 2; }
  if (end < 0) return { header: latin1.decode(raw), body: new Uint8Array() };
  return { header: latin1.decode(raw.subarray(0, end)), body: raw.subarray(end + skip) };
}

function decodeBody(body: Uint8Array, encoding: string | undefined): Uint8Array {
  const enc = (encoding ?? "").trim().toLowerCase();
  if (enc === "base64") return new Uint8Array(Buffer.from(latin1.decode(body).replace(/[^A-Za-z0-9+/=]/g, ""), "base64"));
  if (enc === "quoted-printable") return qpBytes(latin1.decode(body));
  return body;
}

const MAX_DEPTH = 8;
const MAX_PARTS = 200;

export function parseMime(raw: Uint8Array, partId = "", depth = 0, count = { n: 0 }): MimePart {
  const { header, body } = splitHeader(raw);
  const headers = parseHeaders(header);
  const { type, params } = parseContentType(headers.get("content-type"));
  const disposition = parseContentType(headers.get("content-disposition"));
  const rawName = disposition.params.filename ?? params.name ?? null;
  const part: MimePart = { partId, headers, contentType: type, params, filename: rawName ? decodeWords(rawName).trim().slice(0, 255) || null : null, body: new Uint8Array(), children: [] };
  if (type.startsWith("multipart/") && params.boundary && depth < MAX_DEPTH) {
    const boundary = new TextEncoder().encode(`--${params.boundary}`);
    let pos = indexOf(body, boundary);
    let index = 0;
    while (pos >= 0 && count.n < MAX_PARTS) {
      const start = pos + boundary.length;
      if (body[start] === 45 && body[start + 1] === 45) break; // closing --boundary--
      const lineEnd = indexOf(body, new Uint8Array([10]), start);
      if (lineEnd < 0) break;
      const next = indexOf(body, boundary, lineEnd + 1);
      let end = next < 0 ? body.length : next;
      if (body[end - 1] === 10) end--;
      if (body[end - 1] === 13) end--;
      index++; count.n++;
      part.children.push(parseMime(body.subarray(lineEnd + 1, end), partId ? `${partId}.${index}` : String(index), depth + 1, count));
      pos = next;
    }
  } else if (type === "message/rfc822" && depth < MAX_DEPTH) {
    part.body = decodeBody(body, headers.get("content-transfer-encoding"));
  } else {
    part.body = decodeBody(body, headers.get("content-transfer-encoding"));
  }
  // A single-part message is BODY[1] in IMAP terms.
  if (!partId && !part.children.length) part.partId = "1";
  return part;
}

export function partText(part: MimePart): string {
  return decodeCharset(part.body, part.params.charset);
}

function* leaves(part: MimePart): Generator<MimePart> {
  if (!part.children.length) yield part;
  for (const child of part.children) yield* leaves(child);
}

/** The readable text: the first text/plain part, else the first text/html part as HTML. */
export function messageBody(root: MimePart): { text: string; html: boolean } {
  let html: MimePart | null = null;
  for (const leaf of leaves(root)) {
    const attachment = (leaf.headers.get("content-disposition") ?? "").toLowerCase().startsWith("attachment");
    if (attachment) continue;
    if (leaf.contentType === "text/plain") return { text: partText(leaf), html: false };
    if (leaf.contentType === "text/html" && !html) html = leaf;
  }
  return html ? { text: partText(html), html: true } : { text: "", html: false };
}

/** Files attached to the message (named leaf parts that are not the body text). */
export function attachmentsOf(root: MimePart): MimePart[] {
  return [...leaves(root)].filter((leaf) => leaf.filename && leaf.partId);
}

export function findPartById(root: MimePart, partId: string): MimePart | null {
  for (const leaf of leaves(root)) if (leaf.partId === partId) return leaf;
  return null;
}

export const header = (part: MimePart, name: string) => decodeWords(part.headers.get(name.toLowerCase()) ?? "");
