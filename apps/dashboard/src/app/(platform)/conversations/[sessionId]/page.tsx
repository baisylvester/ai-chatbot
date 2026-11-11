import { getConversation, getOrganization } from "@chatbot/core";
import { ActionForm } from "@/components/action-form";
import { Breadcrumbs, Section } from "@/components/ui";
import { orNotFound } from "@/lib/load";
import { asUser } from "@/lib/session";
import { deleteConversationAction } from "../../history-actions";

export const dynamic = "force-dynamic";

const sourceLabel: Record<string, string> = { widget: "Website widget", api: "REST API", playground: "Dashboard test chat" };

export default async function ConversationPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const { convo, org } = await orNotFound(
    asUser(async (db) => {
      const convo = await getConversation(db, sessionId);
      return { convo, org: await getOrganization(db, convo.organization_id) };
    }),
  );
  const canEdit = org.role === "owner" || org.role === "admin";

  return (
    <>
      <Breadcrumbs
        items={[
          { label: "Organizations", href: "/orgs" },
          { label: org.name, href: `/orgs/${org.id}` },
          { label: "Conversations", href: `/orgs/${org.id}/conversations` },
          { label: convo.created_at.toISOString().slice(0, 16).replace("T", " ") },
        ]}
      />
      <h1 className="mt-2 text-2xl font-semibold">{convo.chatbot_name}</h1>
      <p className="text-sm text-zinc-500">
        {sourceLabel[convo.source] ?? convo.source}
        {convo.origin ? ` · ${convo.origin}` : ""} · started {convo.created_at.toISOString().slice(0, 16).replace("T", " ")} UTC
      </p>

      <Section title={`Transcript (${convo.messages.length} messages)`}>
        <ol className="flex flex-col gap-3">
          {convo.messages.map((m, i) => (
            <li key={i} className={`flex max-w-[85%] flex-col gap-1 ${m.role === "user" ? "self-end items-end" : "self-start"}`}>
              <div
                className={`whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                  m.role === "user" ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900" : "bg-zinc-100 dark:bg-zinc-900"
                }`}
              >
                {m.content}
              </div>
              <span className="text-xs text-zinc-500">
                {m.role === "user" ? "Visitor" : m.model ? `${m.provider} / ${m.model}` : "Assistant"} · {m.created_at.toISOString().slice(11, 16)} UTC
              </span>
              {m.citations.length > 0 && (
                <ul className="text-xs text-zinc-600 dark:text-zinc-400">
                  {m.citations.map((c) => (
                    <li key={c.n}>
                      [{c.n}] {c.title}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      </Section>

      {canEdit && (
        <Section title="Delete conversation" description="Removes this transcript permanently (for example, when a visitor asks for their data to be deleted). This can't be undone.">
          <ActionForm action={deleteConversationAction} submitLabel="Delete conversation" variant="danger">
            <input type="hidden" name="sessionId" value={convo.id} />
            <input type="hidden" name="organizationId" value={org.id} />
          </ActionForm>
        </Section>
      )}
    </>
  );
}
