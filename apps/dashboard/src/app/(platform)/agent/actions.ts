"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { DomainError } from "@chatbot/core";
import {
  claimAction, createAction, decryptSecret, deleteConnection, deletePushSubscription, finishAction, getConnection, isPushEndpoint,
  revokeToken, runMailAgent, savePushSubscription, setNotify, type AgentStep, type SendPayload, type TrashPayload,
} from "@chatbot/mail-agent";
import { log } from "@/lib/log";
import { agentModel, mailDb, mailSetup, openMailbox } from "@/lib/mail-agent";
import { rateLimit } from "@/lib/rate-limit";
import { requireUser } from "@/lib/session";

export type ChatResult = { reply: string; steps: AgentStep[]; queued: number } | { error: string };
export type SimpleResult = { ok: true } | { error: string };

const historySchema = z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(8000) })).min(1).max(40);
const idSchema = z.uuid();

function failure(err: unknown, event: string): { error: string } {
  if (err && typeof err === "object" && "digest" in err) throw err; // redirect()/notFound()
  if (err instanceof DomainError) return { error: err.message };
  log.error(event, { error: err });
  return { error: "Something went wrong. Please try again." };
}

/** One request to the agent. `history` is the conversation so far, ending with the user's new message. */
export async function chatAction(history: unknown): Promise<ChatResult> {
  const user = await requireUser();
  try {
    const turns = historySchema.safeParse(history);
    if (!turns.success || turns.data.at(-1)?.role !== "user") return { error: "Type a message first." };
    const limit = await rateLimit(`agent:${user.id}`, 20, 60_000);
    if (!limit.ok) return { error: `Too many requests. Try again in ${limit.retryAfterSec} seconds.` };
    if (!mailSetup().modelReady) return { error: "The agent's AI model is not configured on this server yet." };
    const { connection, gmail } = await openMailbox(user.id);
    const result = await runMailAgent({
      model: agentModel(4096),
      mail: gmail,
      userEmail: connection.email,
      queueAction: (kind, summary, payload) => mailDb((db) => createAction(db, user.id, kind, summary, payload)),
    }, turns.data);
    if (result.queued) revalidatePath("/agent");
    return result;
  } catch (err) {
    return failure(err, "agent.chat_failed");
  }
}

/** The user approves a queued action: this is the only place mail is sent or moved to Trash. */
export async function approveAction(actionId: string): Promise<SimpleResult> {
  const user = await requireUser();
  try {
    const id = idSchema.parse(actionId);
    const action = await mailDb((db) => claimAction(db, user.id, id));
    if (!action) return { error: "This was already handled." };
    try {
      const { gmail } = await openMailbox(user.id);
      if (action.kind === "send") await gmail.sendDraft((action.payload as SendPayload).draftId);
      else await gmail.trash((action.payload as TrashPayload).ids);
      await mailDb((db) => finishAction(db, user.id, id, "done"));
      log.info("agent.action_done", { userId: user.id, kind: action.kind });
    } catch (err) {
      const reason = err instanceof Error ? err.message : "failed";
      await mailDb((db) => finishAction(db, user.id, id, "failed", reason));
      revalidatePath("/agent");
      if (err instanceof DomainError) return { error: err.message };
      return { error: action.kind === "send" ? "Gmail could not send this draft. It may have been changed or deleted in Gmail." : "Gmail could not move those messages to Trash." };
    }
    revalidatePath("/agent");
    return { ok: true };
  } catch (err) {
    return failure(err, "agent.approve_failed");
  }
}

/** Dismisses a queued action. A drafted email stays in Gmail's Drafts folder. */
export async function rejectAction(actionId: string): Promise<SimpleResult> {
  const user = await requireUser();
  try {
    const id = idSchema.parse(actionId);
    await mailDb((db) => finishAction(db, user.id, id, "rejected"));
    revalidatePath("/agent");
    return { ok: true };
  } catch (err) {
    return failure(err, "agent.reject_failed");
  }
}

export async function disconnectAction(): Promise<void> {
  const user = await requireUser();
  const { tokenSecret } = mailSetup();
  const connection = await mailDb((db) => getConnection(db, user.id));
  if (connection && tokenSecret) {
    const token = await decryptSecret(connection.refreshTokenEnc, tokenSecret).catch(() => null);
    if (token) await revokeToken(token);
  }
  await mailDb((db) => deleteConnection(db, user.id));
  log.info("mail.disconnected", { userId: user.id });
  revalidatePath("/agent");
}

/** Registers this device for new-mail notifications. Only the push service address is stored. */
export async function savePushAction(endpoint: string): Promise<SimpleResult> {
  const user = await requireUser();
  try {
    if (typeof endpoint !== "string" || endpoint.length > 2000 || !isPushEndpoint(endpoint)) return { error: "This browser's notification service is not supported." };
    await mailDb(async (db) => {
      await savePushSubscription(db, user.id, endpoint);
      await setNotify(db, user.id, true);
    });
    return { ok: true };
  } catch (err) {
    return failure(err, "agent.push_save_failed");
  }
}

export async function removePushAction(endpoint: string): Promise<SimpleResult> {
  const user = await requireUser();
  try {
    if (typeof endpoint === "string") await mailDb((db) => deletePushSubscription(db, endpoint, user.id));
    return { ok: true };
  } catch (err) {
    return failure(err, "agent.push_remove_failed");
  }
}
