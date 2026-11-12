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
 for(const name of ['20261028000040_exam_document_deletion.sql','20261028000041_exam_delete_after_group.sql','20261028000042_exam_delete_empty_aliases.sql','20261028000043_exam_versions_group_independent.sql','20261103000044_exam_whatsapp_fallback.sql','20261104000046_exam_fallback_primary_priority.sql','20261104000047_exam_gmail_drive_retry_policy.sql','20261112020843_exam_fallback_discovery_dedupe.sql'])await db.exec(await readFile(new URL(name,migrations),'utf8'));
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
 await put(r);await assert.rejects(rpc('confirm_exam_fallback_original',[r.document_id,crypto.randomUUID(),r.document.sha256,123]),{code:'PT409',message:/fence/});
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
 const late=await reserve((await source()).document_id);await put(late);await db.query("UPDATE exam_fallback_original SET lease_until=now()-interval '1 second' WHERE document_id=$1",[late.document_id]);await assert.rejects(confirm(late),{code:'PT409',message:/lease expired/});
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
 await assert.rejects(rpc('begin_exam_fallback_group_dispatch',[g.task.id,g.task.lease_token,'b'.repeat(64)]),{code:'PT409',message:/no longer eligible/});
 const r2=await ready(),g2=await group(r2.document_id);await db.query("UPDATE exam_document_delivery SET lease_until=now()-interval '1 second' WHERE id=$1",[g2.task.id]);await assert.rejects(rpc('begin_exam_fallback_group_dispatch',[g2.task.id,g2.task.lease_token,'b'.repeat(64)]),{code:'PT409',message:/no longer eligible/});
});

test('pending backup fences deletion, and deleted origins never resurrect',async()=>{
 const r=await reserve((await source()).document_id);await db.query("UPDATE exam_document_delivery SET status='pending',lease_until=NULL WHERE document_id=$1",[r.document_id]);
 let d=await one('SELECT * FROM exam_document WHERE id=$1',[r.document_id]);await assert.rejects(rpc('begin_exam_document_deletion',[d.id,d.version,actor,'DELETAR']),{code:'PT409',message:/Fallback.*andamento/});
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
 const b=await rpc('claim_exam_fallback_run',['fallback:run2',100]);assert.deepEqual(b.scan,scan);await assert.rejects(rpc('checkpoint_exam_fallback_run',[a.run_token,{},true,null]),{code:'PT409',message:/fence/});
 await db.query("UPDATE exam_fallback_runtime SET run_until=now()-interval '1 second'");await assert.rejects(rpc('checkpoint_exam_fallback_run',[b.run_token,{},true,null]),{code:'PT409',message:/expired/});
 const c=await rpc('claim_exam_fallback_run',['fallback:run3',100]);assert.deepEqual((await rpc('checkpoint_exam_fallback_run',[c.run_token,{},true,null])).scan,{});
});

