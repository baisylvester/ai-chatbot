import type { Metadata } from "next";
import { getConnection, listNotifications, listPendingActions, type SendPayload, type TrashPayload } from "@chatbot/mail-agent";
import { MailAgentChat } from "@/components/mail-agent-chat";
import { MailApprovals, type ApprovalItem } from "@/components/mail-approvals";
import { PushToggle } from "@/components/push-toggle";
import { Card, Section } from "@/components/ui";
import { mailDb, mailSetup } from "@/lib/mail-agent";
import { requireUser } from "@/lib/session";
import { approveAction, chatAction, disconnectAction, rejectAction, removePushAction, savePushAction } from "./actions";

export const metadata: Metadata = { title: "Mail agent" };

const NOTICES: Record<string, string> = {
  setup: "Gmail can't be connected yet: the server is missing its Google sign-in settings.",
  state: "The Google sign-in could not be verified. Start again from Connect Gmail.",
  denied: "Gmail was not connected because access was not granted on Google's screen.",
  permission: "Gmail was not connected: the Gmail permission has to be ticked on Google's screen.",
  failed: "Gmail could not be connected. Try again in a moment.",
};

const primaryButton = "inline-block rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200";

export default async function AgentPage({ searchParams }: { searchParams: Promise<{ error?: string; connected?: string }> }) {
  const user = await requireUser();
  const params = await searchParams;
  const setup = mailSetup();
  const { connection, pending, notifications } = await mailDb(async (db) => {
    const found = await getConnection(db, user.id);
    return {
      connection: found,
      pending: found ? await listPendingActions(db, user.id) : [],
      notifications: found ? await listNotifications(db, user.id, 5) : [],
    };
  });
  const active = connection?.status === "active";
  const approvals: ApprovalItem[] = pending.map((action) => ({
    id: action.id, kind: action.kind, summary: action.summary,
    preview: action.kind === "send" ? (action.payload as SendPayload).preview : undefined,
    count: action.kind === "trash" ? (action.payload as TrashPayload).ids.length : undefined,
  }));

  return (
    <>
      <h1 className="text-2xl font-semibold">Mail agent</h1>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Reads, sorts and drafts in your Gmail. It never sends or deletes anything until you approve it here.
      </p>

      {params.error && NOTICES[params.error] && (
        <p role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">{NOTICES[params.error]}</p>
      )}
      {params.connected && active && (
        <p role="status" className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">Gmail is connected.</p>
      )}

      {setup.missing.length > 0 && (
        <Section title="Setup needed" description="The site owner has to add these server settings before the agent can work. See DEPLOYMENT.md, “Mail agent”.">
          <ul className="list-disc pl-5 text-sm">
            {setup.missing.map((name) => <li key={name}><code>{name}</code></li>)}
          </ul>
        </Section>
      )}

      <Section title="Mailbox">
        <Card>
          {active ? (
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <p>Connected to <span className="font-medium break-all">{connection.email}</span></p>
              <form action={disconnectAction}>
                <button type="submit" className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">Disconnect</button>
              </form>
            </div>
          ) : (
            <div className="text-sm">
              <p className="text-zinc-600 dark:text-zinc-400">
                {connection ? `Access to ${connection.email} has expired or was revoked.` : "No mailbox is connected yet."}
                {" "}You&apos;ll be asked by Google to allow reading, organizing, drafting and sending mail.
              </p>
              {setup.oauth && setup.tokenSecret
                ? <a href="/api/agent/gmail/connect" className={`mt-3 ${primaryButton}`}>{connection ? "Reconnect Gmail" : "Connect Gmail"}</a>
                : <p className="mt-2 text-zinc-500">Connecting is unavailable until setup is finished.</p>}
            </div>
          )}
        </Card>
      </Section>

      {active && (
        <>
          <Section title="Waiting for your approval">
            <MailApprovals items={approvals} approve={approveAction} reject={rejectAction} />
          </Section>

          <Section title="Ask the agent">
            {setup.modelReady
              ? <MailAgentChat action={chatAction} />
              : <p className="text-sm text-zinc-500">The agent&apos;s AI model is not configured on this server yet.</p>}
          </Section>

          <Section title="Notifications" description="The agent checks for new mail about every 10 minutes and tells you what needs attention. Install this page as an app (browser menu → Install or Add to Home screen) to get notifications like any other app.">
            <PushToggle vapidPublicKey={setup.vapid?.publicKey ?? null} save={savePushAction} remove={removePushAction} />
            {notifications.length > 0 && (
              <ul className="mt-4 divide-y divide-zinc-200 rounded-lg border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
                {notifications.map((item) => (
                  <li key={item.id} className="px-3 py-2">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="font-medium">{item.title}</span>
                      <time className="text-xs text-zinc-500" dateTime={item.createdAt.toISOString()}>{item.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC</time>
                    </div>
                    <p className="whitespace-pre-wrap break-words text-zinc-600 dark:text-zinc-400">{item.body}</p>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
    </>
  );
}
