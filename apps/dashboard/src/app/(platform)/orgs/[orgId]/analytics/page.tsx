import Link from "next/link";
import { after } from "next/server";
import { analyticsFilterOptions, getAnalytics, getOrganization, purgeExpiredData } from "@chatbot/core";
import { withTrustedContext } from "@chatbot/database";
import { PRICES_AS_OF, providerLabels, type Provider } from "@chatbot/shared";
import { DailyColumns } from "@/components/charts";
import { BarList, StatTile, StatusNote } from "@/components/stats";
import { Breadcrumbs, Card, Section } from "@/components/ui";
import { getPool } from "@/lib/db";
import { orNotFound } from "@/lib/load";
import { asUser } from "@/lib/session";

export const dynamic = "force-dynamic";

type Search = Record<string, string | undefined>;

const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const selectClass = "rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700";
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");
const usd = (n: number | null) => (n === null ? "—" : n < 0.01 && n > 0 ? "< $0.01" : `$${n.toFixed(2)}`);
const providerName = (p: string) => providerLabels[p as Provider] ?? p;

export default async function AnalyticsPage({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<Search> }) {
  const { orgId } = await params;
  const sp = await searchParams;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(sp.to ?? "") ? sp.to! : day(0);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? "") ? sp.from! : day(29);
  const filters = {
    organizationId: orgId,
    from,
    to,
    workspaceId: sp.workspace || undefined,
    websiteId: sp.website || undefined,
    chatbotId: sp.chatbot || undefined,
    provider: sp.provider || undefined,
  };

  const { org, report, options, error } = await orNotFound(
    asUser(async (db) => {
      const org = await getOrganization(db, orgId);
      const options = await analyticsFilterOptions(db, orgId);
      try {
        return { org, options, report: await getAnalytics(db, filters), error: null };
      } catch (err) {
        return { org, options, report: await getAnalytics(db, { organizationId: orgId, from: day(29), to: day(0) }), error: (err as Error).message };
      }
    }),
  );

  // Apply this organization's retention policy in the background (cheap, idempotent).
  after(async () => {
    try {
      await withTrustedContext(getPool(), (db) => purgeExpiredData(db, orgId));
    } catch (err) {
      console.error("retention purge failed", err);
    }
  });

  const t = report.totals;
  const quick = (days: number) => `?from=${day(days - 1)}&to=${day(0)}${filters.chatbotId ? `&chatbot=${filters.chatbotId}` : ""}`;

  return (
    <>
      <Breadcrumbs items={[{ label: "Organizations", href: "/orgs" }, { label: org.name, href: `/orgs/${org.id}` }, { label: "Analytics" }]} />
      <h1 className="mt-2 text-2xl font-semibold">Analytics</h1>

      <form method="get" className="mt-4 flex flex-wrap items-end gap-2" aria-label="Filters">
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          From
          <input type="date" name="from" defaultValue={from} className={selectClass} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          To
          <input type="date" name="to" defaultValue={to} className={selectClass} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Workspace
          <select name="workspace" defaultValue={filters.workspaceId ?? ""} className={selectClass}>
            <option value="">All</option>
            {options.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Website
          <select name="website" defaultValue={filters.websiteId ?? ""} className={selectClass}>
            <option value="">All</option>
            {options.websites.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Chatbot
          <select name="chatbot" defaultValue={filters.chatbotId ?? ""} className={selectClass}>
            <option value="">All</option>
            {options.chatbots.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Provider
          <select name="provider" defaultValue={filters.provider ?? ""} className={selectClass}>
            <option value="">All</option>
            {options.providers.map((p) => (
              <option key={p} value={p}>
                {providerName(p)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-zinc-900">
          Apply
        </button>
        <span className="flex gap-2 text-sm">
          {[7, 30, 90].map((d) => (
            <Link key={d} href={quick(d)} className="underline">
              {d} days
            </Link>
          ))}
          <Link href="?" className="text-zinc-500 underline">
            Reset
          </Link>
        </span>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error} Showing the last 30 days instead.
        </p>
      )}
      {filters.provider && <p className="mt-2 text-xs text-zinc-500">The provider filter applies to model usage (tokens, cost, failures, voice). Conversation counts include all providers.</p>}

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Conversations" value={t.conversations.toLocaleString()} hint={`${t.uniqueVisitors.toLocaleString()} unique visitors`} />
        <StatTile label="Messages" value={t.messages.toLocaleString()} hint={`${t.visitorMessages.toLocaleString()} from visitors`} />
        <StatTile label="Tokens" value={(t.inputTokens + t.outputTokens).toLocaleString()} hint={`${t.inputTokens.toLocaleString()} in · ${t.outputTokens.toLocaleString()} out`} />
        <StatTile
          label="Estimated model cost"
          value={usd(t.estimatedCostUsd)}
          hint={t.costCoverage === "partial" ? "Some models have no price set" : t.costCoverage === "none" ? "No prices for these models" : "Based on list prices"}
        />
        <StatTile label="Answers using knowledge" value={pct(t.answersWithSources, t.assistantAnswers)} hint={`${t.answersWithSources} of ${t.assistantAnswers} answers cited sources`} />
        <StatTile label="Failed model requests" value={pct(t.failedRequests, t.modelRequests)} hint={`${t.failedRequests} of ${t.modelRequests} requests`} />
        <StatTile label="Voice call minutes" value={t.voiceCallMinutes.toFixed(1)} hint={`${t.transcribedMinutes.toFixed(1)} min transcribed`} />
        <StatTile label="Read-aloud characters" value={t.spokenCharacters.toLocaleString()} />
      </div>

      <Section title="Activity">
        <Card>
          <DailyColumns label="Conversations per day" unit="conversations" data={report.daily.map((d) => ({ date: d.date, value: d.conversations }))} />
        </Card>
      </Section>

      <div className="grid gap-6 sm:grid-cols-2">
        <Section title="By chatbot">
          <BarList
            unit="conversations"
            empty="No conversations in this period."
            rows={report.byChatbot.map((b) => ({
              key: b.chatbotId,
              label: b.name,
              sublabel: b.website,
              value: b.conversations,
              detail: `${b.name}: ${b.conversations} conversations, ${b.messages} messages, ${b.tokens.toLocaleString()} tokens`,
            }))}
          />
        </Section>
        <Section title="By website">
          <BarList
            unit="conversations"
            empty="No conversations in this period."
            rows={report.byWebsite.map((w) => ({ key: w.websiteId, label: w.name, value: w.conversations, detail: `${w.name}: ${w.conversations} conversations, ${w.messages} messages` }))}
          />
        </Section>
        <Section title="By channel">
          <BarList
            unit="conversations"
            empty="No conversations in this period."
            rows={report.bySource.map((s) => ({
              key: s.source,
              label: s.source === "widget" ? "Website widget" : s.source === "api" ? "REST API" : "Dashboard test chat",
              value: s.conversations,
            }))}
          />
        </Section>
        <Section title="Widget health" description="Times a website tried to load a chatbot and was refused.">
          {report.refusals.length === 0 ? (
            <StatusNote level="good">No refused widget loads in this period.</StatusNote>
          ) : (
            <>
              <StatusNote level="critical">{t.widgetRefusals} refused widget loads. Check the website&apos;s allowed domains and the chatbot status.</StatusNote>
              <ul className="mt-2 space-y-1 text-sm">
                {report.refusals.map((r, i) => (
                  <li key={i} className="flex justify-between gap-2">
                    <span className="truncate">
                      <code className="text-xs">{r.origin ?? "unknown origin"}</code>{" "}
                      <span className="text-zinc-500">{r.type === "widget_origin_refused" ? "domain not allowed" : "chatbot not active"}</span>
                    </span>
                    <span className="tabular-nums">{r.count}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Section>
      </div>

      <Section title="Models" description={`Estimated cost uses list prices as of ${PRICES_AS_OF}.`}>
        {report.byProvider.length === 0 ? (
          <p className="text-sm text-zinc-500">No model requests in this period.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="text-xs text-zinc-500">
                <tr>
                  <th className="py-1 font-normal">Provider / model</th>
                  <th className="py-1 text-right font-normal">Requests</th>
                  <th className="py-1 text-right font-normal">Failed</th>
                  <th className="py-1 text-right font-normal">Tokens in / out</th>
                  <th className="py-1 text-right font-normal">Avg latency</th>
                  <th className="py-1 text-right font-normal">Est. cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {report.byProvider.map((p) => (
                  <tr key={`${p.provider}/${p.model}`}>
                    <td className="py-1.5">
                      {providerName(p.provider)} <span className="text-zinc-500">/ {p.model}</span>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{p.requests}</td>
                    <td className="py-1.5 text-right tabular-nums">{p.failed > 0 ? <span title="Failed requests">⚠ {p.failed}</span> : 0}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {p.inputTokens.toLocaleString()} / {p.outputTokens.toLocaleString()}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{p.avgLatencyMs !== null ? `${(p.avgLatencyMs / 1000).toFixed(1)}s` : "—"}</td>
                    <td className="py-1.5 text-right tabular-nums">{usd(p.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <p className="mt-8 text-xs text-zinc-500">
        Visitors are counted with a random browser ID that the server stores only as a keyed hash; no IP addresses or cookies are used.{" "}
        <Link href={`/orgs/${org.id}/conversations`} className="underline">
          Conversations and retention
        </Link>
      </p>
    </>
  );
}
