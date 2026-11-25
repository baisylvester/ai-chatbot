import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createPool, type DbClient } from "@chatbot/database";
import { addDocument, createChatbot, createKnowledgeSource, deleteDocument, enqueueIngestion, knowledgeStateForChatbot,
  markForReprocessing, processIngestionJob, retrieveForChatbot, setGlobalSourceAssignment } from "@chatbot/core";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/mail-agent", () => ({mailSetup:()=>({modelReady:true,provider:"openai-compatible",model:"fixture"})}));
import { provisionNativeAccount } from "../src/lib/native-onboarding";

it.runIf(Boolean(process.env.NATIVE_KNOWLEDGE_DATABASE_TEST_URL))("reads processed edits, assignment changes and deletion live while isolating other tenant knowledge, then rolls everything back", async () => {
  const pool=createPool(process.env.NATIVE_KNOWLEDGE_DATABASE_TEST_URL!,1), db=await pool.connect();
  const user=randomUUID(), other=randomUUID(), probe="nativekb"+randomUUID().replaceAll("-","");
  const trusted=<T>(fn:(db:DbClient)=>Promise<T>)=>fn(db);
  try {
    await db.query("begin");
    await db.query("insert into users(id,email) values($1,$2),($3,$4)",[user,`kb-${user}@example.invalid`,other,`kb-${other}@example.invalid`]);
    const personal=await provisionNativeAccount(db,{id:user});
    const privateOther=await provisionNativeAccount(db,{id:other});
    await db.query("select set_config('app.user_id',$1,true)",[user]);
    const parent=(await db.query<{website_id:string}>("select website_id from chatbots where public_id=$1",[personal.chatbotId])).rows[0]!;
    const sourceBot=await createChatbot(db,{websiteId:parent.website_id,settings:{name:"Knowledge sync fixture",model:"fixture"}});
    const source=await createKnowledgeSource(db,{chatbotId:sourceBot.id,name:"Own knowledge fixture"});
    const doc=await addDocument(db,{sourceId:source.id,kind:"text",title:"Sync fixture",content:`${probe} lifecycle is AMBERFIRST.`});
    const ingest=async(document:typeof doc)=>processIngestionJob(trusted,await enqueueIngestion(db,document),{embedder:null});
    expect(await ingest(doc)).toBe("succeeded");
    expect(await knowledgeStateForChatbot(db,sourceBot)).toMatchObject({sourceCount:1,readyDocuments:1,chunks:1});
    expect((await retrieveForChatbot(db,sourceBot,probe))[0]?.content).toContain("AMBERFIRST");

    // A different tenant uses the exact same probe; its content must never enter this result.
    const otherBot=(await db.query<{id:string;organization_id:string}>("select id,organization_id from chatbots where public_id=$1",[privateOther.chatbotId])).rows[0]!;
    await db.query("select set_config('app.user_id',$1,true)",[other]);
    const hidden=await createKnowledgeSource(db,{chatbotId:otherBot.id,name:"Other tenant fixture"});
    const hiddenDoc=await addDocument(db,{sourceId:hidden.id,kind:"text",title:"Private fixture",content:`${probe} PRIVATEHIDDEN.`});
    expect(await ingest(hiddenDoc)).toBe("succeeded");
    await db.query("select set_config('app.user_id',$1,true)",[user]);
    expect((await retrieveForChatbot(db,sourceBot,probe)).every(x=>!x.content.includes("PRIVATEHIDDEN"))).toBe(true);

    await db.query("update knowledge_documents set content=$2,updated_at=now() where id=$1",[doc.id,`${probe} lifecycle is COBALTSECOND.`]);
    expect(await ingest(await markForReprocessing(db,doc.id))).toBe("succeeded");
    const updated=await retrieveForChatbot(db,sourceBot,probe);
    expect(updated[0]?.content).toContain("COBALTSECOND");expect(updated.every(x=>!x.content.includes("AMBERFIRST"))).toBe(true);

    const global=await createKnowledgeSource(db,{organizationId:sourceBot.organization_id,name:"Shared fixture"});
    const globalDoc=await addDocument(db,{sourceId:global.id,kind:"text",title:"Shared fixture",content:`${probe} SHAREDASSIGNED.`});
    expect(await ingest(globalDoc)).toBe("succeeded");
    expect((await retrieveForChatbot(db,sourceBot,probe)).some(x=>x.content.includes("SHAREDASSIGNED"))).toBe(false);
    await setGlobalSourceAssignment(db,sourceBot.id,global.id,true);
    expect((await retrieveForChatbot(db,sourceBot,probe)).some(x=>x.content.includes("SHAREDASSIGNED"))).toBe(true);
    expect(await knowledgeStateForChatbot(db,sourceBot)).toMatchObject({sourceCount:2,readyDocuments:2,chunks:2});
    await setGlobalSourceAssignment(db,sourceBot.id,global.id,false);
    await deleteDocument(db,doc.id);
    expect(await retrieveForChatbot(db,sourceBot,probe)).toEqual([]);
    expect(await knowledgeStateForChatbot(db,sourceBot)).toMatchObject({sourceCount:1,readyDocuments:0,chunks:0});
    await db.query("rollback");
    expect((await db.query("select count(*)::int as count from users where id=any($1::uuid[])",[[user,other]])).rows[0].count).toBe(0);
  } finally { await db.query("rollback").catch(()=>{});db.release();await pool.end(); }
},90_000);
