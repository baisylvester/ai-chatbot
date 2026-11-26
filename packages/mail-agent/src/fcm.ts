/**
 * Native push through Firebase Cloud Messaging (HTTP v1). Authenticates with a service account (a
 * signed JWT exchanged for an access token) and sends notification messages. Nothing about the email's
 * content goes beyond the short digest title and body the app shows.
 */
import type { FetchFn } from "./gmail.ts";

export interface FcmServiceAccount { projectId: string; clientEmail: string; privateKey: string }

/** Parses FCM_SERVICE_ACCOUNT_JSON (raw JSON or base64 of it); null when absent or incomplete. */
export function fcmServiceAccount(value: string | undefined): FcmServiceAccount | null {
  if (!value?.trim()) return null;
  try {
    const text = value.trim().startsWith("{") ? value : Buffer.from(value, "base64").toString("utf8");
    const json = JSON.parse(text) as { project_id?: string; client_email?: string; private_key?: string };
    if (!json.project_id || !json.client_email || !json.private_key?.includes("PRIVATE KEY")) return null;
    return { projectId: json.project_id, clientEmail: json.client_email, privateKey: json.private_key };
  } catch {
    return null;
  }
}

const b64url = (bytes: ArrayBuffer | Uint8Array | string) =>
  Buffer.from(typeof bytes === "string" ? bytes : new Uint8Array(bytes)).toString("base64url");

async function signJwt(account: FcmServiceAccount, now: number): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: account.clientEmail, scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }));
  const pem = account.privateKey.replace(/\\n/g, "\n").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Buffer.from(pem, "base64"), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(signature)}`;
}

let cached: { token: string; expires: number; email: string } | null = null;

async function accessToken(account: FcmServiceAccount, fetchFn: FetchFn): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.email === account.clientEmail && cached.expires > now + 60) return cached.token;
  const response = await fetchFn("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: await signJwt(account, now) }),
  });
  const data = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!response.ok || !data.access_token) throw new Error(`FCM authorization failed (${response.status})`);
  cached = { token: data.access_token, expires: now + (data.expires_in ?? 3600), email: account.clientEmail };
  return data.access_token;
}

/** "gone" means the token is no longer valid and should be deleted. */
export async function sendFcm(
  account: FcmServiceAccount, token: string, message: { title: string; body: string; data?: Record<string, string> }, fetchFn: FetchFn = fetch,
): Promise<"sent" | "gone" | "failed"> {
  const response = await fetchFn(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.projectId)}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken(account, fetchFn)}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token,
        notification: { title: message.title.slice(0, 120), body: message.body.slice(0, 500) },
        data: message.data ?? {},
        android: { priority: "high", notification: { channel_id: "mail_updates" } },
      },
    }),
  });
  if (response.ok) return "sent";
  if (response.status === 404) return "gone";
  if (response.status === 400) {
    const text = await response.text().catch(() => "");
    if (/UNREGISTERED|INVALID_ARGUMENT.*registration/i.test(text)) return "gone";
  }
  return "failed";
}
