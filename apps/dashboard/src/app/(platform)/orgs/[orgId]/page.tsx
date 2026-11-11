import Link from "next/link";
import { getOrganization, listApiKeys, listWorkspaces } from "@chatbot/core";
import { ActionForm, Field } from "@/components/action-form";
import { Breadcrumbs, Card, ItemList, Section } from "@/components/ui";
import { orNotFound } from "@/lib/load";
import { asUser } from "@/lib/session";
import { createWorkspaceAction } from "../../actions";
import { ApiKeys } from "./api-keys";

export const dynamic = "force-dynamic";

export default async function OrganizationPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { org, workspaces, keys } = await orNotFound(
    asUser(async (db) => {
      const org = await getOrganization(db, orgId);
      const keys = org.role === "owner" || org.role === "admin" ? await listApiKeys(db, orgId) : [];
      return { org, workspaces: await listWorkspaces(db, orgId), keys };
    }),
  );
  const canEdit = org.role === "owner" || org.role === "admin";
  return (
    <>
      <Breadcrumbs items={[{ label: "Organizations", href: "/orgs" }, { label: org.name }]} />
      <h1 className="mt-2 text-2xl font-semibold">{org.name}</h1>
      <p className="text-sm text-zinc-500">
        Your role: {org.role} ·{" "}
        <Link href={`/orgs/${org.id}/knowledge`} className="underline">
          Knowledge
        </Link>
      </p>
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
      {canEdit && (
        <Section
          title="API keys"
          description="Private keys let your servers call the chat API (POST /api/v1/chat) for any active chatbot in this organization. Keep them server-side."
        >
          <ApiKeys
            organizationId={org.id}
            keys={keys.map((k) => ({
              id: k.id,
              name: k.name,
              prefix: k.key_prefix,
              created: k.created_at.toISOString().slice(0, 10),
              lastUsed: k.last_used_at ? k.last_used_at.toISOString().slice(0, 16).replace("T", " ") : null,
              revoked: !!k.revoked_at,
            }))}
          />
        </Section>
      )}
    </>
  );
}
