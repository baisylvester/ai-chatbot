import { randomInt } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Generates a public chatbot id like `cb_X7k...` (24 random chars, ~142 bits). Identifier only, not a secret. */
export function generatePublicChatbotId(length = 24): string {
  let out = "cb_";
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}
