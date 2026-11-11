"use client";

import { useActionState } from "react";
import { ActionForm, Field } from "@/components/action-form";
import { CopyBlock } from "@/components/copy-block";
import { createApiKeyAction, revokeApiKeyAction } from "../../api-key-actions";

interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  created: string;
  lastUsed: string | null;
  revoked: boolean;
}

export function ApiKeys({ organizationId, keys }: { organizationId: string; keys: KeyRow[] }) {
  const [state, create, pending] = useActionState(createApiKeyAction, null);
  return (
    <div className="flex flex-col gap-4">
      {keys.length > 0 && (
        <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
          {keys.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
              <span>
                <span className="font-medium">{k.name}</span> <code className="text-xs">{k.prefix}_…</code>
                <span className="block text-xs text-zinc-500">
                  Created {k.created} · {k.lastUsed ? `last used ${k.lastUsed} UTC` : "never used"}
                  {k.revoked ? " · revoked" : ""}
                </span>
              </span>
              {!k.revoked && (
                <ActionForm action={revokeApiKeyAction} submitLabel="Revoke" variant="danger" className="flex">
                  <input type="hidden" name="keyId" value={k.id} />
                  <input type="hidden" name="organizationId" value={organizationId} />
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      )}
      <form action={create} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="organizationId" value={organizationId} />
        <Field label="Key name" name="name" placeholder="Backend server" />
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
        >
          {pending ? "Creating…" : "Create API key"}
        </button>
        {state?.error && (
          <p role="alert" className="w-full text-sm text-red-600">
            {state.error}
          </p>
        )}
      </form>
      {state?.key && (
        <div className="rounded-lg border border-amber-300 p-3 dark:border-amber-700">
          <p className="mb-2 text-sm font-medium">Copy this key now. It won&apos;t be shown again.</p>
          <CopyBlock label="Private API key" code={state.key} />
        </div>
      )}
    </div>
  );
}
