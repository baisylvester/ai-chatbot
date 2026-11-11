/**
 * Organization analytics, conversation history and retention.
 * Read functions take an RLS client (members of the organization only) and still filter by
 * organization explicitly. Destructive functions verify the caller is an owner/admin.
 */
import type { DbClient } from "@chatbot/database";
import { estimateCost } from "@chatbot/shared";
import { z } from "zod";
import { DomainError, notFound } from "./errors.ts";
import { getOrganization } from "./services.ts";

const uuid = z.uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export interface AnalyticsFilters {
  organizationId: string;
  /** Inclusive, YYYY-MM-DD (UTC). */
  from: string;
  /** Inclusive, YYYY-MM-DD (UTC). */
  to: string;
  workspaceId?: string;
  websiteId?: string;
  chatbotId?: string;
  /** Applies to model usage figures (tokens, cost, failures, provider table). */
  provider?: string;
}

function parseFilters(f: AnalyticsFilters) {
  const r = z
    .object({
      organizationId: uuid,
      from: isoDate,
      to: isoDate,
      workspaceId: uuid.optional(),
      websiteId: uuid.optional(),
      chatbotId: uuid.optional(),
      provider: z.string().max(40).optional(),
    })
    .safeParse(f);
  if (!r.success) throw new DomainError("invalid", "Invalid filters");
  const days = (Date.parse(r.data.to) - Date.parse(r.data.from)) / 86_400_000;
  if (days < 0) throw new DomainError("invalid", "The start date must be before the end date");
  if (days > 366) throw new DomainError("invalid", "Choose a range of at most one year");
  return r.data;
}

/** SQL fragment + params selecting the chatbots in scope; $1 = organization, $2 = from, $3 = to (exclusive). */
function scope(f: ReturnType<typeof parseFilters>) {
  const params: unknown[] = [f.organizationId, f.from, new Date(Date.parse(f.to) + 86_400_000).toISOString().slice(0, 10)];
  const conds = ["b.organization_id = $1"];
  if (f.workspaceId) conds.push(`b.workspace_id = $${params.push(f.workspaceId)}`);
  if (f.websiteId) conds.push(`b.website_id = $${params.push(f.websiteId)}`);
  if (f.chatbotId) conds.push(`b.id = $${params.push(f.chatbotId)}`);
  const providerParam = f.provider ? `$${params.push(f.provider)}` : null;
  return { params, bots: `(select b.id from chatbots b where ${conds.join(" and ")})`, providerParam };
}

export interface AnalyticsReport {
  totals: {
    conversations: number;
    messages: number;
    visitorMessages: number;
    uniqueVisitors: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number | null;
    costCoverage: "all" | "partial" | "none";
    modelRequests: number;
    failedRequests: number;
    voiceCallMinutes: number;
    transcribedMinutes: number;
    spokenCharacters: number;
    answersWithSources: number;
    assistantAnswers: number;
    widgetRefusals: number;
  };
  daily: { date: string; conversations: number; messages: number }[];
  bySource: { source: string; conversations: number }[];
  byChatbot: { chatbotId: string; name: string; website: string; conversations: number; messages: number; tokens: number }[];
  byWebsite: { websiteId: string; name: string; conversations: number; messages: number }[];
  byProvider: { provider: string; model: string; requests: number; failed: number; inputTokens: number; outputTokens: number; costUsd: number | null; avgLatencyMs: number | null }[];
  refusals: { type: string; origin: string | null; count: number }[];
}

