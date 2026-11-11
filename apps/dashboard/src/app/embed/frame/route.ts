/**
 * GET /embed/frame?chatbotId=cb_…&theme=…
 * A standalone chat page for <iframe> embedding. Framing is restricted with CSP frame-ancestors to the
 * chatbot's allowed domains, so other websites can't display it. The page loads the same embed.js
 * in "inline" mode and talks to the API from the platform's own origin.
 */
import { publicChatbotIdSchema } from "@chatbot/shared";
import { withTrustedContext } from "@chatbot/database";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function frameAncestors(domains: string[]): string {
  const sources = domains.flatMap((d) =>
    d === "localhost" ? ["http://localhost:*", "https://localhost:*"] : [`https://${d}`, `https://*.${d}`],
  );
  return sources.length ? sources.join(" ") : "'none'";
}

const escapeAttr = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const chatbotId = params.get("chatbotId") ?? "";
  const theme = ["light", "dark", "auto"].includes(params.get("theme") ?? "") ? params.get("theme")! : "";

  let domains: string[] = [];
  let available = false;
  if (publicChatbotIdSchema.safeParse(chatbotId).success) {
    const row = await withTrustedContext(getPool(), async (db) =>
      (
        await db.query<{ status: string; domains: string[] }>(
          `select c.status, coalesce((select array_agg(d.domain) from website_domains d where d.website_id = c.website_id), '{}') as domains
           from chatbots c where c.public_id = $1`,
          [chatbotId],
        )
      ).rows[0],
    );
    if (row?.status === "active") {
      available = true;
      domains = row.domains;
    }
  }

  const csp = [
    `frame-ancestors ${available ? frameAncestors(domains) : "'none'"}`,
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

  const body = available
    ? `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chat</title><style>html,body{margin:0;height:100%;background:transparent}</style></head>
<body><ai-chatbot mode="inline" chatbot-id="${escapeAttr(chatbotId)}" api-url="${escapeAttr(new URL(request.url).origin)}"${theme ? ` theme="${theme}"` : ""}></ai-chatbot>
<script src="/embed.js"></script></body></html>`
    : `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Chat unavailable</title></head><body style="font-family:system-ui;margin:16px;color:#555">This chat is not available.</body></html>`;

  return new Response(body, {
    status: available ? 200 : 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": csp,
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}
