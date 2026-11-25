import { createHash } from "node:crypto";
import type { DbClient } from "@chatbot/database";
import type { ClientConversation, ClientConversationPage, ClientMessage, ClientMessagePage, ClientTurn, ClientStreamEvent } from "@chatbot/shared";
import { z } from "zod";
import { DomainError, notFound } from "./errors.ts";
import { MAX_USER_MESSAGE_CHARS, runConversationTurn } from "./conversation.ts";
import type { Chatbot } from "./services.ts";

interface ConversationRow {
  id: string; chatbotId: string; title: string; createdAt: Date; updatedAt: Date; revision: string; cursorCreatedAt: string;
  turn: { requestId: string; status: ClientTurn["status"]; result: ClientTurn | null; expired: boolean } | null;
}
const projection = `s.id, c.public_id as "chatbotId", s.title, s.created_at as "createdAt",
  s.updated_at as "updatedAt", s.revision::text,
  to_char(s.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorCreatedAt",
  (select json_build_object('requestId', t.request_id, 'status', t.status, 'result', t.result,
    'expired', t.lease_expires_at <= now()) from client_turns t
    where t.chat_session_id = s.id order by t.created_at desc, t.id desc limit 1) as turn`;

function view(row: ConversationRow): ClientConversation {
  const t = row.turn;
  const lastTurn: ClientTurn | null = !t ? null : t.result ?? {
    requestId: t.requestId,
    status: t.status === "running" && t.expired ? "interrupted" : t.status,
    text: "", citations: [],
    error: t.status === "running" && !t.expired ? null : "The reply was interrupted. Start a new message to continue.",
  };
  return { id: row.id, chatbotId: row.chatbotId, title: row.title, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), revision: row.revision, lastTurn };
}

/** Trusted context. Always checks the owner as well as the source; UUID knowledge grants no access. */
export async function getClientConversation(db: DbClient, userId: string, conversationId: string): Promise<ClientConversation> {
  if (!z.uuid().safeParse(conversationId).success) throw notFound("Conversation");
  const row = (await db.query<ConversationRow>(`select ${projection} from chat_sessions s join chatbots c on c.id = s.chatbot_id
    where s.id = $1 and s.owner_user_id = $2 and s.source = 'client'`, [conversationId, userId])).rows[0];
  if (!row) throw notFound("Conversation");
  return view(row);
}

/** The client supplies an idempotent UUID, so retrying creation cannot create another conversation. */
export async function createClientConversation(db: DbClient, userId: string, bot: Chatbot, id: string): Promise<ClientConversation> {
  if (!z.uuid().safeParse(id).success) throw new DomainError("invalid", "A conversation UUID is required");
  await db.query(`insert into chat_sessions (id, organization_id, chatbot_id, source, created_by, owner_user_id, expires_at)
    values ($1, $2, $3, 'client', $4, $4, null) on conflict (id) do nothing`, [id, bot.organization_id, bot.id, userId]);
  const result = await getClientConversation(db, userId, id);
  if (result.chatbotId !== bot.public_id) throw notFound("Conversation");
  return result;
}

export async function listClientConversations(db: DbClient, userId: string, bot: Chatbot, before?: string): Promise<ClientConversationPage> {
  let stamp: string | null = null;
  let id: string | null = null;
  if (before) {
    const parsed = z.tuple([z.iso.datetime(), z.uuid()]).safeParse(before.split("|"));
    if (!parsed.success) throw new DomainError("invalid", "Invalid conversation cursor");
    [stamp, id] = parsed.data;
  }
  const rows = (await db.query<ConversationRow>(`select ${projection} from chat_sessions s join chatbots c on c.id = s.chatbot_id
    where s.owner_user_id = $1 and s.chatbot_id = $2 and s.organization_id = $3 and s.source = 'client'
      and ($4::timestamptz is null or (s.created_at, s.id) < ($4::timestamptz, $5::uuid))
    order by s.created_at desc, s.id desc limit 51`, [userId, bot.id, bot.organization_id, stamp, id])).rows;
  const conversations = rows.slice(0, 50).map(view);
  const last = rows[49];
  // Preserve PostgreSQL microseconds; JS Date would truncate the keyset boundary and skip rows.
  return { conversations, nextCursor: rows.length > 50 && last ? `${last.cursorCreatedAt}|${last.id}` : null };
}

export async function listClientMessages(db: DbClient, userId: string, id: string, after = "0"): Promise<ClientMessagePage> {
  if (!/^\d{1,19}$/.test(after) || BigInt(after) > 9223372036854775807n) throw new DomainError("invalid", "Invalid message cursor");
  const conversation = await getClientConversation(db, userId, id);
  if (BigInt(after) > BigInt(conversation.revision)) throw new DomainError("invalid", "Message cursor is ahead of the conversation");
  const rows = (await db.query<Omit<ClientMessage, "createdAt"> & { createdAt: Date }>(`
    select m.id, m.role, m.content as text, m.citations, m.sequence::text, m.created_at as "createdAt",
      t.request_id as "requestId", case when t.status = 'running' and t.lease_expires_at <= now()
        then 'interrupted' else coalesce(t.status, 'completed') end as status
    from messages m join chat_sessions s on s.id = m.chat_session_id left join client_turns t on t.id = m.turn_id
    where s.id = $1 and s.owner_user_id = $2 and s.source = 'client' and m.organization_id = s.organization_id
      and m.role in ('user', 'assistant') and m.sequence > $3::bigint and m.sequence <= $4::bigint
    order by m.sequence limit 101`, [id, userId, after, conversation.revision])).rows;
  const messages = rows.slice(0, 100).map(row => ({ ...row, createdAt: row.createdAt.toISOString() }));
  return { conversation, messages, nextCursor: messages.at(-1)?.sequence ?? after, hasMore: rows.length > 100 };
}

