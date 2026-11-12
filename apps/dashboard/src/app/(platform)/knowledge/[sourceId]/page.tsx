import { getOrganization, getKnowledgeSource, listDocuments } from "@chatbot/core";
import { ActionForm, Field } from "@/components/action-form";
import { AutoRefresh } from "@/components/auto-refresh";
import { KnowledgeUpload } from "@/components/knowledge-upload";
import { Breadcrumbs, Card, Section } from "@/components/ui";
import { getEmbedder } from "@/lib/knowledge";
import { orNotFound } from "@/lib/load";
import { asUser } from "@/lib/session";
import {
  addTextAction,
  addUrlAction,
  deleteDocumentAction,
  deleteSourceAction,
  reprocessDocumentAction,
  uploadFileAction,
} from "../../knowledge-actions";

export const dynamic = "force-dynamic";

const statusStyle: Record<string, string> = {
  ready: "text-emerald-700 dark:text-emerald-500",
  failed: "text-red-600",
  pending: "text-zinc-500",
  processing: "text-amber-700 dark:text-amber-500",
};

function formatBytes(n: number | null) {
  if (n == null) return "";
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default async function KnowledgeSourcePage({ params }: { params: Promise<{ sourceId: string }> }) {
  const { sourceId } = await params;
  const { source, org, docs } = await orNotFound(
    asUser(async (db) => {
      const source = await getKnowledgeSource(db, sourceId);
      return { source, org: await getOrganization(db, source.organization_id), docs: await listDocuments(db, source.id) };
    }),
  );
  const canEdit = org.role === "owner" || org.role === "admin";
  const busy = docs.some((d) => d.status === "pending" || d.status === "processing");
  const { embedder } = getEmbedder();
  const back = source.scope === "chatbot" && source.chatbot_id ? `/chatbots/${source.chatbot_id}` : `/orgs/${org.id}/knowledge`;

  return (
    <>
      <Breadcrumbs
        items={[
          { label: "Organizations", href: "/orgs" },
          { label: org.name, href: `/orgs/${org.id}` },
          { label: "Knowledge", href: `/orgs/${org.id}/knowledge` },
          { label: source.name },
        ]}
      />
      <h1 className="mt-2 text-2xl font-semibold">{source.name}</h1>
      <p className="text-sm text-zinc-500">
        {source.scope === "global"
          ? `Shared source · assigned to ${source.assigned_chatbots} chatbot${source.assigned_chatbots === 1 ? "" : "s"}`
          : `Only for ${source.chatbot_name ?? "one chatbot"}`}
        {source.description ? ` · ${source.description}` : ""}
      </p>
      {!embedder && <p className="mt-2 text-sm text-amber-700 dark:text-amber-500">No embedding provider is configured, so documents are searchable by keywords only. Add one, then choose Reprocess on a document for meaning-based search.</p>}

      <Section title="Documents">
        <AutoRefresh active={busy} />
        {docs.length === 0 ? (
          <p className="text-sm text-zinc-500">No documents yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {docs.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{d.title}</div>
                  <div className="text-xs text-zinc-500">
                    {d.source_type === "url" && d.source_url ? (
                      <a href={d.source_url} target="_blank" rel="noopener noreferrer" className="underline">
                        {d.source_url}
                      </a>
                    ) : (
                      d.source_type
                    )}
                    {d.size_bytes != null && ` · ${formatBytes(d.size_bytes)}`}
                    {d.status === "ready" && ` · ${d.chunk_count} chunks · ${d.embedding_model ?? "keyword search only"}`}
                  </div>
                  {d.error && <div className="text-xs text-red-600">{d.error}</div>}
                </div>
                <span className={`text-xs font-medium ${statusStyle[d.status]}`}>{d.status}</span>
                {canEdit && (
                  <div className="flex gap-1">
                    <ActionForm action={reprocessDocumentAction} submitLabel="Reprocess" variant="subtle" className="flex">
                      <input type="hidden" name="documentId" value={d.id} />
                    </ActionForm>
                    <ActionForm action={deleteDocumentAction} submitLabel="Delete" variant="danger" className="flex">
                      <input type="hidden" name="documentId" value={d.id} />
                    </ActionForm>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {canEdit && (
        <>
          <Section title="Upload files" description="PDF, Word (.doc or .docx), TXT, Markdown or HTML, up to 10 MB each. Add several at once.">
            <Card>
              <KnowledgeUpload action={uploadFileAction} sourceId={source.id} />
            </Card>
          </Section>

          <Section title="Add a web page" description="The page is fetched once now; use Reprocess to fetch it again later. Only public websites can be imported.">
            <Card>
              <ActionForm action={addUrlAction} submitLabel="Add page">
                <input type="hidden" name="sourceId" value={source.id} />
                <Field label="URL" name="url" type="url" placeholder="https://example.com/faq" />
              </ActionForm>
            </Card>
          </Section>

          <Section title="Add text">
            <Card>
              <ActionForm action={addTextAction} submitLabel="Add text" className="flex flex-col gap-3">
                <input type="hidden" name="sourceId" value={source.id} />
                <Field label="Title" name="title" placeholder="Opening hours" />
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">Text</span>
                  <textarea
                    name="content"
                    required
                    rows={6}
                    className="rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 dark:border-zinc-700"
                  />
                </label>
              </ActionForm>
            </Card>
          </Section>

          <Section title="Delete source" description="Deletes this source, all its documents and their search data. This can't be undone.">
            <ActionForm action={deleteSourceAction} submitLabel="Delete source" variant="danger">
              <input type="hidden" name="sourceId" value={source.id} />
              <input type="hidden" name="returnTo" value={back} />
            </ActionForm>
          </Section>
        </>
      )}
    </>
  );
}
