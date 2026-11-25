import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ bot: vi.fn(), state: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/client-api", () => ({ clientBot: mocks.bot, clientTrusted: (fn: (db: object) => unknown) => fn({}) }));
vi.mock("@chatbot/core", async original => ({ ...await original<typeof import("@chatbot/core")>(), knowledgeStateForChatbot: mocks.state }));
import { clientKnowledgeState, knowledgeChatbotForClient, sharedKnowledgeChatbot } from "../src/lib/native-knowledge";
import { DomainError } from "@chatbot/core";
const request = new Request("https://platform.test/api/v1/client/chatbots/cb_personal");
const personal = { id: "personal", public_id: "cb_personal", organization_id: "private-org", nativePersonalAssistant: true, settings: { name: "My assistant" } } as Parameters<typeof knowledgeChatbotForClient>[2];
const source = { id: "source", public_id: "cb_shared", organization_id: "published-org", nativePersonalAssistant: false, settings: { name: "Published assistant" } } as typeof personal;
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("NATIVE_KNOWLEDGE_CHATBOT_ID", "cb_shared"); mocks.bot.mockResolvedValue(source);
  mocks.state.mockResolvedValue({sourceCount:1,readyDocuments:1,processingDocuments:0,failedDocuments:0,chunks:3,updatedAt:"2026-11-20T00:00:00.000Z"});
});
afterEach(() => vi.unstubAllEnvs());
it("links a private assistant to the configured published chatbot using the existing access checks", async () => {
  expect(await knowledgeChatbotForClient(request,"owner",personal)).toBe(source);
  expect(mocks.bot).toHaveBeenCalledWith(request,"cb_shared",true,"owner");
});
it("keeps published chatbot retrieval scoped to its own assignments", async () => {
  expect(await knowledgeChatbotForClient(request,"visitor",source)).toBe(source);
  expect(mocks.bot).not.toHaveBeenCalled();
});
it("retains personal knowledge when no shared source is configured", async () => {
  vi.stubEnv("NATIVE_KNOWLEDGE_CHATBOT_ID", "");
  expect(await knowledgeChatbotForClient(request,"owner",personal)).toBe(personal);
  expect(await sharedKnowledgeChatbot(request,"owner")).toBeNull();
  expect(mocks.bot).not.toHaveBeenCalled();
});
it("refuses to publish any private native assistant as shared knowledge", async () => {
  mocks.bot.mockResolvedValue(personal);
  await expect(knowledgeChatbotForClient(request,"owner",personal)).rejects.toMatchObject({reason:"knowledge_unavailable"});
});
it("fails closed when a source is inactive, missing or denied", async () => {
  mocks.bot.mockRejectedValue(new DomainError("not_found","not found"));
  await expect(knowledgeChatbotForClient(request,"owner",personal)).rejects.toMatchObject({reason:"knowledge_unavailable"});
  expect(await clientKnowledgeState(request,"owner",personal)).toEqual({state:"unavailable"});
});
it("reads fresh metadata and notices processed additions and removals without a cached copy", async () => {
  const first=await clientKnowledgeState(request,"owner",personal);
  expect(first).toMatchObject({state:"ready",sourceChatbotId:"cb_shared",sourceName:"Published assistant",shared:true,readyDocuments:1,chunks:3});
  mocks.state.mockResolvedValue({sourceCount:0,readyDocuments:0,processingDocuments:0,failedDocuments:0,chunks:0,updatedAt:null});
  expect(await clientKnowledgeState(request,"owner",personal)).toMatchObject({state:"empty",readyDocuments:0,chunks:0});
  expect(mocks.state).toHaveBeenCalledTimes(2);expect(mocks.state).toHaveBeenCalledWith({},source);
});
