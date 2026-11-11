import { z } from "zod";

/**
 * Tenant hierarchy: Organization > Workspace > Website > Chatbot.
 * Every server-side lookup must be scoped by these identifiers.
 * Client-supplied IDs are untrusted and must be re-validated on the server.
 */

export const uuid = z.uuid();

export const orgRoleSchema = z.enum(["owner", "admin", "member", "viewer"]);
export type OrgRole = z.infer<typeof orgRoleSchema>;

export const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, digits and hyphens");

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slugSchema,
});

export const createWorkspaceSchema = z.object({
  organizationId: uuid,
  name: z.string().trim().min(1).max(120),
  slug: slugSchema,
});

/** Domains are stored lowercase, without scheme, path or port. */
export const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?=.{1,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/,
    "Enter a bare hostname such as example.com",
  );

export const createWebsiteSchema = z.object({
  workspaceId: uuid,
  name: z.string().trim().min(1).max(120),
  domains: z.array(domainSchema).min(1).max(20),
});

/** True when `origin` (e.g. "https://www.example.com") matches an allowed domain. Pure check, no I/O. */
export function isOriginAllowed(origin: string, allowedDomains: readonly string[]): boolean {
  let host: string;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.hostname !== "localhost") return false;
    host = url.hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedDomains.some((d) => {
    const domain = d.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  });
}
