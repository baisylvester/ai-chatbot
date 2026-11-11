/**
 * Fetches a public web page for ingestion with SSRF protection:
 *  - http/https only, default ports only;
 *  - every hostname (including each redirect hop) must resolve only to public unicast addresses,
 *    so the server can't be used to reach localhost, private networks or cloud metadata endpoints;
 *  - redirects are followed manually (max 5), with size and time limits.
 *
 * Note: a DNS answer could change between our lookup and the connection (DNS rebinding). Pinning
 * the resolved address in the HTTP client would close that gap; for now the check runs on every hop.
 */
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { ExtractionError, htmlToText, MAX_UPLOAD_BYTES, normalizeText } from "./extract.ts";

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;

export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let ip = ipaddr.parse(address);
  if (ip.kind() === "ipv6" && (ip as ipaddr.IPv6).isIPv4MappedAddress()) ip = (ip as ipaddr.IPv6).toIPv4Address();
  return ip.range() === "unicast";
}

export type Resolver = (hostname: string) => Promise<string[]>;

const defaultResolver: Resolver = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((r) => r.address);

export async function assertPublicUrl(raw: string, resolve: Resolver = defaultResolver): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ExtractionError("Enter a full URL starting with https://");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ExtractionError("Only http and https URLs are supported");
  if (url.username || url.password) throw new ExtractionError("URLs with credentials are not allowed");
  if (url.port && url.port !== "80" && url.port !== "443") throw new ExtractionError("Only standard ports (80, 443) are allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = ipaddr.isValid(host) ? [host] : await resolve(host).catch(() => []);
  if (addresses.length === 0) throw new ExtractionError("That website could not be found");
  if (!addresses.every(isPublicAddress)) throw new ExtractionError("That address is not a public website");
  return url;
}

export interface FetchedPage {
  url: string;
  title: string | null;
  text: string;
  contentType: string;
  bytes: number;
}

async function readCapped(res: Response): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_UPLOAD_BYTES) throw new ExtractionError("The page is larger than 10 MB");
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_UPLOAD_BYTES) {
      await reader.cancel();
      throw new ExtractionError("The page is larger than 10 MB");
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

export async function fetchPage(
  raw: string,
  opts: { resolve?: Resolver; fetchImpl?: typeof fetch } = {},
): Promise<FetchedPage> {
  const doFetch = opts.fetchImpl ?? fetch;
  let url = await assertPublicUrl(raw, opts.resolve);
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await doFetch(url, {
        redirect: "manual",
        signal,
        headers: { "user-agent": "ChatbotPlatformIngest/0.1 (+knowledge base import)", accept: "text/html,text/plain;q=0.9,*/*;q=0.1" },
      });
    } catch {
      throw new ExtractionError("The page could not be downloaded");
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop >= MAX_REDIRECTS) throw new ExtractionError("Too many redirects");
      url = await assertPublicUrl(new URL(res.headers.get("location")!, url).toString(), opts.resolve);
      continue;
    }
    if (!res.ok) throw new ExtractionError(`The page returned HTTP ${res.status}`);
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (contentType && contentType !== "text/html" && contentType !== "text/plain" && contentType !== "application/xhtml+xml") {
      throw new ExtractionError(`Unsupported page type (${contentType}). Download the file and upload it instead.`);
    }
    const bytes = await readCapped(res);
    const body = new TextDecoder().decode(bytes);
    const title = contentType === "text/plain" ? null : (body.match(/<title[^>]*>([^<]{1,300})<\/title>/i)?.[1]?.trim() ?? null);
    const text = normalizeText(contentType === "text/plain" ? body : htmlToText(body));
    if (!text) throw new ExtractionError("No readable text was found on that page");
    return { url: url.toString(), title, text, contentType: contentType || "text/html", bytes: bytes.byteLength };
  }
}
