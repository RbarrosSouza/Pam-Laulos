import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRelay,loadConfig,JobStore} from './server.mjs';

const requestBody=(id='pim-'+crypto.randomUUID(),text='Pam Laudos: offline alert fixture')=>({content:text+'\n[PAM-INTAKE:'+id+']',message_type:'outgoing',private:false,content_attributes:{pam_intake_correlation:id}});
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'intake-relay-test-'));
 const env={CHATWOOT_BASE_URL:'https://chat.example',CHATWOOT_ACCOUNT_ID:'1',CHATWOOT_INBOX_ID:'2',CHATWOOT_CONVERSATION_ID:'4',EXPECTED_DESTINATION_PHONE:'+5511999999999',EXPECTED_CHATWOOT_CHANNEL:'Channel::Api',CHATWOOT_TOKEN:'offline-upstream-secret',RELAY_CAPABILITY_TOKEN:'offline-relay-capability-secret-at-least-32-characters',RELAY_ENCRYPTION_KEY:'b'.repeat(64),RELAY_DB_PATH:path.join(dir,'jobs.sqlite')};
 const cfg=loadConfig(env),calls=[],messages=[];let app;
 const state={cfg,env,calls,messages,ackLost:false,redirect:false,destPhone:cfg.phone,maxPage:null,destExtra:{},
  async fetch(url,init){
   calls.push({url,init});assert.equal(new URL(url).origin,'https://chat.example');assert.equal(init.redirect,'manual');assert.equal(init.headers.api_access_token,cfg.upstreamToken);assert.equal(Object.values(init.headers).includes(cfg.capability),false);
   if(state.redirect)return new Response(null,{status:302,headers:{Location:'https://outside.example'}});
   if(!url.includes('/messages'))return Response.json({id:4,inbox_id:2,account_id:1,meta:{channel:'Channel::Api',sender:{phone_number:state.destPhone,identifier:'5511999999999@s.whatsapp.net',...state.destExtra}}});
   if(init.method==='POST'){const body=JSON.parse(init.body),message={...body,id:1000+messages.length,status:'sent',created_at:Date.now()/1000,message_type:1,private:false,conversation_id:4,inbox_id:2,account_id:1};messages.push(message);if(state.ackLost)throw new Error('offline lost provider ACK');return Response.json(message,{status:201});}
   return Response.json({payload:state.maxPage||messages});
  },
  async start(){app=createRelay(cfg,{fetchImpl:state.fetch});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));state.base='http://127.0.0.1:'+app.server.address().port;state.app=app;},
  async restart(){await app.close();await state.start();},
  async req(suffix='',method='GET',body,token=cfg.capability){return fetch(state.base+suffix,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});},
  get prefix(){return '/api/v1/accounts/1/conversations/4';},
  posts(){return calls.filter(c=>c.init.method==='POST');}
 };
 await state.start();t.after(async()=>{await app.close();await fs.rm(dir,{recursive:true,force:true});});return state;
}

