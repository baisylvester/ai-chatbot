import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerEnvStatus } from "@/lib/env";
import { getCurrentUser } from "@/lib/session";

// Read env and session at request time, not at build time.
export const dynamic = "force-dynamic";

const phases = [
  { name: "Foundation", detail: "Monorepo, shared validation, Neon Postgres schema and RLS", done: true },
  { name: "Core platform", detail: "Sign-in, organizations, workspaces, websites, chatbots, access control", done: true },
  { name: "AI engine", detail: "Provider adapters, LangChain.js, streaming conversations", done: false },
  { name: "RAG engine", detail: "Ingestion, embeddings, hybrid retrieval, citations", done: false },
  { name: "Universal embedding", detail: "Embed SDK, Web Component, iframe, origin checks", done: false },
  { name: "Voice", detail: "STT/TTS pipeline and realtime voice", done: false },
  { name: "Admin & analytics", detail: "Dashboard screens, embed management, usage", done: false },
  { name: "Production readiness", detail: "Security review, browser tests, deployment", done: false },
];

export default async function HomePage() {
  const env = getServerEnvStatus();
  if (env.ok && (await getCurrentUser())) redirect("/orgs");
  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-2xl font-semibold">Chatbot Platform</h1>
      <p className="mt-2 text-zinc-600 dark:text-zinc-400">
        Build once, integrate everywhere. This dashboard is the admin surface for the centralized chatbot service.
      </p>

      {env.ok ? (
        <div className="mt-6 flex gap-3">
          <Link href="/auth/sign-in" className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-zinc-900">
            Sign in
          </Link>
          <Link href="/auth/sign-up" className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium dark:border-zinc-700">
            Create account
          </Link>
        </div>
      ) : (
        <p className="mt-6 rounded-lg border border-amber-300 p-4 text-sm">
          Missing configuration: {env.missing.join(", ")}. Copy .env.example to apps/dashboard/.env.local.
        </p>
      )}

      <section className="mt-10">
        <h2 className="font-medium">Build progress</h2>
        <ol className="mt-3 space-y-2">
          {phases.map((p, i) => (
            <li key={p.name} className="flex gap-3 text-sm">
              <span aria-hidden className={p.done ? "text-emerald-600" : "text-zinc-400"}>
                {p.done ? "✓" : "○"}
              </span>
              <span>
                <span className="font-medium">
                  Phase {i + 1}: {p.name}
                </span>
                <span className="text-zinc-600 dark:text-zinc-400"> — {p.detail}</span>
              </span>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