export async function getAnalytics(db: DbClient, filters: AnalyticsFilters): Promise<AnalyticsReport> {
  const f = parseFilters(filters);
  const { params, bots, providerParam } = scope(f);
  const inRange = (col: string) => `${col} >= $2::date and ${col} < $3::date`;
  const providerCond = providerParam ? `and u.provider = ${providerParam}` : "";
  // Each query receives only the parameters it references (the provider filter is the last one).
  const q = async <T extends Record<string, unknown>>(sql: string) => {
    const used = Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    return (await db.query<T>(sql, params.slice(0, used))).rows;
  };

  const [sessions] = await q<{ conversations: number; visitors: number }>(
    `select count(*)::int as conversations, count(distinct s.visitor_hash)::int as visitors
     from chat_sessions s where s.organization_id = $1 and s.chatbot_id in ${bots} and ${inRange("s.created_at")}`,
  );
  const [msgs] = await q<{ messages: number; visitor_messages: number; assistant: number; with_sources: number }>(
    `select count(*)::int as messages,
       count(*) filter (where m.role = 'user')::int as visitor_messages,
       count(*) filter (where m.role = 'assistant')::int as assistant,
       count(*) filter (where m.role = 'assistant' and jsonb_array_length(m.citations) > 0)::int as with_sources
     from messages m join chat_sessions s on s.id = m.chat_session_id
     where m.organization_id = $1 and s.chatbot_id in ${bots} and ${inRange("m.created_at")}`,
  );
  const providers = await q<{ provider: string; model: string; requests: number; failed: number; input: number; output: number; latency: number | null }>(
    `select u.provider, u.model, count(*)::int as requests,
       count(*) filter (where u.status <> 'ok')::int as failed,
       coalesce(sum(u.prompt_tokens), 0)::int as input, coalesce(sum(u.completion_tokens), 0)::int as output,
       round(avg(u.latency_ms) filter (where u.status = 'ok'))::int as latency
     from usage_records u
     where u.organization_id = $1 and u.kind = 'chat' and u.chatbot_id in ${bots} and ${inRange("u.created_at")} ${providerCond}
     group by u.provider, u.model order by requests desc`,
  );
  const [voice] = await q<{ realtime: number; stt: number; chars: number }>(
    `select coalesce(sum(u.audio_seconds) filter (where u.kind = 'realtime'), 0)::float as realtime,
       coalesce(sum(u.audio_seconds) filter (where u.kind = 'stt'), 0)::float as stt,
       coalesce(sum(u.characters) filter (where u.kind = 'tts'), 0)::int as chars
     from usage_records u
     where u.organization_id = $1 and u.kind <> 'chat' and u.chatbot_id in ${bots} and ${inRange("u.created_at")} ${providerCond}`,
  );
  const daily = await q<{ date: string; conversations: number; messages: number }>(
    `select to_char(d, 'YYYY-MM-DD') as date,
       (select count(*) from chat_sessions s where s.organization_id = $1 and s.chatbot_id in ${bots}
          and s.created_at >= d and s.created_at < d + interval '1 day')::int as conversations,
       (select count(*) from messages m join chat_sessions s on s.id = m.chat_session_id
          where m.organization_id = $1 and s.chatbot_id in ${bots} and m.created_at >= d and m.created_at < d + interval '1 day')::int as messages
     from generate_series($2::date, $3::date - interval '1 day', interval '1 day') d order by d`,
  );
  const bySource = await q<{ source: string; conversations: number }>(
    `select s.source, count(*)::int as conversations from chat_sessions s
     where s.organization_id = $1 and s.chatbot_id in ${bots} and ${inRange("s.created_at")}
     group by s.source order by conversations desc`,
  );
  const byChatbot = await q<{ chatbot_id: string; name: string; website: string; conversations: number; messages: number; tokens: number }>(
    `select b.id as chatbot_id, cs.settings->>'name' as name, w.name as website,
       (select count(*) from chat_sessions s where s.chatbot_id = b.id and ${inRange("s.created_at")})::int as conversations,
       (select count(*) from messages m join chat_sessions s on s.id = m.chat_session_id where s.chatbot_id = b.id and ${inRange("m.created_at")})::int as messages,
       (select coalesce(sum(u.prompt_tokens + u.completion_tokens), 0) from usage_records u
          where u.chatbot_id = b.id and u.kind = 'chat' and ${inRange("u.created_at")} ${providerCond})::int as tokens
     from chatbots b join chatbot_settings cs on cs.chatbot_id = b.id join websites w on w.id = b.website_id
     where b.id in ${bots}
     order by conversations desc, name`,
  );
  const byWebsite = await q<{ website_id: string; name: string; conversations: number; messages: number }>(
    `select w.id as website_id, w.name,
       (select count(*) from chat_sessions s join chatbots b on b.id = s.chatbot_id
          where b.website_id = w.id and s.chatbot_id in ${bots} and ${inRange("s.created_at")})::int as conversations,
       (select count(*) from messages m join chat_sessions s on s.id = m.chat_session_id join chatbots b on b.id = s.chatbot_id
          where b.website_id = w.id and s.chatbot_id in ${bots} and ${inRange("m.created_at")})::int as messages
     from websites w
     where w.organization_id = $1 and exists (select 1 from chatbots b where b.website_id = w.id and b.id in ${bots})
     order by conversations desc, w.name`,
  );
  const refusals = await q<{ type: string; origin: string | null; count: number }>(
    `select e.type, e.origin, count(*)::int as count from analytics_events e
     where e.organization_id = $1 and (e.chatbot_id is null or e.chatbot_id in ${bots}) and ${inRange("e.created_at")}
     group by e.type, e.origin order by count desc limit 10`,
  );

  const byProvider = providers.map((p) => ({
    provider: p.provider,
    model: p.model,
    requests: p.requests,
    failed: p.failed,
    inputTokens: p.input,
    outputTokens: p.output,
    costUsd: p.input + p.output > 0 ? estimateCost(p.model, p.input, p.output) : 0,
    avgLatencyMs: p.latency,
  }));
  const priced = byProvider.filter((p) => p.costUsd !== null);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  return {
    totals: {
      conversations: sessions?.conversations ?? 0,
      messages: msgs?.messages ?? 0,
      visitorMessages: msgs?.visitor_messages ?? 0,
      uniqueVisitors: sessions?.visitors ?? 0,
      inputTokens: sum(byProvider.map((p) => p.inputTokens)),
      outputTokens: sum(byProvider.map((p) => p.outputTokens)),
      estimatedCostUsd: priced.length ? sum(priced.map((p) => p.costUsd ?? 0)) : null,
      costCoverage: byProvider.length === 0 || priced.length === byProvider.length ? "all" : priced.length ? "partial" : "none",
      modelRequests: sum(byProvider.map((p) => p.requests)),
      failedRequests: sum(byProvider.map((p) => p.failed)),
      voiceCallMinutes: (voice?.realtime ?? 0) / 60,
      transcribedMinutes: (voice?.stt ?? 0) / 60,
      spokenCharacters: voice?.chars ?? 0,
      answersWithSources: msgs?.with_sources ?? 0,
      assistantAnswers: msgs?.assistant ?? 0,
      widgetRefusals: sum(refusals.map((r) => r.count)),
    },
    daily,
    bySource,
    byChatbot: byChatbot.map((b) => ({ chatbotId: b.chatbot_id, name: b.name, website: b.website, conversations: b.conversations, messages: b.messages, tokens: b.tokens })),
    byWebsite: byWebsite.map((w) => ({ websiteId: w.website_id, name: w.name, conversations: w.conversations, messages: w.messages })),
    byProvider,
    refusals,
  };
}

