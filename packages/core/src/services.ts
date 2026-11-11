/**
 * Tenant-scoped domain services. Every function takes a DbClient:
 *  - "user" functions expect a client from withUserContext (RLS enforces membership and roles).
 *  - "trusted" functions expect a client from withTrustedContext and scope queries explicitly.
 * Parent IDs are always re-read from the database; organization IDs are never taken from the client.
 */
import type { DbClient } from "@chatbot/database";
import {
  chatbotSettingsSchema,
  createOrganizationSchema,
  domainSchema,
  slugSchema,
  type ChatbotSettings,
  type OrgRole,
} from "@chatbot/shared";
import { z } from "zod";
import { DomainError, mapDbError, notFound } from "./errors.ts";
import { generatePublicChatbotId } from "./ids.ts";

const id = z.uuid();
const name = z.string().trim().min(1).max(120);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new DomainError("invalid", r.error.issues[0]?.message ?? "Invalid input");
  return r.data;
}

async function audit(db: DbClient, org: string, action: string, targetType: string, targetId: string) {
  await db.query("select public.write_audit($1, $2, $3, $4)", [org, action, targetType, targetId]);
}

// ------------------------------------------------------------------ users (trusted)

export interface AuthUser {
  id: string;
  email: string;
  name?: string | null;
}

/** Mirrors a verified Supabase Auth user into public.users. Trusted context only. */
export async function upsertUser(db: DbClient, user: AuthUser): Promise<void> {
  const u = parse(z.object({ id, email: z.email(), name: z.string().max(200).nullish() }), user);
  await db.query(
    `insert into users (id, email, full_name) values ($1, $2, $3)
     on conflict (id) do update set email = excluded.email, full_name = excluded.full_name
     where users.email is distinct from excluded.email or users.full_name is distinct from excluded.full_name`,
    [u.id, u.email, u.name ?? null],
  );
}

// ------------------------------------------------------------------ organizations

export interface Organization {
  id: string;
  name: string;
  slug: string;
  role: OrgRole;
}

/** Creates an organization with the caller as owner. Trusted context: no RLS insert policy exists for this. */
export async function createOrganization(
  db: DbClient,
  ownerId: string,
  input: { name: string; slug: string },
): Promise<Organization> {
  const owner = parse(id, ownerId);
  const data = parse(createOrganizationSchema, input);
  try {
    const org = (
      await db.query<{ id: string }>("insert into organizations (name, slug) values ($1, $2) returning id", [
        data.name,
        data.slug,
      ])
    ).rows[0]!;
    await db.query("insert into organization_members (organization_id, user_id, role) values ($1, $2, 'owner')", [
      org.id,
      owner,
    ]);
    await db.query(
      "insert into audit_logs (organization_id, actor_id, action, target_type, target_id) values ($1, $2, 'organization.create', 'organization', $3)",
      [org.id, owner, org.id],
    );
    return { id: org.id, name: data.name, slug: data.slug, role: "owner" };
  } catch (err) {
    mapDbError(err, "That organization URL is already taken");
  }
}

export async function listOrganizations(db: DbClient): Promise<Organization[]> {
  return (
    await db.query<Organization>(
      `select o.id, o.name, o.slug, m.role from organizations o
       join organization_members m on m.organization_id = o.id and m.user_id = public.current_app_user_id()
       order by o.name`,
    )
  ).rows;
}

export async function getOrganization(db: DbClient, orgId: string): Promise<Organization> {
  const row = (
    await db.query<Organization>(
      `select o.id, o.name, o.slug, m.role from organizations o
       join organization_members m on m.organization_id = o.id and m.user_id = public.current_app_user_id()
       where o.id = $1`,
      [parse(id, orgId)],
    )
  ).rows[0];
  if (!row) throw notFound("Organization");
  return row;
}

// ------------------------------------------------------------------ workspaces

export interface Workspace {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
}

export async function listWorkspaces(db: DbClient, orgId: string): Promise<Workspace[]> {
  return (
    await db.query<Workspace>(
      "select id, organization_id, name, slug from workspaces where organization_id = $1 order by name",
      [parse(id, orgId)],
    )
  ).rows;
}

