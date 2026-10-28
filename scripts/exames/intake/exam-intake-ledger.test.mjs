import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectionFixtureDB} from '../../../supabase/tests/collection-db.fixture.mjs';

const repository=new URL('../../../',import.meta.url);
const migrations=new URL('supabase/migrations/',repository);
const instructions=new URL('docs/exames/intake/',repository);

let db,role,rpc,originalMetadata,fixturePostflight;
const member='10000000-0000-4000-8000-000000000001',outsider='10000000-0000-4000-8000-000000000002';
const account='gmail:fixture@example.invalid',relation='a'.repeat(64),hashA='b'.repeat(64),hashB='c'.repeat(64);
const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
const worker=async()=>{await role('service_role');await db.query("SELECT set_config('request.jwt.claim.sub','',false)");};
const asMember=async(id=member)=>{await role('authenticated');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id]);};
const manifest={provider:'gmail',account_id:account,scope_kind:'all_mail',policy_version:'intake_v2',sender_policy:'all',include_spam_trash:false};
async function begin(name,mode='audit',requestId=crypto.randomUUID()){
 return rpc('begin_exam_intake_sweep',[name,'d'.repeat(64),JSON.stringify(manifest),new Date(Date.now()-86400000).toISOString(),new Date(Date.now()-1000).toISOString(),requestId,mode,900]);
}
const event=(run,value)=>rpc('record_exam_intake_event',[run.sweep_id,run.run_token,JSON.stringify(value)]);
const page=(run,ids)=>event(run,{kind:'page_discovered',partition_key:'mailbox',page_key:'first',page_sha256:'e'.repeat(64),message_ids:ids,is_terminal:true});
const discover=(run,id)=>event(run,{kind:'message_discovered',partition_key:'mailbox',message_id:id,received_at:new Date(Date.now()-60000).toISOString()});
const declare=(run,id,attachments=['pdf'])=>event(run,{kind:'origins_declared',partition_key:'mailbox',message_id:id,origins:attachments.map(attachment_id=>({attachment_id,artifact_kind:'attachment'}))});
async function preserve(messageId,sha,options={}){
 const source={channel:'email',account_id:account,message_id:messageId,attachment_id:options.link?'hopelab-link:'+relation:'pdf',original_name:'Synthetic original.pdf',received_at:new Date(Date.now()-60000).toISOString(),metadata:options.metadata||{}};
 const reserved=await rpc(options.v2?'reserve_exam_intake_source':'reserve_exam_document_source',[JSON.stringify(source)]);
 const file={sha256:sha,size_bytes:123,drive_file_id:'synthetic-drive-'+reserved.document_id,drive_folder_id:'synthetic-private-folder'};
 const staged=await rpc(options.v2?'stage_exam_intake_file':'stage_exam_document_file',[reserved.document_id,JSON.stringify(file),'synthetic-worker']);
 if(staged.claimed)await rpc('confirm_exam_document_file',[staged.document_id,JSON.stringify({...file,drive_file_id:staged.drive_file_id}),staged.lease_token]);
 const sourceRow=await one('SELECT * FROM exam_document_source WHERE account_id=$1 AND message_id=$2 AND attachment_id=$3',[account,messageId,source.attachment_id]);
 return {reserved,staged,source:sourceRow,document_id:staged.document_id};
}
const savedOutcome=(run,id,artifact)=>event(run,{kind:'origin_outcome',partition_key:'mailbox',message_id:id,attachment_id:'pdf',disposition:'saved',source_id:artifact.source.id,document_id:artifact.document_id});
const metadata=()=>db.query("SELECT p.oid::regprocedure::text signature,p.proowner,p.proacl::text acl,md5(pg_get_functiondef(p.oid)) body FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('reserve_exam_document_source','stage_exam_document_file','confirm_exam_document_file','reserve_exam_document_delivery','begin_exam_collection_sweep','commit_exam_collection_sweep') ORDER BY signature");

