/** Encrypts mailbox refresh tokens at rest (AES-256-GCM, WebCrypto, so it runs on Node and Workers). */
const encoder = new TextEncoder();

export const toBase64Url = (bytes: Uint8Array | ArrayBuffer): string =>
  Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");

export const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> => {
  const buffer = Buffer.from(text, "base64url");
  const out = new Uint8Array(buffer.length);
  out.set(buffer);
  return out;
};

async function keyFor(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("MAIL_TOKEN_SECRET must be at least 32 characters");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`mail-token:v1:${secret}`));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plain: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyFor(secret), encoder.encode(plain));
  return `v1.${toBase64Url(iv)}.${toBase64Url(sealed)}`;
}

/** Throws when the value was tampered with or the secret changed. */
export async function decryptSecret(sealed: string, secret: string): Promise<string> {
  const [version, iv, data] = sealed.split(".");
  if (version !== "v1" || !iv || !data) throw new Error("Unrecognized encrypted value");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(iv) }, await keyFor(secret), fromBase64Url(data));
  return new TextDecoder().decode(plain);
}
