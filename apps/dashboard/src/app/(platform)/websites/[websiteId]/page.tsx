import { getOrganization, getWebsite, getWorkspace, listChatbots } from "@chatbot/core";
import { ActionForm, Field } from "@/components/action-form";
import { ProviderSelect } from "@/components/provider-select";
import { Breadcrumbs, Card, ItemList, Section } from "@/components/ui";
import { orNotFound } from "@/lib/load";
import { asUser } from "@/lib/session";
import { addDomainAction, createChatbotAction, removeDomainAction } from "../../actions";

export const dynamic = "force-dynamic";

export default async function WebsitePage({ params }: { params: Promise<{ websiteId: string }> }) {
  const { websiteId } = await params;
  const { org, ws, site, bots } = await orNotFound(
    asUser(async (db) => {
      const site = await getWebsite(db, websiteId);
      const [ws, org, bots] = [
        await getWorkspace(db, site.workspace_id),
        await getOrganization(db, site.organization_id),
        await listChatbots(db, site.id),
      ];
      return { site, ws, org, bots };
    }),
  );
  const canEdit = org.role === "owner" || org.role === "admin";
  return (
    <>
      <Breadcrumbs
        items={[
          { label: "Organizations", href: "/orgs" },
          { label: org.name, href: `/orgs/${org.id}` },
          { label: ws.name, href: `/workspaces/${ws.id}` },
          { label: site.name },
        ]}
      />
      <h1 className="mt-2 text-2xl font-semibold">{site.name}</h1>

      <Section title="Allowed domains" description="The widget and chat API will accept requests only from these hosts and their subdomains.">
        <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {site.domains.map((d) => (
            <li key={d.id} className="flex items-center justify-between px-4 py-2 text-sm">
              <code>{d.domain}</code>
              {canEdit && site.domains.length > 1 && (
                <ActionForm action={removeDomainAction} submitLabel="Remove" variant="danger" className="flex">
                  <input type="hidden" name="websiteId" value={site.id} />
                  <input type="hidden" name="domainId" value={d.id} />
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
        {canEdit && (
          <div className="mt-3">
            <ActionForm action={addDomainAction} submitLabel="Add domain" variant="subtle">
              <input type="hidden" name="websiteId" value={site.id} />
              <Field label="Domain" name="domain" placeholder="blog.example.com" />
            </ActionForm>
          </div>
        )}
      </Section>

      <Section title="Chatbots">
        <ItemList
          empty="No chatbots yet."
          items={bots.map((b) => ({
            key: b.id,
            href: `/chatbots/${b.id}`,
            title: b.settings.name,
            meta: `${b.status} · ${b.settings.provider} / ${b.settings.model}`,
          }))}
        />
      </Section>
      {canEdit && (
        <Section title="New chatbot">
          <Card>
            <ActionForm action={createChatbotAction} submitLabel="Create chatbot">
              <input type="hidden" name="websiteId" value={site.id} />
              <Field label="Name" name="name" placeholder="Support assistant" />
              <ProviderSelect name="provider" label="Provider" />
              <Field label="Model" name="model" placeholder="gpt-4.1-mini" />
            </ActionForm>
          </Card>
        </Section>
      )}
    </>
  );
}
