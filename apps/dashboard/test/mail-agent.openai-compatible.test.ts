/**
 * Live tool-calling check for the mail agent against a self-hosted OpenAI-compatible server
 * (for example Ollama running qwen3:8b). It goes through the same provider path the dashboard uses
 * (createChatModel with provider "openai-compatible") and the real runMailAgent loop.
 *
 * It is skipped when the server does not answer, so CI without a local model stays green.
 * Override the defaults with QWEN_TEST_BASE_URL and QWEN_TEST_MODEL.
 */
import { describe, expect, it } from "vitest";
import { createChatModel } from "@chatbot/ai-providers";
import { runMailAgent, type MailApi, type MailSummary } from "@chatbot/mail-agent";

const BASE_URL = process.env.QWEN_TEST_BASE_URL?.trim() || "http://localhost:11434/v1";
const MODEL = process.env.QWEN_TEST_MODEL?.trim() || "qwen3:8b";

async function serverReachable(baseURL: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseURL.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

const reachable = await serverReachable(BASE_URL);

const summary = (id: string, subject: string, from: string): MailSummary => ({
  id, threadId: `t${id}`, from, subject, date: "2026-11-12", snippet: "Please see the attached invoice.", unread: true, starred: false,
});

function recordingMail(): MailApi & { calls: string[] } {
  const calls: string[] = [];
  const inbox = [summary("m1", "Invoice INV-2041 due Friday", "Ana Cruz <ana@example.com>")];
  return {
    calls,
    async search(query) { calls.push(`search:${query}`); return inbox; },
    async read(id) { calls.push(`read:${id}`); return { ...inbox[0]!, to: "me@example.com", body: "Invoice INV-2041 is due Friday.", truncated: false }; },
    async createDraft(input) { calls.push(`draft:${input.to}`); return { draftId: "d1", to: input.to, subject: input.subject }; },
    async organize(ids, action) { calls.push(`${action}:${ids.join(",")}`); },
  };
}

// When the server is unreachable the whole suite is reported as skipped (not failed).
describe.runIf(reachable)("mail agent over openai-compatible (live local server)", () => {
  it("makes a tool call, gets the tool result back, and answers", async () => {
    // Same settings as the chat action (agentModel(4096) in the dashboard). Qwen3 thinks before it
    // calls a tool, and with a 1024-token limit the thinking alone sometimes uses the whole budget.
    const model = createChatModel(
      { provider: "openai-compatible", model: MODEL, temperature: 0.2, maxOutputTokens: 4096 },
      { OPENAI_COMPATIBLE_BASE_URL: BASE_URL },
    );
    const mail = recordingMail();
    const queued: string[] = [];

    const result = await runMailAgent(
      {
        model,
        mail,
        userEmail: "owner@example.com",
        now: new Date("2026-11-13T00:00:00Z"),
        queueAction: async (kind, text) => { queued.push(`${kind}:${text}`); },
      },
      [{ role: "user", content: "Find the latest email from Ana Cruz and tell me what it needs." }],
      4,
    );

    // The model must have used the mailbox tools rather than guessing.
    const debug = JSON.stringify({ steps: result.steps, reply: result.reply, calls: mail.calls });
    expect(mail.calls.some((call) => call.startsWith("search:")), debug).toBe(true);
    expect(result.steps.some((step) => step.tool === "search_mail"), debug).toBe(true);
    // The tool ran and its output went back to the model, which produced a final text answer.
    expect(result.reply.trim().length, debug).toBeGreaterThan(0);
    expect(result.reply, debug).not.toBe("I stopped after several steps without finishing. The steps I took are listed; ask me to continue if you want more.");
    // Nothing is sent or trashed without approval.
    expect(queued).toEqual([]);
  }, 300_000);
});
