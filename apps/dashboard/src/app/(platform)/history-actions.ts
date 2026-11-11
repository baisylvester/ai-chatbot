"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authorizeConversationDelete, deleteConversation, purgeExpiredData, setRetention } from "@chatbot/core";
import { withTrustedContext, withUserContext } from "@chatbot/database";
import { toActionError, type ActionState } from "@/lib/action-result";
import { getPool } from "@/lib/db";
import { asUser, requireUser } from "@/lib/session";

export async function setRetentionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const organizationId = String(fd.get("organizationId") ?? "");
  const raw = String(fd.get("days") ?? "");
  try {
    await asUser((db) => setRetention(db, organizationId, raw ? Number(raw) : null));
    // Apply immediately so the setting visibly takes effect.
    const purged = raw ? await withTrustedContext(getPool(), (db) => purgeExpiredData(db, organizationId)) : { conversations: 0 };
    revalidatePath(`/orgs/${organizationId}/conversations`);
    return { ok: raw ? `Saved. ${purged.conversations} older conversation${purged.conversations === 1 ? "" : "s"} deleted.` : "Saved. Conversations are kept until deleted." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function deleteConversationAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const organizationId = String(fd.get("organizationId") ?? "");
  try {
    const user = await requireUser();
    const pool = getPool();
    // Two separate transactions: authorize as the user, then delete as trusted. Never nested.
    const grant = await withUserContext(pool, user.id, (db) => authorizeConversationDelete(db, String(fd.get("sessionId") ?? ""), user.id));
    await withTrustedContext(pool, (db) => deleteConversation(db, grant));
  } catch (err) {
    return toActionError(err);
  }
  redirect(`/orgs/${organizationId}/conversations`);
}
