/** POST /api/v1/client/mail/connect/imap — connects an IMAP mailbox with an app password. */
import { clientBot, clientError, clientPreflight, withClientRequest } from "@/lib/client-api";
import { connectImap, parseImapRequest } from "@/lib/native-mail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = clientPreflight;
export async function POST(request: Request) {
  return withClientRequest(request, async user => {
    const input = parseImapRequest(await request.json().catch(() => null));
    if (!input) return clientError(400, "invalid", "Enter the email address and its app password.");
    const bot = await clientBot(request, input.chatbotId, false, user.id);
    return Response.json(await connectImap(user.id, bot, input), { status: 201 });
  });
}