export async function createWorkspace(
  db: DbClient,
  input: { organizationId: string; name: string; slug: string },
): Promise<Workspace> {
  const org = await getOrganization(db, input.organizationId);
  const data = parse(z.object({ name, slug: slugSchema }), input);
  try {
    const ws = (
      await db.query<Workspace>(
        "insert into workspaces (organization_id, name, slug) values ($1, $2, $3) returning id, organization_id, name, slug",
        [org.id, data.name, data.slug],
      )
    ).rows[0]!;
    await audit(db, org.id, "workspace.create", "workspace", ws.id);
    return ws;
  } catch (err) {
    mapDbError(err, "A workspace with that URL already exists");
  }
}

export async function getWorkspace(db: DbClient, workspaceId: string): Promise<Workspace> {
  const row = (
    await db.query<Workspace>("select id, organization_id, name, slug from workspaces where id = $1", [
      parse(id, workspaceId),
    ])
  ).rows[0];
  if (!row) throw notFound("Workspace");
  return row;
}

// ------------------------------------------------------------------ websites & domains

export interface Website {
  id: string;
  organization_id: string;
  workspace_id: string;
  name: string;
  domains: { id: string; domain: string }[];
}

const websiteSelect = `
  select w.id, w.organization_id, w.workspace_id, w.name,
    coalesce(json_agg(json_build_object('id', d.id, 'domain', d.domain) order by d.domain)
      filter (where d.id is not null), '[]') as domains
  from websites w left join website_domains d on d.website_id = w.id`;

export async function listWebsites(db: DbClient, workspaceId: string): Promise<Website[]> {
  return (
    await db.query<Website>(`${websiteSelect} where w.workspace_id = $1 group by w.id order by w.name`, [
      parse(id, workspaceId),
    ])
  ).rows;
}

export async function getWebsite(db: DbClient, websiteId: string): Promise<Website> {
  const row = (await db.query<Website>(`${websiteSelect} where w.id = $1 group by w.id`, [parse(id, websiteId)]))
    .rows[0];
  if (!row) throw notFound("Website");
  return row;
}

export async function createWebsite(
  db: DbClient,
  input: { workspaceId: string; name: string; domains: string[] },
): Promise<Website> {
  const ws = await getWorkspace(db, input.workspaceId);
  const data = parse(
    z.object({ name, domains: z.array(domainSchema).min(1, "Add at least one domain").max(20) }),
    input,
  );
  const domains = [...new Set(data.domains)];
  try {
    const site = (
      await db.query<{ id: string }>(
        "insert into websites (organization_id, workspace_id, name) values ($1, $2, $3) returning id",
        [ws.organization_id, ws.id, data.name],
      )
    ).rows[0]!;
    for (const domain of domains) {
      await db.query("insert into website_domains (organization_id, website_id, domain) values ($1, $2, $3)", [
        ws.organization_id,
        site.id,
        domain,
      ]);
    }
    await audit(db, ws.organization_id, "website.create", "website", site.id);
    return getWebsite(db, site.id);
  } catch (err) {
    mapDbError(err);
  }
}

export async function addDomain(db: DbClient, websiteId: string, domain: string): Promise<void> {
  const site = await getWebsite(db, websiteId);
  const d = parse(domainSchema, domain);
  try {
    await db.query("insert into website_domains (organization_id, website_id, domain) values ($1, $2, $3)", [
      site.organization_id,
      site.id,
      d,
    ]);
    await audit(db, site.organization_id, "website.domain.add", "website", site.id);
  } catch (err) {
    mapDbError(err, "That domain is already on this website");
  }
}

export async function removeDomain(db: DbClient, websiteId: string, domainId: string): Promise<void> {
  const site = await getWebsite(db, websiteId);
  try {
    const r = await db.query("delete from website_domains where id = $1 and website_id = $2", [
      parse(id, domainId),
      site.id,
    ]);
    if (r.rowCount === 0) throw new DomainError("forbidden", "You don't have permission to do that");
    await audit(db, site.organization_id, "website.domain.remove", "website", site.id);
  } catch (err) {
    if (err instanceof DomainError) throw err;
    mapDbError(err);
  }
}

