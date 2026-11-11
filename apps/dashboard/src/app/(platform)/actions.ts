"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  addDomain,
  createChatbot,
  createOrganization,
  createWebsite,
  createWorkspace,
  removeDomain,
  setChatbotStatus,
  updateChatbotSettings,
  type ChatbotStatus,
} from "@chatbot/core";
import { toActionError, type ActionState } from "@/lib/action-result";
import { asTrusted, asUser } from "@/lib/session";

const str = (fd: FormData, key: string) => String(fd.get(key) ?? "").trim();

/** Splits "a.com, b.com\nc.com" into a list. */
const list = (value: string) =>
  value
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);

export async function createOrganizationAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  let orgId: string;
  try {
    // Trusted: there is no RLS insert policy for organizations; the service adds the caller as owner.
    const org = await asTrusted((db, user) => createOrganization(db, user.id, { name: str(fd, "name"), slug: str(fd, "slug") }));
    orgId = org.id;
  } catch (err) {
    return toActionError(err);
  }
  redirect(`/orgs/${orgId}`);
}

export async function createWorkspaceAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const orgId = str(fd, "organizationId");
    await asUser((db) => createWorkspace(db, { organizationId: orgId, name: str(fd, "name"), slug: str(fd, "slug") }));
    revalidatePath(`/orgs/${orgId}`);
    return { ok: "Workspace created" };
  } catch (err) {
    return toActionError(err);
  }
}

export async function createWebsiteAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const workspaceId = str(fd, "workspaceId");
    await asUser((db) => createWebsite(db, { workspaceId, name: str(fd, "name"), domains: list(str(fd, "domains")) }));
    revalidatePath(`/workspaces/${workspaceId}`);
    return { ok: "Website created" };
  } catch (err) {
    return toActionError(err);
  }
}

export async function addDomainAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const websiteId = str(fd, "websiteId");
    await asUser((db) => addDomain(db, websiteId, str(fd, "domain")));
    revalidatePath(`/websites/${websiteId}`);
    return { ok: "Domain added" };
  } catch (err) {
    return toActionError(err);
  }
}

export async function removeDomainAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const websiteId = str(fd, "websiteId");
    await asUser((db) => removeDomain(db, websiteId, str(fd, "domainId")));
    revalidatePath(`/websites/${websiteId}`);
    return null;
  } catch (err) {
    return toActionError(err);
  }
}

function settingsFrom(fd: FormData) {
  return {
    name: str(fd, "name"),
    model: str(fd, "model"),
    provider: str(fd, "provider") || undefined,
    systemPrompt: str(fd, "systemPrompt"),
    welcomeMessage: str(fd, "welcomeMessage") || undefined,
    suggestedQuestions: String(fd.get("suggestedQuestions") ?? "")
      .split(/\r?\n/)
      .map((q) => q.trim())
      .filter(Boolean),
    temperature: str(fd, "temperature") === "" ? undefined : Number(str(fd, "temperature")),
    maxOutputTokens: str(fd, "maxOutputTokens") === "" ? undefined : Number(str(fd, "maxOutputTokens")),
    fallbacks:
      str(fd, "fallbackProvider") && str(fd, "fallbackModel")
        ? [{ provider: str(fd, "fallbackProvider"), model: str(fd, "fallbackModel") }]
        : [],
    // Voice fields exist only on the full settings form; the quick "new chatbot" form keeps defaults.
    voice: fd.has("voiceMode")
      ? {
          mode: str(fd, "voiceMode"),
          sttProvider: str(fd, "sttProvider"),
          ttsProvider: str(fd, "ttsProvider"),
          ttsVoice: str(fd, "ttsVoice"),
          autoSpeak: fd.get("autoSpeak") === "on",
          realtimeModel: str(fd, "realtimeModel"),
          realtimeVoice: str(fd, "realtimeVoice"),
        }
      : undefined,
    position: str(fd, "position") || undefined,
    theme: str(fd, "theme") || undefined,
  };
}

export async function createChatbotAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  let chatbotId: string;
  try {
    const websiteId = str(fd, "websiteId");
    const bot = await asUser((db) => createChatbot(db, { websiteId, settings: settingsFrom(fd) }));
    chatbotId = bot.id;
  } catch (err) {
    return toActionError(err);
  }
  redirect(`/chatbots/${chatbotId}`);
}

export async function updateChatbotAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const chatbotId = str(fd, "chatbotId");
    await asUser((db) => updateChatbotSettings(db, chatbotId, settingsFrom(fd)));
    revalidatePath(`/chatbots/${chatbotId}`);
    return { ok: "Settings saved" };
  } catch (err) {
    return toActionError(err);
  }
}

export async function setChatbotStatusAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const chatbotId = str(fd, "chatbotId");
    await asUser((db) => setChatbotStatus(db, chatbotId, str(fd, "status") as ChatbotStatus));
    revalidatePath(`/chatbots/${chatbotId}`);
    return null;
  } catch (err) {
    return toActionError(err);
  }
}
