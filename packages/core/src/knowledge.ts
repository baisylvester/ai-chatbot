/**
 * Knowledge sources, documents, ingestion and retrieval.
 *
 * - "user" functions take an RLS client (withUserContext): members read, owners/admins write.
 * - Ingestion and retrieval take a trusted runner and scope every query by organization explicitly.
 * - Retrieval only ever searches sources owned by the chatbot or global sources explicitly assigned to it.
 */
import type { DbClient } from "@chatbot/database";
import {
  chunkDocument,
  contentHash,
  ExtractionError,
  fetchPage,
  formatContext,
  reciprocalRankFusion,
  type Embedder,
  type FetchedPage,
} from "@chatbot/rag-engine";
import { z } from "zod";
import { DomainError, mapDbError, notFound } from "./errors.ts";
import type { TrustedRunner } from "./conversation.ts";
import { getChatbot, getOrganization } from "./services.ts";

const id = z.uuid();
const parseId = (value: string, what: string) => {
  const r = id.safeParse(value);
  if (!r.success) throw notFound(what);
  return r.data;
};

async function audit(db: DbClient, org: string, action: string, targetType: string, targetId: string) {
  await db.query("select public.write_audit($1, $2, $3, $4)", [org, action, targetType, targetId]);
}

// ------------------------------------------------------------------ sources

export interface KnowledgeSource {
  id: string;
  organization_id: string;
  scope: "global" | "chatbot";
  chatbot_id: string | null;
  chatbot_name: string | null;
  name: string;
  description: string | null;
  document_count: number;
  ready_count: number;
  processing_count: number;
  assigned_chatbots: number;
}

const sourceSelect = `
  select s.id, s.organization_id, s.scope, s.chatbot_id, cs.settings->>'name' as chatbot_name, s.name, s.description,
    (select count(*)::int from knowledge_documents d where d.knowledge_source_id = s.id) as document_count,
    (select count(*)::int from knowledge_documents d where d.knowledge_source_id = s.id and d.status = 'ready') as ready_count,
    (select count(*)::int from knowledge_documents d where d.knowledge_source_id = s.id and d.status in ('pending', 'processing')) as processing_count,
    (select count(*)::int from chatbot_knowledge_assignments a where a.knowledge_source_id = s.id) as assigned_chatbots
  from knowledge_sources s left join chatbot_settings cs on cs.chatbot_id = s.chatbot_id`;

export async function listKnowledgeSources(db: DbClient, orgId: string): Promise<KnowledgeSource[]> {
  return (await db.query<KnowledgeSource>(`${sourceSelect} where s.organization_id = $1 order by s.scope, s.name`, [parseId(orgId, "Organization")])).rows;
}

export async function getKnowledgeSource(db: DbClient, sourceId: string): Promise<KnowledgeSource> {
  const row = (await db.query<KnowledgeSource>(`${sourceSelect} where s.id = $1`, [parseId(sourceId, "Knowledge source")])).rows[0];
  if (!row) throw notFound("Knowledge source");
  return row;
}

const sourceInput = z.object({
  name: z.string().trim().min(1, "Enter a name").max(200),
  description: z.string().trim().max(500).optional(),
});

