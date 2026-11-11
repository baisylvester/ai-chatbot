"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  addDocument,
  createKnowledgeSource,
  deleteDocument,
  deleteKnowledgeSource,
  DomainError,
  getChatbot,
  getDocument,
  getKnowledgeSource,
  getOrganization,
  markForReprocessing,
  setGlobalSourceAssignment,
} from "@chatbot/core";
import { detectFormat, ExtractionError, extractText, MAX_UPLOAD_BYTES } from "@chatbot/rag-engine";
import { MAX_EXTRACTED_CHARS, normalizeText } from "@chatbot/rag-engine/extract-shared";
import { toActionError, type ActionState } from "@/lib/action-result";
import { getEmbedder, startIngestion } from "@/lib/knowledge";
import { asUser } from "@/lib/session";

const str = (fd: FormData, key: string) => String(fd.get(key) ?? "").trim();

/** Only same-site dashboard paths (`/orgs/…` or `/chatbots/…`); anything else goes to /orgs. */
function safeReturnPath(raw: string): string {
  try {
    const url = new URL(raw, "http://internal.invalid");
    if (url.origin !== "http://internal.invalid") return "/orgs";
    return /^\/(orgs|chatbots)\/[0-9a-f-]{36}(\/[a-z]+)?$/.test(url.pathname) ? url.pathname : "/orgs";
  } catch {
    return "/orgs";
  }
}

export async function createSourceAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  let sourceId: string;
  try {
    const chatbotId = str(fd, "chatbotId") || undefined;
    const source = await asUser((db) =>
      createKnowledgeSource(db, {
        organizationId: str(fd, "organizationId") || undefined,
        chatbotId,
        name: str(fd, "name"),
        description: str(fd, "description") || undefined,
      }),
    );
    sourceId = source.id;
  } catch (err) {
    return toActionError(err);
  }
  redirect(`/knowledge/${sourceId}`);
}

export async function deleteSourceAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const back = str(fd, "returnTo") || "/orgs";
  try {
    await asUser((db) => deleteKnowledgeSource(db, str(fd, "sourceId")));
  } catch (err) {
    return toActionError(err);
  }
  redirect(safeReturnPath(back));
}

export async function addTextAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const sourceId = str(fd, "sourceId");
    const doc = await asUser((db) =>
      addDocument(db, { sourceId, kind: "text", title: str(fd, "title"), content: String(fd.get("content") ?? "") }),
    );
    await startIngestion(doc);
    revalidatePath(`/knowledge/${sourceId}`);
    return { ok: "Added. Processing in the background." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function addUrlAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const sourceId = str(fd, "sourceId");
    const doc = await asUser((db) => addDocument(db, { sourceId, kind: "url", url: str(fd, "url") }));
    await startIngestion(doc);
    revalidatePath(`/knowledge/${sourceId}`);
    return { ok: "Added. The page is being fetched in the background." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function uploadFileAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const sourceId = str(fd, "sourceId");
    const chatbotId = str(fd, "chatbotId");
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) return { error: "Choose a file to upload" };
    if (file.size > MAX_UPLOAD_BYTES) return { error: "The file is larger than 10 MB" };
    const format = detectFormat(file.name, file.type);
    if (!format) return { error: "Unsupported file type. Upload PDF, DOC, DOCX, TXT, Markdown or HTML." };
    // Authorize before parsing untrusted bytes. Hiding the form does not protect the server action.
    await asUser(async (db) => {
      const source = sourceId ? await getKnowledgeSource(db, sourceId) : null;
      const bot = chatbotId ? await getChatbot(db, chatbotId) : null;
      if (!source && !bot) throw new DomainError("invalid", "Choose a knowledge source or chatbot");
      if (source && bot && (source.scope !== "chatbot" || source.chatbot_id !== bot.id)) {
        throw new DomainError("invalid", "Choose a source that belongs to this chatbot");
      }
      const org = await getOrganization(db, source?.organization_id ?? bot!.organization_id);
      if (org.role !== "owner" && org.role !== "admin") {
        throw new DomainError("forbidden", "Only owners and admins can upload knowledge files");
      }
    });
    // Extraction is quick and needs the bytes, so it happens now; chunking and embedding run in the background.
    let content: string;
    let sizeBytes = file.size;
    if (process.env.CLOUDFLARE_WORKERS === "1") {
      const extracted = fd.get("extractedContent");
      sizeBytes = Number(fd.get("fileSizeBytes"));
      if (typeof extracted !== "string" || !extracted.trim() || extracted.length > MAX_EXTRACTED_CHARS
        || !Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_UPLOAD_BYTES) {
        return { error: "Read the file in your browser before uploading. Reload this page and try again." };
      }
      // Admins can also paste arbitrary text. Browser extraction is input, never an authorization signal.
      content = normalizeText(extracted);
    } else {
      content = await extractText(new Uint8Array(await file.arrayBuffer()), format);
    }
    const title = str(fd, "title") || file.name.replace(/\.[^.]+$/, "");
    // Source creation and document insertion share one transaction: a failed insert leaves no empty source.
    const doc = await asUser(async (db) => {
      const destination = sourceId || (await createKnowledgeSource(db, {
        chatbotId, name: str(fd, "sourceName") || "Uploaded files",
      })).id;
      return addDocument(db, { sourceId: destination, kind: "file", title, content, mimeType: file.type || undefined, sizeBytes });
    });
    await startIngestion(doc);
    revalidatePath(`/knowledge/${doc.knowledge_source_id}`);
    if (chatbotId) revalidatePath(`/chatbots/${chatbotId}`);
    const { embedder } = getEmbedder();
    return {
      ok: embedder
        ? `Uploaded "${title}". Processing in the background.`
        : `Uploaded "${title}". It will be searchable by keywords only until an embedding provider is configured.`,
      sourceId: doc.knowledge_source_id,
    };
  } catch (err) {
    if (err instanceof ExtractionError) return { error: err.message };
    return toActionError(err);
  }
}

export async function reprocessDocumentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const doc = await asUser((db) => markForReprocessing(db, str(fd, "documentId")));
    await startIngestion(doc);
    revalidatePath(`/knowledge/${doc.knowledge_source_id}`);
    return null;
  } catch (err) {
    return toActionError(err);
  }
}

export async function deleteDocumentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const doc = await asUser(async (db) => {
      const d = await getDocument(db, str(fd, "documentId"));
      await deleteDocument(db, d.id);
      return d;
    });
    revalidatePath(`/knowledge/${doc.knowledge_source_id}`);
    return null;
  } catch (err) {
    return toActionError(err);
  }
}

export async function setAssignmentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const chatbotId = str(fd, "chatbotId");
    await asUser((db) => setGlobalSourceAssignment(db, chatbotId, str(fd, "sourceId"), str(fd, "assigned") === "true"));
    revalidatePath(`/chatbots/${chatbotId}`);
    return null;
  } catch (err) {
    return toActionError(err);
  }
}