/** Options for filter dropdowns: everything in the organization the member can see. */
export async function analyticsFilterOptions(db: DbClient, organizationId: string) {
  const org = uuid.parse(organizationId);
  // Sequential on purpose: one database client can run only one query at a time.
  const workspaces = await db.query<{ id: string; name: string }>("select id, name from workspaces where organization_id = $1 order by name", [org]);
  const websites = await db.query<{ id: string; name: string; workspace_id: string }>("select id, name, workspace_id from websites where organization_id = $1 order by name", [org]);
  const chatbots = await db.query<{ id: string; name: string; website_id: string }>(
    "select c.id, s.settings->>'name' as name, c.website_id from chatbots c join chatbot_settings s on s.chatbot_id = c.id where c.organization_id = $1 order by name",
    [org],
  );
  const providers = await db.query<{ provider: string }>("select distinct provider from usage_records where organization_id = $1 and kind = 'chat' order by provider", [org]);
  return { workspaces: workspaces.rows, websites: websites.rows, chatbots: chatbots.rows, providers: providers.rows.map((r) => r.provider) };
}

// ------------------------------------------------------------------ conversation history

export interface ConversationSummary {
  id: string;
  chatbot_id: string;
  chatbot_name: string;
  source: string;
  origin: string | null;
  created_at: Date;
  message_count: number;
  preview: string | null;
}

export async function listConversations(
  db: DbClient,
  input: { organizationId: string; chatbotId?: string; source?: string; from?: string; to?: string; page?: number },
): Promise<{ items: ConversationSummary[]; page: number; hasMore: boolean }> {
  const org = uuid.parse(input.organizationId);
  const pageSize = 25;
  const page = Math.max(1, Math.min(input.page ?? 1, 1000));
  const params: unknown[] = [org];
  const conds = ["s.organization_id = $1"];
  if (input.chatbotId && uuid.safeParse(input.chatbotId).success) conds.push(`s.chatbot_id = $${params.push(input.chatbotId)}`);
  if (input.source && ["widget", "api", "playground"].includes(input.source)) conds.push(`s.source = $${params.push(input.source)}`);
  if (input.from && isoDate.safeParse(input.from).success) conds.push(`s.created_at >= $${params.push(input.from)}::date`);
  if (input.to && isoDate.safeParse(input.to).success) conds.push(`s.created_at < $${params.push(input.to)}::date + interval '1 day'`);
  params.push(pageSize + 1, (page - 1) * pageSize);
  const rows = (
    await db.query<ConversationSummary>(
      `select s.id, s.chatbot_id, cs.settings->>'name' as chatbot_name, s.source, s.origin, s.created_at,
         (select count(*) from messages m where m.chat_session_id = s.id)::int as message_count,
         (select left(m.content, 140) from messages m where m.chat_session_id = s.id and m.role = 'user' order by m.created_at limit 1) as preview
       from chat_sessions s join chatbot_settings cs on cs.chatbot_id = s.chatbot_id
       where ${conds.join(" and ")}
         and exists (select 1 from messages m where m.chat_session_id = s.id)
       order by s.created_at desc
       limit $${params.length - 1} offset $${params.length}`,
      params,
    )
  ).rows;
  return { items: rows.slice(0, pageSize), page, hasMore: rows.length > pageSize };
}