test('expired fallback pre-submit leases recover, while primary or started sends remain GET-only',async()=>{
 const r=await ready(),first=await group(r.document_id);await db.query("UPDATE exam_document_delivery SET lease_until=now()-interval '1 second' WHERE id=$1",[first.task.id]);
 const second=await group(r.document_id);assert(second.claimed);assert.notEqual(second.task.lease_token,first.task.lease_token);
 await assert.rejects(rpc('begin_exam_fallback_group_dispatch',[first.task.id,first.task.lease_token,'b'.repeat(64)]),{code:'PT409',message:/fence/});
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
 await rpc('claim_exam_fallback_sources',['fallback:next',1]);await assert.rejects(rpc('finish_exam_fallback_source',[q.source_id,task.lease_token,'retry','late',60]),{code:'PT409',message:/fence/});
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

async function primaryLease(id,destination='drive') {
 const token=crypto.randomUUID();
 await db.query(`INSERT INTO exam_document_delivery(document_id,destination,status,worker,lease_token,lease_until,attempts)
   VALUES($1,$2,'reserved','n8n:primary',$3,now()+interval '10 minutes',1)
   ON CONFLICT(document_id,destination,destination_key) DO UPDATE SET status='reserved',worker='n8n:primary',lease_token=$3,lease_until=now()+interval '10 minutes',attempts=1`,[id,destination,token]);
 return token;
}
async function eventAgo(id,type,minutes,details={}) {
 await db.query("INSERT INTO exam_document_event(document_id,event_type,details,created_at) VALUES($1,$2,$3::jsonb,now()-make_interval(mins=>$4))",[id,type,JSON.stringify(details),minutes]);
}
async function receivedAgo(id,minutes) {await db.query("UPDATE exam_document SET received_at=now()-make_interval(mins=>$2) WHERE id=$1",[id,minutes]);}

test('Zoey case: early preservation cannot overtake an active primary Drive upload',async()=>{
 const r=await ready({received_at:new Date(Date.now()-180000).toISOString()});
 const token=await primaryLease(r.document_id);
 const result=await group(r.document_id);assert.equal(result.claimed,false);assert.equal(result.reason,'primary_active');
 assert.equal((await one("SELECT lease_token FROM exam_document_delivery WHERE document_id=$1 AND destination='drive'",[r.document_id])).lease_token,token);
 assert.equal((await one("SELECT attempts FROM exam_document_delivery WHERE document_id=$1 AND destination='group'",[r.document_id])).attempts,0);
});

test('a valid primary processing lease has priority and retry timestamps are not advancement',async()=>{
 const r=await ready();await receivedAgo(r.document_id,20);await eventAgo(r.document_id,'file_saved',8);
 await primaryLease(r.document_id,'processing');
 assert.equal((await group(r.document_id)).reason,'primary_active');
 const state=await rpc('exam_fallback_primary_state',[r.document_id]);assert(state.idle_seconds>=479);assert.equal(state.active_destination,'processing');
});

test('a primary that never starts gets two collection cycles, then verified backup may deliver',async()=>{
 const r=await ready({received_at:new Date(Date.now()-180000).toISOString()});
 assert.equal((await group(r.document_id)).reason,'primary_start_grace');
 await receivedAgo(r.document_id,11);
 const claim=await group(r.document_id);assert(claim.claimed);assert.equal(claim.reason,'primary_stalled');
 const audit=await one("SELECT details FROM exam_document_event WHERE document_id=$1 AND event_type='fallback_group_reserved'",[r.document_id]);assert.equal(audit.details.primary.reason,'primary_stalled');
});

test('recent verified extraction or Drive completion keeps the principal first',async()=>{
 for(const stage of ['file_saved','extraction_updated']){
  const r=await ready();await receivedAgo(r.document_id,40);await eventAgo(r.document_id,stage,3);
  assert.equal((await group(r.document_id)).reason,'primary_progress');
 }
});

test('stale historic Gmail failures do not override later successful advancement',async()=>{
 const r=await ready();await receivedAgo(r.document_id,30);
 await db.query("UPDATE exam_document SET file_status='failed' WHERE id=$1",[r.document_id]);
 await eventAgo(r.document_id,'source_failed',20,{error:'Não foi possível preservar o original Gmail/Drive'});
 await eventAgo(r.document_id,'file_saved',2);
 const state=await rpc('exam_fallback_primary_state',[r.document_id]);assert.equal(state.eligible,false);assert.equal(state.reason,'primary_progress');assert.equal(state.last_failure_at,null);
});

test('Paçoca case: confirmed failed Gmail/Drive and no valid primary lease allows fallback',async()=>{
 const r=await ready({received_at:new Date(Date.now()-180000).toISOString()});
 await db.query("UPDATE exam_document SET file_status='failed' WHERE id=$1",[r.document_id]);
 await eventAgo(r.document_id,'source_failed',0,{error:'Não foi possível preservar o original Gmail/Drive'});
 const claim=await group(r.document_id);assert(claim.claimed);assert.equal(claim.reason,'primary_failed');
 const started=await rpc('begin_exam_fallback_group_dispatch',[claim.task.id,claim.task.lease_token,'b'.repeat(64)]);assert(started.dispatch_allowed);
 const audit=await one("SELECT details FROM exam_document_event WHERE document_id=$1 AND event_type='fallback_group_dispatch_started'",[r.document_id]);assert.equal(audit.details.primary.reason,'primary_failed');
});

test('busy/deferred source work and failures on a now healthy source are not immediate failover',async()=>{
 for(const reason of ['primary_busy','primary_deferred','deferred']){
  const r=await ready({received_at:new Date(Date.now()-180000).toISOString()});
  await db.query("UPDATE exam_document SET file_status='failed' WHERE id=$1",[r.document_id]);
  await eventAgo(r.document_id,'source_failed',0,{reason_code:reason});
  assert.equal((await group(r.document_id)).reason,'primary_start_grace');
 }
 const r=await ready({received_at:new Date(Date.now()-180000).toISOString()});
 await eventAgo(r.document_id,'source_failed',0,{error:'old generic'});
 assert.equal((await group(r.document_id)).reason,'primary_start_grace');
});

test('an explicit failed primary task can fail over before the no-progress window',async()=>{
 const r=await ready({received_at:new Date(Date.now()-180000).toISOString()});
 await db.query("UPDATE exam_document_delivery SET status='failed',worker='n8n:primary',last_error='drive_upload_failed',updated_at=now() WHERE document_id=$1 AND destination='drive'",[r.document_id]);
 const claim=await group(r.document_id);assert(claim.claimed);assert.equal(claim.reason,'primary_failed');
});

test('fallback events, document edits, retries and new source aliases cannot reset a stalled primary',async()=>{
 const r=await ready();await receivedAgo(r.document_id,40);await eventAgo(r.document_id,'file_saved',12);
 for(const type of ['fallback_original_verified','retry_requested','source_reserved','source_deduplicated','contact_recorded'])await eventAgo(r.document_id,type,0);
 await db.query("UPDATE exam_document SET original_name='unchanged identity.pdf' WHERE id=$1",[r.document_id]);
 const claim=await group(r.document_id);assert(claim.claimed);assert.equal(claim.reason,'primary_stalled');assert(claim.primary.idle_seconds>=719);
});

test('renewed Drive lease cannot starve last-resort delivery after 30 minutes without real progress',async()=>{
 const r=await ready();await receivedAgo(r.document_id,20);const token=await primaryLease(r.document_id);
 assert.equal((await group(r.document_id)).reason,'primary_active');
 await receivedAgo(r.document_id,31);
 const claim=await group(r.document_id);assert(claim.claimed);assert.equal(claim.reason,'primary_stalled_max');
 assert.equal((await one("SELECT lease_token FROM exam_document_delivery WHERE document_id=$1 AND destination='drive'",[r.document_id])).lease_token,token);
});

test('even the hard stall limit never invades a live or uncertain primary group delivery',async()=>{
 for(const status of ['reserved','sent','submitted','uncertain']){
  const r=await ready();await receivedAgo(r.document_id,40);
  await db.query("UPDATE exam_document_delivery SET status=$2,worker='n8n:primary',lease_token=gen_random_uuid(),lease_until=now()+interval '10 minutes',external_id='existing' WHERE document_id=$1 AND destination='group'",[r.document_id,status]);
  assert.equal((await group(r.document_id)).claimed,false);
 }
});

test('primary progress between reserve and provider POST revokes only the unstarted fallback claim',async()=>{
 const r=await ready();await receivedAgo(r.document_id,15);const claim=await group(r.document_id);assert(claim.claimed);
 await eventAgo(r.document_id,'file_saved',0);
 const result=await rpc('begin_exam_fallback_group_dispatch',[claim.task.id,claim.task.lease_token,'b'.repeat(64)]);
 assert.equal(result.dispatch_allowed,false);assert.equal(result.reason,'primary_progress');
 const task=await one('SELECT * FROM exam_document_delivery WHERE id=$1',[claim.task.id]);assert.equal(task.status,'pending');assert.equal(task.lease_token,null);assert.equal(task.attempts,0);
 assert.equal(Number((await one("SELECT count(*) n FROM exam_document_event WHERE document_id=$1 AND event_type='fallback_group_dispatch_started'",[r.document_id])).n),0);
});

test('priority settings and state remain service-only and invalid time limits are rejected',async()=>{
 for(const roleName of ['anon','authenticated']){await role(roleName);await assert.rejects(rpc('exam_fallback_primary_state',[crypto.randomUUID()]),e=>e.code==='42501');}
 await role('service_role');await assert.rejects(db.query('UPDATE exam_fallback_configuration SET primary_idle_seconds=120'),e=>e.code==='23514');
 await assert.rejects(db.query('UPDATE exam_fallback_configuration SET primary_max_stall_seconds=500'),e=>e.code==='23514');
});


test('source failures after a verified saved document and fallback-owned failed group are not primary failure',async()=>{
 const healthy=await ready({received_at:new Date(Date.now()-1200000).toISOString()});
 const stage=await rpc('stage_exam_intake_file',[healthy.document_id,JSON.stringify({sha256:healthy.document.sha256,size_bytes:123,drive_file_id:'healthy-drive',drive_folder_id:'fixture-folder'}),'n8n:healthy']);
 await rpc('confirm_exam_document_file',[healthy.document_id,JSON.stringify({sha256:healthy.document.sha256,size_bytes:123,drive_file_id:'healthy-drive',drive_folder_id:'fixture-folder'}),stage.lease_token]);
 await eventAgo(healthy.document_id,'source_failed',0,{error:'stale child reports failure after completion'});
 assert.equal((await group(healthy.document_id)).reason,'primary_progress');
 const fallback=await ready({received_at:new Date(Date.now()-180000).toISOString()});
 await db.query("UPDATE exam_document_delivery SET status='failed',worker='fallback:old',updated_at=now() WHERE document_id=$1 AND destination='group'",[fallback.document_id]);
 assert.equal((await group(fallback.document_id)).reason,'primary_start_grace');
 const busy=await ready({received_at:new Date(Date.now()-180000).toISOString()});
 await db.query("UPDATE exam_document SET file_status='failed' WHERE id=$1",[busy.document_id]);
 await eventAgo(busy.document_id,'source_failed',0,{error:'Gmail/Drive [primary_busy]'});
 assert.equal((await group(busy.document_id)).reason,'primary_start_grace');
});

test('a fresh WhatsApp alias does not reset prior failure or stagnation of the same canonical bytes',async()=>{
 const old=await ready();await receivedAgo(old.document_id,31);
 const fresh=await source({received_at:new Date(Date.now()-180000).toISOString()});
 const matched=await reserve(fresh.document_id,old.document.sha256);assert.equal(matched.document_id,old.document_id);
 const claim=await group(old.document_id);assert(claim.claimed);assert.equal(claim.reason,'primary_stalled');
});


test('typed Gmail failure and retry cooldown preserve fallback eligibility and immutable original',async()=>{
 const r=await ready({received_at:new Date(Date.now()-20*60000).toISOString()});
 const failed=await rpc('record_exam_document_source_error',[r.document_id,'Gmail/Drive [drive_upload_failed]','Fixture storage failure']);
 assert.equal(failed.intake_retry.failure_count,1);
 const before=await rpc('exam_fallback_primary_state',[r.document_id]);
 assert.equal(before.eligible,true);assert.equal(before.reason,'primary_failed');
 const original=await one('SELECT * FROM exam_document_source WHERE document_id=$1',[r.document_id]);
 const replay=await rpc('reserve_exam_intake_source',[JSON.stringify({...original,original_name:'fixture.pdf',mime_type:'application/pdf'})]);
 assert.equal(replay.intake_retry,undefined);
 const after=await rpc('exam_fallback_primary_state',[r.document_id]);
 assert.equal(after.last_progress_at,before.last_progress_at);assert.equal(after.reason,'primary_failed');
 assert.equal((await one('SELECT sha256 FROM exam_document WHERE id=$1',[r.document_id])).sha256,r.document.sha256);
 const claim=await group(r.document_id);assert.equal(claim.claimed,true);assert.equal(claim.reason,'primary_failed');
});

function discoveredSource(extra={}) {
 const id=String(++seq);
 return {channel:'whatsapp',account_id:'chatwoot:1:inbox:2',message_id:id,attachment_id:'chatwoot-attachment:'+id,original_name:'fixture.pdf',mime_type:'application/pdf',received_at:new Date(Date.now()-600000).toISOString(),
  metadata:{provider:'chatwoot',chatwoot_account_id:'1',chatwoot_inbox_id:'2',chatwoot_conversation_id:'3',chatwoot_message_id:id,chatwoot_attachment_id:id,sender_phone:'5511999998888',sender_allowlisted:true,unknown_sender:false,exam_candidate:true,missing_attachment:false,unsupported_attachment:false,pending_reason:null},...extra};
}
const discover=items=>rpc('enqueue_exam_fallback_sources',[JSON.stringify(items)]);
const lookupSource=item=>one('SELECT * FROM exam_document_source WHERE channel=$1 AND account_id=$2 AND message_id=$3 AND attachment_id=$4',[item.channel,item.account_id,item.message_id,item.attachment_id]);

test('durable discovery replay and URL rotation perform no repeated reservation/event or queue writes',async()=>{
 const item=discoveredSource();item.metadata.attachment_url_sha256='a'.repeat(64);
 assert.deepEqual(await discover([item]),{acknowledged:1,enqueued:1,unchanged:0});
 const s=await lookupSource(item);
 await db.query("UPDATE exam_fallback_source_queue SET attempts=4,next_attempt_at=now()+interval '15 minutes',last_error_code='fixture_pending' WHERE source_id=$1",[s.id]);
 const queue=await one('SELECT * FROM exam_fallback_source_queue WHERE source_id=$1',[s.id]);
 const events=await one('SELECT count(*) n FROM exam_document_event WHERE document_id=$1',[s.document_id]);
 const ack=await one('SELECT xmin::text version FROM exam_fallback_discovery_ack WHERE source_id=$1',[s.id]);
 for(let i=0;i<3;i++) {
  item.metadata.attachment_url_sha256=String(i+1).repeat(64);
  assert.deepEqual(await discover([item]),{acknowledged:1,enqueued:0,unchanged:1});
 }
 assert.deepEqual(await one('SELECT * FROM exam_fallback_source_queue WHERE source_id=$1',[s.id]),queue);
 assert.deepEqual(await one('SELECT count(*) n FROM exam_document_event WHERE document_id=$1',[s.document_id]),events);
 assert.deepEqual(await one('SELECT xmin::text version FROM exam_fallback_discovery_ack WHERE source_id=$1',[s.id]),ack);
});

test('late attachment and missing media recovery are acknowledged without resetting an existing pending retry',async()=>{
 const item=discoveredSource();item.metadata.missing_attachment=true;item.metadata.pending_reason='pdf_url_missing_or_untrusted';
 await discover([item]);const s=await lookupSource(item);
 await db.query("UPDATE exam_fallback_source_queue SET attempts=3,next_attempt_at=now()+interval '5 minutes' WHERE source_id=$1",[s.id]);
 const queue=await one('SELECT * FROM exam_fallback_source_queue WHERE source_id=$1',[s.id]);
 item.metadata.missing_attachment=false;item.metadata.pending_reason=null;
 assert.deepEqual(await discover([item]),{acknowledged:1,enqueued:1,unchanged:0});
 assert.equal((await lookupSource(item)).metadata.missing_attachment,false);
 assert.deepEqual(await one('SELECT * FROM exam_fallback_source_queue WHERE source_id=$1',[s.id]),queue);
 const late=structuredClone(item);late.attachment_id='chatwoot-attachment:'+String(++seq);late.metadata.chatwoot_attachment_id=String(seq);
 assert.deepEqual(await discover([item,late]),{acknowledged:2,enqueued:1,unchanged:1});
 assert.notEqual((await lookupSource(late)).id,s.id);
 for(const field of ['original_name','mime_type','received_at']) {
  const changed=structuredClone(item);
  if(field==='mime_type'){changed.mime_type='text/plain';await assert.rejects(discover([changed]),{code:'42501'});}
  else {changed[field]=field==='received_at'?new Date(Date.now()-500000).toISOString():'renamed.pdf';assert.equal((await discover([changed])).unchanged,0);}
 }
});

test('a rejected member rolls the entire batch back; malformed and changed scope cannot hit the cache',async()=>{
 const first=discoveredSource(),bad=discoveredSource();bad.metadata.sender_allowlisted=false;
 await assert.rejects(discover([first,bad]),{code:'42501'});assert.equal(await lookupSource(first),undefined);
 await discover([first]);
 for(const changes of [{sender_allowlisted:false},{unknown_sender:true},{chatwoot_conversation_id:'99'},{chatwoot_account_id:'99'},{chatwoot_message_id:'99'},{url:'https://secret.invalid'}]) {
  const changed=structuredClone(first);Object.assign(changed.metadata,changes);await assert.rejects(discover([changed]),{code:'42501'});
 }
 await db.query("UPDATE exam_fallback_configuration SET source_conversation_id='9'");
 await assert.rejects(discover([first]),{code:'42501'});
 await db.query("UPDATE exam_fallback_configuration SET source_conversation_id='3'");
 await assert.rejects(discover(Array.from({length:101},()=>first)),/Invalid fallback discovery batch/);
 for(const browser of ['anon','authenticated']){
  await role(browser);await assert.rejects(discover([first]),{code:'42501'});await assert.rejects(db.query('SELECT * FROM exam_fallback_discovery_ack'),{code:'42501'});
 }
 await role('service_role');
});

test('unsupported sources stay visible, recover when metadata changes, and terminal queue removal never resurrects delivery',async()=>{
 const review=discoveredSource();review.metadata.unsupported_attachment=true;review.metadata.pending_reason='pdf_metadata_mismatch';
 assert.deepEqual(await discover([review]),{acknowledged:1,enqueued:0,unchanged:0});
 const s=await lookupSource(review);
 assert.equal((await discover([review])).unchanged,1);
 assert.equal(Number((await one("SELECT count(*) n FROM exam_intake_incident WHERE document_id=$1 AND code='unsupported_attachment_requires_review'",[s.document_id])).n),1);
 review.metadata.unsupported_attachment=false;review.metadata.pending_reason=null;
 assert.equal((await discover([review])).enqueued,1);
 await db.query("INSERT INTO exam_document_delivery(document_id,destination,status,destination_key,external_id) VALUES($1,'group','submitted','chatwoot:1:inbox:2:conversation:23','fixture')",[s.document_id]);
 await db.query('DELETE FROM exam_fallback_source_queue WHERE source_id=$1',[s.id]);
 assert.equal((await discover([review])).unchanged,1);
 review.original_name='changed.pdf';assert.equal((await discover([review])).enqueued,0);
 assert.equal(await one('SELECT * FROM exam_fallback_source_queue WHERE source_id=$1',[s.id]),undefined);
 assert.equal((await one("SELECT status FROM exam_document_delivery WHERE document_id=$1 AND destination='group'",[s.document_id])).status,'submitted');
});

test('a corrected exclusion and a receipt for another destination cannot permanently suppress discovery',async()=>{
 const corrected=discoveredSource();const initial=await rpc('reserve_exam_intake_source',[JSON.stringify(corrected)]);
 await db.query("UPDATE exam_document SET identification_status='not_exam' WHERE id=$1",[initial.document_id]);
 assert.equal((await discover([corrected])).enqueued,0);
 await db.query("UPDATE exam_document SET identification_status='review' WHERE id=$1",[initial.document_id]);
 assert.equal((await discover([corrected])).enqueued,1);
 const historical=discoveredSource();const prior=await rpc('reserve_exam_intake_source',[JSON.stringify(historical)]);
 await db.query("INSERT INTO exam_document_delivery(document_id,destination,status,destination_key,external_id) VALUES($1,'group','submitted','another-destination','fixture')",[prior.document_id]);
 assert.equal((await discover([historical])).enqueued,1);
 const src=await lookupSource(historical);assert(await one('SELECT * FROM exam_fallback_source_queue WHERE source_id=$1',[src.id]));
});
