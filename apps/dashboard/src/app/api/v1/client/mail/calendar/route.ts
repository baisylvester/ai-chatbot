/** DELETE /api/v1/client/mail/calendar — disconnects Google Calendar (connect it with POST /mail/connect, provider "gcal"). */
import { clientPreflight, withClientRequest } from "@/lib/client-api";
import { disconnectCalendar } from "@/lib/native-mail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = clientPreflight;
export async function DELETE(request: Request) {
  return withClientRequest(request, async user => {
    await disconnectCalendar(user.id);
    return new Response(null, { status: 204 });
  });
}
