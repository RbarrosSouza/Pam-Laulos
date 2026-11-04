import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {collectionFixtureDB} from './collection-db.fixture.mjs';
let db,role,rpc; let seq=0;
const migrations=new URL('../migrations/',import.meta.url);
const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
const hash=()=> (++seq).toString(16).padStart(64,'a');
const actor='10000000-0000-4000-8000-000000000001';
async function source(extra={}) {
 const id=String(++seq);
 const payload={channel:'whatsapp',account_id:'chatwoot:1:inbox:2',message_id:id,attachment_id:'chatwoot-attachment:'+id,original_name:'fixture.pdf',mime_type:'application/pdf',received_at:new Date(Date.now()-600000).toISOString(),
  metadata:{provider:'chatwoot',chatwoot_conversation_id:'3',chatwoot_message_id:id,chatwoot_attachment_id:id,sender_allowlisted:true,unknown_sender:false,exam_candidate:true,unsupported_attachment:false},...extra};
 return rpc('reserve_exam_intake_source',[JSON.stringify(payload)]);
}
async function reserve(id,fingerprint=hash(),worker='fallback:fixture') {return rpc('reserve_exam_fallback_original',[id,fingerprint,123,worker]);}
async function put(result){await db.query("INSERT INTO storage.objects(bucket_id,name,metadata) VALUES($1,$2,'{\"size\":123}')",[result.bucket,result.path]);}
async function confirm(result){return rpc('confirm_exam_fallback_original',[result.document_id,result.lease_token,result.document.sha256,123]);}
async function ready(extra={}){const s=await source(extra),r=await reserve(s.document_id);await put(r);await confirm(r);return r;}
async function group(id,worker='fallback:group'){return rpc('reserve_exam_fallback_group',[id,worker,120]);}
before(async()=>{
 ({db,role,rpc}=await collectionFixtureDB());await db.exec('RESET ROLE');
 for(const name of ['20261016000006_exam_operational_flow.sql','20261016000007_exam_clinical_group_eligibility.sql','20261016000008_exam_gmail_origin_identity.sql','20261016000009_exam_group_after_processing.sql','20261016000010_exam_group_without_identification.sql','20261027000023_exam_intake_receipts_incidents.sql','20261027000024_exam_hopelab_notice_snapshots.sql','20261027000025_exam_intake_panel_coverage.sql','20261027000026_exam_intake_source_lookup.sql','20261027000027_exam_intake_version_review.sql'])await db.exec(await readFile(new URL(name,migrations),'utf8'));
 await db.exec('CREATE TABLE public.exam_document_responsibility(document_id uuid PRIMARY KEY REFERENCES public.exam_document(id)); CREATE TABLE public.exam_document_reaction(document_id uuid REFERENCES public.exam_document(id)); GRANT ALL ON public.exam_document_reaction TO service_role');
 for(const name of ['20261028000040_exam_document_deletion.sql','20261028000041_exam_delete_after_group.sql','20261028000042_exam_delete_empty_aliases.sql','20261028000043_exam_versions_group_independent.sql','20261103000044_exam_whatsapp_fallback.sql'])await db.exec(await readFile(new URL(name,migrations),'utf8'));
 await db.query('INSERT INTO auth.users(id) VALUES($1)',[actor]);await db.query("INSERT INTO exam_document_member(user_id,role) VALUES($1,'admin')",[actor]);
 await role('service_role');await db.query("UPDATE exam_document_configuration SET ingestion_enabled=true,enabled_destinations=ARRAY['drive','processing','group','nexus'],notification_cutoff=now()-interval '2 days',group_destination_key='chatwoot:1:inbox:2:conversation:23'");
});
after(async()=>{await db?.close();});

