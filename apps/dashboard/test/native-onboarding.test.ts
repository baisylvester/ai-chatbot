import { beforeEach, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({organization:vi.fn(),setup:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/mail-agent",()=>({mailSetup:mocks.setup}));
vi.mock("@chatbot/core",async original=>({...await original<typeof import("@chatbot/core")>(),createOrganization:mocks.organization}));
import {provisionNativeAccount} from "../src/lib/native-onboarding";
import type {DbClient} from "@chatbot/database";
const user={id:"bbe10854-962d-43e9-9f42-64ac8f05a323"};
beforeEach(()=>{vi.clearAllMocks();mocks.setup.mockReturnValue({modelReady:true,provider:"openai-compatible",model:"qwen3:8b"});mocks.organization.mockResolvedValue({id:"org"});});
function database(existing?:unknown){return {query:vi.fn(async(sql:string,_values?:unknown[])=>{
  if(sql.includes('from native_accounts'))return {rows:existing?[existing]:[]};
  if(sql.includes('insert into workspaces'))return {rows:[{id:"workspace"}]};
  if(sql.includes('insert into websites'))return {rows:[{id:"website"}]};
  if(sql.includes('insert into chatbots('))return {rows:[{id:"bot"}]};
  return {rows:[]};
})};}
it("provisions a private owner workspace and active assistant without a caller-selected tenant",async()=>{
  const db=database(); const result=await provisionNativeAccount(db as unknown as DbClient,user);
  expect(result.chatbotId).toMatch(/^cb_[A-Za-z0-9]{16,64}$/);
  expect(mocks.organization).toHaveBeenCalledWith(db,user.id,{name:"My Mail Assistant",slug:`mail-${user.id}`});
  const settings=db.query.mock.calls.find(([sql])=>sql.includes('insert into chatbot_settings'));
  expect(JSON.parse(settings![1]![2] as string)).toMatchObject({provider:"openai-compatible",model:"qwen3:8b"});
  expect(db.query.mock.calls.find(([sql])=>sql.includes('insert into native_accounts'))?.[1]).toEqual([user.id,"org","bot"]);
  expect(db.query.mock.calls[0]![0]).toContain('pg_advisory_xact_lock');
});
it("reuses the user's existing assistant instead of creating duplicate organizations",async()=>{
  const db=database({chatbotId:"cb_existing",validOwner:true,status:"active"});
  expect(await provisionNativeAccount(db as unknown as DbClient,user)).toEqual({chatbotId:"cb_existing"});
  expect(mocks.organization).not.toHaveBeenCalled();expect(mocks.setup).not.toHaveBeenCalled();
});
it.each([{validOwner:false,status:"active"},{validOwner:true,status:"paused"}])("refuses invalid or unavailable mappings without changing access",async existing=>{
  const db=database({chatbotId:"cb_other",...existing});
  await expect(provisionNativeAccount(db as unknown as DbClient,user)).rejects.toMatchObject({code:"conflict"});
  expect(mocks.organization).not.toHaveBeenCalled();
});
it("does not provision anything when the mail model is unavailable",async()=>{
  mocks.setup.mockReturnValue({modelReady:false}); const db=database();
  await expect(provisionNativeAccount(db as unknown as DbClient,user)).rejects.toMatchObject({code:"conflict"});
  expect(mocks.organization).not.toHaveBeenCalled();
});
