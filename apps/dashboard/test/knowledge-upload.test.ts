import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  extractText: vi.fn(), getKnowledgeSource: vi.fn(), getChatbot: vi.fn(), getOrganization: vi.fn(),
  addDocument: vi.fn(), createKnowledgeSource: vi.fn(), revalidatePath: vi.fn(), startIngestion: vi.fn(),
  getEmbedder: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/session", () => ({ asUser: (fn: (db: object) => Promise<unknown>) => fn({}) }));
vi.mock("@/lib/knowledge", () => ({ startIngestion: mocks.startIngestion, getEmbedder: mocks.getEmbedder }));
vi.mock("@chatbot/core", async (original) => ({ ...await original<object>(), ...mocks }));
vi.mock("@chatbot/rag-engine", async (original) => ({ ...await original<object>(), extractText: mocks.extractText }));

import { uploadFileAction } from "../src/app/(platform)/knowledge-actions";

function upload(fields: Record<string, string> = { chatbotId: "bot-a", sourceId: "source-a" }) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  fd.set("file", new File(["Knowledge file content"], "hours.txt", { type: "text/plain" }));
  return fd;
}

describe("knowledge file upload authorization and ingestion", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getKnowledgeSource.mockResolvedValue({ id: "source-a", organization_id: "org-a", scope: "chatbot", chatbot_id: "bot-a" });
    mocks.getChatbot.mockResolvedValue({ id: "bot-a", organization_id: "org-a" });
    mocks.getOrganization.mockResolvedValue({ id: "org-a", role: "admin" });
    mocks.extractText.mockResolvedValue("Extracted knowledge text");
    mocks.createKnowledgeSource.mockResolvedValue({ id: "new-source" });
    mocks.addDocument.mockResolvedValue({ id: "doc-a", organization_id: "org-a", knowledge_source_id: "source-a" });
    mocks.getEmbedder.mockReturnValue({ embedder: null });
  });

  it("rejects a viewer before parsing or storing the file", async () => {
    mocks.getOrganization.mockResolvedValue({ id: "org-a", role: "viewer" });
    expect(await uploadFileAction(null, upload())).toMatchObject({ error: expect.stringContaining("Only owners and admins") });
    expect(mocks.extractText).not.toHaveBeenCalled();
    expect(mocks.addDocument).not.toHaveBeenCalled();
  });

  it("rejects a source belonging to a different chatbot", async () => {
    mocks.getKnowledgeSource.mockResolvedValue({ id: "source-a", organization_id: "org-a", scope: "chatbot", chatbot_id: "bot-b" });
    expect(await uploadFileAction(null, upload())).toMatchObject({ error: expect.stringContaining("belongs to this chatbot") });
    expect(mocks.extractText).not.toHaveBeenCalled();
    expect(mocks.startIngestion).not.toHaveBeenCalled();
  });

  it("stores a file in the selected source and reports a missing embedding provider accurately", async () => {
    const result = await uploadFileAction(null, upload());
    expect(mocks.addDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sourceId: "source-a", kind: "file", title: "hours", content: "Extracted knowledge text" }));
    expect(result).toMatchObject({ sourceId: "source-a", ok: expect.stringContaining("Configure an embedding provider") });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/chatbots/bot-a");
  });

  it("creates a chatbot source only after successful extraction", async () => {
    await uploadFileAction(null, upload({ chatbotId: "bot-a", sourceName: "Manuals" }));
    expect(mocks.createKnowledgeSource).toHaveBeenCalledWith(expect.anything(), { chatbotId: "bot-a", name: "Manuals" });
    expect(mocks.addDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sourceId: "new-source" }));
    expect(mocks.extractText.mock.invocationCallOrder[0]).toBeLessThan(mocks.createKnowledgeSource.mock.invocationCallOrder[0]!);
  });

  it("does not create a source when extraction fails", async () => {
    const { ExtractionError } = await import("@chatbot/rag-engine");
    mocks.extractText.mockRejectedValue(new ExtractionError("Not a valid PDF file"));
    expect(await uploadFileAction(null, upload({ chatbotId: "bot-a" }))).toMatchObject({ error: "Not a valid PDF file" });
    expect(mocks.createKnowledgeSource).not.toHaveBeenCalled();
  });

  it("validates size, type and empty files before extraction", async () => {
    for (const file of [new File([], "empty.txt"), new File(["exe"], "bad.exe"), new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.pdf")]) {
      const fd = upload(); fd.set("file", file);
      expect(await uploadFileAction(null, fd)).toHaveProperty("error");
    }
    expect(mocks.extractText).not.toHaveBeenCalled();
  });
});