/** Global sources belong to the organization; chatbot sources belong to one chatbot (org taken from it). */
export async function createKnowledgeSource(
  db: DbClient,
  input: { organizationId?: string; chatbotId?: string; name: string; description?: string },
): Promise<KnowledgeSource> {
  const data = sourceInput.safeParse(input);
  if (!data.success) throw new DomainError("invalid", data.error.issues[0]!.message);
  let orgId: string;
  let workspaceId: string | null = null;
  let chatbotId: string | null = null;
  if (input.chatbotId) {
    const bot = await getChatbot(db, input.chatbotId);
    orgId = bot.organization_id;
    workspaceId = bot.workspace_id;
    chatbotId = bot.id;
  } else {
    orgId = (await getOrganization(db, input.organizationId ?? "")).id;
  }
  try {
    const row = (
      await db.query<{ id: string }>(
        `insert into knowledge_sources (organization_id, workspace_id, scope, chatbot_id, name, description)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [orgId, workspaceId, chatbotId ? "chatbot" : "global", chatbotId, data.data.name, data.data.description || null],
      )
    ).rows[0]!;
    await audit(db, orgId, "knowledge.source.create", "knowledge_source", row.id);
    return getKnowledgeSource(db, row.id);
  } catch (err) {
    mapDbError(err);
  }
}

export async function deleteKnowledgeSource(db: DbClient, sourceId: string): Promise<void> {
  const source = await getKnowledgeSource(db, sourceId);
  const r = await db.query("delete from knowledge_sources where id = $1", [source.id]);
  if (r.rowCount === 0) throw new DomainError("forbidden", "You don't have permission to do that");
  await audit(db, source.organization_id, "knowledge.source.delete", "knowledge_source", source.id);
}

// ------------------------------------------------------------------ chatbot assignments

export interface ChatbotKnowledge {
  own: KnowledgeSource[];
  global: (KnowledgeSource & { assigned: boolean })[];
}

export async function listChatbotKnowledge(db: DbClient, chatbotId: string): Promise<ChatbotKnowledge> {
  const bot = await getChatbot(db, chatbotId);
  const all = await listKnowledgeSources(db, bot.organization_id);
  const assigned = new Set(
    (await db.query<{ knowledge_source_id: string }>("select knowledge_source_id from chatbot_knowledge_assignments where chatbot_id = $1", [bot.id])).rows.map(
      (r) => r.knowledge_source_id,
    ),
  );
  return {
    own: all.filter((s) => s.scope === "chatbot" && s.chatbot_id === bot.id),
    global: all.filter((s) => s.scope === "global").map((s) => ({ ...s, assigned: assigned.has(s.id) })),
  };
}

export async function setGlobalSourceAssignment(db: DbClient, chatbotId: string, sourceId: string, assigned: boolean): Promise<void> {
  const bot = await getChatbot(db, chatbotId);
  const source = await getKnowledgeSource(db, sourceId);
  if (source.scope !== "global") throw new DomainError("invalid", "Only shared knowledge sources can be assigned");
  if (source.organization_id !== bot.organization_id) throw notFound("Knowledge source");
  try {
    if (assigned) {
      await db.query(
        `insert into chatbot_knowledge_assignments (chatbot_id, knowledge_source_id, organization_id) values ($1, $2, $3)
         on conflict do nothing`,
        [bot.id, source.id, bot.organization_id],
      );
    } else {
      await db.query("delete from chatbot_knowledge_assignments where chatbot_id = $1 and knowledge_source_id = $2", [bot.id, source.id]);
    }
    await audit(db, bot.organization_id, assigned ? "knowledge.assign" : "knowledge.unassign", "chatbot", bot.id);
  } catch (err) {
    mapDbError(err);
  }
}

// ------------------------------------------------------------------ documents

export type DocumentStatus = "pending" | "processing" | "ready" | "failed";

export interface KnowledgeDocument {
  id: string;
  organization_id: string;
  knowledge_source_id: string;
  title: string;
  source_type: "file" | "url" | "text";
  source_url: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  char_count: number | null;
  chunk_count: number;
  status: DocumentStatus;
  error: string | null;
  embedding_model: string | null;
  processed_at: Date | null;
  created_at: Date;
}

const docColumns = `id, organization_id, knowledge_source_id, title, source_type, source_url, mime_type, size_bytes,
  char_count, chunk_count, status, error, embedding_model, processed_at, created_at`;

export async function listDocuments(db: DbClient, sourceId: string): Promise<KnowledgeDocument[]> {
  return (
    await db.query<KnowledgeDocument>(`select ${docColumns} from knowledge_documents where knowledge_source_id = $1 order by created_at desc`, [
      parseId(sourceId, "Knowledge source"),
    ])
  ).rows;
}

export async function getDocument(db: DbClient, documentId: string): Promise<KnowledgeDocument> {
  const row = (await db.query<KnowledgeDocument>(`select ${docColumns} from knowledge_documents where id = $1`, [parseId(documentId, "Document")])).rows[0];
  if (!row) throw notFound("Document");
  return row;
}

const MAX_TEXT_CHARS = 2_000_000;

/**
 * Adds a document to a source (RLS: owners/admins). Text and file content is already extracted;
 * URL documents are fetched by the ingestion job. Returns the new document; the caller enqueues it.
 */
export async function addDocument(
  db: DbClient,
  input:
    | { sourceId: string; kind: "text"; title: string; content: string }
    | { sourceId: string; kind: "file"; title: string; content: string; mimeType?: string; sizeBytes: number }
    | { sourceId: string; kind: "url"; url: string },
): Promise<KnowledgeDocument> {
  const source = await getKnowledgeSource(db, input.sourceId);
  let title: string;
  let content: string | null = null;
  let hash: string;
  let url: string | null = null;
  if (input.kind === "url") {
    const u = z.url({ protocol: /^https?$/ }).safeParse(input.url.trim());
    if (!u.success) throw new DomainError("invalid", "Enter a full URL starting with https://");
    url = u.data;
    title = new URL(url).hostname + new URL(url).pathname.replace(/\/$/, "");
    hash = contentHash(`url:${url}`); // replaced by the content hash once fetched
  } else {
    title = input.title.trim().slice(0, 300);
    content = input.content.trim();
    if (!title) throw new DomainError("invalid", "Enter a title");
    if (!content) throw new DomainError("invalid", "The document has no text");
    if (content.length > MAX_TEXT_CHARS) throw new DomainError("invalid", "The document has too much text");
    hash = contentHash(content);
  }
  try {
    const row = (
      await db.query<{ id: string }>(
        `insert into knowledge_documents
           (organization_id, knowledge_source_id, title, content_hash, source_type, source_url, mime_type, size_bytes, content, char_count, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending') returning id`,
        [
          source.organization_id,
          source.id,
          title,
          hash,
          input.kind,
          url,
          input.kind === "file" ? (input.mimeType ?? null) : input.kind === "text" ? "text/plain" : null,
          input.kind === "file" ? input.sizeBytes : content ? Buffer.byteLength(content) : null,
          content,
          content?.length ?? null,
        ],
      )
    ).rows[0]!;
    await audit(db, source.organization_id, "knowledge.document.add", "knowledge_document", row.id);
    return getDocument(db, row.id);
  } catch (err) {
    mapDbError(err, input.kind === "url" ? "That URL is already in this source" : "This content is already in this source");
  }
}

export async function deleteDocument(db: DbClient, documentId: string): Promise<void> {
  const doc = await getDocument(db, documentId);
  const r = await db.query("delete from knowledge_documents where id = $1", [doc.id]);
  if (r.rowCount === 0) throw new DomainError("forbidden", "You don't have permission to do that");
  await audit(db, doc.organization_id, "knowledge.document.delete", "knowledge_document", doc.id);
}

/** Marks a document for reprocessing (RLS: admins). The caller enqueues a job afterwards. */
export async function markForReprocessing(db: DbClient, documentId: string): Promise<KnowledgeDocument> {
  const doc = await getDocument(db, documentId);
  const r = await db.query("update knowledge_documents set status = 'pending', error = null, updated_at = now() where id = $1", [doc.id]);
  if (r.rowCount === 0) throw new DomainError("forbidden", "You don't have permission to do that");
  await audit(db, doc.organization_id, "knowledge.document.reprocess", "knowledge_document", doc.id);
  return { ...doc, status: "pending", error: null };
}

// ------------------------------------------------------------------ ingestion (trusted)

/** Queues a job for a document the caller has just added or marked (trusted context). */
export async function enqueueIngestion(db: DbClient, doc: { id: string; organization_id: string }): Promise<string> {
  return (
    await db.query<{ id: string }>("insert into ingestion_jobs (organization_id, document_id) values ($1, $2) returning id", [
      doc.organization_id,
      doc.id,
    ])
  ).rows[0]!.id;
}

const vectorLiteral = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;
const EMBED_BATCH = 64;

export interface IngestionDeps {
  /** Null when no embedding provider is configured: chunks are stored without vectors and found by keyword search only. */
  embedder: Embedder | null;
  fetchPage?: (url: string) => Promise<FetchedPage>;
}

/**
 * Runs one ingestion job: fetch (URLs), chunk, embed (when an embedder is configured), and replace the document's chunks atomically.
 * Network work happens outside transactions. Safe to retry: a failed job can be re-run.
 */
export async function processIngestionJob(trusted: TrustedRunner, jobId: string, deps: IngestionDeps): Promise<"succeeded" | "failed" | "skipped"> {
  const claimed = await trusted(async (db) => {
    const job = (
      await db.query<{ id: string; document_id: string; organization_id: string }>(
        `update ingestion_jobs set status = 'running', attempts = attempts + 1, started_at = now(), error = null
         where id = $1 and status in ('queued', 'failed') returning id, document_id, organization_id`,
        [jobId],
      )
    ).rows[0];
    if (!job) return null;
    const doc = (
      await db.query<{ id: string; source_type: string; source_url: string | null; content: string | null; title: string; knowledge_source_id: string }>(
        `update knowledge_documents set status = 'processing', error = null, updated_at = now()
         where id = $1 and organization_id = $2
         returning id, source_type, source_url, content, title, knowledge_source_id`,
        [job.document_id, job.organization_id],
      )
    ).rows[0];
    return doc ? { job, doc } : null;
  });
  if (!claimed) return "skipped";
  const { job, doc } = claimed;

  try {
    let content = doc.content;
    let title = doc.title;
    let fetched: FetchedPage | null = null;
    if (doc.source_type === "url") {
      if (!doc.source_url) throw new ExtractionError("The document has no URL");
      fetched = await (deps.fetchPage ?? fetchPage)(doc.source_url);
      content = fetched.text;
      if (fetched.title) title = fetched.title.slice(0, 300);
    }
    if (!content) throw new ExtractionError("The document has no text");

    const chunks = await chunkDocument(content);
    if (chunks.length === 0) throw new ExtractionError("The document has no text");
    const vectors: (number[] | null)[] = deps.embedder ? [] : chunks.map(() => null);
    for (let i = 0; deps.embedder && i < chunks.length; i += EMBED_BATCH) {
      // The document title gives each chunk context ("Store hours" + a passage that never says "hours").
      vectors.push(...(await deps.embedder.embedDocuments(chunks.slice(i, i + EMBED_BATCH).map((c) => `${title}\n\n${c.content}`))));
    }

    await trusted(async (db) => {
      if (fetched) {
        const dupe = (
          await db.query(
            "select 1 from knowledge_documents where knowledge_source_id = $1 and content_hash = $2 and id <> $3",
            [doc.knowledge_source_id, contentHash(fetched.text), doc.id],
          )
        ).rowCount;
        if (dupe) throw new ExtractionError("This page's content is already in this source");
        await db.query(
          `update knowledge_documents set content = $1, title = $2, content_hash = $3, char_count = $4, size_bytes = $5, mime_type = $6, source_url = $7
           where id = $8 and organization_id = $9`,
          [fetched.text, title, contentHash(fetched.text), fetched.text.length, fetched.bytes, fetched.contentType, fetched.url, doc.id, job.organization_id],
        );
      }
      await db.query("delete from document_chunks where document_id = $1 and organization_id = $2", [doc.id, job.organization_id]);
      await db.query(
        `insert into document_chunks (organization_id, knowledge_source_id, document_id, chunk_index, content, embedding, embedding_model, token_estimate, metadata)
         select $1, $2, $3, idx, content, emb::vector, $4, tokens, jsonb_build_object('title', $5::text)
         from unnest($6::int[], $7::text[], $8::text[], $9::int[]) as t(idx, content, emb, tokens)`,
        [
          job.organization_id,
          doc.knowledge_source_id,
          doc.id,
          deps.embedder?.modelId ?? null,
          title,
          chunks.map((c) => c.index),
          chunks.map((c) => c.content),
          vectors.map((v) => (v ? vectorLiteral(v) : null)),
          chunks.map((c) => c.tokenEstimate),
        ],
      );
      await db.query(
        `update knowledge_documents set status = 'ready', error = null, chunk_count = $1, embedding_model = $2, processed_at = now(), updated_at = now()
         where id = $3 and organization_id = $4`,
        [chunks.length, deps.embedder?.modelId ?? null, doc.id, job.organization_id],
      );
      await db.query("update ingestion_jobs set status = 'succeeded', finished_at = now() where id = $1", [job.id]);
    });
    return "succeeded";
  } catch (err) {
    const message =
      err instanceof ExtractionError || (err instanceof Error && /not configured|not set/i.test(err.message))
        ? err.message
        : "Processing failed. Try reprocessing; if it keeps failing, check the server logs.";
    if (!(err instanceof ExtractionError)) console.error("ingestion job failed", job.id, err);
    await trusted(async (db) => {
      await db.query("update knowledge_documents set status = 'failed', error = $1, updated_at = now() where id = $2 and organization_id = $3", [
        message.slice(0, 500),
        doc.id,
        job.organization_id,
      ]);
      await db.query("update ingestion_jobs set status = 'failed', error = $1, finished_at = now() where id = $2", [message.slice(0, 500), job.id]);
    });
    return "failed";
  }
}

/** Marks a document failed when ingestion can't even start (e.g. no embedding provider). Trusted context. */
export async function failDocument(db: DbClient, documentId: string, organizationId: string, message: string): Promise<void> {
  await db.query("update knowledge_documents set status = 'failed', error = $1, updated_at = now() where id = $2 and organization_id = $3", [
    message.slice(0, 500),
    documentId,
    organizationId,
  ]);
  await db.query("update ingestion_jobs set status = 'failed', error = $1, finished_at = now() where document_id = $2 and status = 'queued'", [
    message.slice(0, 500),
    documentId,
  ]);
}

// ------------------------------------------------------------------ retrieval (trusted, scoped)

export interface RetrievedChunk {
  id: string;
  documentId: string;
  title: string;
  sourceUrl: string | null;
  content: string;
  score: number;
}

export interface Citation {
  n: number;
  documentId: string;
  title: string;
  sourceUrl: string | null;
  snippet: string;
}

const STOPWORDS = new Set(
  "the and for are but not you your with what who whom which when where why how was were has have had does did this that these those from into about can could would should will his her its our their they them she him any all also than then there here been being just more most some such only own same very of to in on at by is it be as or an a ang ng sa mga na at ay si ni kay ano sino saan kailan bakit paano".split(" "),
);

/** Builds an OR full-text query from the meaningful words of a question (safe: words are alphanumeric only). */
export function keywordQuery(query: string): string | null {
  const words = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3 && !STOPWORDS.has(w)))].slice(0, 12);
  return words.length ? words.join(" | ") : null;
}

