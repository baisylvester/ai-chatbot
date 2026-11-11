import { getOrganization, getWorkspace, listWebsites } from "@chatbot/core";
import { ActionForm, Field } from "@/components/action-form";
import { Breadcrumbs, Card, ItemList, Section } from "@/components/ui";
import { orNotFound } from "@/lib/load";
import { asUser } from "@/lib/session";
import { createWebsiteAction } from "../../actions";

export const dynamic = "force-dynamic";

export default async function WorkspacePage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { org, ws, websites } = await orNotFound(
    asUser(async (db) => {
      const ws = await getWorkspace(db, workspaceId);
      return { ws, org: await getOrganization(db, ws.organization_id), websites: await listWebsites(db, ws.id) };
    }),
  );
  const canEdit = org.role === "owner" || org.role === "admin";
  return (
    <>
      <Breadcrumbs
        items={[{ label: "Organizations", href: "/orgs" }, { label: org.name, href: `/orgs/${org.id}` }, { label: ws.name }]}
      />
      <h1 className="mt-2 text-2xl font-semibold">{ws.name}</h1>
      <Section title="Websites">
        <ItemList
          empty="No websites yet."
          items={websites.map((w) => ({
            key: w.id,
            href: `/websites/${w.id}`,
            title: w.name,
            meta: w.domains.map((d) => d.domain).join(", "),
          }))}
        />
      </Section>
      {canEdit && (
        <Section title="New website" description="The chatbot widget will only load on these domains and their subdomains.">
          <Card>
            <ActionForm action={createWebsiteAction} submitLabel="Add website">
              <input type="hidden" name="workspaceId" value={ws.id} />
              <Field label="Name" name="name" placeholder="Company site" />
              <Field label="Domains" name="domains" placeholder="example.com, shop.example.com" hint="Comma-separated hostnames, no https://" />
            </ActionForm>
          </Card>
        </Section>
      )}
    </>
  );
}
