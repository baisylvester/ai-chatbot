import { headers } from "next/headers";
import { getChatbot, getOrganization, getWebsite, getWorkspace } from "@chatbot/core";
import { ActionForm, Field } from "@/components/action-form";
import { Breadcrumbs, Card, Section } from "@/components/ui";
import { orNotFound } from "@/lib/load";
import { asUser } from "@/lib/session";
import { setChatbotStatusAction, updateChatbotAction } from "../../actions";

export const dynamic = "force-dynamic";

const selectClass = "rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 dark:border-zinc-700";

export default async function ChatbotPage({ params }: { params: Promise<{ chatbotId: string }> }) {
  const { chatbotId } = await params;
  const { bot, site, ws, org } = await orNotFound(
    asUser(async (db) => {
      const bot = await getChatbot(db, chatbotId);
      return {
        bot,
        site: await getWebsite(db, bot.website_id),
        ws: await getWorkspace(db, bot.workspace_id),
        org: await getOrganization(db, bot.organization_id),
      };
    }),
  );
  const canEdit = org.role === "owner" || org.role === "admin";
  const s = bot.settings;
  const h = await headers();
  const platformUrl =
    process.env.NEXT_PUBLIC_PLATFORM_URL ?? `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}`;
  const snippet = `<script>
  window.AIChatbotConfig = { chatbotId: "${bot.public_id}", apiUrl: "${platformUrl}", position: "${s.position}", theme: "${s.theme}" };
</script>
<script src="${platformUrl}/embed.js" async></script>`;

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

      <Section title="Settings">
        <Card>
          {canEdit ? (
            <ActionForm action={updateChatbotAction} submitLabel="Save settings" className="grid gap-4 sm:grid-cols-2">
              <input type="hidden" name="chatbotId" value={bot.id} />
              <Field label="Name" name="name" defaultValue={s.name} />
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">Provider</span>
                <select name="provider" defaultValue={s.provider} className={selectClass}>
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="gemini">Google Gemini</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="openai-compatible">OpenAI-compatible</option>
                </select>
              </label>
              <Field label="Model" name="model" defaultValue={s.model} />
              <Field label="Temperature" name="temperature" type="number" defaultValue={s.temperature} hint="0 to 2" />
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
            </ActionForm>
          ) : (
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div><dt className="text-zinc-500">Provider / model</dt><dd>{s.provider} / {s.model}</dd></div>
              <div><dt className="text-zinc-500">Temperature</dt><dd>{s.temperature}</dd></div>
              <div className="sm:col-span-2"><dt className="text-zinc-500">Welcome message</dt><dd>{s.welcomeMessage}</dd></div>
            </dl>
          )}
        </Card>
      </Section>

      <Section
        title="Embed code"
        description="Preview of the install snippet. The embed script and chat API arrive in Phase 5, so this snippet does not work on a site yet."
      >
        <pre className="overflow-x-auto rounded-lg bg-zinc-100 p-4 text-xs dark:bg-zinc-900">
          <code>{snippet}</code>
        </pre>
      </Section>
    </>
  );
}
