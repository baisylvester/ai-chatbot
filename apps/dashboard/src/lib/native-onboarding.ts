import "server-only";
import { createOrganization, generatePublicChatbotId, DomainError, type Chatbot } from "@chatbot/core";
import { chatbotSettingsSchema } from "@chatbot/shared";
import type { DbClient } from "@chatbot/database";
import { mailSetup } from "@/lib/mail-agent";

/** Must run in one trusted transaction. A user cannot select another owner or organization. */
export async function provisionNativeAccount(db: DbClient, user: { id: string }) {
  await db.query("select pg_advisory_xact_lock(hashtextextended($1,731901))", [user.id]);
  const existing = (await db.query<{ chatbotId: string; validOwner: boolean; status: Chatbot["status"] }>(`
    select c.public_id as "chatbotId", c.status,
      (c.organization_id=a.organization_id and m.role='owner') as "validOwner"
    from native_accounts a join chatbots c on c.id=a.chatbot_id
    left join organization_members m on m.organization_id=a.organization_id and m.user_id=a.user_id
    where a.user_id=$1`, [user.id])).rows[0];
  if (existing) {
    if (!existing.validOwner || existing.status !== "active") throw new DomainError("conflict", "Your personal assistant is unavailable. Contact support.");
    return { chatbotId: existing.chatbotId };
  }
  const setup = mailSetup();
  if (!setup.modelReady) throw new DomainError("conflict", "The mail assistant is temporarily unavailable. Please try again later.");
  const organization = await createOrganization(db, user.id, { name: "My Mail Assistant", slug: `mail-${user.id}` });
  const workspace = (await db.query<{ id: string }>("insert into workspaces(organization_id,name,slug) values($1,'Personal mail','personal-mail') returning id", [organization.id])).rows[0]!;
  await db.query("insert into workspace_members(workspace_id,organization_id,user_id,role) values($1,$2,$3,'admin')", [workspace.id,organization.id,user.id]);
  const website = (await db.query<{ id: string }>("insert into websites(organization_id,workspace_id,name) values($1,$2,'Personal mail assistant') returning id", [organization.id,workspace.id])).rows[0]!;
  const publicId = generatePublicChatbotId();
  const bot = (await db.query<{ id: string }>("insert into chatbots(organization_id,workspace_id,website_id,public_id,status) values($1,$2,$3,$4,'active') returning id", [organization.id,workspace.id,website.id,publicId])).rows[0]!;
  const settings = chatbotSettingsSchema.parse({ name: "Mail Assistant", provider: setup.provider, model: setup.model, maxOutputTokens: 4096,
    systemPrompt: "You are the signed-in user's personal mail assistant. Use available mailbox tools for mailbox facts. Never invent email content or claim an email was sent. Sending and moving messages to Trash require explicit user approval.",
    welcomeMessage: "How can I help with your email today?", suggestedQuestions: ["Summarize my unread mail", "Help me write an email"] });
  await db.query("insert into chatbot_settings(chatbot_id,organization_id,settings) values($1,$2,$3)", [bot.id,organization.id,JSON.stringify(settings)]);
  await db.query("insert into native_accounts(user_id,organization_id,chatbot_id) values($1,$2,$3)", [user.id,organization.id,bot.id]);
  await db.query("insert into audit_logs(organization_id,actor_id,action,target_type,target_id) values($1,$2,'native.onboarding.create','chatbot',$3)", [organization.id,user.id,bot.id]);
  return { chatbotId: publicId };
}
