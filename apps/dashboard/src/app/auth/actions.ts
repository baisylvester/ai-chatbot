"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createAuthClient } from "@/lib/auth/server";
import type { ActionState } from "@/lib/action-result";

const signUpSchema = z.object({
  name: z.string().trim().min(1, "Enter your name").max(120),
  email: z.email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
});

/** Where confirmation links send people back to: this deployment's own callback route. */
async function callbackUrl(): Promise<string> {
  const h = await headers();
  const origin = process.env.NEXT_PUBLIC_PLATFORM_URL || h.get("origin") || `http://${h.get("host")}`;
  return new URL("/auth/callback", origin).toString();
}

export async function signUpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = signUpSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const { name, email, password } = parsed.data;
  const supabase = await createAuthClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { name }, emailRedirectTo: await callbackUrl() },
  });
  if (error) return { error: error.message || "Could not create the account" };
  // With email confirmation on (Supabase's default) there is no session until the link is clicked.
  if (!data.session) return { ok: "Check your email and click the confirmation link to finish signing up." };
  redirect("/orgs");
}

const signInSchema = z.object({ email: z.email("Enter a valid email"), password: z.string().min(1, "Enter your password") });

export async function signInAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = signInSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createAuthClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: error.message || "Could not sign in" };
  redirect("/orgs");
}

export async function signOutAction(): Promise<void> {
  const supabase = await createAuthClient();
  await supabase.auth.signOut();
  redirect("/");
}
