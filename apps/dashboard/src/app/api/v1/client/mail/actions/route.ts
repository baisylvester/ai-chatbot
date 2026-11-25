/** GET /api/v1/client/mail/actions?filter=pending|recent — the caller's own send and trash requests. */
import { clientError, clientPreflight, withClientRequest } from "@/lib/client-api";
import { listActionItems } from "@/lib/native-mail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = clientPreflight;
export async function GET(request: Request) {
  return withClientRequest(request, async user => {
    const filter = new URL(request.url).searchParams.get("filter") ?? "pending";
    if (filter !== "pending" && filter !== "recent") return clientError(400, "invalid", "filter must be pending or recent");
    return Response.json({ actions: await listActionItems(user.id, filter) });
  });
}
