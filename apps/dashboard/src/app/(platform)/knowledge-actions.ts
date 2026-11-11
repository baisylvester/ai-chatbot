"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  addDocument,
  createKnowledgeSource,
  deleteDocument,
  deleteKnowledgeSource,
  getDocument,
  markForReprocessing,
  setGlobalSourceAssignment,
} from "@chatbot/core";
import { detectFormat, ExtractionError, extractText, MAX_UPLOAD_BYTES } from "@chatbot/rag-engine";
import { toActionError, type ActionState } from "@/lib/action-result";
import { startIngestion } from "@/lib/knowledge";
import { asUser } from "@/lib/session";

const str = (fd: FormData, key: string) => String(fd.get(key) ?? "").trim();

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
  redirect(back.startsWith("/") && !back.startsWith("//") ? back : "/orgs");
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
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) return { error: "Choose a file to upload" };
    if (file.size > MAX_UPLOAD_BYTES) return { error: "The file is larger than 10 MB" };
    const format = detectFormat(file.name, file.type);
    if (!format) return { error: "Unsupported file type. Upload PDF, DOCX, TXT, Markdown or HTML." };
    // Extraction is quick and needs the bytes, so it happens now; chunking and embedding run in the background.
    const content = await extractText(new Uint8Array(await file.arrayBuffer()), format);
    const title = str(fd, "title") || file.name.replace(/\.[^.]+$/, "");
    const doc = await asUser((db) =>
      addDocument(db, { sourceId, kind: "file", title, content, mimeType: file.type || undefined, sizeBytes: file.size }),
    );
    await startIngestion(doc);
    revalidatePath(`/knowledge/${sourceId}`);
    return { ok: `Uploaded "${title}". Processing in the background.` };
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
