import { listOrganizations } from "@chatbot/core";
import { ActionForm, Field } from "@/components/action-form";
import { Card, ItemList, Section } from "@/components/ui";
import { asUser } from "@/lib/session";
import { createOrganizationAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function OrganizationsPage() {
  const orgs = await asUser((db) => listOrganizations(db));
  return (
    <>
      <h1 className="text-2xl font-semibold">Organizations</h1>
      <Section title="Your organizations">
        <ItemList
          empty="You're not in any organization yet. Create one below."
          items={orgs.map((o) => ({ key: o.id, href: `/orgs/${o.id}`, title: o.name, meta: `${o.slug} · ${o.role}` }))}
        />
      </Section>
      <Section title="New organization">
        <Card>
          <ActionForm action={createOrganizationAction} submitLabel="Create organization">
            <Field label="Name" name="name" placeholder="Beyond AI" />
            <Field label="URL slug" name="slug" placeholder="beyond-ai" hint="Lowercase letters, digits and hyphens" />
          </ActionForm>
        </Card>
      </Section>
    </>
  );
}
