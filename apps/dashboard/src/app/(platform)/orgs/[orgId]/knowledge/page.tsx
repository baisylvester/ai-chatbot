import { getOrganization, listKnowledgeSources } from "@chatbot/core";
import { ActionForm, Field } from "@/components/action-form";
import { Breadcrumbs, Card, ItemList, Section } from "@/components/ui";
import { getEmbedder } from "@/lib/knowledge";
import { orNotFound } from "@/lib/load";
import { asUser } from "@/lib/session";
import { createSourceAction } from "../../../knowledge-actions";

export const dynamic = "force-dynamic";

export default async function OrgKnowledgePage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { org, sources } = await orNotFound(
    asUser(async (db) => ({ org: await getOrganization(db, orgId), sources: await listKnowledgeSources(db, orgId) })),
  );
  const canEdit = org.role === "owner" || org.role === "admin";
  const { embedder, problem } = getEmbedder();
  const describe = (s: (typeof sources)[number]) =>
    `${s.ready_count}/${s.document_count} ready · ${
      s.scope === "global" ? `shared, assigned to ${s.assigned_chatbots} chatbot${s.assigned_chatbots === 1 ? "" : "s"}` : `only ${s.chatbot_name ?? "one chatbot"}`
    }`;

  return (
    <>
      <Breadcrumbs items={[{ label: "Organizations", href: "/orgs" }, { label: org.name, href: `/orgs/${org.id}` }, { label: "Knowledge" }]} />
      <h1 className="mt-2 text-2xl font-semibold">Knowledge</h1>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Shared sources can be assigned to any chatbot in this organization. A chatbot never sees shared knowledge unless it is assigned.
      </p>
      <p className={`mt-2 text-sm ${embedder ? "text-zinc-500" : "text-amber-700 dark:text-amber-500"}`}>
        {embedder ? `Embeddings: ${embedder.modelId}` : `Documents can't be processed yet: ${problem}`}
      </p>

      <Section title="Shared sources">
        <ItemList
          empty="No shared sources yet."
          items={sources.filter((s) => s.scope === "global").map((s) => ({ key: s.id, href: `/knowledge/${s.id}`, title: s.name, meta: describe(s) }))}
        />
      </Section>
      <Section title="Chatbot-only sources" description="Created from a chatbot's page; searchable only by that chatbot.">
        <ItemList
          empty="None yet."
          items={sources.filter((s) => s.scope === "chatbot").map((s) => ({ key: s.id, href: `/knowledge/${s.id}`, title: s.name, meta: describe(s) }))}
        />
      </Section>

      {canEdit && (
        <Section title="New shared source">
          <Card>
            <ActionForm action={createSourceAction} submitLabel="Create source">
              <input type="hidden" name="organizationId" value={org.id} />
              <Field label="Name" name="name" placeholder="Company policies" />
              <Field label="Description" name="description" required={false} placeholder="Optional" />
            </ActionForm>
          </Card>
        </Section>
      )}
    </>
  );
}
