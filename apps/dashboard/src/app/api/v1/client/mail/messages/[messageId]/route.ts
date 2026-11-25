import { clientPreflight } from "@/lib/client-api";
import { readMailboxMessage } from "@/lib/mail-client";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = clientPreflight;
export async function GET(request: Request, context: { params: Promise<{ messageId: string }> }) {
  return readMailboxMessage(request, (await context.params).messageId);
}
