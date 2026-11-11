import Link from "next/link";
import type { ReactNode } from "react";
import { requireUser } from "@/lib/session";
import { signOutAction } from "../auth/actions";

export const dynamic = "force-dynamic";

export default async function PlatformLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  return (
    <>
      <header className="border-b border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3">
          <Link href="/orgs" className="font-semibold">
            Chatbot Platform
          </Link>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-zinc-500 sm:inline">{user.email}</span>
            <form action={signOutAction}>
              <button type="submit" className="rounded-md px-2 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-900">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-8">{children}</main>
    </>
  );
}
