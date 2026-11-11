import { headers } from "next/headers";
import Link from "next/link";
import { getChatbot, getOrganization, getWebsite, getWorkspace, listChatbotKnowledge } from "@chatbot/core";
import { providerLabels } from "@chatbot/shared";
import { ActionForm, Field } from "@/components/action-form";
import { CopyBlock } from "@/components/copy-block";
import { Playground } from "@/components/playground";
import { embedSnippets } from "@/lib/snippets";
import { ProviderSelect, ProviderStatus } from "@/components/provider-select";
import { VoiceSettingsFields } from "@/components/voice-settings";
import { KnowledgeUpload } from "@/components/knowledge-upload";
import { AutoRefresh } from "@/components/auto-refresh";
import { getEmbedder } from "@/lib/knowledge";
import { Breadcrumbs, Card, Section } from "@/components/ui";
import { orNotFound } from "@/lib/load";
import { asUser } from "@/lib/session";
import { setChatbotStatusAction, updateChatbotAction } from "../../actions";
import { createSourceAction, setAssignmentAction, uploadFileAction } from "../../knowledge-actions";

export const dynamic = "force-dynamic";

const selectClass = "rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 dark:border-zinc-700";

export default async function ChatbotPage({ params }: { params: Promise<{ chatbotId: string }> }) {
  const { chatbotId } = await params;
  const { bot, site, ws, org, knowledge } = await orNotFound(
    asUser(async (db) => {
      const bot = await getChatbot(db, chatbotId);
      return {
        bot,
        site: await getWebsite(db, bot.website_id),
        ws: await getWorkspace(db, bot.workspace_id),
        org: await getOrganization(db, bot.organization_id),
        knowledge: await listChatbotKnowledge(db, bot.id),
      };
    }),
  );
  const canEdit = org.role === "owner" || org.role === "admin";
  const { embedder } = getEmbedder();
  const s = bot.settings;
  const h = await headers();
  const platformUrl =
    process.env.NEXT_PUBLIC_PLATFORM_URL ?? `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}`;
  const snippets = embedSnippets({ platformUrl, chatbotId: bot.public_id, position: s.position, theme: s.theme });
  const domains = site.domains.map((d) => d.domain);

  return (
    <>
      <Breadcrumbs
        items={[
          { label: "Organizations", href: "/orgs" },
          { label: org.name, href: `/orgs/${org.id}` },
          { label: ws.name, href: `/workspaces/${ws.id}` },
          { label: site.name, href: `/websites/${site.id}` },
          { label: s.name },
        ]}
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{s.name}</h1>
        <span className="rounded-full border border-zinc-300 px-2 py-0.5 text-xs dark:border-zinc-700">{bot.status}</span>
      </div>
      <p className="text-sm text-zinc-500">
        Public ID <code>{bot.public_id}</code>. This identifies the chatbot. It is not a secret and grants no access by itself.
      </p>

      {canEdit && (
        <Section title="Status">
          <div className="flex flex-wrap gap-2">
            {(["active", "paused", "draft", "archived"] as const)
              .filter((st) => st !== bot.status)
              .map((st) => (
                <ActionForm key={st} action={setChatbotStatusAction} submitLabel={`Set ${st}`} variant="subtle" className="flex">
                  <input type="hidden" name="chatbotId" value={bot.id} />
                  <input type="hidden" name="status" value={st} />
                </ActionForm>
              ))}
          </div>
        </Section>
      )}

      <Section
        title="Knowledge base"
        description="The chatbot answers from its own sources and from shared sources assigned to it, and cites them."
      >
        {canEdit && <div className="mb-4">
          <Card>
            <h3 className="font-medium">Add knowledge to this chatbot</h3>
            <p className="mb-4 mt-1 text-sm text-zinc-500">Upload a document directly into an existing source, or create a source with your first upload.</p>
            {!embedder && <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              No embedding provider is configured, so documents are searchable by keywords only. Add one, then choose Reprocess on a document for meaning-based search.
            </p>}
            <KnowledgeUpload action={uploadFileAction} chatbotId={bot.id} sources={knowledge.own.map(({ id, name }) => ({ id, name }))} />
          </Card>
        </div>}
        <AutoRefresh active={knowledge.own.some((source) => source.document_count > source.ready_count && source.processing_count > 0)} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <h3 className="text-sm font-medium">This chatbot&apos;s sources</h3>
            {knowledge.own.length === 0 ? (
              <p className="mt-2 text-sm text-zinc-500">None yet.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {knowledge.own.map((s) => (
                  <li key={s.id}>
                    <Link href={`/knowledge/${s.id}`} className="underline">
                      {s.name}
                    </Link>{" "}
                    <span className="text-zinc-500">
                      {s.ready_count}/{s.document_count} ready
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {canEdit && (
              <div className="mt-3">
                <ActionForm action={createSourceAction} submitLabel="Add source" variant="subtle">
                  <input type="hidden" name="chatbotId" value={bot.id} />
                  <Field label="New source name" name="name" placeholder="Product FAQ" />
                </ActionForm>
              </div>
            )}
          </Card>
          <Card>
            <h3 className="text-sm font-medium">Shared sources</h3>
            {knowledge.global.length === 0 ? (
              <p className="mt-2 text-sm text-zinc-500">
                None in this organization.{" "}
                <Link href={`/orgs/${org.id}/knowledge`} className="underline">
                  Manage knowledge
                </Link>
              </p>
            ) : (
              <ul className="mt-2 space-y-2 text-sm">
                {knowledge.global.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2">
                    <span>
                      <Link href={`/knowledge/${s.id}`} className="underline">
                        {s.name}
                      </Link>{" "}
                      <span className="text-zinc-500">{s.assigned ? "assigned" : "not assigned"}</span>
                    </span>
                    {canEdit && (
                      <ActionForm action={setAssignmentAction} submitLabel={s.assigned ? "Unassign" : "Assign"} variant="subtle" className="flex">
                        <input type="hidden" name="chatbotId" value={bot.id} />
                        <input type="hidden" name="sourceId" value={s.id} />
                        <input type="hidden" name="assigned" value={s.assigned ? "false" : "true"} />
                      </ActionForm>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </Section>

      <Section title="Settings">
        <Card>
          {canEdit ? (
            <ActionForm action={updateChatbotAction} submitLabel="Save settings" className="grid gap-4 sm:grid-cols-2">
              <input type="hidden" name="chatbotId" value={bot.id} />
              <Field label="Name" name="name" defaultValue={s.name} />
              <ProviderSelect name="provider" label="Provider" defaultValue={s.provider} />
              <Field label="Model" name="model" defaultValue={s.model} />
              <Field label="Temperature" name="temperature" type="number" defaultValue={s.temperature} hint="0 to 2" />
              <Field label="Max output tokens" name="maxOutputTokens" type="number" defaultValue={s.maxOutputTokens} hint="64 to 8192" />
              <ProviderSelect name="fallbackProvider" label="Fallback provider" defaultValue={s.fallbacks[0]?.provider ?? ""} allowNone />
              <Field label="Fallback model" name="fallbackModel" defaultValue={s.fallbacks[0]?.model ?? ""} required={false} hint="Used if the main model fails before answering" />
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">Position</span>
                <select name="position" defaultValue={s.position} className={selectClass}>
                  <option value="bottom-right">Bottom right</option>
                  <option value="bottom-left">Bottom left</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">Theme</span>
                <select name="theme" defaultValue={s.theme} className={selectClass}>
                  <option value="auto">Automatic</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
              <div className="sm:col-span-2">
                <Field label="Welcome message" name="welcomeMessage" defaultValue={s.welcomeMessage} wide />
              </div>
              <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                <span className="font-medium">System prompt</span>
                <textarea name="systemPrompt" defaultValue={s.systemPrompt} rows={5} className={selectClass} />
              </label>
              <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                <span className="font-medium">Suggested questions</span>
                <textarea name="suggestedQuestions" defaultValue={s.suggestedQuestions.join("\n")} rows={3} className={selectClass} />
                <span className="text-xs text-zinc-500">One per line, up to 6</span>
              </label>
              <VoiceSettingsFields voice={s.voice} />
            </ActionForm>
          ) : (
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div><dt className="text-zinc-500">Provider / model</dt><dd>{providerLabels[s.provider]} / {s.model}</dd></div>
              <div><dt className="text-zinc-500">Temperature</dt><dd>{s.temperature}</dd></div>
              <div className="sm:col-span-2"><dt className="text-zinc-500">Welcome message</dt><dd>{s.welcomeMessage}</dd></div>
            </dl>
          )}
        </Card>
      </Section>

      {canEdit && (
        <Section
          title="Test chat"
          description="Talk to this chatbot with its current saved settings. Test conversations are stored and count toward usage."
        >
          <Playground chatbotId={bot.id} welcomeMessage={s.welcomeMessage} />
        </Section>
      )}

      <Section title="AI providers" description="Credentials live in server environment variables and are never sent to the browser.">
        <ProviderStatus />
      </Section>

      <Section
        title="Install on a website"
        description="Pick one method. The chatbot ID in these snippets is public; it only works on the allowed domains below."
      >
        <div
          className={`mb-4 rounded-lg border p-3 text-sm ${
            bot.status === "active" ? "border-emerald-300 dark:border-emerald-800" : "border-amber-300 dark:border-amber-700"
          }`}
        >
          <p>
            {bot.status === "active"
              ? "Status: active. The widget will load on the allowed domains."
              : `Status: ${bot.status}. Set the chatbot to active before it can be used on a website.`}
          </p>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            Allowed domains (and their subdomains): {domains.join(", ")}.{" "}
            <Link href={`/websites/${site.id}`} className="underline">
              Manage domains
            </Link>
            . Other websites are refused, including over plain http (except localhost).
          </p>
        </div>
        <div className="grid gap-4">
          <CopyBlock label="JavaScript snippet (any website: HTML, WordPress, Shopify, Webflow, Wix, PHP, Django, ASP.NET…)" code={snippets.script} />
          <CopyBlock label="Web Component" code={snippets.webComponent} />
          <CopyBlock label="iframe" code={snippets.iframe} />
          <CopyBlock label="React / Next.js" code={snippets.react} />
          <CopyBlock label="REST API (server-to-server, needs a private API key from the organization page)" code={snippets.rest} />
        </div>
      </Section>
    </>
  );
}
