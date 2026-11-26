import { clientPreflight } from "@/lib/client-api";
import { deleteMailLabel, updateMailLabel } from "@/lib/mail-client";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = clientPreflight;
type Context = { params: Promise<{ labelId: string }> };
export async function PATCH(request: Request, context: Context) {
  return updateMailLabel(request, (await context.params).labelId);
}
export async function DELETE(request: Request, context: Context) {
  return deleteMailLabel(request, (await context.params).labelId);
}