// ------------------------------------------------------------------ chatbots

export type ChatbotStatus = "draft" | "active" | "paused" | "archived";

export interface Chatbot {
  id: string;
  organization_id: string;
  workspace_id: string;
  website_id: string;
  public_id: string;
  status: ChatbotStatus;
  settings: ChatbotSettings;
}

const chatbotSelect = `
  select c.id, c.organization_id, c.workspace_id, c.website_id, c.public_id, c.status, s.settings
  from chatbots c join chatbot_settings s on s.chatbot_id = c.id`;

/**
 * Settings are stored as JSON and new fields are added over time; parsing on read fills defaults for
 * older rows (e.g. `voice`, `fallbacks`). Unparseable settings keep the stored values plus defaults.
 */
export function normalizeChatbot<T extends Chatbot>(row: T): T {
  const parsed = chatbotSettingsSchema.safeParse(row.settings ?? {});
  if (parsed.success) return { ...row, settings: parsed.data };
  const defaults = chatbotSettingsSchema.parse({ name: (row.settings as { name?: string })?.name || "Chatbot", model: "unset" });
  return { ...row, settings: { ...defaults, ...(row.settings as object) } as ChatbotSettings };
}

export async function listChatbots(db: DbClient, websiteId: string): Promise<Chatbot[]> {
  return (
    await db.query<Chatbot>(`${chatbotSelect} where c.website_id = $1 order by c.created_at`, [
      parse(id, websiteId),
    ])
  ).rows.map(normalizeChatbot);
}

export async function getChatbot(db: DbClient, chatbotId: string): Promise<Chatbot> {
  const row = (await db.query<Chatbot>(`${chatbotSelect} where c.id = $1`, [parse(id, chatbotId)])).rows[0];
  if (!row) throw notFound("Chatbot");
  return normalizeChatbot(row);
}

export async function createChatbot(
  db: DbClient,
  input: { websiteId: string; settings: unknown },
): Promise<Chatbot> {
  const site = await getWebsite(db, input.websiteId);
  const settings = parse(chatbotSettingsSchema, input.settings);
  try {
    const bot = (
      await db.query<{ id: string }>(
        "insert into chatbots (organization_id, workspace_id, website_id, public_id) values ($1, $2, $3, $4) returning id",
        [site.organization_id, site.workspace_id, site.id, generatePublicChatbotId()],
      )
    ).rows[0]!;
    await db.query("insert into chatbot_settings (chatbot_id, organization_id, settings) values ($1, $2, $3)", [
      bot.id,
      site.organization_id,
      JSON.stringify(settings),
    ]);
    await audit(db, site.organization_id, "chatbot.create", "chatbot", bot.id);
    return getChatbot(db, bot.id);
  } catch (err) {
    mapDbError(err);
  }
}

export async function updateChatbotSettings(db: DbClient, chatbotId: string, settings: unknown): Promise<Chatbot> {
  const bot = await getChatbot(db, chatbotId);
  const data = parse(chatbotSettingsSchema, settings);
  try {
    const r = await db.query(
      "update chatbot_settings set settings = $1, updated_at = now() where chatbot_id = $2",
      [JSON.stringify(data), bot.id],
    );
    if (r.rowCount === 0) throw new DomainError("forbidden", "You don't have permission to do that");
    await audit(db, bot.organization_id, "chatbot.settings.update", "chatbot", bot.id);
    return getChatbot(db, bot.id);
  } catch (err) {
    if (err instanceof DomainError) throw err;
    mapDbError(err);
  }
}

export async function setChatbotStatus(db: DbClient, chatbotId: string, status: ChatbotStatus): Promise<void> {
  const bot = await getChatbot(db, chatbotId);
  const s = parse(z.enum(["draft", "active", "paused", "archived"]), status);
  const r = await db.query("update chatbots set status = $1 where id = $2", [s, bot.id]);
  if (r.rowCount === 0) throw new DomainError("forbidden", "You don't have permission to do that");
  await audit(db, bot.organization_id, `chatbot.status.${s}`, "chatbot", bot.id);
}
