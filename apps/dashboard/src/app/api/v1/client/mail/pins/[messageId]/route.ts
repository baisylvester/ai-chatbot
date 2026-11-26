import { clientPreflight } from "@/lib/client-api";
import { unpinMessage } from "@/lib/mail-client";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = clientPreflight;
export async function DELETE(request: Request, context: { params: Promise<{ messageId: string }> }) {
  return unpinMessage(request, (await context.params).messageId);
}
