import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ToolMessage, type AIMessageChunk, type BaseMessage } from "@langchain/core/messages";

/** A model to try. `create` is lazy so a misconfigured provider counts as a failed attempt, not a crash. */
export interface ModelCandidate {
  provider: string;
  model: string;
  create: () => BaseChatModel;
}

export interface AttemptFailure {
  provider: string;
  model: string;
  error: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** What a tool hands back: `content` goes to the model, the rest is shown to the person chatting. */
export interface ToolOutcome {
  content: string;
  /** Short lines describing what was done, for the chat's activity list. */
  steps?: string[];
  /** Actions now waiting for the person's approval elsewhere in the app. */
  waiting?: number;
}

/** Something the model may call while answering. Callers decide who gets which tools. */
export interface EngineTool {
  name: string;
  description: string;
  /** A zod schema or JSON schema for the arguments, passed to the model as is. */
  schema: unknown;
  run(args: unknown, signal?: AbortSignal): Promise<ToolOutcome>;
}

export type EngineEvent =
  | { type: "start"; provider: string; model: string }
  | { type: "token"; text: string }
  | { type: "tool"; name: string; phase: "start" }
  | { type: "tool"; name: string; phase: "end"; steps: string[]; waiting: number; failed: boolean }
  | {
      type: "done";
      text: string;
      provider: string;
      model: string;
      usage: Usage | null;
      latencyMs: number;
      failedAttempts: AttemptFailure[];
    }
  | {
      type: "error";
      /** "unavailable": every candidate failed before replying. "interrupted": failed mid-reply. "cancelled": aborted. */
      reason: "unavailable" | "interrupted" | "cancelled";
      partialText: string;
      provider: string | null;
      model: string | null;
      latencyMs: number;
      failedAttempts: AttemptFailure[];
    };

function chunkText(chunk: AIMessageChunk): string {
  const c = chunk.content;
  if (typeof c === "string") return c;
  return c
    .map((part) => (typeof part === "string" ? part : part.type === "text" && "text" in part ? String(part.text) : ""))
    .join("");
}

function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}

/** Tool rounds per reply. After them the model runs without tools, so it has to answer in words. */
const MAX_TOOL_ROUNDS = 3;
const MAX_TOOL_RESULT_CHARS = 12_000;

/**
 * Streams a reply from the first candidate that works. A candidate that fails before producing any
 * text is skipped and the next one is tried (fallback). Once text has been streamed or a tool has
 * run, a failure ends the reply with an "interrupted" error, because switching models mid-answer
 * would garble it (and could repeat what a tool already did).
 * Retries for transient errors happen inside each model (maxRetries).
 *
 * With `tools`, the model may call them between pieces of text: each call is run, its result goes
 * back to the model, and the reply continues. Without `tools` nothing changes.
 */
export async function* streamReply(params: {
  candidates: ModelCandidate[];
  messages: BaseMessage[];
  signal?: AbortSignal;
  tools?: EngineTool[];
}): AsyncGenerator<EngineEvent> {
  const failedAttempts: AttemptFailure[] = [];
  const started = Date.now();
  const tools = params.tools ?? [];

  for (const candidate of params.candidates) {
    const { provider, model } = candidate;
    let chat: BaseChatModel;
    let withTools: Pick<BaseChatModel, "stream"> | null = null;
    try {
      chat = candidate.create();
      if (tools.length) {
        if (!chat.bindTools) throw new Error("This model does not support tools");
        withTools = chat.bindTools(tools.map(({ name, description, schema }) => ({ name, description, schema }))) as Pick<BaseChatModel, "stream">;
      }
    } catch (err) {
      failedAttempts.push({ provider, model, error: errorMessage(err) });
      continue;
    }

    let text = "";
    let emittedStart = false;
    let toolRan = false;
    let usage: Usage | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    const messages = [...params.messages];
    try {
      for (let round = 0; ; round++) {
        const offered = withTools !== null && round < MAX_TOOL_ROUNDS;
        const runner = offered && withTools ? withTools : chat;
        let aggregate: AIMessageChunk | undefined;
        const stream = await runner.stream(messages, { signal: params.signal });
        for await (const chunk of stream) {
          aggregate = aggregate ? aggregate.concat(chunk) : chunk;
          const piece = chunkText(chunk);
          if (!piece) continue;
          if (!emittedStart) {
            emittedStart = true;
            yield { type: "start", provider, model };
          }
          text += piece;
          yield { type: "token", text: piece };
        }
        const u = aggregate?.usage_metadata;
        if (u) {
          // Summed over every round of the reply.
          inputTokens += u.input_tokens ?? 0;
          outputTokens += u.output_tokens ?? 0;
          usage = { inputTokens, outputTokens };
        }

        const calls = offered ? aggregate?.tool_calls ?? [] : [];
        if (!aggregate || !calls.length) break;

        if (!emittedStart) {
          emittedStart = true;
          yield { type: "start", provider, model };
        }
        messages.push(aggregate);
        for (const call of calls) {
          const tool = tools.find((item) => item.name === call.name);
          yield { type: "tool", name: call.name, phase: "start" };
          toolRan = true;
          let outcome: ToolOutcome;
          let failed = false;
          try {
            if (!tool) throw new Error(`Unknown tool ${call.name}`);
            outcome = await tool.run(call.args, params.signal);
          } catch (err) {
            if (params.signal?.aborted) throw err;
            failed = true;
            outcome = { content: JSON.stringify({ error: errorMessage(err) }) };
          }
          yield { type: "tool", name: call.name, phase: "end", steps: outcome.steps ?? [], waiting: outcome.waiting ?? 0, failed };
          messages.push(new ToolMessage({ content: outcome.content.slice(0, MAX_TOOL_RESULT_CHARS), tool_call_id: call.id ?? call.name, name: call.name }));
        }
        // Words before and after a tool call are separate paragraphs.
        if (text && !text.endsWith("\n")) {
          text += "\n\n";
          yield { type: "token", text: "\n\n" };
        }
      }
      if (!emittedStart) yield { type: "start", provider, model };
      yield { type: "done", text: text.trimEnd(), provider, model, usage, latencyMs: Date.now() - started, failedAttempts };
      return;
    } catch (err) {
      if (params.signal?.aborted) {
        yield { type: "error", reason: "cancelled", partialText: text, provider, model, latencyMs: Date.now() - started, failedAttempts };
        return;
      }
      failedAttempts.push({ provider, model, error: errorMessage(err) });
      if (emittedStart || toolRan) {
        yield { type: "error", reason: "interrupted", partialText: text, provider, model, latencyMs: Date.now() - started, failedAttempts };
        return;
      }
    }
  }

  yield {
    type: "error",
    reason: "unavailable",
    partialText: "",
    provider: null,
    model: null,
    latencyMs: Date.now() - started,
    failedAttempts,
  };
}