test('installation is dormant and all fallback APIs/tables are inaccessible to browser roles',async()=>{
 assert.equal((await one('SELECT enabled FROM exam_fallback_configuration')).enabled,false);
 const s=await source();await assert.rejects(reserve(s.document_id),/not enabled or authorized/);
 assert.equal((await rpc('claim_exam_fallback_run',['fallback:fixture',100])).reason,'disabled');
 for(const name of ['anon','authenticated']){await role(name);await assert.rejects(db.query('SELECT * FROM exam_fallback_original'),e=>e.code==='42501');await assert.rejects(rpc('reserve_exam_fallback_original',[s.document_id,hash(),123,'fallback:fixture']),e=>e.code==='42501');}
 await role('service_role');await db.query("UPDATE exam_fallback_configuration SET enabled=true,source_account_id='chatwoot:1:inbox:2',source_conversation_id='3',received_from=now()-interval '1 day'");
});

test('source scope rejects unknown sender, another conversation and pre-cutoff origins',async()=>{
 const base=await source();const metadata=(await one('SELECT metadata FROM exam_document_source WHERE document_id=$1',[base.document_id])).metadata;
 for(const changes of [{unknown_sender:true},{sender_allowlisted:false},{chatwoot_conversation_id:'9'},{unsupported_attachment:true},{exam_candidate:false}]){
  const s=await source();await db.query('UPDATE exam_document_source SET metadata=metadata||$2::jsonb WHERE document_id=$1',[s.document_id,JSON.stringify(changes)]);await assert.rejects(reserve(s.document_id),/not enabled or authorized/);
 }
 const old=await source({received_at:new Date(Date.now()-3*86400000).toISOString()});await assert.rejects(reserve(old.document_id),/not enabled or authorized/);
});

test('Storage proof does not invent Drive completion, extraction or clinical identification',async()=>{
 const s=await source(),r=await reserve(s.document_id);assert(r.claimed);assert.equal(r.document.drive_file_id,null);
 await assert.rejects(confirm(r),/Storage object/);
 await put(r);await assert.rejects(rpc('confirm_exam_fallback_original',[r.document_id,crypto.randomUUID(),r.document.sha256,123]),/fence/);
 const proof=await confirm(r);assert(proof.verified);assert(proof.drive_pending);
 const d=await one('SELECT * FROM exam_document WHERE id=$1',[r.document_id]);assert.equal(d.file_status,'pending');assert.equal(d.extractor_version,null);assert.equal(d.pet_id,null);
 assert.equal((await one("SELECT status FROM exam_document_delivery WHERE document_id=$1 AND destination='drive'",[d.id])).status,'pending');
 assert.equal(Number((await one("SELECT count(*) n FROM exam_document_delivery WHERE document_id=$1 AND destination='processing'",[d.id])).n),0);
 assert.equal(Number((await one("SELECT count(*) n FROM exam_document_delivery WHERE document_id=$1 AND destination='group'",[d.id])).n),1);
 const attempts=(await one("SELECT attempts FROM exam_document_delivery WHERE document_id=$1 AND destination='drive'",[d.id])).attempts;
 assert.equal((await reserve(s.document_id,r.document.sha256)).already_verified,true);
 assert.equal((await one("SELECT attempts FROM exam_document_delivery WHERE document_id=$1 AND destination='drive'",[d.id])).attempts,attempts);
});

test('hash canonicalization shares one immutable backup and one group task',async()=>{
 const first=await ready(),s=await source(),second=await reserve(s.document_id,first.document.sha256);
 assert.equal(second.document_id,first.document_id);assert.equal(second.already_verified,true);
 assert.equal(Number((await one('SELECT count(*) n FROM exam_fallback_original WHERE document_id=$1',[first.document_id])).n),1);
 assert.equal(Number((await one("SELECT count(*) n FROM exam_document_delivery WHERE document_id=$1 AND destination='group'",[first.document_id])).n),1);
 await assert.rejects(reserve(s.document_id,hash()),/não podem ser substituídos/);
});

