import "server-only";
import { after } from "next/server";
import {
  enqueueIngestion,
  failDocument,
  processIngestionJob,
  retrieveForChatbot,
  type RetrievedChunk,
} from "@chatbot/core";
import { withTrustedContext } from "@chatbot/database";
import { createEmbedder, type Embedder } from "@chatbot/rag-engine";
import { getPool } from "@/lib/db";

const trusted = <T,>(fn: Parameters<typeof withTrustedContext<T>>[1]) => withTrustedContext(getPool(), fn);

/** The configured embedder, or null with the reason (shown to admins). */
export function getEmbedder(): { embedder: Embedder | null; problem: string | null } {
  try {
    return { embedder: createEmbedder(process.env), problem: null };
  } catch (err) {
    return { embedder: null, problem: (err as Error).message };
  }
}

/**
 * Queues ingestion for a document and runs it after the response is sent (Next.js `after`).
 * The job row stays in ingestion_jobs, so a failed or interrupted run can be retried with Reprocess.
 * On a multi-instance deployment, move this to a queue worker (e.g. a Neon Function on a cron).
 */
export async function startIngestion(doc: { id: string; organization_id: string }): Promise<void> {
  const { embedder, problem } = getEmbedder();
  const jobId = await trusted((db) => enqueueIngestion(db, doc));
  if (!embedder) {
    await trusted((db) => failDocument(db, doc.id, doc.organization_id, problem ?? "No embedding provider is configured"));
    return;
  }
  after(async () => {
    try {
      await processIngestionJob(trusted, jobId, { embedder });
    } catch (err) {
      console.error("ingestion crashed", jobId, err);
    }
  });
}

/** Tenant-scoped retrieval for a chatbot; falls back to keyword-only search if embedding the query fails. */
export function retrieverFor(chatbot: { id: string; organization_id: string }) {
  const { embedder } = getEmbedder();
  return async (query: string): Promise<RetrievedChunk[]> => {
    let queryVector: number[] | undefined;
    if (embedder) {
      try {
        queryVector = await embedder.embedQuery(query);
      } catch (err) {
        console.error("query embedding failed; using keyword search only", err);
      }
    }
    return trusted((db) => retrieveForChatbot(db, chatbot, query, { embedder: queryVector ? embedder : null, queryVector }));
  };
}
