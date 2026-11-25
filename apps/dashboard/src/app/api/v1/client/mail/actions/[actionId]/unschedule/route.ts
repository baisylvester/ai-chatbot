/** POST /api/v1/client/mail/actions/{id}/unschedule — a scheduled email goes back to waiting for approval. */
import { z } from "zod";
import { clientError, clientPreflight, withClientRequest } from "@/lib/client-api";
import { unscheduleSend } from "@/lib/native-mail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = clientPreflight;
type Context = { params: Promise<{ actionId: string }> };
export async function POST(request: Request, { params }: Context) {
  return withClientRequest(request, async user => {
    const id = z.uuid().safeParse((await params).actionId);
    if (!id.success) return clientError(404, "not_found", "This request was not found.", "action_not_found");
    return Response.json(await unscheduleSend(user.id, id.data));
  });
}
