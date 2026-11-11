/**
 * One conversation turn: load history, stream a reply with fallback, persist messages and usage.
 * Shared by the dashboard playground now and the public widget/REST API later, so the flow lives here once.
 *
 * Database work happens in short trusted transactions (`trusted`) before and after streaming; no
 * transaction is held open while the model is generating. Callers must have already authorised access
 * to `chatbot` (e.g. loaded it in the user's RLS context, or resolved it from a validated embed session).
 */
import type { DbClient } from "@chatbot/database";
import { buildMessages, streamReply, type EngineEvent, type HistoryMessage, type ModelCandidate } from "@chatbot/ai-engine";
import { createChatModel, type ProviderEnv } from "@chatbot/ai-providers";
import type { ChatbotSettings } from "@chatbot/shared";
import { z } from "zod";
import { DomainError, notFound } from "./errors.ts";
import { formatContext, toCitations, type Citation, type RetrievedChunk } from "./knowledge.ts";
import type { Chatbot } from "./services.ts";

export const MAX_USER_MESSAGE_CHARS = 4000;
const HISTORY_TURNS = 20;

export type SessionSource = "widget" | "api" | "playground";
export type TrustedRunner = <T>(fn: (db: DbClient) => Promise<T>) => Promise<T>;

export type TurnEvent =
  | { type: "session"; sessionId: string }
  | { type: "sources"; citations: Citation[] }
  | EngineEvent;