export interface ConversationDetail {
  id: string;
  organization_id: string;
  chatbot_id: string;
  chatbot_name: string;
  source: string;
  origin: string | null;
  created_at: Date;
  messages: { role: "user" | "assistant" | "system"; content: string; provider: string | null; model: string | null; citations: { n: number; title: string; sourceUrl: string | null }[]; created_at: Date }[];
}

export async function getConversation(db: DbClient, sessionId: string): Promise<ConversationDetail> {
  const id = uuid.safeParse(sessionId);
  if (!id.success) throw notFound("Conversation");
  const session = (
    await db.query<Omit<ConversationDetail, "messages">>(
      `select s.id, s.organization_id, s.chatbot_id, cs.settings->>'name' as chatbot_name, s.source, s.origin, s.created_at
       from chat_sessions s join chatbot_settings cs on cs.chatbot_id = s.chatbot_id where s.id = $1`,
      [id.data],
    )
  ).rows[0];
  if (!session) throw notFound("Conversation");
  const messages = (
    await db.query<ConversationDetail["messages"][number]>(
      "select role, content, provider, model, citations, created_at from messages where chat_session_id = $1 order by created_at",
      [id.data],
    )
  ).rows;
  return { ...session, messages };
}

/**
 * Deletes one conversation and its messages (e.g. a visitor's deletion request). Owners/admins only.
 * `userDb` proves the role; the delete itself is trusted because conversations have no RLS delete policy.
 */
export async function deleteConversation(userDb: DbClient, trustedDb: DbClient, sessionId: string, actorId: string): Promise<void> {
  const convo = await getConversation(userDb, sessionId);
  const org = await getOrganization(userDb, convo.organization_id);
  if (org.role !== "owner" && org.role !== "admin") throw new DomainError("forbidden", "Only owners and admins can delete conversations");
  await trustedDb.query("delete from chat_sessions where id = $1 and organization_id = $2", [convo.id, org.id]);
  await trustedDb.query(
    "insert into audit_logs (organization_id, actor_id, action, target_type, target_id) values ($1, $2, 'conversation.delete', 'chat_session', $3)",
    [org.id, actorId, convo.id],
  );
}

// ------------------------------------------------------------------ retention

export async function setRetention(db: DbClient, organizationId: string, days: number | null): Promise<void> {
  const org = await getOrganization(db, organizationId);
  if (org.role !== "owner" && org.role !== "admin") throw new DomainError("forbidden", "Only owners and admins can change retention");
  if (days !== null && (!Number.isInteger(days) || days < 7 || days > 3650)) throw new DomainError("invalid", "Retention must be between 7 and 3650 days");
  const r = await db.query("update organizations set retention_days = $2 where id = $1", [org.id, days]);
  if (r.rowCount === 0) throw new DomainError("forbidden", "You don't have permission to do that");
  await db.query("select public.write_audit($1, 'organization.retention', 'organization', $2)", [org.id, org.id]);
}

export async function getRetention(db: DbClient, organizationId: string): Promise<number | null> {
  const row = (await db.query<{ retention_days: number | null }>("select retention_days from organizations where id = $1", [uuid.parse(organizationId)])).rows[0];
  return row?.retention_days ?? null;
}

/**
 * Deletes conversations (and their messages, voice sessions and widget events) older than each
 * organization's retention period. Usage records keep their counts but lose the conversation link.
 * Trusted context; safe to run repeatedly (cron, or after page views).
 */
export async function purgeExpiredData(db: DbClient, organizationId?: string): Promise<{ conversations: number; events: number }> {
  const params = organizationId ? [organizationId] : [];
  const orgCond = organizationId ? "and o.id = $1" : "";
  const conversations = (
    await db.query(
      `delete from chat_sessions s using organizations o
       where s.organization_id = o.id and o.retention_days is not null ${orgCond}
         and s.created_at < now() - make_interval(days => o.retention_days)`,
      params,
    )
  ).rowCount ?? 0;
  const events = (
    await db.query(
      `delete from analytics_events e using organizations o
       where e.organization_id = o.id and o.retention_days is not null ${orgCond}
         and e.created_at < now() - make_interval(days => o.retention_days)`,
      params,
    )
  ).rowCount ?? 0;
  return { conversations, events };
}
