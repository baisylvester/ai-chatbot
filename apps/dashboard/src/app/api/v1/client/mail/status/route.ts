/** GET /api/v1/client/mail/status?chatbotId=cb_… — mailbox connection, eligibility and pending approvals. */
import { clientBot, clientPreflight, withClientRequest } from "@/lib/client-api";
import { mailStatus } from "@/lib/native-mail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = clientPreflight;
export async function GET(request: Request) {
  return withClientRequest(request, async user => {
    const bot = await clientBot(request, new URL(request.url).searchParams.get("chatbotId") ?? "", false, user.id);
    return Response.json(await mailStatus(user.id, bot));
  });
}
