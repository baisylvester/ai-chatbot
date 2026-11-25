import { describe, expect, it, vi } from "vitest";
import { GmailClient, hideInternalMessageIds, scopedMailQuery, mailTools } from "../src/index.ts";

describe("native mailbox browsing", () => {
  it("passes opaque cursors and folder scope to Gmail without returning unsafe ids", async () => {
    const seen: URL[] = [];
    const fetcher = vi.fn(async (url: string) => {
      seen.push(new URL(url));
      return Response.json({ messages: [{ id: "../unsafe" }], nextPageToken: "next+/=" });
    });
    const client = new GmailClient("token", fetcher as unknown as typeof fetch);
    expect(await client.listPage("in:trash", "page+/=")).toEqual({ messages: [], nextCursor: "next+/=" });
    expect(seen[0]!.searchParams.get("pageToken")).toBe("page+/=");
    expect(seen[0]!.searchParams.get("maxResults")).toBe("20");
    expect(seen[0]!.searchParams.get("includeSpamTrash")).toBe("true");
  });
  it("returns an empty last page without issuing a metadata batch", async () => {
    const fetcher = vi.fn(async () => Response.json({}));
    expect(await new GmailClient("token", fetcher as typeof fetch).listPage("in:inbox")).toEqual({ messages: [], nextCursor: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("moves spam back to Inbox by removing the spam label", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({}));
    await new GmailClient("token", fetcher as typeof fetch).organize(["m1"], "mark_spam");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ ids: ["m1"], addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] });
  });
});

describe("mail agent presentation", () => {
  it("groups OR searches inside Inbox and preserves explicit folders", () => {
    expect(scopedMailQuery("from:ana OR subject:invoice")).toBe("in:inbox (from:ana OR subject:invoice)");
    expect(scopedMailQuery("in:sent subject:invoice")).toBe("in:sent subject:invoice");
    expect(scopedMailQuery("in:anywhere subject:invoice")).toBe("in:anywhere subject:invoice");
    expect(scopedMailQuery("-in:inbox subject:invoice")).toBe("-in:inbox subject:invoice");
  });
  it("removes model ID annotations without changing message facts", () => {
    expect(hideInternalMessageIds("Invoice 2026 (message ID m2) is due Nov 19.")).toBe("Invoice 2026 is due Nov 19.");
    expect(hideInternalMessageIds("Message ID: abcdef123 needs your reply.")).toBe("the message needs your reply.");
    expect(hideInternalMessageIds("**Ready for review.** [Approve] [Cancel]")).toBe("Ready for review.");
  });
  it("derives reply recipients from Gmail instead of a model-generated recipient", async () => {
    const createDraft=vi.fn(async () => ({draftId:"d1",to:"sender@example.test",subject:"Re: Hello"}));
    const draftTool=mailTools.find(t=>t.name==="draft_email")!;
    await draftTool.run({to:"wrong@example.test",subject:"",body:"Thanks",replyToMessageId:"m1"},{mail:{createDraft},queueAction:vi.fn()} as any);
    expect(createDraft).toHaveBeenCalledWith(expect.objectContaining({to:"",replyToMessageId:"m1"}));
  });
});
