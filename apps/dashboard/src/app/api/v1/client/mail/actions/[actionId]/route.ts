/** GET /api/v1/client/mail/actions/{id} — the request with its live Gmail content and the version to approve. */
import { z } from "zod";
import { clientError, clientPreflight, withClientRequest } from "@/lib/client-api";
import { actionDetail } from "@/lib/native-mail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = clientPreflight;
type Context = { params: Promise<{ actionId: string }> };
export async function GET(request: Request, { params }: Context) {
  return withClientRequest(request, async user => {
    const id = z.uuid().safeParse((await params).actionId);
    if (!id.success) return clientError(404, "not_found", "This request was not found.", "action_not_found");
    return Response.json(await actionDetail(user.id, id.data));
  });
}
