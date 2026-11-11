"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Refreshes server data every few seconds while `active` (e.g. documents still processing). */
export function AutoRefresh({ active, intervalMs = 3000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs, router]);
  return active ? (
    <p role="status" className="text-xs text-zinc-500">
      Processing… this page updates automatically.
    </p>
  ) : null;
}
