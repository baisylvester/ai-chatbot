/**
 * Periodic maintenance (run by a cron every few minutes; safe to run concurrently and repeatedly):
 *  - requeue ingestion jobs left "running" by a crashed or redeployed server (max 3 attempts)
 *  - process queued ingestion jobs the in-process background step never picked up
 *  - apply every organization's conversation retention
 *  - close realtime voice calls that never reported their end, recording their (capped) usage
 *  - prune expired rate-limit counters
 */
import type { DbClient } from "@chatbot/database";
import type { Embedder } from "@chatbot/rag-engine";
import { purgeExpiredData } from "./analytics.ts";
import type { TrustedRunner } from "./conversation.ts";
import { processIngestionJob } from "./knowledge.ts";
import { closeAbandonedVoiceSessions } from "./voice.ts";

export interface MaintenanceResult {
  requeuedJobs: number;
  abandonedJobs: number;
  processedJobs: { succeeded: number; failed: number; skipped: number };
  purgedConversations: number;
  purgedEvents: number;
  closedVoiceSessions: number;
  prunedRateLimits: number;
}

export async function recoverStuckJobs(db: DbClient, olderThanMinutes = 15): Promise<{ requeued: number; abandoned: number }> {
  const requeued = await db.query(
    `with stuck as (
       update ingestion_jobs set status = 'queued', started_at = null
       where status = 'running' and started_at < now() - make_interval(mins => $1) and attempts < 3
       returning document_id)
     update knowledge_documents d set status = 'pending', updated_at = now() from stuck where d.id = stuck.document_id`,
    [olderThanMinutes],
  );
  const abandoned = await db.query(
    `with dead as (
       update ingestion_jobs set status = 'failed', finished_at = now(), error = 'Gave up after 3 attempts'
       where status = 'running' and started_at < now() - make_interval(mins => $1) and attempts >= 3
       returning document_id)
     update knowledge_documents d set status = 'failed', error = 'Processing kept failing. Try Reprocess, or check the file.', updated_at = now()
     from dead where d.id = dead.document_id`,
    [olderThanMinutes],
  );
  return { requeued: requeued.rowCount ?? 0, abandoned: abandoned.rowCount ?? 0 };
}

export async function runMaintenance(
  trusted: TrustedRunner,
  deps: { embedder: Embedder | null; maxJobs?: number; queuedOlderThanSeconds?: number },
): Promise<MaintenanceResult> {
  const stuck = await trusted((db) => recoverStuckJobs(db));

  // Jobs normally run right after upload; only pick up ones that have waited a while.
  const queued = await trusted(async (db) =>
    (
      await db.query<{ id: string }>(
        `select id from ingestion_jobs where status = 'queued' and created_at < now() - make_interval(secs => $1)
         order by created_at limit $2`,
        [deps.queuedOlderThanSeconds ?? 120, deps.maxJobs ?? 10],
      )
    ).rows.map((r) => r.id),
  );
  const processed = { succeeded: 0, failed: 0, skipped: 0 };
  for (const id of queued) processed[await processIngestionJob(trusted, id, { embedder: deps.embedder })]++;

  const purged = await trusted((db) => purgeExpiredData(db));
  // Calls whose browser never reported the end: close them and record (capped) usage.
  const closedVoiceSessions = await trusted((db) => closeAbandonedVoiceSessions(db, { olderThanMinutes: 90 }));
  const prunedRateLimits = await trusted(
    async (db) => (await db.query("delete from rate_limits where window_start < now() - interval '1 day'")).rowCount ?? 0,
  );

  return {
    requeuedJobs: stuck.requeued,
    abandonedJobs: stuck.abandoned,
    processedJobs: processed,
    purgedConversations: purged.conversations,
    purgedEvents: purged.events,
    closedVoiceSessions,
    prunedRateLimits,
  };
}
