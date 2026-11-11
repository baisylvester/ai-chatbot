"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/lib/auth/server";
import type { ActionState } from "@/lib/action-result";

const signUpSchema = z.object({
  name: z.string().trim().min(1, "Enter your name").max(120),
  email: z.email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
});

export async function signUpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = signUpSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const { error } = await auth.signUp.email(parsed.data);
  if (error) return { error: error.message || "Could not create the account" };
  redirect("/orgs");
}

const signInSchema = z.object({ email: z.email("Enter a valid email"), password: z.string().min(1, "Enter your password") });

export async function signInAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = signInSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const { error } = await auth.signIn.email(parsed.data);
  if (error) return { error: error.message || "Could not sign in" };
  redirect("/orgs");
}

export async function signOutAction(): Promise<void> {
  await auth.signOut();
  redirect("/");
}
