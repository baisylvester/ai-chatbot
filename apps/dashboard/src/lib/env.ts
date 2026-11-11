import "server-only";
import { z } from "zod";

const serverEnvSchema = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "Must be a postgres:// connection string"),
  NEON_AUTH_BASE_URL: z.url(),
  NEON_AUTH_COOKIE_SECRET: z.string().min(32, "Must be at least 32 characters"),
  EMBED_TOKEN_SECRET: z.string().min(32, "Must be at least 32 characters"),
});

/** Extra requirements once deployed (checked at startup by instrumentation.ts). */
const productionEnvSchema = serverEnvSchema.extend({
  NEXT_PUBLIC_PLATFORM_URL: z.url().refine((u) => u.startsWith("https://"), "Must be the public https:// URL"),
  CRON_SECRET: z.string().min(32, "Must be at least 32 characters"),
});

/** Names (never values) of missing or invalid production variables. */
export function productionEnvProblems(): string[] {
  const r = productionEnvSchema.safeParse(process.env);
  return r.success ? [] : [...new Set(r.error.issues.map((i) => `${String(i.path[0])}: ${i.message}`))];
}

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/** Reports which required variables are missing, without exposing any values. */
export function getServerEnvStatus(): { ok: boolean; missing: string[] } {
  const result = serverEnvSchema.safeParse(process.env);
  if (result.success) return { ok: true, missing: [] };
  const missing = [...new Set(result.error.issues.map((i) => String(i.path[0])))];
  return { ok: false, missing };
}

/** Returns validated server env or throws. Only call from server code. */
export function getServerEnv(): ServerEnv {
  return serverEnvSchema.parse(process.env);
}
