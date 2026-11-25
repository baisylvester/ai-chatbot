/** POST /api/v1/client/mail/connect/complete — the app proves it started the transaction; the mailbox is saved. */
import { z } from "zod";
import { clientBot, clientError, clientPreflight, withClientRequest } from "@/lib/client-api";
import { completeNativeConnect, mailStatus } from "@/lib/native-mail";
import { readJson } from "@/lib/public-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = clientPreflight;
const token = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/);
const schema = z.object({ transactionId: z.uuid(), code: token, verifier: token }).strict();
export async function POST(request: Request) {
  return withClientRequest(request, async user => {
    const body = schema.safeParse(await readJson(request, 4096));
    if (!body.success) return clientError(400, "invalid", "transactionId, code and verifier are required", "verification_failed");
    const outcome = await completeNativeConnect(user.id, body.data);
    if (!outcome.ok) return clientError(outcome.status, outcome.code, outcome.message, outcome.reason);
    return Response.json(await mailStatus(user.id, await clientBot(request, outcome.chatbotPublicId, false, user.id)));
  });
}
