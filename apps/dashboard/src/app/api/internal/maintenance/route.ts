/**
 * GET /api/internal/maintenance — periodic maintenance (see packages/core/src/maintenance.ts).
 * Requires `Authorization: Bearer $CRON_SECRET` (Vercel Cron sends this automatically when
 * CRON_SECRET is set). Returns counts only.
 */
import { timingSafeEqual } from "node:crypto";
import { runMaintenance } from "@chatbot/core";
import { withTrustedContext } from "@chatbot/database";
import { getPool } from "@/lib/db";
import { getEmbedder } from "@/lib/knowledge";
import { log } from "@/lib/log";
import { runMailChecks } from "@/lib/mail-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function GET(request: Request) {
  if (!authorized(request)) return Response.json({ error: { code: "unauthorized", message: "Unauthorized" } }, { status: 401 });
  const started = Date.now();
  try {
    const result = await runMaintenance((fn) => withTrustedContext(getPool(), fn), { embedder: getEmbedder().embedder });
    // New-mail checks for connected mailboxes. A failure here must not fail the rest of maintenance.
    const mail = await runMailChecks().catch((err: unknown) => {
      log.warn("mail_check.run_failed", { error: err });
      return { mailboxesChecked: 0, notificationsSent: 0 };
    });
    log.info("maintenance.done", { ...result, ...mail, ms: Date.now() - started });
    return Response.json({ ok: true, ...result, ...mail, ms: Date.now() - started });
  } catch (err) {
    log.error("maintenance.failed", { error: err });
    return Response.json({ error: { code: "server_error", message: "Maintenance failed" } }, { status: 500 });
  }
}
