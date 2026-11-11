"use server";

import { revalidatePath } from "next/cache";
import { createApiKey, DomainError, revokeApiKey } from "@chatbot/core";
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
    const created = await withUserContext(pool, user.id, (userDb) =>
      withTrustedContext(pool, (trustedDb) => createApiKey(userDb, trustedDb, { organizationId, name: String(fd.get("name") ?? ""), createdBy: user.id })),
    );
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
