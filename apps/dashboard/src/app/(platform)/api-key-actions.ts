"use server";

import { revalidatePath } from "next/cache";
import { authorizeApiKeyCreate, createApiKey, DomainError, revokeApiKey } from "@chatbot/core";
import { withTrustedContext, withUserContext } from "@chatbot/database";
import { toActionError, type ActionState } from "@/lib/action-result";
import { getPool } from "@/lib/db";
import { asUser, requireUser } from "@/lib/session";

/** Creates a key and returns the plaintext once (it is never stored or shown again). */
export async function createApiKeyAction(
  _prev: { error?: string; key?: string } | null,
  fd: FormData,
): Promise<{ error?: string; key?: string } | null> {
  const organizationId = String(fd.get("organizationId") ?? "");
  try {
    const user = await requireUser();
    const pool = getPool();
    // Two separate transactions: authorize as the user, then insert as trusted. Never nested.
    const grant = await withUserContext(pool, user.id, (db) => authorizeApiKeyCreate(db, { organizationId, name: String(fd.get("name") ?? ""), createdBy: user.id }));
    const created = await withTrustedContext(pool, (db) => createApiKey(db, grant));
    revalidatePath(`/orgs/${organizationId}`);
    return { key: created.plaintext };
  } catch (err) {
    if (err instanceof DomainError) return { error: err.message };
    const r = toActionError(err);
    return { error: r?.error };
  }
}

export async function revokeApiKeyAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await asUser((db) => revokeApiKey(db, String(fd.get("keyId") ?? "")));
    revalidatePath(`/orgs/${String(fd.get("organizationId") ?? "")}`);
    return null;
  } catch (err) {
    return toActionError(err);
  }
}
