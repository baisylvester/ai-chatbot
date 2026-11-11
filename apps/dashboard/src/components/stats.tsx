import type { ReactNode } from "react";

/** A headline number with a short label; text stays in text colours, never a series colour. */
export function StatTile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-zinc-500">{hint}</div>}
    </div>
  );
}

/**
 * Ranked horizontal bars for one measure across categories (single hue; the value is printed, so
 * colour never carries meaning alone). Hovering a row shows its full numbers.
 */
export function BarList({ rows, unit, empty }: { rows: { key: string; label: string; sublabel?: string; value: number; detail?: string }[]; unit: string; empty: string }) {
  if (rows.length === 0 || rows.every((r) => r.value === 0)) return <p className="text-sm text-zinc-500">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((r) => (
        <li key={r.key} className="text-sm" title={r.detail ?? `${r.label}: ${r.value.toLocaleString()} ${unit}`}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate">
              {r.label}
              {r.sublabel && <span className="ml-1 text-xs text-zinc-500">{r.sublabel}</span>}
            </span>
            <span className="tabular-nums text-zinc-600 dark:text-zinc-400">{r.value.toLocaleString()}</span>
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-900">
            <div className="h-1.5 rounded-full bg-[#2a78d6] dark:bg-[#3987e5]" style={{ width: `${Math.max(r.value > 0 ? 2 : 0, (r.value / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Status line with icon + label + colour (status colours are reserved for state, never series). */
export function StatusNote({ level, children }: { level: "good" | "critical"; children: ReactNode }) {
  const style = level === "good" ? "text-[#0a7a0a] dark:text-[#0ca30c]" : "text-[#b42f2f] dark:text-[#e66767]";
  return (
    <p className={`flex items-center gap-1.5 text-sm ${style}`}>
      <span aria-hidden>{level === "good" ? "✓" : "⚠"}</span>
      <span className="text-zinc-700 dark:text-zinc-300">{children}</span>
    </p>
  );
}
