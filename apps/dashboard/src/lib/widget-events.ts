import "server-only";
import { recordWidgetRefusal } from "@chatbot/core";
import { withTrustedContext } from "@chatbot/database";
import { getPool } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Records a refused widget load for the chatbot's analytics. Throttled per chatbot+origin so a
 * misconfigured or hostile site can't flood the table; failures never affect the response.
 */
export async function logRefusal(chatbotId: string, origin: string | null, code: string): Promise<void> {
  if (!rateLimit(`refusal:${chatbotId}:${origin ?? "-"}`, 10, 60_000).ok) return;
  try {
    await withTrustedContext(getPool(), (db) => recordWidgetRefusal(db, chatbotId, origin, code));
  } catch (err) {
    console.error("could not record widget refusal", err);
  }
}
