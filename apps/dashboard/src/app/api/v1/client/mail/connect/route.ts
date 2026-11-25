/** POST /api/v1/client/mail/connect — starts a single-use native Gmail connection transaction. */
import { z } from "zod";
import { clientBot, clientError, clientPreflight, withClientRequest } from "@/lib/client-api";
import { startNativeConnect, VERIFIER_CHALLENGE } from "@/lib/native-mail";
import { readJson } from "@/lib/public-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = clientPreflight;
const schema = z.object({ chatbotId: z.string().min(1).max(80), verifierChallenge: z.string().regex(VERIFIER_CHALLENGE) }).strict();
export async function POST(request: Request) {
  return withClientRequest(request, async user => {
    const body = schema.safeParse(await readJson(request, 4096));
    if (!body.success) return clientError(400, "invalid", "chatbotId and verifierChallenge (base64url SHA-256, 43 characters) are required");
    const bot = await clientBot(request, body.data.chatbotId, false, user.id);
    return startNativeConnect(user.id, bot, body.data.verifierChallenge);
  });
}
