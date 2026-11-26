import { z } from "zod";
import { withClientRequest, clientTrusted, clientPreflight, clientError } from "@/lib/client-api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = clientPreflight;

const themeSchema = z.object({
  palette: z.enum(["BlueMint", "Violet", "Forest", "Sunset", "Rose", "Graphite", "Device"]),
  mode: z.enum(["System", "Light", "Dark"]),
}).strict();
const bodySchema = z.object({ theme: themeSchema.nullable() }).strict();

/** The signed-in user's synced app preferences. Unknown stored values are dropped, never echoed. */
export async function GET(request: Request) {
  return withClientRequest(request, async user => {
    const rows = await clientTrusted(db => db.query<{ theme: unknown; updated_at: Date }>(
      "select theme, updated_at from public.client_preferences where user_id = $1", [user.id]));
    const row = rows.rows[0];
    const theme = themeSchema.safeParse(row?.theme);
    return Response.json({ theme: theme.success ? theme.data : null, updatedAt: row?.updated_at?.toISOString() ?? null });
  });
}

export async function PUT(request: Request) {
  return withClientRequest(request, async user => {
    const input = bodySchema.safeParse(await request.json().catch(() => null));
    if (!input.success) return clientError(400, "invalid", "Choose a valid theme.");
    await clientTrusted(db => db.query(
      `insert into public.client_preferences (user_id, theme, updated_at) values ($1, $2, now())
       on conflict (user_id) do update set theme = excluded.theme, updated_at = now()`, [user.id, input.data.theme ? JSON.stringify(input.data.theme) : null]));
    return Response.json({ ok: true });
  });
}
