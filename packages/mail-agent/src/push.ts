/**
 * Web Push without a payload. The push only wakes the installed app's service worker, which then
 * fetches the notification text from the server with the user's own session. Mail content therefore
 * never passes through a push service, and no payload encryption is needed: just a signed VAPID token.
 */
import { fromBase64Url, toBase64Url } from "./crypto.ts";
import type { FetchFn } from "./gmail.ts";

export interface VapidKeys { publicKey: string; privateKey: string; subject: string }

/** Push services browsers actually use. Subscriptions for any other host are refused (no open relay). */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/, /\.push\.apple\.com$/];

export function isPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && PUSH_HOSTS.some((host) => host.test(url.hostname));
  } catch {
    return false;
  }
}

export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: toBase64Url(await crypto.subtle.exportKey("raw", pair.publicKey)), privateKey: jwk.d! };
}

async function vapidToken(endpoint: string, keys: VapidKeys, now: number): Promise<string> {
  const point = fromBase64Url(keys.publicKey);
  if (point.length !== 65 || point[0] !== 4) throw new Error("VAPID_PUBLIC_KEY must be an uncompressed P-256 point");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: keys.privateKey, x: toBase64Url(point.slice(1, 33)), y: toBase64Url(point.slice(33)) },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
  const part = (value: object) => toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: keys.subject })}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${toBase64Url(signature)}`;
}

/** "gone" means the browser dropped the subscription and it should be deleted. */
export async function sendPush(endpoint: string, keys: VapidKeys, fetchFn: FetchFn = fetch, now = Date.now()): Promise<"sent" | "gone" | "failed"> {
  if (!isPushEndpoint(endpoint)) return "gone";
  try {
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: { Authorization: `vapid t=${await vapidToken(endpoint, keys, now)}, k=${keys.publicKey}`, TTL: "86400", Urgency: "normal", "Content-Length": "0" },
    });
    if (response.status === 404 || response.status === 410) return "gone";
    return response.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