before(async()=>{
 ({db,role,rpc}=await collectionFixtureDB());await db.exec('RESET ROLE');
 for(const file of ['20261016000006_exam_operational_flow.sql','20261016000007_exam_clinical_group_eligibility.sql','20261016000008_exam_gmail_origin_identity.sql','20261016000009_exam_group_after_processing.sql','20261016000010_exam_group_without_identification.sql'])await db.exec(await readFile(new URL(file,migrations),'utf8'));
 await db.query('INSERT INTO auth.users(id) VALUES($1),($2)',[member,outsider]);await db.query("INSERT INTO exam_document_member(user_id,role) VALUES($1,'admin')",[member]);
 originalMetadata=(await metadata()).rows;
 let fixturePreflight=await readFile(new URL('intake-preflight.sql',instructions),'utf8');fixturePostflight=await readFile(new URL('intake-postflight.sql',instructions),'utf8');
 for(const [signature,productionHash] of [['public.reserve_exam_document_source(jsonb)','ea4f2ca17e18ed109e9ecd958ff09bc9'],['public.stage_exam_document_file(uuid,jsonb,text)','eb59790852b2b00bd03a95612f48a709'],['public.reserve_exam_document_delivery(text,text,integer)','209f2fd9eb0049a30f209887a70a6890'],['public.require_exam_document_member(text[])','5e3481e739d8b32eb6bc4b9e0e74e664']]){
  const fixtureHash=(await one('SELECT md5(prosrc) hash FROM pg_proc WHERE oid=to_regprocedure($1)',[signature])).hash;fixturePreflight=fixturePreflight.replaceAll(productionHash,fixtureHash);fixturePostflight=fixturePostflight.replaceAll(productionHash,fixtureHash);
 }
 await db.exec(fixturePreflight);
 for(const file of ['20261027000023_exam_intake_receipts_incidents.sql','20261027000024_exam_hopelab_notice_snapshots.sql'])await db.exec(await readFile(new URL(file,migrations),'utf8'));
 await worker();await db.query("UPDATE exam_document_configuration SET ingestion_enabled=true,enabled_destinations=ARRAY['drive','processing','group'],notification_cutoff=now()-interval '2 days',group_destination_key='synthetic-group'");
});
after(async()=>{await db?.close();});

test('incremental installation preserves existing RPC owners/ACLs and all bodies except the reviewed pre-claim group guard',async()=>{
 await db.exec('RESET ROLE');const after=(await metadata()).rows;
 for(const before of originalMetadata){const current=after.find(item=>item.signature===before.signature);assert.equal(current.proowner,before.proowner);assert.equal(current.acl,before.acl);if(!before.signature.startsWith('reserve_exam_document_delivery('))assert.equal(current.body,before.body);else assert.notEqual(current.body,before.body);}
 assert.equal((await one('SELECT enabled FROM exam_intake_alert_configuration')).enabled,false);await worker();
});

test('worker and member boundaries reject anonymous access, outsiders and direct clinical table reads',async()=>{
 for(const name of ['anon','authenticated']){
  await role(name);for(const table of ['exam_intake_health','exam_intake_receipt','exam_intake_incident','exam_intake_alert_outbox','exam_intake_document_hold','exam_intake_snapshot'])await assert.rejects(db.query('SELECT * FROM '+table),error=>error.code==='42501');
  await assert.rejects(rpc('check_exam_intake_health',[]),error=>error.code==='42501');
 }
 await asMember(outsider);await assert.rejects(rpc('get_exam_intake_panel',[50]),error=>error.code==='42501');
 await asMember();assert(Array.isArray((await rpc('get_exam_intake_panel',[50])).incidents));await worker();
});

test('worker health overview is service-only and omits receipt identities, payloads and dispatch tokens',async()=>{
 for(const roleName of ['anon','authenticated']){await role(roleName);await assert.rejects(rpc('get_exam_intake_worker_status',[]),error=>error.code==='42501');}
 await worker();const overview=await rpc('get_exam_intake_worker_status',[]);assert.equal(overview.contract,'exam_intake_monitor_v1');assert.equal(overview.open_incidents,overview.incident_total);assert.equal(overview.pending_alerts,overview.pending_alert_total);assert(Array.isArray(overview.collectors));
 for(const forbidden of ['receipts','source_id','message_id','attachment_id','lease_token','content_sha256'])assert(!JSON.stringify(overview).includes(forbidden));
});

