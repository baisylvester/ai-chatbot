import { DomainError } from "@chatbot/core";

export type ActionState = { error?: string; ok?: string } | null;

/** Turns thrown errors into a message safe to show the user. Unknown errors are logged, not shown. */
export function toActionError(err: unknown): ActionState {
  if (err instanceof DomainError) return { error: err.message };
  // Let Next.js redirect()/notFound() propagate.
  if (err && typeof err === "object" && "digest" in err) throw err;
  console.error(err);
  return { error: "Something went wrong. Please try again." };
}
