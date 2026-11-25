/** DELETE /api/v1/client/mail/connection — revokes and removes the caller's mailbox, like the web Disconnect button. */
import { clientPreflight, withClientRequest } from "@/lib/client-api";
import { disconnectMailbox } from "@/lib/native-mail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = clientPreflight;
export async function DELETE(request: Request) {
  return withClientRequest(request, async user => {
    await disconnectMailbox(user.id);
    return new Response(null, { status: 204 });
  });
}
