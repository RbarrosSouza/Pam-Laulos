import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {collectionFixtureDB} from './collection-db.fixture.mjs';
let db,role,rpc,contractsBefore,baselineBefore;let seq=0;
const migrations=new URL('../migrations/',import.meta.url);
const one=async(sql,args=[])=>(await db.query(sql,args)).rows[0];
const actor='10000000-0000-4000-8000-000000000001';
const hash=()=>String(++seq).padStart(64,'a');
const snapshot=()=>one(`SELECT jsonb_build_object('documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM exam_document d),
 'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM exam_document_delivery t),
 'configuration',(SELECT to_jsonb(c) FROM exam_document_configuration c),'fallback',(SELECT to_jsonb(c) FROM exam_fallback_configuration c)) AS value`);
const contracts=()=>db.query(`SELECT oid::regprocedure::text signature,proowner,proacl::text,prosecdef,proconfig,prorettype,proargtypes::text,proargnames
 FROM pg_proc WHERE oid IN ('public.reserve_exam_document_delivery(text,text,integer)'::regprocedure,
 'public.complete_exam_document_delivery(uuid,uuid,jsonb)'::regprocedure,'public.update_exam_document_extraction(uuid,jsonb)'::regprocedure,
 'public.reconcile_exam_document_tasks()'::regprocedure,'public.exam_fallback_primary_state(uuid)'::regprocedure,
 'public.expire_exam_fallback_group_leases(uuid)'::regprocedure) ORDER BY oid::regprocedure::text`);
