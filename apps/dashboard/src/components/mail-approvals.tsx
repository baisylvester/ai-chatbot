"use client";

import { useState, useTransition } from "react";
import type { SimpleResult } from "@/app/(platform)/agent/actions";

export interface ApprovalItem { id: string; kind: "send" | "trash"; summary: string; preview?: string; count?: number }

/** Actions the agent prepared. Nothing here happens until the user presses the approve button. */
export function MailApprovals({ items, approve, reject }: {
  items: ApprovalItem[];
  approve: (id: string) => Promise<SimpleResult>;
  reject: (id: string) => Promise<SimpleResult>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [, startTransition] = useTransition();

  function run(id: string, fn: (id: string) => Promise<SimpleResult>) {
    setBusy(id);
    setErrors((all) => ({ ...all, [id]: "" }));
    startTransition(async () => {
      let result: SimpleResult;
      try { result = await fn(id); } catch { result = { error: "Could not reach the server. Try again." }; }
      if ("error" in result) setErrors((all) => ({ ...all, [id]: result.error }));
      setBusy(null);
    });
  }

  if (!items.length) return <p className="text-sm text-zinc-500">Nothing is waiting. Emails the agent drafts and messages it wants to trash appear here for you to approve.</p>;
  return (
    <ul className="space-y-3">
      {items.map((item) => (
        <li key={item.id} className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
          <p className="font-medium break-words">{item.summary}</p>
          {item.preview && (
            <details className="mt-2">
              <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">Read the draft</summary>
              <p className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-white p-3 dark:bg-zinc-900">{item.preview}</p>
            </details>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={busy !== null} onClick={() => run(item.id, approve)}
              className="rounded-md bg-zinc-900 px-3 py-1.5 font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200">
              {busy === item.id ? "Working…" : item.kind === "send" ? "Send email" : "Move to Trash"}
            </button>
            <button type="button" disabled={busy !== null} onClick={() => run(item.id, reject)}
              className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-white disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
              {item.kind === "send" ? "Keep as draft" : "Don't trash"}
            </button>
          </div>
          {errors[item.id] && <p role="alert" className="mt-2 text-red-600 dark:text-red-400">{errors[item.id]}</p>}
        </li>
      ))}
    </ul>
  );
}
