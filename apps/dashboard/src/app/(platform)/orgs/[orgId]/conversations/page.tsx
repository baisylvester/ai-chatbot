import Link from "next/link";
import { analyticsFilterOptions, getOrganization, getRetention, listConversations } from "@chatbot/core";
import { ActionForm } from "@/components/action-form";
import { Breadcrumbs, Card, Section } from "@/components/ui";
import { orNotFound } from "@/lib/load";
import { asUser } from "@/lib/session";
import { setRetentionAction } from "../../../history-actions";

export const dynamic = "force-dynamic";

const selectClass = "rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700";
const sourceLabel: Record<string, string> = { widget: "Widget", api: "REST API", playground: "Test chat" };

export default async function ConversationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const { org, list, options, retention } = await orNotFound(
    asUser(async (db) => ({
      org: await getOrganization(db, orgId),
      options: await analyticsFilterOptions(db, orgId),
      retention: await getRetention(db, orgId),
      list: await listConversations(db, { organizationId: orgId, chatbotId: sp.chatbot, source: sp.source, from: sp.from, to: sp.to, page }),
    })),
  );
  const canEdit = org.role === "owner" || org.role === "admin";
  const qs = (p: number) => {
    const q = new URLSearchParams(Object.entries({ ...sp, page: String(p) }).filter(([, v]) => v) as [string, string][]);
    return `?${q.toString()}`;
  };

  return (
    <>
      <Breadcrumbs items={[{ label: "Organizations", href: "/orgs" }, { label: org.name, href: `/orgs/${org.id}` }, { label: "Conversations" }]} />
      <h1 className="mt-2 text-2xl font-semibold">Conversations</h1>

      <form method="get" className="mt-4 flex flex-wrap items-end gap-2" aria-label="Filters">
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Chatbot
          <select name="chatbot" defaultValue={sp.chatbot ?? ""} className={selectClass}>
            <option value="">All</option>
            {options.chatbots.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Channel
          <select name="source" defaultValue={sp.source ?? ""} className={selectClass}>
            <option value="">All</option>
            <option value="widget">Website widget</option>
            <option value="api">REST API</option>
            <option value="playground">Test chat</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          From
          <input type="date" name="from" defaultValue={sp.from ?? ""} className={selectClass} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          To
          <input type="date" name="to" defaultValue={sp.to ?? ""} className={selectClass} />
        </label>
        <button type="submit" className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-zinc-900">
          Apply
        </button>
        <Link href="?" className="text-sm text-zinc-500 underline">
          Reset
        </Link>
      </form>

      <Section title={`Page ${list.page}`}>
        {list.items.length === 0 ? (
          <p className="text-sm text-zinc-500">No conversations match these filters.</p>
        ) : (
          <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {list.items.map((c) => (
              <li key={c.id}>
                <Link href={`/conversations/${c.id}`} className="block px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900">
                  <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                    <span className="font-medium">{c.chatbot_name}</span>
                    <span className="text-xs text-zinc-500">
                      {sourceLabel[c.source] ?? c.source}
                      {c.origin ? ` · ${c.origin}` : ""} · {c.message_count} messages · {c.created_at.toISOString().slice(0, 16).replace("T", " ")} UTC
                    </span>
                  </div>
                  {c.preview && <p className="mt-1 truncate text-sm text-zinc-600 dark:text-zinc-400">{c.preview}</p>}
                </Link>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex gap-3 text-sm">
          {list.page > 1 && (
            <Link href={qs(list.page - 1)} className="underline">
              ← Newer
            </Link>
          )}
          {list.hasMore && (
            <Link href={qs(list.page + 1)} className="underline">
              Older →
            </Link>
          )}
        </div>
      </Section>

      <Section
        title="Retention"
        description="Conversations older than this are deleted automatically, with their messages and voice transcripts. Usage counts for billing and analytics are kept without the conversation text."
      >
        <Card>
          <p className="mb-3 text-sm">Current setting: {retention ? `delete after ${retention} days` : "keep until deleted"}.</p>
          {canEdit ? (
            <ActionForm action={setRetentionAction} submitLabel="Save retention">
              <input type="hidden" name="organizationId" value={org.id} />
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">Keep conversations for</span>
                <select name="days" defaultValue={retention ? String(retention) : ""} className={selectClass}>
                  <option value="">Until deleted</option>
                  {[7, 30, 90, 180, 365, 730].map((d) => (
                    <option key={d} value={d}>
                      {d} days
                    </option>
                  ))}
                </select>
              </label>
            </ActionForm>
          ) : (
            <p className="text-sm text-zinc-500">Only owners and admins can change retention.</p>
          )}
        </Card>
      </Section>
    </>
  );
}
