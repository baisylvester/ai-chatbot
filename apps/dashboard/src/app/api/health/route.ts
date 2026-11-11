/** GET /api/health — liveness and database readiness for load balancers and uptime monitors. */
import { getPool } from "@/lib/db";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  try {
    await Promise.race([
      getPool().query("select 1"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("database timeout")), 3000)),
    ]);
    return Response.json({ status: "ok", database: "ok", ms: Date.now() - started }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    log.error("health.database_unavailable", { error: err });
    return Response.json({ status: "degraded", database: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
