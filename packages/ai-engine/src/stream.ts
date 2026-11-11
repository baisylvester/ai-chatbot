import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AIMessageChunk, BaseMessage } from "@langchain/core/messages";

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

export type EngineEvent =
  | { type: "start"; provider: string; model: string }
  | { type: "token"; text: string }
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

/**
 * Streams a reply from the first candidate that works. A candidate that fails before producing any
 * text is skipped and the next one is tried (fallback). Once text has been streamed, a failure ends
 * the reply with an "interrupted" error, because switching models mid-answer would garble it.
 * Retries for transient errors happen inside each model (maxRetries).
 */
export async function* streamReply(params: {
  candidates: ModelCandidate[];
  messages: BaseMessage[];
  signal?: AbortSignal;
}): AsyncGenerator<EngineEvent> {
  const failedAttempts: AttemptFailure[] = [];
  const started = Date.now();

  for (const candidate of params.candidates) {
    const { provider, model } = candidate;
    let chat: BaseChatModel;
    try {
      chat = candidate.create();
    } catch (err) {
      failedAttempts.push({ provider, model, error: errorMessage(err) });
      continue;
    }

    let text = "";
    let emittedStart = false;
    let aggregate: AIMessageChunk | undefined;
    try {
      const stream = await chat.stream(params.messages, { signal: params.signal });
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
      if (!emittedStart) yield { type: "start", provider, model };
      const u = aggregate?.usage_metadata;
      yield {
        type: "done",
        text,
        provider,
        model,
        usage: u ? { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 } : null,
        latencyMs: Date.now() - started,
        failedAttempts,
      };
      return;
    } catch (err) {
      if (params.signal?.aborted) {
        yield { type: "error", reason: "cancelled", partialText: text, provider, model, latencyMs: Date.now() - started, failedAttempts };
        return;
      }
      failedAttempts.push({ provider, model, error: errorMessage(err) });
      if (emittedStart) {
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
