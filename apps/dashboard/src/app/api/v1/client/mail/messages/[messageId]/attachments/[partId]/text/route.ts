import { clientPreflight } from "@/lib/client-api";
import { attachmentText } from "@/lib/mail-client";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = clientPreflight;
export const maxDuration = 60;
export async function GET(request: Request, context: { params: Promise<{ messageId: string; partId: string }> }) {
  const { messageId, partId } = await context.params;
  return attachmentText(request, messageId, partId);
}
