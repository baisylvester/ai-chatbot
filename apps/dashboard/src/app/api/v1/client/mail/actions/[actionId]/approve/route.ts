/** POST /api/v1/client/mail/actions/{id}/approve — sends, schedules or trashes, only for the exact version reviewed. */
import { z } from "zod";
import { clientError, clientPreflight, withClientRequest } from "@/lib/client-api";
import { approveAction } from "@/lib/native-mail";
import { readJson } from "@/lib/public-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = clientPreflight;
export const maxDuration = 60;
type Context = { params: Promise<{ actionId: string }> };
/** `sendAt` (ISO 8601 with Z or an offset) schedules an email instead of sending it now. */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const schema = z.object({ version: z.string().regex(/^[0-9a-f]{64}$/), sendAt: z.string().regex(ISO_WITH_OFFSET).optional() }).strict();
export async function POST(request: Request, { params }: Context) {
  return withClientRequest(request, async user => {
    const id = z.uuid().safeParse((await params).actionId);
    if (!id.success) return clientError(404, "not_found", "This request was not found.", "action_not_found");
    const body = schema.safeParse(await readJson(request, 1024));
    if (!body.success) return clientError(400, "invalid", "version from the request details is required", "stale_approval");
    return Response.json(await approveAction(user.id, id.data, body.data.version, body.data.sendAt ? new Date(body.data.sendAt) : undefined));
  });
}
