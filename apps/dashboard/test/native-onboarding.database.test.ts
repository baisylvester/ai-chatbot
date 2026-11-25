import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {createPool} from "@chatbot/database";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/mail-agent",()=>({mailSetup:()=>({modelReady:true,provider:"openai-compatible",model:"qwen3:8b"})}));
import {provisionNativeAccount} from "../src/lib/native-onboarding";

it.runIf(Boolean(process.env.ONBOARDING_DATABASE_TEST_URL))("provisions isolated assistants idempotently against Postgres and rolls back all fixtures",async()=>{
  const pool=createPool(process.env.ONBOARDING_DATABASE_TEST_URL!,1);const db=await pool.connect();
  const a=randomUUID(),b=randomUUID();
  try {
    await db.query('begin');
    await db.query("insert into public.users(id,email) values($1,$2),($3,$4)",[a,`qa-${a}@example.invalid`,b,`qa-${b}@example.invalid`]);
    const first=await provisionNativeAccount(db,{id:a});
    expect(await provisionNativeAccount(db,{id:a})).toEqual(first);
    const second=await provisionNativeAccount(db,{id:b});expect(second.chatbotId).not.toBe(first.chatbotId);
    expect((await db.query("select count(*)::int as count from native_accounts where user_id=any($1::uuid[])",[[a,b]])).rows[0].count).toBe(2);
    await db.query('savepoint role_check');
    await db.query('set local role chatbot_app');await db.query("select set_config('app.user_id',$1,true)",[a]);
    const visible=(await db.query("select public_id from chatbots where public_id=any($1::text[])",[[first.chatbotId,second.chatbotId]])).rows;
    expect(visible.map(r=>r.public_id)).toEqual([first.chatbotId]);
    await expect(db.query('select * from native_accounts')).rejects.toMatchObject({code:'42501'});
    await db.query('rollback to savepoint role_check');
    await db.query('rollback');
    expect((await db.query("select count(*)::int as count from users where id=any($1::uuid[])",[[a,b]])).rows[0].count).toBe(0);
  } finally {await db.query('rollback').catch(()=>{});db.release();await pool.end()}
},30_000);
