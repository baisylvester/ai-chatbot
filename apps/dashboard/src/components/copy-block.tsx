"use client";

import { useState } from "react";

/** A code block with a copy-to-clipboard button. */
export function CopyBlock({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-1.5 text-xs dark:border-zinc-800">
        <span className="font-medium">{label}</span>
        <button type="button" onClick={copy} className="rounded px-2 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-900" aria-live="polite">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-xs">
        <code>{code}</code>
      </pre>
    </div>
  );
}