test('page discovery is durable and replay fenced before message processing',async()=>{
 const run=await begin('page-fixture');await page(run,['page-message']);await page(run,['page-message']);
 assert.equal(Number((await one('SELECT count(*) n FROM exam_intake_page WHERE sweep_id=$1',[run.sweep_id])).n),1);
 assert.equal(Number((await one('SELECT count(*) n FROM exam_collection_message WHERE sweep_id=$1',[run.sweep_id])).n),1);
 await assert.rejects(event(run,{kind:'page_discovered',partition_key:'mailbox',page_key:'first',page_sha256:'f'.repeat(64),message_ids:['different'],is_terminal:true}),/replay conflicts/);
 await assert.rejects(rpc('record_exam_intake_event',[run.sweep_id,crypto.randomUUID(),JSON.stringify({kind:'heartbeat'})]),/fence/);
 await event(run,{kind:'failure',stage:'metadata',code:'fixture_transport_failed'});
 const finished=await rpc('finish_exam_intake_sweep',[run.sweep_id,run.run_token]);assert.equal(finished.coverageComplete,false);assert.equal(finished.scanFinished,false);
});

test('four declared originals with three completed outcomes cannot finish successfully or advance a checkpoint',async()=>{
 const run=await begin('four-fixture','operational');await page(run,['four-message']);await discover(run,'four-message');await declare(run,'four-message',['a','b','c','d']);
 for(const attachment of ['a','b','c'])await event(run,{kind:'origin_outcome',partition_key:'mailbox',message_id:'four-message',attachment_id:attachment,disposition:'excluded',code:'synthetic_nonclinical_fixture'});
 await event(run,{kind:'enumeration_complete',expected_message_count:1,page_count:1});const result=await rpc('finish_exam_intake_sweep',[run.sweep_id,run.run_token]);
 assert.equal(result.scanFinished,false);assert.equal(result.coverageComplete,false);assert.equal(result.counts.missing_receipts,1);assert.equal(result.checkpointAdvanced,false);assert.equal((await one("SELECT revision FROM exam_collection_cursor WHERE collector_id='four-fixture'")).revision,0);
});

test('failure before document creation atomically opens one incident/outbox and remains visible to a member',async()=>{
 const run=await begin('failure-fixture');await page(run,['unreadable-message']);
 const payload={kind:'failure',partition_key:'mailbox',message_id:'unreadable-message',stage:'metadata',code:'provider_unavailable'};
 const first=await event(run,payload),second=await event(run,payload);assert.equal(first.incident_id,second.incident_id);
 const incident=await one('SELECT * FROM exam_intake_incident WHERE id=$1',[first.incident_id]);assert.equal(incident.document_id,null);assert.equal(incident.occurrences,2);
 assert.equal(Number((await one('SELECT count(*) n FROM exam_intake_alert_outbox WHERE incident_id=$1',[incident.id])).n),1);
 assert.equal((await one('SELECT status FROM exam_intake_alert_outbox WHERE incident_id=$1',[incident.id])).status,'blocked');
 await asMember();const panel=await rpc('get_exam_intake_panel',[200]);assert(panel.incidents.some(item=>item.id===incident.id));assert.equal((await rpc('acknowledge_exam_intake_incident',[incident.id])).state,'acknowledged');await worker();
});

test('saved receipts bind actual source/document/hash, survive retries and never fabricate a second canonical document',async()=>{
 const artifact=await preserve('saved-fixture',hashA),run=await begin('saved-receipt-fixture');await page(run,['saved-fixture']);await discover(run,'saved-fixture');await declare(run,'saved-fixture');
 await assert.rejects(event(run,{kind:'origin_outcome',partition_key:'mailbox',message_id:'saved-fixture',attachment_id:'pdf',disposition:'saved',source_id:artifact.source.id,document_id:crypto.randomUUID()}),/canonical source/);
 await savedOutcome(run,'saved-fixture',artifact);await savedOutcome(run,'saved-fixture',artifact);await event(run,{kind:'enumeration_complete',expected_message_count:1,page_count:1});
 const result=await rpc('finish_exam_intake_sweep',[run.sweep_id,run.run_token]);assert.equal(result.scanFinished,true);assert.equal(result.checkpointAdvanced,false);
 const next=await begin('saved-receipt-fixture');await page(next,['saved-fixture']);await discover(next,'saved-fixture');await declare(next,'saved-fixture');await event(next,{kind:'enumeration_complete',expected_message_count:1,page_count:1});
 const unobserved=await rpc('finish_exam_intake_sweep',[next.sweep_id,next.run_token]);assert.equal(unobserved.scanFinished,false);assert.equal(unobserved.counts.missing_receipts,1);
 assert.equal(Number((await one("SELECT count(*) n FROM exam_intake_receipt WHERE message_id='saved-fixture'")).n),1);
});