test('backup does not steal or reset a primary Drive lease; late backup token cannot confirm',async()=>{
 const s=await source(),fingerprint=hash();const primary=await rpc('stage_exam_intake_file',[s.document_id,JSON.stringify({sha256:fingerprint,size_bytes:123,drive_file_id:'fixture-primary',drive_folder_id:'fixture-folder'}),'n8n:primary']);
 const r=await reserve(s.document_id,fingerprint);await put(r);await confirm(r);
 const t=await one("SELECT * FROM exam_document_delivery WHERE document_id=$1 AND destination='drive'",[r.document_id]);assert.equal(t.worker,'n8n:primary');assert.equal(t.lease_token,primary.lease_token);assert.equal(t.status,'reserved');assert.equal(t.attempts,1);
 const late=await reserve((await source()).document_id);await put(late);await db.query("UPDATE exam_fallback_original SET lease_until=now()-interval '1 second' WHERE document_id=$1",[late.document_id]);await assert.rejects(confirm(late),/lease expired/);
});

test('fallback group requires proof, respects age, destination, and existing holds',async()=>{
 const pending=await source();assert.equal((await group(pending.document_id)).claimed,false);
 const r=await ready();assert.equal((await group(r.document_id)).claimed,true);
 const fresh=await ready({received_at:new Date().toISOString()});assert.equal((await group(fresh.document_id)).reason,'primary_grace');
 const held=await ready();await db.query("INSERT INTO exam_intake_document_hold(document_id,state,reason) VALUES($1,'held','awaiting_snapshot')",[held.document_id]);assert.equal((await group(held.document_id)).claimed,false);
 await db.query("UPDATE exam_intake_document_hold SET reason='changed_content_review' WHERE document_id=$1",[held.document_id]);assert.equal((await group(held.document_id)).claimed,true);
 const cutoff=await ready({received_at:new Date(Date.now()-600000).toISOString()});await db.query("UPDATE exam_document_configuration SET notification_cutoff=now()-interval '1 minute'");assert.equal((await group(cutoff.document_id)).claimed,false);await db.query("UPDATE exam_document_configuration SET notification_cutoff=now()-interval '2 days'");
});

test('human rejection and a rejected extraction cannot be bypassed by source candidacy',async()=>{
 for(const event of [{event_type:'reviewed',actor_id:actor,details:{classification:'not_exam'}},{event_type:'extraction_updated',actor_id:null,details:{classification:'not_exam'}}]){
  const r=await ready();await db.query('INSERT INTO exam_document_event(document_id,event_type,actor_id,details) VALUES($1,$2,$3,$4::jsonb)',[r.document_id,event.event_type,event.actor_id,JSON.stringify(event.details)]);assert.equal((await group(r.document_id)).claimed,false);
 }
 const r=await ready();await db.query("UPDATE exam_document SET group_exception_reason='manual hold' WHERE id=$1",[r.document_id]);assert.equal((await group(r.document_id)).claimed,false);
});

test('a primary group reservation or uncertain submission is never taken over or resent',async()=>{
 for(const status of ['reserved','submitted','uncertain','sent','waived']){
  const r=await ready();await db.query("UPDATE exam_document_delivery SET status=$2,worker='n8n:primary',lease_token=gen_random_uuid(),lease_until=now()-interval '1 minute',external_id='fixture' WHERE document_id=$1 AND destination='group'",[r.document_id,status]);assert.equal((await group(r.document_id)).claimed,false);
 }
 const exhausted=await ready();await db.query("UPDATE exam_document_delivery SET status='failed',attempts=max_attempts WHERE document_id=$1 AND destination='group'",[exhausted.document_id]);assert.equal((await group(exhausted.document_id)).claimed,false);
});