export async function deleteClientConversation(db: DbClient, userId: string, id: string): Promise<void> {
  await getClientConversation(db, userId, id);
  await db.query("delete from chat_sessions where id = $1 and owner_user_id = $2 and source = 'client'", [id, userId]);
}

export async function recoverClientTurns(db: DbClient): Promise<number> {
  return (await db.query("update client_turns set status = 'interrupted' where status = 'running' and lease_expires_at <= now()")).rowCount ?? 0;
}

interface TurnClaim { id: string; result: ClientTurn | null }
export async function claimClientTurn(db: DbClient, userId: string, conversationId: string, requestId: string, message: string, emailManager: boolean): Promise<TurnClaim> {
  const owned = await db.query("select id from chat_sessions where id = $1 and owner_user_id = $2 and source = 'client' for update", [conversationId, userId]);
  if (!owned.rowCount) throw notFound("Conversation");
  const hash = createHash("sha256").update(JSON.stringify({ message, emailManager })).digest("hex");
  await db.query("update client_turns set status = 'interrupted' where chat_session_id = $1 and status = 'running' and lease_expires_at <= now()", [conversationId]);
  const existing = (await db.query<{ id: string; request_hash: string; status: ClientTurn["status"]; result: ClientTurn | null }>(
    "select id, request_hash, status, result from client_turns where chat_session_id = $1 and request_id = $2", [conversationId, requestId])).rows[0];
  if (existing) {
    if (existing.request_hash !== hash) throw new DomainError("conflict", "This request ID was already used for another message", "request_mismatch");
    if (existing.status === "running") throw new DomainError("conflict", "This reply is still running. Refresh the conversation before retrying.", "request_running");
    return { id: existing.id, result: existing.result ?? { requestId, status: existing.status, text: "", citations: [], error: "The reply was interrupted. Start a new message to continue." } };
  }
  if ((await db.query("select 1 from client_turns where chat_session_id = $1 and status = 'running'", [conversationId])).rowCount) {
    throw new DomainError("conflict", "Another reply is running in this conversation. Wait for it to finish.", "conversation_busy");
  }
  const row = (await db.query<{ id: string }>(`insert into client_turns (organization_id, chat_session_id, request_id, request_hash)
    select organization_id, id, $2, $3 from chat_sessions where id = $1 returning id`, [conversationId, requestId, hash])).rows[0]!;
  await db.query("update chat_sessions set title = case when revision = 0 then $2 else title end, updated_at = clock_timestamp() where id = $1", [conversationId, message.slice(0, 120)]);
  return { id: row.id, result: null };
}

/** No DB connection is held during generation. A short transactional claim serializes devices. */
export async function* runClientConversationTurn(params: Omit<Parameters<typeof runConversationTurn>[0], "source" | "createdBy" | "ownerUserId" | "turnId" | "beforeWrite" | "afterPersist"> & {
  userId: string; sessionId: string; requestId: string; emailManager?: boolean;
}): AsyncGenerator<ClientStreamEvent> {
  const message = params.message.trim();
  if (!message || message.length > MAX_USER_MESSAGE_CHARS || !z.uuid().safeParse(params.requestId).success) throw new DomainError("invalid", "A request UUID and message of 1–4000 characters are required");
  await params.trusted(db => getClientConversation(db, params.userId, params.sessionId));
  const claim = await params.trusted(db => claimClientTurn(db, params.userId, params.sessionId, params.requestId, message, !!params.emailManager));
  if (claim.result) { yield { type: "done", turn: claim.result }; return; }
  const assertLease = async (db: DbClient) => {
    const session = await db.query("select id from chat_sessions where id = $1 and owner_user_id = $2 and source = 'client' for update", [params.sessionId, params.userId]);
    if (!session.rowCount) throw notFound("Conversation");
    const lease = await db.query("select id from client_turns where id = $1 and chat_session_id = $2 and status = 'running' and lease_expires_at > now() for update", [claim.id, params.sessionId]);
    if (!lease.rowCount) throw new DomainError("conflict", "This reply was interrupted. Refresh the conversation.", "lease_lost");
  };
  let persisted: ClientTurn | null = null;
  try {
    yield { type: "accepted", requestId: params.requestId };
    for await (const event of runConversationTurn({
      ...params, message, source: "client", createdBy: params.userId, ownerUserId: params.userId, turnId: claim.id,
      beforeWrite: assertLease,
      afterPersist: async (db, result, citations) => {
        persisted = {
          requestId: params.requestId, status: result.type === "done" ? "completed" : "failed",
          text: (result.type === "done" ? result.text : result.partialText).slice(0, 20000), citations,
          error: result.type === "done" ? null : "The reply could not finish. You can send a new message to continue.",
        };
        await db.query("update client_turns set status = $2, result = $3 where id = $1", [claim.id, persisted.status, JSON.stringify(persisted)]);
      },
    })) {
      if (event.type === "token" || event.type === "sources" || event.type === "tool") yield event;
      else if ((event.type === "done" || event.type === "error") && persisted) yield { type: "done", turn: persisted };
    }
  } finally {
    // A cancelled consumer or crashed provider must not leave an unbounded lock. If the process
    // itself dies, the lease and maintenance recover it without replaying possible side effects.
    await params.trusted(db => db.query("update client_turns set status = 'interrupted' where id = $1 and status = 'running'", [claim.id])).catch(() => undefined);
  }
}