test('heartbeat renews an active fenced run but a stalled collector gets an incident and an expired run cannot revive',async()=>{
 const run=await begin('health-fixture','operational');await db.query("UPDATE exam_collection_sweep SET expires_at=now()+interval '10 seconds' WHERE id=$1",[run.sweep_id]);await event(run,{kind:'heartbeat'});
 assert((await one('SELECT expires_at>now()+interval \'800 seconds\' renewed FROM exam_collection_sweep WHERE id=$1',[run.sweep_id])).renewed);
 await db.query("UPDATE exam_intake_health SET progress_at=now()-interval '20 minutes' WHERE collector_id='health-fixture'");assert.equal((await rpc('check_exam_intake_health',[])).stale_collectors,1);
 await db.query("UPDATE exam_collection_sweep SET started_at=now()-interval '1 hour',expires_at=now()-interval '1 second' WHERE id=$1",[run.sweep_id]);await assert.rejects(event(run,{kind:'heartbeat'}),/expired/);
});

test('WhatsApp alert dispatch starts once, treats a lost response as uncertain and reconciles the same provider receipt',async()=>{
 await db.query('UPDATE exam_intake_alert_configuration SET enabled=true');
 const reserved=await rpc('reserve_exam_intake_alert',['synthetic-alert-worker']);assert.equal(reserved.claimed,true);assert.equal(reserved.alert.channel,'whatsapp');
 const task=reserved.alert;const args=[task.id,task.lease_token,task.destination_key,'1'.repeat(64)];assert.equal((await rpc('begin_exam_intake_alert',args)).dispatch_allowed,true);
 await assert.rejects(rpc('begin_exam_intake_alert',args),/fence/);
 const outcome={status:'uncertain',content_sha256:'1'.repeat(64),error_code:'response_lost'};assert.equal((await rpc('record_exam_intake_alert_result',[task.id,task.lease_token,JSON.stringify(outcome)])).status,'uncertain');
 const receipt={status:'delivered',content_sha256:'1'.repeat(64),external_id:'synthetic-provider-receipt'};assert.equal((await rpc('record_exam_intake_alert_result',[task.id,task.lease_token,JSON.stringify(receipt)])).status,'sent');
 await rpc('record_exam_intake_alert_result',[task.id,task.lease_token,JSON.stringify(outcome)]);assert.equal((await one('SELECT status FROM exam_intake_alert_outbox WHERE id=$1',[task.id])).status,'sent');
});

let changed,firstLink;
test('each new Hopelab notice reserves its own origin, ACK and immutable snapshot while equal bytes share a canonical',async()=>{
 const metadata={provider:'hopelab_link',hopelab_notice_protocol:'gmail_notice_link_v2',link_sha256:relation,gmail_message_id:'notice-first',exam_candidate:true};
 firstLink=await preserve('notice-first','2'.repeat(64),{link:true,v2:true,metadata});
 assert.equal(firstLink.reserved.hopelab_notice_v2.contract,'hopelab_notice_v2_hold_v1');assert.equal(firstLink.reserved.hopelab_notice_v2.group_hold_enforced,true);
 assert.equal((await one('SELECT state FROM exam_intake_document_hold WHERE document_id=$1',[firstLink.document_id])).state,'released');
 const second=await preserve('notice-second','2'.repeat(64),{link:true,v2:true,metadata:{...metadata,gmail_message_id:'notice-second'}});
 assert.notEqual(firstLink.source.id,second.source.id);assert.equal(firstLink.document_id,second.document_id);assert.equal((await one('SELECT relation_state FROM exam_intake_snapshot WHERE source_id=$1',[second.source.id])).relation_state,'unchanged');
 assert.equal((await one('SELECT state FROM exam_intake_document_hold WHERE document_id=$1',[firstLink.document_id])).state,'released');
});