/** Source ids this chatbot may search: its own sources plus explicitly assigned global sources. */
async function allowedSourceIds(db: DbClient, chatbotId: string, orgId: string): Promise<string[]> {
  return (
    await db.query<{ id: string }>(
      `select s.id from knowledge_sources s
       where s.organization_id = $2
         and ((s.scope = 'chatbot' and s.chatbot_id = $1)
           or (s.scope = 'global' and exists (
                 select 1 from chatbot_knowledge_assignments a
                 where a.knowledge_source_id = s.id and a.chatbot_id = $1 and a.organization_id = $2)))`,
      [chatbotId, orgId],
    )
  ).rows.map((r) => r.id);
}

/**
 * Hybrid retrieval: semantic (pgvector cosine) + keyword (Postgres full-text), fused with RRF.
 * Without an embedder it falls back to keyword search only.
 */
export async function retrieveForChatbot(
  db: DbClient,
  chatbot: { id: string; organization_id: string },
  query: string,
  opts: { embedder?: Embedder | null; queryVector?: number[]; k?: number; minSimilarity?: number } = {},
): Promise<RetrievedChunk[]> {
  const k = opts.k ?? 6;
  const sources = await allowedSourceIds(db, chatbot.id, chatbot.organization_id);
  if (sources.length === 0 || !query.trim()) return [];

  type Row = { id: string; document_id: string; title: string; source_url: string | null; content: string };
  const lists: Row[][] = [];

  if (opts.embedder && opts.queryVector) {
    lists.push(
      (
        await db.query<Row & { similarity: number }>(
          `select c.id, c.document_id, d.title, d.source_url, c.content, 1 - (c.embedding <=> $4::vector) as similarity
           from document_chunks c join knowledge_documents d on d.id = c.document_id
           where c.organization_id = $1 and c.knowledge_source_id = any($2::uuid[]) and c.embedding_model = $3 and d.status = 'ready'
           order by c.embedding <=> $4::vector
           limit 20`,
          [chatbot.organization_id, sources, opts.embedder.modelId, vectorLiteral(opts.queryVector)],
        )
      ).rows.filter((r) => r.similarity >= (opts.minSimilarity ?? 0.2)),
    );
  }

  const tsquery = keywordQuery(query);
  if (tsquery) {
    lists.push(
      (
        await db.query<Row>(
          `select c.id, c.document_id, d.title, d.source_url, c.content
           from document_chunks c join knowledge_documents d on d.id = c.document_id,
                to_tsquery('simple', $3) q
           where c.organization_id = $1 and c.knowledge_source_id = any($2::uuid[]) and d.status = 'ready' and c.fts @@ q
           order by ts_rank_cd(c.fts, q) desc
           limit 20`,
          [chatbot.organization_id, sources, tsquery],
        )
      ).rows,
    );
  }

  return reciprocalRankFusion(lists)
    .slice(0, k)
    .map((r) => ({ id: r.id, documentId: r.document_id, title: r.title, sourceUrl: r.source_url, content: r.content, score: r.score }));
}

export function toCitations(chunks: RetrievedChunk[]): Citation[] {
  return chunks.map((c, i) => ({
    n: i + 1,
    documentId: c.documentId,
    title: c.title,
    sourceUrl: c.sourceUrl,
    snippet: c.content.length > 240 ? `${c.content.slice(0, 240)}…` : c.content,
  }));
}

export { formatContext };