test('one-shot dispatch survives lost HTTP responses and uses ordinary provider receipt confirmation',async()=>{
 const r=await ready(),g=await group(r.document_id),t=g.task;
 const first=await rpc('begin_exam_fallback_group_dispatch',[t.id,t.lease_token,'b'.repeat(64)]);assert(first.dispatch_allowed);
 assert.equal((await rpc('begin_exam_fallback_group_dispatch',[t.id,t.lease_token,'b'.repeat(64)])).dispatch_allowed,false);
 assert.equal((await group(r.document_id)).claimed,false);
 const reconciliation=await rpc('list_exam_fallback_group_reconciliation',[20]);assert(reconciliation.tasks.some(x=>x.id===t.id));
 await assert.rejects(rpc('complete_exam_document_delivery',[t.id,t.lease_token,JSON.stringify({status:'sent',external_id:'message',external_status:'created'})]),/Confirmação/);
 await rpc('complete_exam_document_delivery',[t.id,t.lease_token,JSON.stringify({status:'submitted',external_id:'fixture-message',external_status:'sent'})]);
 await rpc('complete_exam_document_delivery',[t.id,t.lease_token,JSON.stringify({status:'sent',external_id:'fixture-message',external_status:'delivered'})]);
 assert.equal((await one('SELECT status FROM exam_document_delivery WHERE id=$1',[t.id])).status,'sent');
 assert.equal((await group(r.document_id)).claimed,false);
 // A later Drive confirmation adds processing, but preserves the existing group receipt.
 const drive=await rpc('stage_exam_intake_file',[r.document_id,JSON.stringify({sha256:r.document.sha256,size_bytes:123,drive_file_id:'later-drive',drive_folder_id:'fixture-folder'}),'n8n:recovered']);
 await rpc('confirm_exam_document_file',[r.document_id,JSON.stringify({sha256:r.document.sha256,size_bytes:123,drive_file_id:'later-drive',drive_folder_id:'fixture-folder'}),drive.lease_token]);
 assert.equal((await one('SELECT status,external_id FROM exam_document_delivery WHERE id=$1',[t.id])).external_id,'fixture-message');
 assert.equal(Number((await one("SELECT count(*) n FROM exam_document_delivery WHERE document_id=$1 AND destination='group'",[r.document_id])).n),1);
});

test('dispatch rechecks deletion, hold, scope and lease just before the external POST',async()=>{
 const r=await ready(),g=await group(r.document_id);await db.query("INSERT INTO exam_intake_document_hold(document_id,state,reason) VALUES($1,'held','awaiting_snapshot')",[r.document_id]);
 await assert.rejects(rpc('begin_exam_fallback_group_dispatch',[g.task.id,g.task.lease_token,'b'.repeat(64)]),/no longer eligible/);
 const r2=await ready(),g2=await group(r2.document_id);await db.query("UPDATE exam_document_delivery SET lease_until=now()-interval '1 second' WHERE id=$1",[g2.task.id]);await assert.rejects(rpc('begin_exam_fallback_group_dispatch',[g2.task.id,g2.task.lease_token,'b'.repeat(64)]),/no longer eligible/);
});

test('pending backup fences deletion, and deleted origins never resurrect',async()=>{
 const r=await reserve((await source()).document_id);await db.query("UPDATE exam_document_delivery SET status='pending',lease_until=NULL WHERE document_id=$1",[r.document_id]);
 let d=await one('SELECT * FROM exam_document WHERE id=$1',[r.document_id]);await assert.rejects(rpc('begin_exam_document_deletion',[d.id,d.version,actor,'DELETAR']),/Fallback.*andamento/);
 await put(r);await confirm(r);d=await one('SELECT * FROM exam_document WHERE id=$1',[r.document_id]);
 assert.equal((await rpc('begin_exam_document_deletion',[d.id,d.version,actor,'DELETAR'])).state,'deleting');
 await assert.rejects(confirm(r),/no longer eligible/);assert.equal((await group(d.id)).claimed,false);
 await db.query('DELETE FROM storage.objects WHERE bucket_id=$1 AND name=$2',[r.bucket,r.path]);assert.equal((await rpc('finish_exam_document_deletion',[d.id,actor,'DELETAR'])).state,'deleted');
 await assert.rejects(reserve(d.id,r.document.sha256),/not enabled or authorized|excluded/);
});