test('changed linked bytes are preserved as a new snapshot and held before group claim without altering the old delivery',async()=>{
 await db.query("INSERT INTO exam_document_delivery(document_id,destination,status,external_id,external_status,sent_at) VALUES($1,'group','sent','synthetic-old-delivery','delivered',now()) ON CONFLICT(document_id,destination,destination_key) DO UPDATE SET status='sent',external_id='synthetic-old-delivery',external_status='delivered',sent_at=now()",[firstLink.document_id]);
 const original=await one("SELECT * FROM exam_document_delivery WHERE document_id=$1 AND destination='group'",[firstLink.document_id]);
 changed=await preserve('notice-changed',hashB,{link:true,v2:true,metadata:{provider:'hopelab_link',hopelab_notice_protocol:'gmail_notice_link_v2',link_sha256:relation,gmail_message_id:'notice-changed',exam_candidate:true}});
 assert.notEqual(changed.document_id,firstLink.document_id);const hold=await one('SELECT * FROM exam_intake_document_hold WHERE document_id=$1',[changed.document_id]);assert.equal(hold.state,'held');assert.equal(hold.previous_document_id,firstLink.document_id);
 await db.query("UPDATE exam_document SET group_release_at=now()-interval '1 hour' WHERE id=$1",[changed.document_id]);await db.query("INSERT INTO exam_document_delivery(document_id,destination,created_at) VALUES($1,'group',now()-interval '1 hour') ON CONFLICT DO NOTHING",[changed.document_id]);await db.query("UPDATE exam_document_delivery SET created_at=now()-interval '1 hour' WHERE document_id=$1 AND destination='group'",[changed.document_id]);
 const tasks=(await rpc('reserve_exam_document_delivery',['group','synthetic-group-worker',20])).tasks;assert(!tasks.some(task=>task.document_id===changed.document_id));
 assert.deepEqual(await one("SELECT * FROM exam_document_delivery WHERE document_id=$1 AND destination='group'",[firstLink.document_id]),original);
 assert.equal((await one('SELECT previous_document_id FROM exam_document WHERE id=$1',[changed.document_id])).previous_document_id,null);
 assert(await one("SELECT id FROM exam_intake_incident WHERE document_id=$1 AND code='linked_result_content_requires_review'",[changed.document_id]));
});

test('an exact duplicate of a held version does not clear its hold; only an authorized explicit review may release it',async()=>{
 const incidentsBefore=Number((await one("SELECT count(*) n FROM exam_intake_incident WHERE document_id=$1 AND code='linked_result_content_requires_review'",[changed.document_id])).n);
 const duplicate=await preserve('notice-changed-repeat',hashB,{link:true,v2:true,metadata:{provider:'hopelab_link',hopelab_notice_protocol:'gmail_notice_link_v2',link_sha256:relation,gmail_message_id:'notice-changed-repeat',exam_candidate:true}});
 assert.equal(duplicate.document_id,changed.document_id);assert.equal((await one('SELECT state FROM exam_intake_document_hold WHERE document_id=$1',[changed.document_id])).state,'held');
 assert.equal((await one('SELECT relation_state FROM exam_intake_snapshot WHERE source_id=$1',[duplicate.source.id])).relation_state,'unchanged');assert.equal(Number((await one("SELECT count(*) n FROM exam_intake_incident WHERE document_id=$1 AND code='linked_result_content_requires_review'",[changed.document_id])).n),incidentsBefore);
 await asMember(outsider);await assert.rejects(rpc('release_exam_intake_hold',[changed.document_id,hashB,'clinical_version_checked']),error=>error.code==='42501');
 await asMember();assert.equal((await rpc('release_exam_intake_hold',[changed.document_id,hashB,'clinical_version_checked'])).hold_released,true);await worker();
 const tasks=(await rpc('reserve_exam_document_delivery',['group','synthetic-after-review',20])).tasks;assert(tasks.some(task=>task.document_id===changed.document_id));
});