async function saved({candidate=true,channel='whatsapp'}={}){
 const serial=String(++seq),received_at=new Date(Date.now()-600000).toISOString();
 const source=await rpc('reserve_exam_intake_source',[{channel,account_id:channel==='whatsapp'?'chatwoot:1:inbox:2':'gmail:fixture@example.invalid',message_id:serial,attachment_id:'chatwoot-attachment:'+serial,
  original_name:'fixture.pdf',mime_type:'application/pdf',received_at,metadata:{provider:channel==='whatsapp'?'chatwoot':'gmail',chatwoot_conversation_id:'3',chatwoot_message_id:serial,chatwoot_attachment_id:serial,sender_allowlisted:true,unknown_sender:false,exam_candidate:candidate,unsupported_attachment:false}}]);
 const file={sha256:hash(),size_bytes:123,drive_file_id:'fixture-drive-'+serial,drive_folder_id:'fixture-folder',drive_name:'Original.pdf'};
 const staged=await rpc('stage_exam_intake_file',[source.document_id,file,'n8n:fixture']);
 const result=await rpc('confirm_exam_document_file',[source.document_id,file,staged.lease_token]);
 return result.document;
}
async function process(d,{complete=true,fields={},single=false}={}){
 const task=(await rpc('reserve_exam_document_delivery',['processing','n8n:extractor',20])).tasks.find(t=>t.document_id===d.id);assert(task);
 const actual={pet_name:'Paciente Fixture',client_name:'Tutor Fixture',exam_type:'Hemograma',exam_date:'2026-11-04',...fields};
 const extraction={classification:'exam',single_patient:single,extractor_version:'fixture-v1',fields:actual,
   evidence:Object.entries(actual).filter(([,v])=>v).map(([field,value])=>({field,page:1,excerpt:field==='exam_date'?'Data do exame: 04/11/2026':field+': '+value})),
   delivery_id:task.id,lease_token:task.lease_token,drive_name:'Nome pretendido.pdf'};
 await rpc('update_exam_document_extraction',[d.id,extraction]);
 if(complete)await rpc('complete_exam_document_delivery',[task.id,task.lease_token,{status:'completed'}]);
 return task;
}
const group=async id=>(await rpc('reserve_exam_document_delivery',['group','n8n:group',20])).tasks.find(t=>t.document_id===id);
async function startWorker(stage,name=stage+':'+(++seq)){const claim=await rpc('acquire_exam_pipeline_worker',[stage,name,660]);assert(claim.claimed);return{...claim,worker:name};}
async function claimPipeline(stage,w){return(await rpc('reserve_exam_pipeline_tasks',[stage,w.worker,w.lease_token,1])).tasks[0];}
const prep=t=>rpc('prepare_exam_group_dispatch',[t.id,t.lease_token]);
const begin=(t,p)=>rpc('begin_exam_group_dispatch',[t.id,t.lease_token,p.presentation_revision,'b'.repeat(64)]);
const delayOld=async()=>{
 await db.query("UPDATE exam_document_delivery t SET lease_until=now()-interval '1 second' FROM exam_document d WHERE t.document_id=d.id AND t.status='reserved' AND d.deletion_state IS NULL");
 await rpc('reconcile_exam_document_tasks',[]);
 await db.query("UPDATE exam_document_delivery t SET next_attempt_at=now()+interval '1 day' FROM exam_document d WHERE t.document_id=d.id AND d.deletion_state IS NULL AND t.status IN ('pending','failed','submitted','uncertain')");
 await db.query("UPDATE exam_document_rename SET next_attempt_at=now()+interval '1 day' WHERE status IN ('pending','failed')");
 await db.query("UPDATE exam_pipeline_worker SET lease_until=NULL");
};
before(async()=>{
 ({db,role,rpc}=await collectionFixtureDB());await db.exec('RESET ROLE');
 for(const name of ['20261016000006_exam_operational_flow.sql','20261016000007_exam_clinical_group_eligibility.sql','20261016000008_exam_gmail_origin_identity.sql',
  '20261016000009_exam_group_after_processing.sql','20261016000010_exam_group_without_identification.sql','20261016000011_exam_unique_patient_matching.sql',
  '20261019000016_exam_hemogram_normalization.sql','20261027000023_exam_intake_receipts_incidents.sql','20261027000024_exam_hopelab_notice_snapshots.sql',
  '20261027000025_exam_intake_panel_coverage.sql','20261027000026_exam_intake_source_lookup.sql','20261027000027_exam_intake_version_review.sql'])await db.exec(await readFile(new URL(name,migrations),'utf8'));
 // Existing production responsibility/reaction module is outside this change.
 await db.exec(`CREATE TABLE public.exam_document_responsibility(document_id uuid PRIMARY KEY REFERENCES public.exam_document(id));
 CREATE FUNCTION public.exam_document_responsibility_fields(uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT '{"responsible_vet_name":"Vet Fixture"}'::jsonb$$;
 CREATE TABLE public.exam_document_reaction(document_id uuid REFERENCES public.exam_document(id));GRANT ALL ON public.exam_document_reaction TO service_role;`);
 for(const name of ['20261028000040_exam_document_deletion.sql','20261028000041_exam_delete_after_group.sql','20261028000042_exam_delete_empty_aliases.sql','20261028000043_exam_versions_group_independent.sql',
  '20261103000044_exam_whatsapp_fallback.sql','20261104000045_exam_business_conflicts_no_retry.sql','20261104000046_exam_fallback_primary_priority.sql','20261104000047_exam_gmail_drive_retry_policy.sql'])await db.exec(await readFile(new URL(name,migrations),'utf8'));
 await db.exec('GRANT SELECT ON public.exam_item,public.exam_card TO service_role');
 await db.query('INSERT INTO auth.users(id) VALUES($1)',[actor]);await db.query("INSERT INTO exam_document_member(user_id,role) VALUES($1,'admin')",[actor]);
 await role('service_role');await db.query("UPDATE exam_document_configuration SET ingestion_enabled=true,enabled_destinations=ARRAY['drive','processing','group','nexus'],notification_cutoff=now()-interval '2 days',group_destination_key='chatwoot:1:inbox:2:conversation:23'");
 await db.query("UPDATE exam_fallback_configuration SET enabled=true,source_account_id='chatwoot:1:inbox:2',source_conversation_id='3',received_from=now()-interval '1 day'");
 await saved();baselineBefore=await snapshot();contractsBefore=(await contracts()).rows;
 await db.exec('RESET ROLE');
 for(const name of ['20261105000100_exam_group_dispatch_fence.sql','20261105000101_exam_pipeline_workers_and_rename.sql','20261105000102_exam_fallback_presentation_fence.sql'])await db.exec(await readFile(new URL(name,migrations),'utf8'));
 await role('service_role');
});
after(async()=>{await db?.close();});
// The first check must observe installation before test-only queue isolation.
let first=true;beforeEach(async()=>{if(first){first=false;return;}await delayOld();});