test('run claim, scan validation and checkpoint are fenced and contain only bounded metadata',async()=>{
 const a=await rpc('claim_exam_fallback_run',['fallback:run1',100]);assert(a.claimed);assert.equal((await rpc('claim_exam_fallback_run',['fallback:run2',100])).reason,'run_active');
 const scan={cursor:{version:1,scope:'a'.repeat(64),conversationIndex:0,beforeMessageId:'123',highWaterMessageIds:{3:'150'}},window_start:'2026-11-03T00:00:00.000Z',window_end:'2026-11-03T00:01:00.000Z'};
 await assert.rejects(rpc('checkpoint_exam_fallback_run',[a.run_token,{...scan,url:'https://secret.invalid'},false,null]),/Invalid fallback checkpoint/);
 await assert.rejects(rpc('checkpoint_exam_fallback_run',[a.run_token,{...scan,cursor:{...scan.cursor,scope:'https://secret.invalid'}},false,null]),/Invalid fallback checkpoint/);
 const checkpoint=await rpc('checkpoint_exam_fallback_run',[a.run_token,scan,false,'provider_unavailable']);assert.deepEqual(checkpoint.scan,scan);
 const b=await rpc('claim_exam_fallback_run',['fallback:run2',100]);assert.deepEqual(b.scan,scan);await assert.rejects(rpc('checkpoint_exam_fallback_run',[a.run_token,{},true,null]),/fence/);
 await db.query("UPDATE exam_fallback_runtime SET run_until=now()-interval '1 second'");await assert.rejects(rpc('checkpoint_exam_fallback_run',[b.run_token,{},true,null]),/expired/);
 const c=await rpc('claim_exam_fallback_run',['fallback:run3',100]);assert.deepEqual((await rpc('checkpoint_exam_fallback_run',[c.run_token,{},true,null])).scan,{});
});

test('expired fallback pre-submit leases recover, while primary or started sends remain GET-only',async()=>{
 const r=await ready(),first=await group(r.document_id);await db.query("UPDATE exam_document_delivery SET lease_until=now()-interval '1 second' WHERE id=$1",[first.task.id]);
 const second=await group(r.document_id);assert(second.claimed);assert.notEqual(second.task.lease_token,first.task.lease_token);
 await assert.rejects(rpc('begin_exam_fallback_group_dispatch',[first.task.id,first.task.lease_token,'b'.repeat(64)]),/fence/);
 await rpc('begin_exam_fallback_group_dispatch',[second.task.id,second.task.lease_token,'b'.repeat(64)]);
 assert.equal((await group(r.document_id)).claimed,false);
 const event=await one("SELECT details FROM exam_document_event WHERE document_id=$1 AND event_type='fallback_group_dispatch_started'",[r.document_id]);assert.equal(event.details.lease_token,second.task.lease_token);
 // Primary submissions with no sidecar or fallback event must also reconcile.
 const origin=await source(),fingerprint=hash();const staged=await rpc('stage_exam_intake_file',[origin.document_id,JSON.stringify({sha256:fingerprint,size_bytes:123,drive_file_id:'primary-only',drive_folder_id:'fixture'}),'n8n:primary']);
 await rpc('confirm_exam_document_file',[origin.document_id,JSON.stringify({sha256:fingerprint,size_bytes:123,drive_file_id:'primary-only',drive_folder_id:'fixture'}),staged.lease_token]);
 const token=crypto.randomUUID();await db.query("UPDATE exam_document_delivery SET status='reserved',worker='n8n:primary',lease_token=$2,lease_until=now()-interval '1 minute',destination_key='chatwoot:1:inbox:2:conversation:23' WHERE document_id=$1 AND destination='group'",[origin.document_id,token]);
 const list=await rpc('list_exam_fallback_group_reconciliation',[20]);const item=list.tasks.find(x=>x.document_id===origin.document_id);assert(item);assert.equal(item.status,'uncertain');assert.equal(item.lease_token,token);assert.equal((await group(origin.document_id)).claimed,false);
});

async function enqueueFromDocument(id){const s=await one('SELECT * FROM exam_document_source WHERE document_id=$1',[id]);return rpc('enqueue_exam_fallback_source',[JSON.stringify({...s,original_name:'fixture.pdf',mime_type:'application/pdf'})]);}