/** Primary model first, then configured fallbacks; duplicates removed. */
export function modelCandidates(settings: ChatbotSettings, env: ProviderEnv): ModelCandidate[] {
  const refs = [{ provider: settings.provider, model: settings.model }, ...settings.fallbacks];
  const seen = new Set<string>();
  return refs
    .filter((r) => {
      const key = `${r.provider}:${r.model}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((r) => ({
      provider: r.provider,
      model: r.model,
      create: () =>
        createChatModel(
          {
            provider: r.provider,
            model: r.model,
            temperature: settings.temperature,
            maxOutputTokens: settings.maxOutputTokens,
          },
          env,
        ),
    }));
}

async function openSession(
  db: DbClient,
  chatbot: Chatbot,
  opts: { sessionId?: string; source: SessionSource; createdBy?: string; origin?: string },
): Promise<{ sessionId: string; history: HistoryMessage[] }> {
  if (opts.sessionId) {
    const id = z.uuid().safeParse(opts.sessionId);
    if (!id.success) throw notFound("Conversation");
    // Scoped by chatbot and organization: a session id from another chatbot or tenant is "not found".
    const session = (
      await db.query<{ id: string }>(
        `select id from chat_sessions
         where id = $1 and chatbot_id = $2 and organization_id = $3 and source = $4 and expires_at > now()`,
        [id.data, chatbot.id, chatbot.organization_id, opts.source],
      )
    ).rows[0];
    if (!session) throw notFound("Conversation");
    const rows = (
      await db.query<HistoryMessage>(
        `select role, content from (
           select role, content, created_at from messages
           where chat_session_id = $1 and organization_id = $2 and role in ('user', 'assistant')
           order by created_at desc limit $3
         ) recent order by created_at`,
        [session.id, chatbot.organization_id, HISTORY_TURNS * 2],
      )
    ).rows;
    return { sessionId: session.id, history: rows };
  }
  const created = (
    await db.query<{ id: string }>(
      `insert into chat_sessions (organization_id, chatbot_id, source, created_by, origin)
       values ($1, $2, $3, $4, $5) returning id`,
      [chatbot.organization_id, chatbot.id, opts.source, opts.createdBy ?? null, opts.origin ?? null],
    )
  ).rows[0]!;
  return { sessionId: created.id, history: [] };
}

export async function* runConversationTurn(params: {
  trusted: TrustedRunner;
  chatbot: Chatbot;
  message: string;
  sessionId?: string;
  source: SessionSource;
  createdBy?: string;
  origin?: string;
  env: ProviderEnv;
  signal?: AbortSignal;
  /** Knowledge retrieval for this chatbot (already tenant-scoped by the caller). Errors are logged and skipped. */
  retrieve?: (query: string) => Promise<RetrievedChunk[]>;
  /** For tests: replaces the model list built from settings. */
  candidates?: ModelCandidate[];
}): AsyncGenerator<TurnEvent> {
  const message = params.message.trim();
  if (!message) throw new DomainError("invalid", "Type a message first");
  if (message.length > MAX_USER_MESSAGE_CHARS) {
    throw new DomainError("invalid", `Messages can be at most ${MAX_USER_MESSAGE_CHARS} characters`);
  }
  const { chatbot } = params;

  const { sessionId, history } = await params.trusted(async (db) => {
    const s = await openSession(db, chatbot, params);
    await db.query(
      "insert into messages (organization_id, chat_session_id, role, content) values ($1, $2, 'user', $3)",
      [chatbot.organization_id, s.sessionId, message],
    );
    return s;
  });
  yield { type: "session", sessionId };

  let chunks: RetrievedChunk[] = [];
  if (params.retrieve) {
    try {
      chunks = await params.retrieve(message);
    } catch (err) {
      console.error("knowledge retrieval failed; answering without it", err);
    }
  }
  const citations = toCitations(chunks);
  if (citations.length) yield { type: "sources", citations };

  const messages = buildMessages({
    systemPrompt: chatbot.settings.systemPrompt,
    history,
    userMessage: message,
    context: chunks.length ? formatContext(chunks.map((c) => ({ title: c.title, content: c.content }))) : undefined,
  });
  const candidates = params.candidates ?? modelCandidates(chatbot.settings, params.env);

  let final: EngineEvent | undefined;
  for await (const event of streamReply({ candidates, messages, signal: params.signal })) {
    if (event.type === "done" || event.type === "error") final = event;
    yield event;
  }
  if (!final || (final.type !== "done" && final.type !== "error")) return;
  const result = final;

  // Persist even if the client has gone away; usage must be recorded for billing and analytics.
  await params.trusted(async (db) => {
    const text = result.type === "done" ? result.text : result.partialText;
    if (text) {
      await db.query(
        `insert into messages (organization_id, chat_session_id, role, content, provider, model, citations)
         values ($1, $2, 'assistant', $3, $4, $5, $6)`,
        [chatbot.organization_id, sessionId, text.slice(0, 20000), result.provider, result.model, JSON.stringify(citations)],
      );
    }
    for (const failure of result.failedAttempts) {
      await db.query(
        `insert into usage_records (organization_id, chatbot_id, chat_session_id, source, provider, model, status, error)
         values ($1, $2, $3, $4, $5, $6, 'error', $7)`,
        [chatbot.organization_id, chatbot.id, sessionId, params.source, failure.provider, failure.model, failure.error],
      );
    }
    if (result.provider && result.model) {
      const usage = result.type === "done" ? result.usage : null;
      await db.query(
        `insert into usage_records
           (organization_id, chatbot_id, chat_session_id, source, provider, model, prompt_tokens, completion_tokens, status, latency_ms)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          chatbot.organization_id,
          chatbot.id,
          sessionId,
          params.source,
          result.provider,
          result.model,
          usage?.inputTokens ?? 0,
          usage?.outputTokens ?? 0,
          result.type === "done" ? "ok" : result.reason,
          result.latencyMs,
        ],
      );
    }
  });
}

/** Recent messages of a session the caller is allowed to see (RLS context: members of the organization). */
export async function listSessionMessages(db: DbClient, sessionId: string) {
  const id = z.uuid().safeParse(sessionId);
  if (!id.success) throw notFound("Conversation");
  return (
    await db.query<{ role: "user" | "assistant"; content: string; provider: string | null; model: string | null; created_at: Date }>(
      "select role, content, provider, model, created_at from messages where chat_session_id = $1 order by created_at",
      [id.data],
    )
  ).rows;
}