test('installation preserves original documents/tasks/configuration and modified function contracts',async()=>{
 assert.deepEqual(await snapshot(),baselineBefore);assert.deepEqual((await contracts()).rows,contractsBefore);
 assert.equal((await rpc('get_exam_pipeline_wakeup_configuration',[])).enabled,false);
 assert.equal((await one('SELECT count(*) n FROM exam_document_rename')).n,0);
});
test('browser roles cannot acquire, prepare, dispatch, rename or read private configuration',async()=>{
 const funcs=['public.prepare_exam_group_dispatch(uuid,uuid)','public.begin_exam_group_dispatch(uuid,uuid,text,text)','public.acquire_exam_pipeline_worker(text,text,integer)',
  'public.reserve_exam_pipeline_tasks(text,text,uuid,integer)','public.reserve_exam_document_rename(text,uuid)','public.prepare_exam_document_rename(uuid,uuid,bigint,text)',
  'public.complete_exam_document_rename(uuid,uuid,jsonb)','public.get_exam_pipeline_wakeup_configuration()',
  'public.prepare_exam_fallback_group_dispatch(uuid,uuid)','public.begin_exam_fallback_group_dispatch_v2(uuid,uuid,text,text)'];
 for(const name of ['anon','authenticated']){
  for(const signature of funcs)assert.equal((await one('SELECT has_function_privilege($1,$2,\'EXECUTE\') allowed',[name,signature])).allowed,false);
  await role(name);await assert.rejects(db.query('SELECT * FROM exam_pipeline_configuration'),{code:'42501'});await assert.rejects(db.query('SELECT * FROM exam_document_rename'),{code:'42501'});
 }
 await role('service_role');
});
test('five-minute group age no longer outruns an unfinished processing task',async()=>{
 const d=await saved();await db.query("UPDATE exam_document_delivery SET created_at=now()-interval '7 minutes' WHERE document_id=$1 AND destination='group'",[d.id]);
 assert.equal(await group(d.id),undefined);
 const t=await process(d,{complete:false});assert.equal(await group(d.id),undefined,'persisted extraction alone does not announce completion');
 await rpc('complete_exam_document_delivery',[t.id,t.lease_token,{status:'completed'}]);assert(await group(d.id));
});
test('transient processing failure does not release normal or fallback before shared idle window',async()=>{
 const d=await saved(),t=await process(d,{complete:false});await rpc('complete_exam_document_delivery',[t.id,t.lease_token,{status:'failed',error:'temporary_fixture'}]);
 assert.equal(await group(d.id),undefined);const primary=await rpc('exam_fallback_primary_state',[d.id]);assert.equal(primary.eligible,false);assert.equal(primary.last_failure_at,null);
 assert.equal((await rpc('reserve_exam_fallback_group',[d.id,'fallback:fixture',120])).claimed,false);
 await db.query("UPDATE exam_document_event SET created_at=now()-interval '11 minutes' WHERE document_id=$1 AND event_type IN ('file_saved','extraction_updated')",[d.id]);
 await db.query("UPDATE exam_document SET received_at=now()-interval '20 minutes' WHERE id=$1",[d.id]);
 assert.equal((await rpc('exam_fallback_primary_state',[d.id])).eligible,true);assert(await group(d.id));
});
test('terminal failure and maximum stall retain the independent safety route',async()=>{
 const d=await saved();await db.query("UPDATE exam_document_delivery SET status='failed',attempts=max_attempts,updated_at=now()+interval '1 second' WHERE document_id=$1 AND destination='processing'",[d.id]);
 assert.equal((await rpc('exam_fallback_primary_state',[d.id])).reason,'primary_failed');assert((await rpc('reserve_exam_fallback_group',[d.id,'fallback:terminal',120])).claimed);
 const stalled=await saved();await db.query("UPDATE exam_document SET received_at=now()-interval '1 hour' WHERE id=$1",[stalled.id]);
 await db.query("UPDATE exam_document_event SET created_at=now()-interval '40 minutes' WHERE document_id=$1 AND event_type='file_saved'",[stalled.id]);
 await db.query("UPDATE exam_document_delivery SET status='reserved',worker='n8n:stalled',lease_token=gen_random_uuid(),lease_until=now()+interval '1 hour' WHERE document_id=$1 AND destination='processing'",[stalled.id]);
 assert.equal((await rpc('exam_fallback_primary_state',[stalled.id])).reason,'primary_stalled_max');
});
test('fresh preparation includes fields changed after reservation, with immutable original identity',async()=>{
 const d=await saved();await process(d);const t=await group(d.id);
 await db.query("UPDATE exam_document SET confirmed_data='{"+'"pet_name":"Nome corrigido","client_name":null'+"}'::jsonb WHERE id=$1",[d.id]);
 const p=await prep(t);assert(p.dispatch_ready);assert.equal(p.task.notification_fields.pet_name,'Nome corrigido');assert.equal(p.task.notification_fields.client_name,null);
 assert.equal(p.task.document.sha256,d.sha256);assert.equal(p.task.document.drive_file_id,d.drive_file_id);assert.equal(p.task.document.responsible_vet_name,'Vet Fixture');
 assert.equal(p.task.configured_destination,'chatwoot:1:inbox:2:conversation:23');
});
test('changed presentation between prepare and begin defers without consuming a POST',async()=>{
 const d=await saved();await process(d);const t=await group(d.id),p=await prep(t);
 await db.query("UPDATE exam_document SET confirmed_data='{"+'"pet_name":"Outra revisão"'+"}'::jsonb WHERE id=$1",[d.id]);
 const b=await begin(t,p);assert.equal(b.dispatch_allowed,false);assert.equal(b.reason,'presentation_changed');
 const task=await one('SELECT * FROM exam_document_delivery WHERE id=$1',[t.id]);assert.equal(task.status,'pending');assert.equal(task.lease_token,null);assert(task.next_attempt_at>new Date());
 assert.equal((await one("SELECT count(*) n FROM exam_document_event WHERE document_id=$1 AND event_type='primary_group_dispatch_started'",[d.id])).n,0);
});
test('begin is one-shot, lost response stays uncertain, and fallback cannot duplicate it',async()=>{
 const d=await saved();await process(d);const t=await group(d.id),p=await prep(t);assert((await begin(t,p)).dispatch_allowed);
 assert.equal((await begin(t,p)).dispatch_allowed,false);assert.equal((await prep(t)).dispatch_ready,false);
 assert.equal((await rpc('reserve_exam_fallback_group',[d.id,'fallback:after-begin',120])).claimed,false);
 await assert.rejects(rpc('complete_exam_document_delivery',[t.id,t.lease_token,{status:'failed',error:'transport_timeout'}]),/reconcilia/);
 await rpc('complete_exam_document_delivery',[t.id,t.lease_token,{status:'submitted',external_id:'fixture-123',external_status:'sent'}]);
 await assert.rejects(rpc('complete_exam_document_delivery',[t.id,t.lease_token,{status:'sent',external_id:'fixture-123',external_status:'sent'}]),/Confirmação/);
 await rpc('complete_exam_document_delivery',[t.id,t.lease_token,{status:'sent',external_id:'fixture-123',external_status:'delivered'}]);
 assert.equal((await one('SELECT status FROM exam_document_delivery WHERE id=$1',[t.id])).status,'sent');
});
test('pre-POST rechecks holds, cutoff, destination, deletion and explicit rejection',async()=>{
 for(const kind of ['hold','cutoff','destination','deleted','rejected']){
  const d=await saved();await process(d);const t=await group(d.id),p=await prep(t);
  if(kind==='hold')await db.query("INSERT INTO exam_intake_document_hold(document_id,state,reason) VALUES($1,'held','awaiting_snapshot')",[d.id]);
  if(kind==='cutoff')await db.query("UPDATE exam_document_configuration SET notification_cutoff=now()");
  if(kind==='destination')await db.query("UPDATE exam_document_configuration SET group_destination_key='chatwoot:1:inbox:2:conversation:24'");
  if(kind==='deleted')await db.query("UPDATE exam_document SET deletion_state='deleting' WHERE id=$1",[d.id]);
  if(kind==='rejected')await db.query("INSERT INTO exam_document_event(document_id,event_type,actor_id,details) VALUES($1,'reviewed',$2,'{\"classification\":\"not_exam\"}')",[d.id,actor]);
  assert.equal((await begin(t,p)).dispatch_allowed,false,kind);
  await db.query("UPDATE exam_document_configuration SET notification_cutoff=now()-interval '2 days',group_destination_key='chatwoot:1:inbox:2:conversation:23'");
  await delayOld();
 }
});
test('expired/stale tokens cannot prepare or begin and do not change a replacement reservation',async()=>{
 const d=await saved();await process(d);const t=await group(d.id),p=await prep(t);
 await assert.rejects(rpc('prepare_exam_group_dispatch',[t.id,crypto.randomUUID()]),{code:'PT409'});
 await db.query("UPDATE exam_document_delivery SET lease_until=now()-interval '1 second' WHERE id=$1",[t.id]);
 await assert.rejects(begin(t,p),{code:'PT409'});assert.equal((await one('SELECT status FROM exam_document_delivery WHERE id=$1',[t.id])).status,'reserved');
});
test('global worker exclusion survives duplicate wakeups and fenced release',async()=>{
 const w=await startWorker('processing','processing:first');assert.equal((await rpc('acquire_exam_pipeline_worker',['processing','processing:second',660])).claimed,false);
 const same=await rpc('acquire_exam_pipeline_worker',['processing',w.worker,660]);assert.equal(same.lease_token,w.lease_token);assert.equal(same.lease_until,w.lease_until);
 await assert.rejects(rpc('release_exam_pipeline_worker',['processing',crypto.randomUUID()]),{code:'PT409'});
 await rpc('release_exam_pipeline_worker',['processing',w.lease_token]);assert((await rpc('acquire_exam_pipeline_worker',['processing','processing:second',660])).claimed);
 await assert.rejects(rpc('reserve_exam_pipeline_tasks',['processing',w.worker,w.lease_token,1]),{code:'PT409'});
});
test('continuous drain claims only one due item when the global consumer is ready',async()=>{
 const a=await saved(),b=await saved(),w=await startWorker('processing');
 await assert.rejects(rpc('reserve_exam_pipeline_tasks',['processing',w.worker,w.lease_token,20]),/just in time/);
 const first=await claimPipeline('processing',w);assert.equal(first.document_id,a.id);
 await rpc('complete_exam_document_delivery',[first.id,first.lease_token,{status:'failed',error:'fixture transient'}]);
 const second=await claimPipeline('processing',w);assert.equal(second.document_id,b.id);assert.notEqual(first.lease_token,second.lease_token);
});
test('expired protocol-2 pre-POST claims are retryable; legacy claims remain uncertain',async()=>{
 const d=await saved();await process(d);const w=await startWorker('group'),t=await claimPipeline('group',w);assert.equal(t.document_id,d.id);
 await db.query("UPDATE exam_document_delivery SET lease_until=now()-interval '1 second' WHERE id=$1",[t.id]);
 await rpc('reconcile_exam_document_tasks',[]);assert.equal((await one('SELECT status FROM exam_document_delivery WHERE id=$1',[t.id])).status,'pending');
 await delayOld();const old=await saved();await process(old);const legacy=await group(old.id);
 await db.query("UPDATE exam_document_delivery SET lease_until=now()-interval '1 second' WHERE id=$1",[legacy.id]);await rpc('reconcile_exam_document_tasks',[]);
 assert.equal((await one('SELECT status FROM exam_document_delivery WHERE id=$1',[legacy.id])).status,'uncertain');
});
test('fallback expiry also recognizes protocol-2 unstarted reservations',async()=>{
 const d=await saved();await process(d);const w=await startWorker('group'),t=await claimPipeline('group',w);
 await db.query("UPDATE exam_document_delivery SET lease_until=now()-interval '1 second' WHERE id=$1",[t.id]);
 await rpc('list_exam_fallback_group_reconciliation',[20]);const row=await one('SELECT status,lease_token FROM exam_document_delivery WHERE id=$1',[t.id]);assert.equal(row.status,'pending');assert.equal(row.lease_token,null);
});
test('bounded reconciliation rotates old uncertainties without taking the new-send worker',async()=>{
 const ids=[];for(let i=0;i<5;i++){const d=await saved();await process(d);const t=await group(d.id),p=await prep(t);await begin(t,p);ids.push(t.id);}
 const w=await startWorker('reconcile'),first=await rpc('list_exam_pipeline_group_reconciliation',[w.worker,w.lease_token,4]);assert.equal(first.tasks.length,4);
 const second=await rpc('list_exam_pipeline_group_reconciliation',[w.worker,w.lease_token,4]);assert.equal(second.tasks.length,1);assert(!first.tasks.some(t=>t.id===second.tasks[0].id));
 assert((await rpc('acquire_exam_pipeline_worker',['group','group:independent',660])).claimed);
});
test('an alias uncertainty cannot trigger an endless empty reconciliation wakeup',async()=>{
 const canonical=await saved(),alias=await saved();await process(alias);const t=await group(alias.id),p=await prep(t);await begin(t,p);
 await db.query('UPDATE exam_document SET canonical_document_id=$2 WHERE id=$1',[alias.id,canonical.id]);
 const w=await startWorker('reconcile');assert.deepEqual((await rpc('list_exam_pipeline_group_reconciliation',[w.worker,w.lease_token,4])).tasks,[]);
 assert.equal((await rpc('release_exam_pipeline_worker',['reconcile',w.lease_token])).has_more,false);
 assert.equal((await one('SELECT status FROM exam_document_delivery WHERE id=$1',[t.id])).status,'uncertain','reconciliation preserves the unknown external effect');
});
test('extraction enqueues rename without claiming a physical rename or delaying group',async()=>{
 const d=await saved(),oldName=d.drive_name;await process(d);const doc=await one('SELECT * FROM exam_document WHERE id=$1',[d.id]);
 assert.equal(doc.drive_name,oldName);assert.equal((await one('SELECT status FROM exam_document_rename WHERE document_id=$1',[d.id])).status,'pending');assert(await group(d.id));
});
async function renameClaim(d){const w=await startWorker('rename');const r=(await rpc('reserve_exam_document_rename',[w.worker,w.lease_token])).tasks[0];assert.equal(r.document_id,d.id);return r;}
test('rename provider receipt is fenced and updates physical name only after verification',async()=>{
 const d=await saved();await process(d);const r=await renameClaim(d);
 assert((await rpc('prepare_exam_document_rename',[r.id,r.lease_token,r.document_version,'Paciente - Hemograma.pdf'])).dispatch_allowed);
 await assert.rejects(rpc('complete_exam_document_rename',[r.id,r.lease_token,{status:'completed',drive_file_id:'another',name:'Paciente - Hemograma.pdf'}]),/receipt mismatch/);
 const result=await rpc('complete_exam_document_rename',[r.id,r.lease_token,{status:'completed',drive_file_id:r.drive_file_id,name:'Paciente - Hemograma.pdf'}]);
 assert(result.applied);assert.equal(result.task.status,'completed');assert.equal((await one('SELECT drive_name FROM exam_document WHERE id=$1',[d.id])).drive_name,'Paciente - Hemograma.pdf');
});
test('human correction before rename preparation defers the old name',async()=>{
 const d=await saved();await process(d);const r=await renameClaim(d);
 await db.query("UPDATE exam_document SET confirmed_data='{\"pet_name\":\"Revisado\"}'::jsonb WHERE id=$1",[d.id]);
 const p=await rpc('prepare_exam_document_rename',[r.id,r.lease_token,r.document_version,'Paciente antigo.pdf']);assert.equal(p.dispatch_allowed,false);
 assert.equal((await one('SELECT status FROM exam_document_rename WHERE id=$1',[r.id])).status,'pending');
});
test('human correction after rename grant confirms the applied name and keeps new revision pending',async()=>{
 const d=await saved();await process(d);const r=await renameClaim(d);
 await rpc('prepare_exam_document_rename',[r.id,r.lease_token,r.document_version,'Paciente antigo.pdf']);
 await db.query("UPDATE exam_document SET confirmed_data='{\"pet_name\":\"Revisado\"}'::jsonb WHERE id=$1",[d.id]);
 const result=await rpc('complete_exam_document_rename',[r.id,r.lease_token,{status:'completed',drive_file_id:r.drive_file_id,name:'Paciente antigo.pdf'}]);
 assert(result.applied);assert.equal(result.task.status,'pending');assert(result.task.revision>result.task.reserved_revision);
});
test('rename outage has bounded backoff and does not revert identification or group receipt',async()=>{
 const d=await saved();await process(d);const r=await renameClaim(d),g=await group(d.id),p=await prep(g);await begin(g,p);
 await rpc('complete_exam_document_delivery',[g.id,g.lease_token,{status:'sent',external_id:'fixture-rename-outage',external_status:'delivered'}]);
 const result=await rpc('complete_exam_document_rename',[r.id,r.lease_token,{status:'failed',error:'provider_unavailable'}]);assert.equal(result.task.status,'failed');assert(new Date(result.task.next_attempt_at).getTime()>Date.now());
 const doc=await one('SELECT * FROM exam_document WHERE id=$1',[d.id]);assert.equal(doc.extractor_version,'fixture-v1');assert.equal((await one('SELECT status FROM exam_document_delivery WHERE id=$1',[g.id])).status,'sent');
});
test('actual extraction still creates card/item/link before group and preserves Nexus qualification',async()=>{
 const serial=String(++seq),pet=crypto.randomUUID(),fields={pet_name:'Paciente Unico '+serial,client_name:'Tutor Unico '+serial,exam_type:'Hemograma',exam_date:'2026-11-04'};
 await db.query('INSERT INTO clients("Código","Nome") VALUES($1,$2)',['C'+serial,fields.client_name]);await db.query('INSERT INTO pets(id,client_code,name) VALUES($1,$2,$3)',[pet,'C'+serial,fields.pet_name]);
 const d=await saved();await process(d,{fields,single:true});
 const doc=await one('SELECT * FROM exam_document WHERE id=$1',[d.id]);assert.equal(doc.pet_id,pet);assert.equal(doc.identification_status,'confirmed');
 const link=await one('SELECT i.exam_card_id FROM exam_document_item di JOIN exam_item i ON i.id=di.exam_item_id WHERE di.document_id=$1',[d.id]);assert(link?.exam_card_id);
 assert(await group(d.id));assert.equal((await one("SELECT status FROM exam_document_delivery WHERE document_id=$1 AND destination='nexus'",[d.id])).status,'pending');
});

