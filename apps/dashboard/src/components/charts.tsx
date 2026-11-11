"use client";

import { useState } from "react";

/**
 * Daily column chart (one series, so no legend: the title names it). Single sequential blue
 * (#2a78d6 light / #3987e5 dark, validated against the light and dark surfaces), 4px rounded data
 * ends on the baseline, 2px gaps, recessive grid, and a hover tooltip per column with a hit area
 * the full height of the plot. A table view is available for screen readers and exact values.
 */
export function DailyColumns({ data, label, unit }: { data: { date: string; value: number }[]; label: string; unit: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 640;
  const height = 180;
  const pad = { top: 12, right: 8, bottom: 24, left: 36 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...data.map((d) => d.value));
  const niceMax = max <= 4 ? 4 : Math.ceil(max / 4) * 4;
  const step = plotW / Math.max(1, data.length);
  const colW = Math.max(2, step - 2);
  const y = (v: number) => pad.top + plotH - (v / niceMax) * plotH;
  const ticks = [0, niceMax / 2, niceMax];
  const fmtDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const total = data.reduce((a, d) => a + d.value, 0);
  const active = hover !== null ? data[hover] : null;

  return (
    <figure className="m-0">
      <figcaption className="mb-2 flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-zinc-500">
          {total.toLocaleString()} total
        </span>
      </figcaption>
      <div className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-auto w-full"
          role="img"
          aria-label={`${label}: ${total} ${unit} over ${data.length} days`}
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} className="stroke-zinc-200 dark:stroke-zinc-800" strokeWidth={1} />
              <text x={pad.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-zinc-500 text-[10px]">
                {t}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const x = pad.left + i * step + 1;
            const top = y(d.value);
            const h = pad.top + plotH - top;
            const r = Math.min(4, colW / 2, h);
            const path =
              h <= 0
                ? ""
                : `M${x},${pad.top + plotH} V${top + r} Q${x},${top} ${x + r},${top} H${x + colW - r} Q${x + colW},${top} ${x + colW},${top + r} V${pad.top + plotH} Z`;
            return (
              <g key={d.date}>
                {path && <path d={path} className={hover === i ? "fill-[#1c5cab] dark:fill-[#6da7ec]" : "fill-[#2a78d6] dark:fill-[#3987e5]"} />}
                <rect x={pad.left + i * step} y={pad.top} width={step} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={-1} />
              </g>
            );
          })}
          <line x1={pad.left} x2={width - pad.right} y1={pad.top + plotH} y2={pad.top + plotH} className="stroke-zinc-300 dark:stroke-zinc-700" strokeWidth={1} />
          {data.length > 0 && (
            <>
              <text x={pad.left} y={height - 6} className="fill-zinc-500 text-[10px]">
                {fmtDate(data[0]!.date)}
              </text>
              <text x={width - pad.right} y={height - 6} textAnchor="end" className="fill-zinc-500 text-[10px]">
                {fmtDate(data.at(-1)!.date)}
              </text>
            </>
          )}
        </svg>
        {active && hover !== null && (
          <div
            role="status"
            className="pointer-events-none absolute top-0 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
            style={{ left: `${Math.min(80, Math.max(0, ((pad.left + hover * step) / width) * 100))}%` }}
          >
            <div className="text-zinc-500">{fmtDate(active.date)}</div>
            <div className="font-medium">
              {active.value.toLocaleString()} {unit}
            </div>
          </div>
        )}
      </div>
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-zinc-500">Show as table</summary>
        <table className="mt-2 w-full max-w-sm text-left">
          <thead>
            <tr className="text-zinc-500">
              <th className="py-0.5 font-normal">Date</th>
              <th className="py-0.5 text-right font-normal">{unit}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.date}>
                <td className="py-0.5">{d.date}</td>
                <td className="py-0.5 text-right tabular-nums">{d.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
