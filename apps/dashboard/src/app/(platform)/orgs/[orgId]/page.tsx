import { getOrganization, listWorkspaces } from "@chatbot/core";
import { ActionForm, Field } from "@/components/action-form";
import { Breadcrumbs, Card, ItemList, Section } from "@/components/ui";
import { orNotFound } from "@/lib/load";
import { asUser } from "@/lib/session";
import { createWorkspaceAction } from "../../actions";

export const dynamic = "force-dynamic";

export default async function OrganizationPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { org, workspaces } = await orNotFound(
    asUser(async (db) => ({ org: await getOrganization(db, orgId), workspaces: await listWorkspaces(db, orgId) })),
  );
  const canEdit = org.role === "owner" || org.role === "admin";
  return (
    <>
      <Breadcrumbs items={[{ label: "Organizations", href: "/orgs" }, { label: org.name }]} />
      <h1 className="mt-2 text-2xl font-semibold">{org.name}</h1>
      <p className="text-sm text-zinc-500">Your role: {org.role}</p>
      <Section title="Workspaces">
        <ItemList
          empty="No workspaces yet."
          items={workspaces.map((w) => ({ key: w.id, href: `/workspaces/${w.id}`, title: w.name, meta: w.slug }))}
        />
      </Section>
      {canEdit && (
        <Section title="New workspace">
          <Card>
            <ActionForm action={createWorkspaceAction} submitLabel="Create workspace">
              <input type="hidden" name="organizationId" value={org.id} />
              <Field label="Name" name="name" placeholder="Marketing sites" />
              <Field label="URL slug" name="slug" placeholder="marketing" />
            </ActionForm>
          </Card>
        </Section>
      )}
    </>
  );
}