test('configuration has no embedded recipient and requires HTTPS, distinct capability and encryption key',()=>{
 assert.throws(()=>loadConfig({}),/CONFIGURATION_INVALID/);
 const env={CHATWOOT_BASE_URL:'http://example.invalid',CHATWOOT_ACCOUNT_ID:'1',CHATWOOT_INBOX_ID:'2',CHATWOOT_CONVERSATION_ID:'4',EXPECTED_DESTINATION_PHONE:'+5511999999999',EXPECTED_CHATWOOT_CHANNEL:'Channel::Api',CHATWOOT_TOKEN:'offline-upstream-secret',RELAY_CAPABILITY_TOKEN:'offline-relay-secret-at-least-32-characters',RELAY_ENCRYPTION_KEY:'b'.repeat(64)};assert.throws(()=>loadConfig(env),/CONFIGURATION_INVALID/);
 assert.throws(()=>loadConfig({...env,CHATWOOT_BASE_URL:'https://example.invalid',RELAY_CAPABILITY_TOKEN:'b'.repeat(64)}),/CONFIGURATION_INVALID/);
});
test('wrong capability, foreign destination path, forbidden method and arbitrary body never reach provider POST',async t=>{
 const f=await fixture(t);assert.equal((await f.req(f.prefix,'GET',undefined,'wrong')).status,401);assert.equal((await f.req('/api/v1/accounts/1/conversations/999','GET')).status,404);assert.equal((await f.req(f.prefix+'/messages','DELETE')).status,404);
 assert.equal((await f.req(f.prefix+'/messages','POST',{...requestBody(),destination:'elsewhere'})).status,400);assert.equal((await f.req(f.prefix+'/messages','POST',{...requestBody(),attachments:['private-file']})).status,400);assert.equal(f.calls.length,0);
});
test('phone mismatch and redirect fail before dispatch; token never follows redirect',async t=>{
 const f=await fixture(t);f.destPhone='+5516000000000';assert.equal((await f.req(f.prefix+'/messages','POST',requestBody())).status,409);assert.equal(f.posts().length,0);
 f.destPhone=f.cfg.phone;f.redirect=true;assert.equal((await f.req(f.prefix+'/messages','POST',requestBody())).status,503);assert.equal(f.posts().length,0);assert.ok(f.calls.every(c=>c.url.startsWith(f.cfg.base)));
});
test('same idempotency correlation performs one POST, conflict cannot change content, data at rest is encrypted',async t=>{
 const f=await fixture(t),body=requestBody(undefined,'Pam Laudos: sensitive-offline-sentinel');assert.equal((await f.req(f.prefix+'/messages','POST',body)).status,202);
 for(let i=0;i<3;i++)assert.equal((await f.req(f.prefix+'/messages','POST',body)).status,200);assert.equal(f.posts().length,1);
 const changed={...body,content:body.content.replace('sensitive','changed')};assert.equal((await f.req(f.prefix+'/messages','POST',changed)).status,409);assert.equal(f.posts().length,1);
 const row=f.app.store.db.prepare('SELECT * FROM jobs').get();assert.equal(Buffer.from(row.ciphertext).includes(Buffer.from('sensitive-offline-sentinel')),false);assert.equal(JSON.stringify(row).includes(body.content_attributes.pam_intake_correlation),false);
});
test('lost ACK remains uncertain across restart and GET readback confirms without redispatch',async t=>{
 const f=await fixture(t),body=requestBody();f.ackLost=true;const first=await (await f.req(f.prefix+'/messages','POST',body)).json();assert.equal(first.relay.state,'uncertain');await f.restart();
 assert.equal((await (await f.req(f.prefix+'/messages','POST',body)).json()).relay.state,'uncertain');assert.equal(f.posts().length,1);
 f.messages[0].status='read';const page=await (await f.req(f.prefix+'/messages')).json();assert.equal(page.payload[0].content,body.content);const job=await (await f.req('/v1/jobs/'+body.content_attributes.pam_intake_correlation)).json();assert.equal(job.relay.state,'confirmed');
 await f.req(f.prefix+'/messages','POST',body);assert.equal(f.posts().length,1);
});
test('a process death after the durable dispatch fence cannot resend on restart',async t=>{
 const f=await fixture(t),body=requestBody();const reserved=f.app.store.reserve(body,20);f.app.store.update(reserved.job,'started');await f.restart();const out=await (await f.req(f.prefix+'/messages','POST',body)).json();assert.equal(out.relay.state,'uncertain');assert.equal(f.posts().length,0);
});
test('concurrent copies of the same job cannot produce multiple provider POSTs',async t=>{
 const f=await fixture(t),body=requestBody();await Promise.all(Array.from({length:5},()=>f.req(f.prefix+'/messages','POST',body)));assert.equal(f.posts().length,1);
});
test('21-message pages are complete, over 100 or nonprogressing pages are rejected, unrelated content is redacted',async t=>{
 const f=await fixture(t);f.maxPage=Array.from({length:21},(_,i)=>({id:100-i,created_at:Date.now()/1000,status:'sent',message_type:1,private:false,conversation_id:4,inbox_id:2,content:'private unrelated text',attachments:[{url:'https://secret.example'}]}));
 const result=await (await f.req(f.prefix+'/messages')).json();assert.equal(result.payload.length,21);assert.ok(result.payload.every(m=>m.content===''&&Object.keys(m.content_attributes).length===0));assert.equal(JSON.stringify(result).includes('secret.example'),false);
 f.maxPage=Array(101).fill(f.maxPage[0]);assert.equal((await f.req(f.prefix+'/messages')).status,503);f.maxPage=[{id:100,created_at:1}];assert.equal((await f.req(f.prefix+'/messages?before=100')).status,503);assert.equal((await f.req(f.prefix+'/messages?url=https://outside.example')).status,400);
});
test('persistent encryption-key mismatch refuses startup rather than treating old jobs as new',async t=>{
 const f=await fixture(t);await f.req(f.prefix+'/messages','POST',requestBody());assert.throws(()=>new JobStore(f.cfg.dbPath,Buffer.from('c'.repeat(64),'hex')),/KEY_CHANGED/);assert.equal(f.posts().length,1);
});
test('body size and rate limits apply before a second provider mutation',async t=>{
 const f=await fixture(t);f.cfg.maxPerHour=1;assert.equal((await f.req(f.prefix+'/messages','POST',requestBody())).status,202);assert.equal((await f.req(f.prefix+'/messages','POST',requestBody())).status,429);assert.equal((await f.req(f.prefix+'/messages','POST','x'.repeat(9000))).status,413);assert.equal(f.posts().length,1);
});
test('readback uses the exact footer if provider omits attributes and preserves confirmed/conflict evidence',async t=>{
 const f=await fixture(t),body=requestBody();await f.req(f.prefix+'/messages','POST',body);delete f.messages[0].content_attributes;f.messages[0].status='delivered';
 const page=await (await f.req(f.prefix+'/messages')).json();assert.equal(page.payload[0].content,body.content);let job=f.app.store.get(body.content_attributes.pam_intake_correlation);assert.equal(job.state,'confirmed');
 f.app.store.update(job,'submitted',{observed:'created'});assert.equal(f.app.store.get(body.content_attributes.pam_intake_correlation).state,'confirmed');
 f.app.store.update(job,'uncertain',{errorCode:'LATE_POST_ACK_LOST'});assert.equal(f.app.store.get(body.content_attributes.pam_intake_correlation).state,'confirmed');
 f.app.store.update(job,'uncertain',{conflict:true});f.app.store.update(job,'submitted',{observed:'created'});job=f.app.store.get(body.content_attributes.pam_intake_correlation);assert.equal(job.state,'uncertain');assert.equal(job.payload.conflict,true);assert.equal(f.posts().length,1);
});
test('group flags and group/broadcast/newsletter JIDs are rejected despite a matching phone',async t=>{
 const f=await fixture(t);
 for(const extra of [{is_group:true},{isGroup:'true'},{group_type:'group'},{additional_attributes:{remoteJid:'opaque@g.us'}},{custom_attributes:{jid:'opaque@broadcast'}},{identifier:'opaque@newsletter'}]){
  f.destExtra=extra;assert.equal((await f.req(f.prefix+'/messages','POST',requestBody())).status,409);assert.equal(f.posts().length,0);
 }
});
test('attribute/footer disagreement holds the existing job instead of confirming another identity',async t=>{
 const f=await fixture(t),body=requestBody();await f.req(f.prefix+'/messages','POST',body);f.messages[0].status='read';f.messages[0].content_attributes.pam_intake_correlation='pim-'+crypto.randomUUID();
 const page=await (await f.req(f.prefix+'/messages')).json();assert.equal(page.payload[0].content,'');const job=f.app.store.get(body.content_attributes.pam_intake_correlation);assert.equal(job.state,'uncertain');assert.equal(job.payload.conflict,true);assert.equal(f.posts().length,1);
});
