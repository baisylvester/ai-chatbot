/** POST /api/v1/client/mail/connection/select — makes one of the caller's mailboxes the selected one. */
import { z } from "zod";
import { clientError, clientPreflight, withClientRequest } from "@/lib/client-api";
import { selectMailbox } from "@/lib/native-mail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = clientPreflight;
const schema = z.object({ mailboxId: z.uuid() }).strict();
export async function POST(request: Request) {
  return withClientRequest(request, async user => {
    const body = schema.safeParse(await request.json().catch(() => null));
    if (!body.success) return clientError(400, "invalid", "Choose a mailbox.");
    if (!await selectMailbox(user.id, body.data.mailboxId)) return clientError(404, "not_found", "This mailbox is no longer connected.", "mailbox_not_connected");
    return Response.json({ ok: true });
  });
}
