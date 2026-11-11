import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm, Field } from "@/components/action-form";
import { getCurrentUser } from "@/lib/session";
import { signUpAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function SignUpPage() {
  if (await getCurrentUser()) redirect("/orgs");
  return (
    <main className="mx-auto max-w-sm px-4 py-12">
      <h1 className="text-xl font-semibold">Create your account</h1>
      <ActionForm action={signUpAction} submitLabel="Create account" className="mt-6 flex flex-col gap-4">
        <Field label="Name" name="name" />
        <Field label="Email" name="email" type="email" />
        <Field label="Password" name="password" type="password" hint="At least 8 characters" />
      </ActionForm>
      <p className="mt-6 text-sm text-zinc-600 dark:text-zinc-400">
        Already have an account?{" "}
        <Link href="/auth/sign-in" className="underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}
