import Link from "next/link";
import type { ReactNode } from "react";

export function Breadcrumbs({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm text-zinc-500">
      {items.map((item, i) => (
        <span key={i}>
          {i > 0 && <span className="mx-1.5">/</span>}
          {item.href ? (
            <Link href={item.href} className="hover:underline">
              {item.label}
            </Link>
          ) : (
            <span className="text-zinc-900 dark:text-zinc-100">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

export function Section({ title, children, description }: { title: string; children: ReactNode; description?: string }) {
  return (
    <section className="mt-8">
      <h2 className="font-medium">{title}</h2>
      {description && <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{description}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function ItemList({ items, empty }: { items: { key: string; href: string; title: string; meta?: string }[]; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-zinc-500">{empty}</p>;
  return (
    <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
      {items.map((item) => (
        <li key={item.key}>
          <Link href={item.href} className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900">
            <span className="font-medium">{item.title}</span>
            {item.meta && <span className="truncate text-sm text-zinc-500">{item.meta}</span>}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">{children}</div>;
}
