/**
 * GET /api/agent/notifications — notifications not yet shown on a device, for the signed-in user.
 * Called by the service worker (public/agent-sw.js) when a push wakes it. Pushes carry no content,
 * so the text is only ever handed to the user's own session.
 */
import { takeUndelivered } from "@chatbot/mail-agent";
import { mailDb } from "@/lib/mail-agent";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const headers = { "Cache-Control": "private, no-store" };
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: { code: "unauthorized", message: "Sign in to see notifications" } }, { status: 401, headers });
  const items = await mailDb((db) => takeUndelivered(db, user.id));
  return Response.json({ items: items.map(({ id, title, body }) => ({ id, title, body })) }, { headers });
}