test('receipts, incidents, outbox and run fencing survive a real database close and reopen',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'exam-intake-persistence-'));let fixture;
 try{
  fixture=await collectionFixtureDB({dataDir:directory});await fixture.db.exec('RESET ROLE');
  for(const file of ['20261027000023_exam_intake_receipts_incidents.sql','20261027000024_exam_hopelab_notice_snapshots.sql'])await fixture.db.exec(await readFile(new URL(file,migrations),'utf8'));
  await fixture.role('service_role');const from=new Date(Date.now()-86400000).toISOString(),through=new Date(Date.now()-1000).toISOString();
  const run=await fixture.rpc('begin_exam_intake_sweep',['restart-fixture','d'.repeat(64),JSON.stringify(manifest),from,through,crypto.randomUUID(),'audit',900]);
  await fixture.rpc('record_exam_intake_event',[run.sweep_id,run.run_token,JSON.stringify({kind:'page_discovered',partition_key:'mailbox',page_key:'first',page_sha256:'e'.repeat(64),message_ids:['restart-message'],is_terminal:true})]);
  await fixture.rpc('record_exam_intake_event',[run.sweep_id,run.run_token,JSON.stringify({kind:'origins_declared',partition_key:'mailbox',message_id:'restart-message',origins:[{attachment_id:'pdf',artifact_kind:'attachment'}]})]);
  const failed=await fixture.rpc('record_exam_intake_event',[run.sweep_id,run.run_token,JSON.stringify({kind:'origin_outcome',partition_key:'mailbox',message_id:'restart-message',attachment_id:'pdf',disposition:'failed',stage:'metadata',code:'synthetic_provider_unavailable'})]);
  await fixture.db.close();fixture=await collectionFixtureDB({dataDir:directory,initialize:false});
  assert.equal((await fixture.db.query('SELECT state FROM exam_intake_incident WHERE id=$1',[failed.incident_id])).rows[0].state,'open');
  assert.equal((await fixture.db.query('SELECT disposition FROM exam_intake_receipt WHERE id=$1',[failed.receipt_id])).rows[0].disposition,'failed');
  assert.equal(Number((await fixture.db.query('SELECT count(*) n FROM exam_intake_alert_outbox WHERE incident_id=$1',[failed.incident_id])).rows[0].n),1);
  assert.equal((await fixture.rpc('record_exam_intake_event',[run.sweep_id,run.run_token,JSON.stringify({kind:'heartbeat'})])).recorded,true);
 }finally{await fixture?.db.close();await rm(directory,{recursive:true,force:true});}
});

test('a legacy notice without a preserved historical original cannot make a later current URL snapshot a proven first version',async()=>{
 const oldRelation='8'.repeat(64);
 await rpc('reserve_exam_document_source',[JSON.stringify({channel:'email',account_id:account,message_id:'legacy-link-unknown',attachment_id:'hopelab-link:'+oldRelation,original_name:'Synthetic unavailable old original.pdf',received_at:new Date(Date.now()-86400000).toISOString(),metadata:{provider:'hopelab_link',link_sha256:oldRelation}})]);
 const reserved=await rpc('reserve_exam_intake_source',[JSON.stringify({channel:'email',account_id:account,message_id:'new-link-current',attachment_id:'hopelab-link:'+oldRelation,original_name:'Synthetic current original.pdf',received_at:new Date(Date.now()-60000).toISOString(),metadata:{provider:'hopelab_link',hopelab_notice_protocol:'gmail_notice_link_v2',gmail_message_id:'new-link-current',link_sha256:oldRelation,exam_candidate:true}})]);
 const file={sha256:'9'.repeat(64),size_bytes:123,drive_file_id:'synthetic-history-drive',drive_folder_id:'synthetic-private-folder'};
 const staged=await rpc('stage_exam_intake_file',[reserved.document_id,JSON.stringify(file),'synthetic-worker']);await rpc('confirm_exam_document_file',[staged.document_id,JSON.stringify(file),staged.lease_token]);
 assert.equal((await one('SELECT relation_state FROM exam_intake_snapshot WHERE document_id=$1',[staged.document_id])).relation_state,'historical_unknown_review');
 assert.equal((await one('SELECT reason FROM exam_intake_document_hold WHERE document_id=$1',[staged.document_id])).reason,'historical_snapshot_unavailable');
 assert(await one("SELECT id FROM exam_intake_incident WHERE document_id=$1 AND code='historical_link_snapshot_unavailable'",[staged.document_id]));
});

test('an uncompleted notice capture or a failed original generates an incident/outbox before any group effect',async()=>{
 const reserved=await rpc('reserve_exam_intake_source',[JSON.stringify({channel:'email',account_id:account,message_id:'notice-fails-before-bytes',attachment_id:'hopelab-link:'+relation,original_name:'Synthetic failed original.pdf',metadata:{provider:'hopelab_link',hopelab_notice_protocol:'gmail_notice_link_v2',gmail_message_id:'notice-fails-before-bytes',link_sha256:relation}})]);
 await db.query("UPDATE exam_intake_document_hold SET created_at=now()-interval '20 minutes' WHERE document_id=$1",[reserved.document_id]);
 const health=await rpc('check_exam_intake_health',[]);assert.equal(health.stale_notice_snapshots,1);
 await rpc('record_exam_document_source_error',[reserved.document_id,'Synthetic storage unavailable','Synthetic review']);
 assert(await one("SELECT id FROM exam_intake_incident WHERE document_id=$1 AND code='notice_original_preservation_failed'",[reserved.document_id]));
 assert.equal((await one('SELECT file_status FROM exam_document WHERE id=$1',[reserved.document_id])).file_status,'failed');
});

