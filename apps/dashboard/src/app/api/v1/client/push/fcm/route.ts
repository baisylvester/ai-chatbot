/**
 * POST /api/v1/client/push/fcm — registers this phone's Firebase token for new-mail notifications.
 * DELETE — unregisters it (sign-out, or the user turned notifications off).
 */
import { clientPreflight, withClientRequest } from "@/lib/client-api";
import { pushTokenRequest } from "@/lib/native-mail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = clientPreflight;
export async function POST(request: Request) {
  return withClientRequest(request, user => pushTokenRequest(request, user.id, true));
}
export async function DELETE(request: Request) {
  return withClientRequest(request, user => pushTokenRequest(request, user.id, false));
}