test('durable source retry scheduling lets the seventh origin pass six recurring failures',async()=>{
 const ids=[];for(let i=0;i<7;i++){const s=await source();const q=await enqueueFromDocument(s.document_id);ids.push(q);}
 const first=(await rpc('claim_exam_fallback_sources',['fallback:queue',6])).tasks;assert.equal(first.length,6);assert(first.every(t=>t.document?.id===t.document_id&&t.source?.id===t.source_id));
 for(const task of first) await rpc('finish_exam_fallback_source',[task.source_id,task.lease_token,'retry','download_unavailable',60]);
 const before=await one('SELECT * FROM exam_fallback_source_queue WHERE source_id=$1',[first[0].source_id]);await enqueueFromDocument(first[0].document_id);const after=await one('SELECT * FROM exam_fallback_source_queue WHERE source_id=$1',[first[0].source_id]);assert.equal(after.attempts,before.attempts);assert.equal(after.next_attempt_at.getTime(),before.next_attempt_at.getTime());
 const next=(await rpc('claim_exam_fallback_sources',['fallback:queue',1])).tasks;assert.equal(next.length,1);assert(!first.some(t=>t.source_id===next[0].source_id));
 await assert.rejects(rpc('finish_exam_fallback_source',[next[0].source_id,next[0].lease_token,'done',null,null]),/not terminal/);
 await db.query("INSERT INTO exam_document_delivery(document_id,destination,status,destination_key,external_id) VALUES($1,'group','submitted','chatwoot:1:inbox:2:conversation:23','fixture')",[next[0].document_id]);
 await rpc('finish_exam_fallback_source',[next[0].source_id,next[0].lease_token,'done',null,null]);
 assert((await rpc('list_exam_fallback_group_reconciliation',[20])).tasks.some(t=>t.document_id===next[0].document_id));
});

test('source queue expiry invalidates old tokens, respects primary grace, and refuses metadata URLs',async()=>{
 const old=await source(),q=await enqueueFromDocument(old.document_id);const task=(await rpc('claim_exam_fallback_sources',['fallback:queue-expiry',1])).tasks[0];assert.equal(task.source_id,q.source_id);
 await db.query("UPDATE exam_fallback_source_queue SET lease_until=now()-interval '1 second' WHERE source_id=$1",[q.source_id]);
 await rpc('claim_exam_fallback_sources',['fallback:next',1]);await assert.rejects(rpc('finish_exam_fallback_source',[q.source_id,task.lease_token,'retry','late',60]),/fence/);
 const fresh=await source({received_at:new Date().toISOString()});const freshQueue=await enqueueFromDocument(fresh.document_id);assert(!(await rpc('claim_exam_fallback_sources',['fallback:grace',20])).tasks.some(t=>t.source_id===freshQueue.source_id));
 const s=await one('SELECT * FROM exam_document_source WHERE document_id=$1',[fresh.document_id]);await assert.rejects(rpc('enqueue_exam_fallback_source',[JSON.stringify({...s,metadata:{...s.metadata,url:'https://secret.invalid'},original_name:'fixture.pdf'})]),/outside/);
});

test('an unsupported authorized attachment becomes visible review without blocking subsequent discovery',async()=>{
 const s=await source();const src=await one('SELECT * FROM exam_document_source WHERE document_id=$1',[s.document_id]);
 const input={...src,original_name:'fixture.pdf',metadata:{...src.metadata,unsupported_attachment:true,pending_reason:'pdf_size_invalid_or_exceeds_limit'}};
 const first=await rpc('enqueue_exam_fallback_source',[JSON.stringify(input)]),second=await rpc('enqueue_exam_fallback_source',[JSON.stringify(input)]);
 assert.equal(first.queued,false);assert.equal(first.reason,'requires_review');assert.equal(second.reason,'requires_review');
 assert.equal(Number((await one("SELECT count(*) n FROM exam_document_event WHERE document_id=$1 AND event_type='fallback_source_requires_review'",[s.document_id])).n),1);
 assert.equal(Number((await one("SELECT count(*) n FROM exam_intake_incident WHERE document_id=$1 AND code='unsupported_attachment_requires_review'",[s.document_id])).n),1);
 assert.equal(Number((await one('SELECT count(*) n FROM exam_fallback_source_queue WHERE source_id=$1',[src.id])).n),0);
 const next=await source();assert.equal((await enqueueFromDocument(next.document_id)).queued,true);
});