test('ten-minute receipt and fifteen-minute group deadlines open incidents, exclude fixtures, and resolve proven recoveries',async()=>{
 const run=await begin('deadline-fixture','operational');await page(run,['deadline-message']);await declare(run,'deadline-message');
 await event(run,{kind:'origin_outcome',partition_key:'mailbox',message_id:'deadline-message',attachment_id:'pdf',disposition:'pending',stage:'storage',code:'original_pending'});
 await db.query("UPDATE exam_intake_receipt SET first_seen_at=now()-interval '11 minutes' WHERE collector_id='deadline-fixture'");
 const waiting=await preserve('waiting-group-fixture','5'.repeat(64)),excluded=await preserve('explicit-test-fixture','6'.repeat(64),{metadata:{test_fixture:true}});
 for(const artifact of [waiting,excluded]){
  await db.query("UPDATE exam_document SET created_at=now()-interval '20 minutes' WHERE id=$1",[artifact.document_id]);
  await db.query("UPDATE exam_document_event SET created_at=now()-interval '20 minutes' WHERE document_id=$1 AND event_type='file_saved'",[artifact.document_id]);
  await db.query("UPDATE exam_document_delivery SET created_at=now()-interval '20 minutes' WHERE document_id=$1 AND destination='group'",[artifact.document_id]);
 }
 const health=await rpc('check_exam_intake_health',[]);assert(health.overdue_receipts>=1);assert(health.overdue_group_documents>=1);
 assert(await one("SELECT id FROM exam_intake_incident WHERE document_id=$1 AND code='group_delivery_overdue' AND state='open'",[waiting.document_id]));
 assert.equal(await one("SELECT id FROM exam_intake_incident WHERE document_id=$1 AND code='group_delivery_overdue'",[excluded.document_id]),undefined);
 const receipt=await one("SELECT id FROM exam_intake_receipt WHERE collector_id='deadline-fixture'");assert(await one("SELECT id FROM exam_intake_incident WHERE receipt_id=$1 AND code='receipt_processing_overdue' AND state='open'",[receipt.id]));
 const recovered=await preserve('deadline-message','7'.repeat(64));await savedOutcome(run,'deadline-message',recovered);
 await db.query("UPDATE exam_document_delivery SET status='sent',external_id='synthetic-recovered-provider-receipt',external_status='delivered',sent_at=now() WHERE document_id=$1 AND destination='group'",[waiting.document_id]);
 await begin('health-fixture','operational');await rpc('check_exam_intake_health',[]);
 assert.equal((await one("SELECT state FROM exam_intake_incident WHERE receipt_id=$1 AND code='receipt_processing_overdue'",[receipt.id])).state,'resolved');
 assert.equal((await one("SELECT state FROM exam_intake_incident WHERE document_id=$1 AND code='group_delivery_overdue'",[waiting.document_id])).state,'resolved');
 assert.equal((await one("SELECT state FROM exam_intake_incident WHERE collector_id='health-fixture' AND code='collector_heartbeat_stale'")).state,'resolved');
});

test('postflight SQL executes and the explicit pause disables alerts without dropping or rewriting audit data',async()=>{
 await db.exec('RESET ROLE');await db.exec(fixturePostflight);
 const snapshot=async()=>one('SELECT (SELECT count(*) FROM exam_intake_snapshot) snapshots,(SELECT count(*) FROM exam_intake_receipt) receipts,(SELECT count(*) FROM exam_intake_incident) incidents,(SELECT count(*) FROM exam_intake_alert_outbox) alerts,(SELECT count(*) FROM exam_document_delivery) deliveries');
 const beforePause=await snapshot();await db.exec(await readFile(new URL('intake-pause-without-data-loss.sql',instructions),'utf8'));assert.deepEqual(await snapshot(),beforePause);assert.equal((await one('SELECT enabled FROM exam_intake_alert_configuration')).enabled,false);
 await worker();
});
