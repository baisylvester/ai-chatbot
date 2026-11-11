import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { upsertUser } from "@chatbot/core";
import { withTrustedContext, withUserContext, type DbClient } from "@chatbot/database";
import { auth } from "@/lib/auth/server";
import { getPool } from "@/lib/db";

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}

/** Returns the signed-in user (mirrored into public.users), or null. Cached per request. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const { data: session } = await auth.getSession();
  const u = session?.user;
  if (!u?.id || !u.email) return null;
  const user = { id: u.id, email: u.email, name: u.name ?? null };
  await withTrustedContext(getPool(), (db) => upsertUser(db, user));
  return user;
});

/** Returns the signed-in user or redirects to sign-in. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/auth/sign-in");
  return user;
}

/** Runs `fn` with RLS scoped to the signed-in user. */
export async function asUser<T>(fn: (db: DbClient, user: SessionUser) => Promise<T>): Promise<T> {
  const user = await requireUser();
  return withUserContext(getPool(), user.id, (db) => fn(db, user));
}

/** Trusted (RLS-bypassing) work on behalf of the signed-in user. Use only where no RLS policy can apply. */
export async function asTrusted<T>(fn: (db: DbClient, user: SessionUser) => Promise<T>): Promise<T> {
  const user = await requireUser();
  return withTrustedContext(getPool(), (db) => fn(db, user));
}