test('rolling deployment serializes legacy reservations and new global workers in both directions',async()=>{
 const d=await saved();const old=(await rpc('reserve_exam_document_delivery',['processing','legacy:running',1])).tasks[0];assert.equal(old.document_id,d.id);
 assert.equal((await rpc('acquire_exam_pipeline_worker',['processing','new:waiting',660])).reason,'legacy_worker_active');
 await rpc('complete_exam_document_delivery',[old.id,old.lease_token,{status:'failed',error:'fixture transient'}]);
 const w=await startWorker('processing','new:running'),another=await saved();
 const legacy=await rpc('reserve_exam_document_delivery',['processing','legacy:new',1]);assert.equal(legacy.tasks.length,0);assert.equal(legacy.reason,'worker_active');
 assert.equal((await claimPipeline('processing',w)).document_id,another.id);
});
test('expired global lease cannot reserve another task even when old worker still knows its token',async()=>{
 const d=await saved(),w=await startWorker('processing');await db.query("UPDATE exam_pipeline_worker SET lease_until=now()-interval '1 second' WHERE stage='processing'");
 await assert.rejects(claimPipeline('processing',w),{code:'PT409'});
 assert.equal((await one("SELECT status FROM exam_document_delivery WHERE document_id=$1 AND destination='processing'",[d.id])).status,'pending');
});
test('full supported filenames above 240 characters survive rename without truncating identity',async()=>{
 const d=await saved();await process(d);const r=await renameClaim(d),name='Paciente '+('Nome Completo '.repeat(55))+' - Hemograma.pdf';assert(name.length>240&&name.length<1024);
 const prepared=await rpc('prepare_exam_document_rename',[r.id,r.lease_token,r.document_version,name]);assert(prepared.dispatch_allowed);assert.equal(prepared.name,name);
 const result=await rpc('complete_exam_document_rename',[r.id,r.lease_token,{status:'completed',drive_file_id:r.drive_file_id,name}]);assert(result.applied);
 assert.equal((await one('SELECT drive_name FROM exam_document WHERE id=$1',[d.id])).drive_name,name);
});
test('deletion clears the new rename queue rather than retaining patient names in a cancelled task',async()=>{
 const d=await saved();await process(d);const r=await renameClaim(d);
 // Simulate the deletion-state transition to cover its trigger independently
 // of the existing begin-deletion guards for other live delivery destinations.
 await db.query("UPDATE exam_document SET deletion_state='deleting' WHERE id=$1",[d.id]);
 assert.equal((await one('SELECT count(*) n FROM exam_document_rename WHERE document_id=$1',[d.id])).n,0);
 await assert.rejects(rpc('complete_exam_document_rename',[r.id,r.lease_token,{status:'completed',drive_file_id:r.drive_file_id,name:'Paciente - Nome reservado.pdf'}]),{code:'P0002'});
});
test('wakeup configuration is dormant and accepts only an HTTPS origin without paths or embedded credentials',async()=>{
 assert.equal((await rpc('get_exam_pipeline_wakeup_configuration',[])).enabled,false);
 for(const url of ['http://example.invalid','https://user:secret@example.invalid','https://example.invalid/webhook','https://example.invalid?key=x'])await assert.rejects(db.query('UPDATE exam_pipeline_configuration SET n8n_base_url=$1',[url]),{code:'23514'});
 await db.query("UPDATE exam_pipeline_configuration SET n8n_base_url='https://n8n.fixture.invalid'");assert.equal((await rpc('get_exam_pipeline_wakeup_configuration',[])).n8n_base_url,'https://n8n.fixture.invalid');
});

