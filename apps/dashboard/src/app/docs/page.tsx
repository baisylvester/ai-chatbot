import Link from "next/link";
import { headers } from "next/headers";
import { openApiSpec } from "@/lib/openapi";

export const dynamic = "force-dynamic";

export const metadata = { title: "API & integration docs" };

const method = (m: string) => (
  <span className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase text-white dark:bg-white dark:text-zinc-900">{m}</span>
);

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-900">
      <code>{children}</code>
    </pre>
  );
}

export default async function DocsPage() {
  const h = await headers();
  const api = process.env.NEXT_PUBLIC_PLATFORM_URL ?? `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}`;
  const spec = openApiSpec(api);
  const id = "cb_YOUR_CHATBOT_ID";

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <p className="text-sm">
        <Link href="/" className="underline">
          Chatbot Platform
        </Link>
      </p>
      <h1 className="mt-2 text-2xl font-semibold">API & integration docs</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Every chatbot runs on this platform. Websites add it with a snippet, a Web Component or an iframe, and servers call the REST API. You never
        need to host an AI model, a database or a knowledge base yourself. Machine-readable spec:{" "}
        <a href="/api/v1/openapi.json" className="underline">
          /api/v1/openapi.json
        </a>{" "}
        (OpenAPI 3.1).
      </p>

      <h2 className="mt-8 text-lg font-semibold">1. Before you start</h2>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
        <li>Create the chatbot in the dashboard and set it to <strong>active</strong>.</li>
        <li>Add your site&apos;s domain to the chatbot&apos;s website (subdomains are included; use <code>localhost</code> for development).</li>
        <li>Copy the chatbot ID (<code>cb_…</code>) from its <em>Install on a website</em> panel. The ID is public; it only works on your allowed domains.</li>
      </ol>

      <h2 className="mt-8 text-lg font-semibold">2. Add it to a website</h2>
      <h3 className="mt-4 font-medium">Any website (HTML, PHP/Laravel, Django, ASP.NET, static sites)</h3>
      <p className="mb-2 text-sm text-zinc-600 dark:text-zinc-400">Paste before <code>&lt;/body&gt;</code>:</p>
      <Code>{`<script>
  window.AIChatbotConfig = { chatbotId: "${id}", apiUrl: "${api}", position: "bottom-right", theme: "auto" };
</script>
<script src="${api}/embed.js" async></script>`}</Code>
      <h3 className="mt-4 font-medium">Website builders</h3>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
        <li><strong>WordPress:</strong> add the snippet with a header/footer code plugin, or in your theme&apos;s footer.</li>
        <li><strong>Shopify:</strong> Online Store → Themes → Edit code → <code>theme.liquid</code>, before <code>&lt;/body&gt;</code>.</li>
        <li><strong>Webflow:</strong> Site settings → Custom code → Footer code.</li>
        <li><strong>Wix:</strong> Settings → Custom code → Body – end (requires a plan that allows custom code).</li>
      </ul>
      <h3 className="mt-4 font-medium">Web Component (Vue, Nuxt, Angular, Svelte, SvelteKit, or plain HTML)</h3>
      <Code>{`<script src="${api}/embed.js" async></script>
<ai-chatbot chatbot-id="${id}" api-url="${api}" theme="auto" position="bottom-right"></ai-chatbot>

<!-- Inline in your layout; style it with CSS variables -->
<ai-chatbot chatbot-id="${id}" api-url="${api}" mode="inline"
  style="display:block;height:560px;--aic-accent:#0f766e;--aic-font:Inter,sans-serif"></ai-chatbot>`}</Code>
      <p className="mt-2 text-xs text-zinc-500">
        Vue: add <code>compilerOptions.isCustomElement = tag =&gt; tag === &quot;ai-chatbot&quot;</code>. Angular: add <code>CUSTOM_ELEMENTS_SCHEMA</code>. Svelte uses it directly.
      </p>
      <h3 className="mt-4 font-medium">React / Next.js</h3>
      <Code>{`"use client";
import { AIChatbot } from "@chatbot/react"; // packages/react in the platform repo

export function SiteChat() {
  return <AIChatbot chatbotId="${id}" apiUrl="${api}" />;
}`}</Code>
      <h3 className="mt-4 font-medium">iframe (locked-down pages)</h3>
      <Code>{`<iframe src="${api}/embed/frame?chatbotId=${id}" title="Chat"
  style="width:100%;max-width:420px;height:560px;border:0" allow="microphone; clipboard-write"></iframe>`}</Code>
      <p className="mt-2 text-xs text-zinc-500">Only your allowed domains can frame it (CSP frame-ancestors). JavaScript API: <code>window.AIChatbot.mount(options)</code>, <code>window.AIChatbot.mountIframe(options)</code>; element events <code>ai-chatbot:open</code> and <code>ai-chatbot:close</code>.</p>

      <h2 className="mt-8 text-lg font-semibold">3. Call it from your server</h2>
      <p className="mb-2 text-sm text-zinc-600 dark:text-zinc-400">Create a private API key on your organization page. Never put it in browser code.</p>
      <Code>{`curl ${api}/api/v1/chat \\
  -H "Authorization: Bearer $CHATBOT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"chatbotId":"${id}","message":"What are your opening hours?"}'

# → {"sessionId":"…","reply":"…","citations":[{"n":1,"title":"Store hours",…}],"usage":{…}}
# Continue with "sessionId"; add "stream": true for Server-Sent Events.`}</Code>

      <h2 className="mt-8 text-lg font-semibold">4. Endpoint reference</h2>
      <div className="mt-2 flex flex-col gap-4">
        {Object.entries(spec.paths).map(([path, ops]) =>
          Object.entries(ops).map(([m, op]) => {
            const o = op as { summary: string; description?: string; tags: string[]; security?: Record<string, unknown>[]; responses: Record<string, { description?: string }> };
            return (
              <section key={`${m} ${path}`} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                <div className="flex flex-wrap items-center gap-2">
                  {method(m)}
                  <code className="text-sm">{path}</code>
                  <span className="text-xs text-zinc-500">{o.tags.join(", ")}</span>
                </div>
                <p className="mt-1 text-sm font-medium">{o.summary}</p>
                {o.description && <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{o.description}</p>}
                <p className="mt-1 text-xs text-zinc-500">
                  Auth: {o.security ? (Object.keys(o.security[0]!)[0] === "apiKey" ? "private API key" : "widget session token") : "none (allowed Origin required)"} · Responses:{" "}
                  {Object.keys(o.responses).join(", ")}
                </p>
              </section>
            );
          }),
        )}
      </div>

      <h2 className="mt-8 text-lg font-semibold">Errors and limits</h2>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Errors use one shape: <code>{`{"error":{"code":"…","message":"…"}}`}</code>. Rate limits answer <code>429</code> with <code>Retry-After</code>: 10 new
        widget sessions per minute per IP, 20 messages per minute per conversation, 120 API requests per minute per key.
      </p>
    </main>
  );
}
