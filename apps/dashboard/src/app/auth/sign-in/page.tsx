import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm, Field } from "@/components/action-form";
import { getCurrentUser } from "@/lib/session";
import { signInAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function SignInPage() {
  if (await getCurrentUser()) redirect("/orgs");
  return (
    <main className="mx-auto max-w-sm px-4 py-12">
      <h1 className="text-xl font-semibold">Sign in</h1>
      <ActionForm action={signInAction} submitLabel="Sign in" className="mt-6 flex flex-col gap-4">
        <Field label="Email" name="email" type="email" />
        <Field label="Password" name="password" type="password" />
      </ActionForm>
      <p className="mt-6 text-sm text-zinc-600 dark:text-zinc-400">
        No account?{" "}
        <Link href="/auth/sign-up" className="underline">
          Create one
        </Link>
      </p>
    </main>
  );
}