test('deletion waits for an already granted rename and can cancel it once the short lease expires',async()=>{
 const d=await saved();await process(d);const r=await renameClaim(d);await rpc('prepare_exam_document_rename',[r.id,r.lease_token,r.document_version,'Nome reservado.pdf']);
 await assert.rejects(db.query("UPDATE exam_document SET deletion_state='deleting' WHERE id=$1",[d.id]),{code:'PT409',message:/Renomeação/});
 await db.query("UPDATE exam_document_rename SET lease_until=now()-interval '1 second' WHERE id=$1",[r.id]);
 await db.query("UPDATE exam_document SET deletion_state='deleting' WHERE id=$1",[d.id]);
 assert.equal((await one('SELECT count(*) n FROM exam_document_rename WHERE document_id=$1',[d.id])).n,0);
});

test('cosmetic Drive rename between group prepare and begin does not invalidate the same message',async()=>{
 const d=await saved();await process(d);const t=await group(d.id),p=await prep(t);
 await db.query('UPDATE exam_document SET drive_name=$2 WHERE id=$1',[d.id,'Nome físico confirmado.pdf']);
 const fresh=await prep(t);assert.equal(fresh.presentation_revision,p.presentation_revision);assert((await begin(t,p)).dispatch_allowed);
});
test('Nexus storage bookkeeping between group prepare and begin does not invalidate the same message',async()=>{
 const d=await saved();await process(d);const t=await group(d.id),p=await prep(t);
 await db.query("UPDATE exam_document SET storage_bucket='exam_documents_private',storage_path=$2 WHERE id=$1",[d.id,'fixture/'+d.id+'/original.pdf']);
 const fresh=await prep(t);assert.equal(fresh.presentation_revision,p.presentation_revision);assert((await begin(t,p)).dispatch_allowed);
});
test('worker release requests continuation only for remaining eligible due work',async()=>{
 const d=await saved(),w=await startWorker('processing');assert.equal((await rpc('release_exam_pipeline_worker',['processing',w.lease_token])).has_more,true);
 const again=await startWorker('processing');const task=await claimPipeline('processing',again);assert.equal(task.document_id,d.id);
 await rpc('complete_exam_document_delivery',[task.id,task.lease_token,{status:'failed',error:'fixture retry later'}]);
 assert.equal((await rpc('release_exam_pipeline_worker',['processing',again.lease_token])).has_more,false);
 const groupWorker=await startWorker('group');assert.equal((await rpc('release_exam_pipeline_worker',['group',groupWorker.lease_token])).has_more,false,'unfinished extraction is not runnable group work');
});

