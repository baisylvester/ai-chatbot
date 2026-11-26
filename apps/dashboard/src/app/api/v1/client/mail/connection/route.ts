/**
 * DELETE /api/v1/client/mail/connection?mailboxId=… — disconnects one mailbox (the selected one without
 * mailboxId), like the web Disconnect button. Google tokens are revoked; stored secrets are deleted.
 */
import { clientPreflight, withClientRequest } from "@/lib/client-api";
import { requestedMailbox } from "@/lib/mail-client";
import { disconnectMailbox } from "@/lib/native-mail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = clientPreflight;
export async function DELETE(request: Request) {
  return withClientRequest(request, async user => {
    await disconnectMailbox(user.id, requestedMailbox(request));
    return new Response(null, { status: 204 });
  });
}
