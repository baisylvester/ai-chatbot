import "server-only";
import { notFound } from "next/navigation";
import { DomainError } from "@chatbot/core";

/** Maps a domain "not found" (including rows hidden by RLS and malformed ids) to the Next.js 404 page. */
export async function orNotFound<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof DomainError && (err.code === "not_found" || err.code === "invalid")) notFound();
    throw err;
  }
}