async function fallbackStored(){
 const serial=String(++seq),source=await rpc('reserve_exam_intake_source',[{channel:'whatsapp',account_id:'chatwoot:1:inbox:2',message_id:serial,attachment_id:'chatwoot-attachment:'+serial,
  original_name:'fixture.pdf',mime_type:'application/pdf',received_at:new Date(Date.now()-1200000).toISOString(),metadata:{provider:'chatwoot',chatwoot_conversation_id:'3',chatwoot_message_id:serial,
  chatwoot_attachment_id:serial,sender_allowlisted:true,unknown_sender:false,exam_candidate:true,unsupported_attachment:false}}]);
 const original=await rpc('reserve_exam_fallback_original',[source.document_id,hash(),123,'fallback:fixture']);
 await db.query('INSERT INTO storage.objects(bucket_id,name,metadata) VALUES($1,$2,$3)',[original.bucket,original.path,{size:123}]);
 await rpc('confirm_exam_fallback_original',[original.document_id,original.lease_token,original.document.sha256,123]);
 const claimed=await rpc('reserve_exam_fallback_group',[original.document_id,'fallback:group-v2',120]);assert(claimed.claimed);
 return {original,t:claimed.task};
}
const fallbackPrep=t=>rpc('prepare_exam_fallback_group_dispatch',[t.id,t.lease_token]);
const fallbackBegin=async(t,p)=>(await one('SELECT public.begin_exam_fallback_group_dispatch_v2($1,$2,$3,$4) result',[t.id,t.lease_token,p.presentation_revision,'c'.repeat(64)])).result;
test('fallback v2 preserves verified Storage-only delivery without inventing Drive or processing completion',async()=>{
 const {t}=await fallbackStored(),p=await fallbackPrep(t);assert(p.dispatch_ready);assert.equal(p.task.document.file_status,'pending');assert.equal(p.task.document.drive_file_id,null);
 assert.equal(p.task.document.extractor_version,null);assert.equal(p.task.notification_fields.pet_name,null);assert.equal(p.task.document.sha256,t.document.sha256);
 assert((await fallbackBegin(t,p)).dispatch_allowed);assert.equal((await fallbackBegin(t,p)).dispatch_allowed,false);
 assert.equal((await rpc('begin_exam_fallback_group_dispatch',[t.id,t.lease_token,'c'.repeat(64)])).dispatch_allowed,false);
 assert.equal((await one('SELECT file_status,drive_file_id FROM exam_document WHERE id=$1',[t.document_id])).file_status,'pending');
});
test('fallback prepare refreshes human identity after claim and fences a later edit before POST',async()=>{
 const {t}=await fallbackStored();await db.query('UPDATE exam_document SET confirmed_data=$2 WHERE id=$1',[t.document_id,{pet_name:'Identificado depois da reserva',client_name:'Tutor completo',exam_type:'Hemograma',exam_date:'2026-11-04'}]);
 const p=await fallbackPrep(t);assert(p.dispatch_ready);assert.equal(p.task.notification_fields.pet_name,'Identificado depois da reserva');assert.equal(p.task.document.responsible_vet_name,'Vet Fixture');
 await db.query('UPDATE exam_document SET confirmed_data=confirmed_data||$2::jsonb WHERE id=$1',[t.document_id,{pet_name:'Corrigido antes do POST'}]);
 const beginResult=await fallbackBegin(t,p);assert.equal(beginResult.dispatch_allowed,false);assert.equal(beginResult.reason,'presentation_changed');
 const state=await one('SELECT status,lease_token,attempts FROM exam_document_delivery WHERE id=$1',[t.id]);assert.equal(state.status,'pending');assert.equal(state.lease_token,null);assert.equal(state.attempts,0);
 assert.equal((await one("SELECT count(*) n FROM exam_document_event WHERE document_id=$1 AND event_type='fallback_group_dispatch_started'",[t.document_id])).n,0);
});
test('fallback v2 respects explicit rejection, newly held source, and resumed primary before POST',async()=>{
 for(const kind of ['rejected','held','resumed']){
  const {t,original}=await fallbackStored(),p=await fallbackPrep(t);assert(p.dispatch_ready);
  if(kind==='rejected')await db.query("INSERT INTO exam_document_event(document_id,event_type,actor_id,details) VALUES($1,'reviewed',$2,'{\"classification\":\"not_exam\"}')",[t.document_id,actor]);
  if(kind==='held')await db.query("INSERT INTO exam_intake_document_hold(document_id,state,reason) VALUES($1,'held','awaiting_snapshot')",[t.document_id]);
  if(kind==='resumed')await rpc('stage_exam_intake_file',[t.document_id,{sha256:original.document.sha256,size_bytes:123,drive_file_id:'resumed-'+t.document_id,drive_folder_id:'fixture-folder'},'n8n:resumed']);
  const result=await fallbackBegin(t,p);assert.equal(result.dispatch_allowed,false,kind);
  assert.equal((await one('SELECT status FROM exam_document_delivery WHERE id=$1',[t.id])).status,'pending');
 }
});
test('fallback v2 invalid lease and cross-protocol tokens cannot consume a dispatch grant',async()=>{
 const {t}=await fallbackStored(),p=await fallbackPrep(t);
 await assert.rejects(rpc('prepare_exam_fallback_group_dispatch',[t.id,crypto.randomUUID()]),{code:'PT409'});
 await assert.rejects(prep(t),{code:'PT409'});
 await db.query("UPDATE exam_document_delivery SET lease_until=now()-interval '1 second' WHERE id=$1",[t.id]);
 await assert.rejects(fallbackBegin(t,p),{code:'PT409'});
});
