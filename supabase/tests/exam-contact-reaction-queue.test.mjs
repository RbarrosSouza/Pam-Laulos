// Actual SQL with isolated PostgreSQL/PGlite; no provider/session/clinical I/O.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectionFixtureDB} from './collection-db.fixture.mjs';
const dir=await mkdtemp(join(tmpdir(),'exam-reaction-'));
let {db,role,rpc}=await collectionFixtureDB({dataDir:dir});
const actor='10000000-0000-0000-0000-000000000001';
let serial=0,passed=0,nowMs=Date.parse('2026-11-05T03:42:00.000Z'),destination='';
const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
const check=async(name,fn)=>{await fn();console.log(`ok ${++passed} - ${name}`);};
const iso=offset=>new Date(nowMs+offset).toISOString();
async function clock(value=nowMs){
 nowMs=value;const instant=new Date(value).toISOString();assert.match(instant,/^[0-9T:Z.\-]+$/);
 await db.exec('RESET ROLE');await db.exec(`CREATE OR REPLACE FUNCTION public.exam_reaction_clock() RETURNS timestamptz LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$ SELECT '${instant}'::timestamptz $$`);await role('service_role');
}
async function configure(key,{enabled=true,cutoff=iso(-60000),actorId=1}={}){
 destination=key;await db.query("UPDATE exam_document_configuration SET group_destination_key=$1,enabled_destinations=ARRAY['group','drive','processing']",[key]);
 await db.query('UPDATE exam_reaction_configuration SET enabled=$1,activation_cutoff=$2,chatwoot_actor_id=$3',[enabled,cutoff,actorId]);
}
const reserve=(worker='fixture-worker',limit=1)=>rpc('reserve_exam_contact_reactions',[worker,limit]);
const preview=()=>rpc('preview_exam_contact_reactions',[]);
const begin=(r,extra={})=>rpc('begin_exam_contact_reaction',[r.reaction_id,extra.token??r.lease_token,extra.destination??r.destination_key,extra.message??r.external_message_id,extra.emoji??r.emoji,extra.actorId??r.actor_id]);
const report=(r,status,extra={})=>rpc('record_exam_contact_reaction_result',[r.reaction_id,r.lease_token,JSON.stringify({status,external_message_id:r.external_message_id,emoji:r.emoji,actor_id:r.actor_id,...extra})]);
async function document(options={}){
 const n=++serial,id=crypto.randomUUID(),sha=n.toString(16).padStart(64,'0');
 await db.query(`INSERT INTO exam_document(id,original_name,file_status,sha256,size_bytes,drive_file_id,received_at,canonical_document_id,identification_status,group_exception_reason)
 VALUES($1,'Synthetic isolated.pdf',$2,$3,123,$4,$5,$6,$7,$8)`,[id,options.fileStatus??'saved',sha,'fixture-'+n,iso(-7*86400000),options.canonical??null,options.identification??'review',options.exception??null]);
 const delivery=await one(`INSERT INTO exam_document_delivery(document_id,destination,destination_key,status,sent_at,external_id)
 VALUES($1,'group',$2,$3,$4,$5) RETURNING *`,[id,options.destination??destination,options.deliveryStatus??'sent',options.sentAt===null?null:(options.sentAt??iso(-86400000)),options.message===null?null:String(options.message??n)]);
 if(options.event!==false)await contactEvent(id,options.eventAt??iso(-1000));
 return{id,delivery,sha};
}
async function contactEvent(id,at=iso(-1000)){
 return one("INSERT INTO exam_document_event(document_id,event_type,created_at) VALUES($1,'contact_recorded',$2) RETURNING *",[id,at]);
}
async function item(id,{contacted=true}={}){
 const c=await one("INSERT INTO exam_card(pet_name,client_name,status,origin) VALUES('Pet Fixture','Tutor Fixture','exame_pronto','manual') RETURNING id");
 const i=await one("INSERT INTO exam_item(exam_card_id,exam_type,result_received) VALUES($1,'Hemograma',true) RETURNING id",[c.id]);
 await db.query(`INSERT INTO exam_document_item(document_id,exam_item_id,confirmation_method,confirmed_by,contacted_by,contacted_at,contact_channel,contact_note)
 VALUES($1,$2,'automatic',NULL,$3,$4,$5,$6)`,[id,i.id,contacted?actor:null,contacted?iso(-86400000):null,contacted?'whatsapp':null,contacted?'Synthetic contact':null]);
 return i.id;
}
async function complete(options={}){const d=await document(options);await item(d.id);return d;}

const reconcile=(worker='fixture-reader',limit=1)=>rpc('reserve_exam_contact_reconciliations',[worker,limit]);
const reconcileReport=(r,status,extra={})=>rpc('record_exam_contact_reconciliation_result',[r.reaction_id,r.reconcile_token,JSON.stringify({status,external_message_id:r.external_message_id,emoji:r.emoji,actor_id:r.actor_id,delivery_id:r.delivery_id,document_id:r.document_id,destination_key:r.destination_key,sha256:r.sha256,...extra})]);
const readyEvidence=(extra={})=>({provider_contract:'pamvet_check_v1',evidence_complete:true,own_reaction_absent:true,provider_state:'absent',...extra});
const scan=(after='200')=>({after,targetIdentityHash:'a'.repeat(64),own:{seen:false,unsafe:false,emoji:null,status:null,eventId:null,sourcePresent:false},pageCount:4,observedThrough:after});
const grantFields=r=>Object.fromEntries(['status','worker','lease_token','lease_until','submit_started_at'].map(k=>[k,r[k]]));

try{
 await db.exec('RESET ROLE');await db.exec(`ALTER TABLE veterinarios ADD COLUMN ativo boolean DEFAULT true,ADD COLUMN crmv text,ADD COLUMN avatar_url text;
 ALTER TABLE exam_card ADD COLUMN vet_id uuid REFERENCES veterinarios(id);
 ALTER TABLE exam_tracking ALTER COLUMN pet_id TYPE text USING pet_id::text;
 ALTER TABLE exam_tracking ALTER COLUMN veterinario_id TYPE text USING veterinario_id::text;
 ALTER TABLE exam_tracking ADD COLUMN created_at timestamptz DEFAULT now();
 CREATE TABLE sales_header(id uuid PRIMARY KEY,pet_id varchar,customer_id varchar,veterinarian_id varchar,sale_date date,status varchar);
 INSERT INTO auth.users(id) VALUES('${actor}'); INSERT INTO exam_document_member(user_id,role) VALUES('${actor}','vet');`);
 for(const file of ['20261016000006_exam_operational_flow.sql','20261016000007_exam_clinical_group_eligibility.sql','20261016000008_exam_gmail_origin_identity.sql',
 '20261016000009_exam_group_after_processing.sql','20261016000010_exam_group_without_identification.sql','20261016000011_exam_unique_patient_matching.sql',
 '20261018000012_exam_document_responsibility.sql','20261018000013_exam_pending_summary.sql'])await db.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
 await db.exec('GRANT ALL ON public.exam_card,public.exam_item,public.exam_card_log,public.sales_header,public.veterinarios,public.exam_tracking TO service_role');
 await role('service_role');await db.exec('UPDATE exam_document_configuration SET ingestion_enabled=true');const old=await one('SELECT * FROM exam_document_configuration');
 await db.exec('RESET ROLE');await db.exec(await readFile(new URL('../migrations/20261018000014_exam_contact_reaction.sql',import.meta.url),'utf8'));await role('service_role');
 await db.exec('RESET ROLE');await db.exec('ALTER TABLE public.exam_document ADD COLUMN deletion_state text');await db.exec(await readFile(new URL('../migrations/20261105000048_exam_contact_reaction_queue.sql',import.meta.url),'utf8'));await role('service_role');
 await clock();
 await check('new lanes are service-only and install without changing activation, contact or dispatch history',async()=>{
  const cfg=await one('SELECT * FROM exam_reaction_configuration');assert.equal(cfg.enabled,false);assert.equal(cfg.activation_cutoff,null);
  assert.equal((await reserve()).paused,true);assert.equal((await reconcile()).paused,true);
  for(const r of ['anon','authenticated']){await role(r);for(const [fn,args] of [
   ['reserve_exam_contact_reconciliations',['reader',1]],['record_exam_contact_reconciliation_result',[actor,actor,'{}']]])
   await assert.rejects(()=>rpc(fn,args),e=>e.code==='42501');}await role('service_role');
 });
 await check('new claim never carries an old reconciliation and reader claim never exposes a dispatch grant',async()=>{
  await configure('lanes');await complete();const first=(await reserve()).tasks[0];await begin(first);await report(first,'submitted');
  await clock(nowMs+60000);const secondDoc=await complete();const n=await reserve();assert.equal(n.tasks[0].document_id,secondDoc.id);assert.deepEqual(n.reconcile_tasks,[]);
  const r=(await reconcile()).tasks[0];assert.equal(r.reaction_id,first.reaction_id);assert.equal(r.reconcile_only,true);assert.equal(r.dispatch_allowed,false);
  assert.equal(r.lease_token,undefined);assert.equal(r.lease_until,undefined);assert.match(r.reconcile_token,/^[a-f0-9-]{36}$/);
  await assert.rejects(()=>begin({...r,lease_token:r.reconcile_token}),e=>e.code==='PT409');
 });
 await check('lost dispatch ACK still grants exactly one POST across concurrent begin and worker restart',async()=>{
  await configure('one-shot');await complete();const r=(await reserve()).tasks[0];
  const grants=await Promise.all([begin(r),begin(r)]);assert.equal(grants.filter(x=>x.dispatch_allowed).length,1);
  await clock(nowMs+3600000);assert.deepEqual((await reserve()).tasks,[]);assert.equal((await begin(r)).dispatch_allowed,false);
  assert.equal(Number((await one("SELECT count(*) n FROM exam_document_reaction_event WHERE reaction_id=$1 AND event_type='submit_started'",[r.reaction_id])).n),1);
 });
 await check('expired dispatch without callback goes behind untouched targets instead of monopolizing the head',async()=>{
  await configure('fair-new');await complete({eventAt:iso(-3000)});await complete({eventAt:iso(-2000)});await complete({eventAt:iso(-1000)});
  const first=(await reserve()).tasks[0];await clock(nowMs+180000);const second=(await reserve()).tasks[0];assert.notEqual(first.reaction_id,second.reaction_id);
  await clock(nowMs+180000);const third=(await reserve()).tasks[0];assert(![first.reaction_id,second.reaction_id].includes(third.reaction_id));
  const old=await one('SELECT * FROM exam_document_reaction WHERE id=$1',[first.reaction_id]);assert.equal(old.submit_started_at,null);assert.equal(old.dispatch_attempts,1);
 });
 await check('an aged pre-dispatch retry progresses even while fresh contacts keep arriving',async()=>{
  await configure('aged-new');await complete();const old=(await reserve()).tasks[0];await report(old,'uncertain',{error_code:'REACTION_HTTP_TIMEOUT'});
  // A minute divisible by three is the aged slot; continuous arrivals cannot starve the old retry.
  const aged=Math.ceil((nowMs+180000)/180000)*180000;await clock(aged);await complete();const retry=(await reserve()).tasks[0];
  assert.equal(retry.reaction_id,old.reaction_id);assert.notEqual(retry.lease_token,old.lease_token);
  await assert.rejects(()=>begin(old),e=>e.code==='PT409');
 });
 await check('obsolete cursor proofs are rejected rather than used to authorize a mutable reaction toggle',async()=>{
  await configure('no-stale-prefix');await complete();const r=(await reserve()).tasks[0];
  await assert.rejects(()=>report(r,'failed',{error_code:'REACTION_SCAN_PENDING',scan_state:scan('999')}),e=>e.code==='22023');
  const row=await one('SELECT * FROM exam_document_reaction WHERE id=$1',[r.reaction_id]);assert.equal(row.status,'reserved');assert.equal(row.submit_started_at,null);
 });
 await check('preflight unknown/identity/other-emoji holds remain GET-only; transient failures retry after backoff',async()=>{
  await configure('held');await complete();const held=(await reserve()).tasks[0];await report(held,'uncertain',{error_code:'REACTION_EXISTING_SUPPORT_CHOICE'});
  await clock(nowMs+180000);assert.deepEqual((await reserve()).tasks,[]);const read=(await reconcile()).tasks[0];assert.equal(read.reaction_id,held.reaction_id);assert.equal(read.reconcile_only,true);
  await reconcileReport(read,'failed',{error_code:'REACTION_HTTP_TIMEOUT'});await clock(nowMs+180000);assert.deepEqual((await reserve()).tasks,[]);
  assert.equal((await one('SELECT dispatch_retryable FROM exam_document_reaction WHERE id=$1',[held.reaction_id])).dispatch_retryable,false);
  await configure('transient');await complete();const transient=(await reserve()).tasks[0];await report(transient,'uncertain',{error_code:'REACTION_HTTP_TIMEOUT'});
  assert.deepEqual((await reserve()).tasks,[]);await clock(nowMs+180000);assert.equal((await reserve()).tasks[0].reaction_id,transient.reaction_id);
 });
 await check('read claims single-flight until expiry; stale claim cannot overwrite a newer owner',async()=>{
  await configure('reader-claim');await complete();const d=(await reserve()).tasks[0];await begin(d);await report(d,'submitted');await clock(nowMs+60000);
  const readers=await Promise.all([reconcile('a'),reconcile('b')]);assert.equal(readers.flatMap(r=>r.tasks).length,1);const a=readers.flatMap(r=>r.tasks)[0];
  await db.close();({db,role,rpc}=await collectionFixtureDB({dataDir:dir,initialize:false}));await role('service_role');
  assert.deepEqual((await reconcile()).tasks,[]);await clock(nowMs+120000);const b=(await reconcile()).tasks[0];assert.notEqual(a.reconcile_token,b.reconcile_token);
  await assert.rejects(()=>reconcileReport(a,'uncertain',{error_code:'REACTION_NOT_OBSERVED_NO_RETRY'}),e=>e.code==='PT409');
  const before=grantFields(await one('SELECT * FROM exam_document_reaction WHERE id=$1',[d.reaction_id]));
  await reconcileReport(b,'uncertain',{error_code:'REACTION_NOT_OBSERVED_NO_RETRY'});const after=await one('SELECT * FROM exam_document_reaction WHERE id=$1',[d.reaction_id]);
  assert.deepEqual(grantFields(after),before);assert.equal(after.last_error_code,'REACTION_NOT_OBSERVED_NO_RETRY');assert.deepEqual((await reserve()).tasks,[]);assert.equal((await begin(d)).dispatch_allowed,false);
 });
 await check('reader confirmation requires complete current own-reaction evidence and rejects partial/stale proof',async()=>{
  await configure('reader-proof');await complete();const d=(await reserve()).tasks[0];await begin(d);await report(d,'submitted');await clock(nowMs+60000);const r=(await reconcile()).tasks[0];
  for(const proof of [undefined,false,'true'])await assert.rejects(()=>reconcileReport(r,'confirmed',{own_reaction_verified:true,evidence_complete:proof,provider_contract:'pamvet_check_v1'}),e=>e.code==='22023');
  await assert.rejects(()=>reconcileReport(r,'confirmed',{own_reaction_verified:false,evidence_complete:true,provider_contract:'pamvet_check_v1'}),e=>e.code==='22023');
  await assert.rejects(()=>reconcileReport(r,'confirmed',{own_reaction_verified:true,evidence_complete:true,provider_contract:'pamvet_check_v1',scan_state:scan()}),e=>e.code==='22023');
  await assert.rejects(()=>reconcileReport(r,'confirmed',{own_reaction_verified:true,evidence_complete:true,provider_contract:'unknown'}),e=>e.code==='22023');
  for(const extra of [{delivery_id:crypto.randomUUID()},{document_id:crypto.randomUUID()},{destination_key:'other'},{sha256:'f'.repeat(64)}])
   await assert.rejects(()=>reconcileReport(r,'uncertain',extra),e=>e.code==='PT409');
  await reconcileReport(r,'confirmed',{own_reaction_verified:true,evidence_complete:true,provider_contract:'pamvet_check_v1'});const row=await one('SELECT * FROM exam_document_reaction WHERE id=$1',[d.reaction_id]);
  assert.equal(row.status,'confirmed');assert.equal(row.reconcile_claim_token,null);assert.equal((await begin(d)).dispatch_allowed,false);
  assert.equal((await reconcileReport(r,'confirmed',{own_reaction_verified:true,evidence_complete:true,provider_contract:'pamvet_check_v1'})).status,'confirmed');
 });
 await check('read failure backoff also applies when no callback arrives, without changing the consumed grant',async()=>{
  await configure('reader-backoff');await complete();const d=(await reserve()).tasks[0];await begin(d);await report(d,'submitted');await clock(nowMs+60000);
  const first=(await reconcile()).tasks[0];await reconcileReport(first,'failed',{error_code:'https://secret.invalid/?TOKEN'});
  let row=await one('SELECT * FROM exam_document_reaction WHERE id=$1',[d.reaction_id]);assert.equal(row.last_error_code,'REACTION_WORKER_ERROR');assert.deepEqual((await reconcile()).tasks,[]);
  await clock(nowMs+61000);const second=(await reconcile()).tasks[0];assert.equal(second.reaction_id,first.reaction_id);
  await clock(nowMs+120000);const third=(await reconcile()).tasks[0];assert.equal(third.reaction_id,first.reaction_id);
  assert.equal((await one('SELECT reconcile_attempts FROM exam_document_reaction WHERE id=$1',[d.reaction_id])).reconcile_attempts,3);
  await clock(nowMs+91000);assert.deepEqual((await reconcile()).tasks,[]);await clock(nowMs+150000);assert.equal((await reconcile()).tasks[0].reaction_id,d.reaction_id);
 });
 await check('recent submitted gets prompt read slots while an old uncertain item still receives aged slots',async()=>{
  await configure('reader-fair');await complete({eventAt:iso(-50000)});const old=(await reserve()).tasks[0];await begin(old);await report(old,'submitted');await clock(nowMs+60000);
  await complete();const fresh=(await reserve()).tasks[0];await begin(fresh);await report(fresh,'submitted');
  let next=Math.floor(nowMs/180000)*180000+240000;await clock(next);const recent=(await reconcile()).tasks[0];assert.equal(recent.reaction_id,fresh.reaction_id);
  await reconcileReport(recent,'uncertain',{error_code:'REACTION_NOT_OBSERVED_NO_RETRY'});
  await clock(Math.ceil((nowMs+60000)/180000)*180000);assert.equal((await reconcile()).tasks[0].reaction_id,old.reaction_id);
 });
 await check('held without any consumed grant can hand off once only with complete current provider absence',async()=>{
  await configure('handoff');await complete();const old=(await reserve()).tasks[0];await report(old,'uncertain',{error_code:'REACTION_WORKER_ERROR'});await clock(nowMs+180000);const r=(await reconcile()).tasks[0];
  const before=await one('SELECT * FROM exam_document_reaction WHERE id=$1',[old.reaction_id]);
  const out=await reconcileReport(r,'pre_dispatch_ready',readyEvidence());assert.equal(out.status,'pending');assert.equal(out.dispatch_allowed,false);
  const handed=await one('SELECT * FROM exam_document_reaction WHERE id=$1',[old.reaction_id]);assert.equal(handed.submit_started_at,null);assert.equal(handed.lease_token,before.lease_token);assert.equal(handed.dispatch_attempts,before.dispatch_attempts);
  assert.deepEqual((await reconcile()).tasks,[]);assert.deepEqual((await reserve()).tasks,[]);
  assert.equal((await reconcileReport(r,'pre_dispatch_ready',readyEvidence())).idempotent,true);
  assert.deepEqual(await one('SELECT * FROM exam_document_reaction WHERE id=$1',[old.reaction_id]),handed);
  await clock(nowMs+61000);const next=(await reserve()).tasks[0];assert.equal(next.reaction_id,old.reaction_id);assert.notEqual(next.lease_token,old.lease_token);
  assert.equal((await begin(next)).dispatch_allowed,true);const started=await one('SELECT * FROM exam_document_reaction WHERE id=$1',[old.reaction_id]);
  const late=await reconcileReport(r,'pre_dispatch_ready',readyEvidence());assert.equal(late.idempotent,true);assert.equal(late.status,'started');
  assert.deepEqual(await one('SELECT * FROM exam_document_reaction WHERE id=$1',[old.reaction_id]),started);assert.equal((await begin(next)).dispatch_allowed,false);
 });
 await check('handoff requires typed current absence and never trusts removed, other, pending or contradictory own states',async()=>{
  await configure('handoff-proof');await complete();const d=(await reserve()).tasks[0];await report(d,'uncertain',{error_code:'REACTION_WORKER_ERROR'});await clock(nowMs+180000);const r=(await reconcile()).tasks[0];
  for(const bad of [{own_reaction_absent:false},{own_reaction_absent:'true'},{own_reaction_absent:null},{provider_state:'removed'},
   {provider_state:'another'},{provider_state:'pending'},{provider_state:'check'},{provider_contract:'unknown'},
   {evidence_complete:false},{evidence_complete:'true'},{own_reaction_verified:true}])
   await assert.rejects(()=>reconcileReport(r,'pre_dispatch_ready',readyEvidence(bad)),e=>e.code==='22023');
  const row=await one('SELECT * FROM exam_document_reaction WHERE id=$1',[d.reaction_id]);assert.equal(row.status,'held');assert.equal(row.submit_started_at,null);
 });
 await check('a consumed grant and its durable history can never be reopened by an absence handoff',async()=>{
  await configure('handoff-consumed');await complete();const d=(await reserve()).tasks[0];await begin(d);await report(d,'submitted');await clock(nowMs+60000);const r=(await reconcile()).tasks[0];
  const before=await one('SELECT * FROM exam_document_reaction WHERE id=$1',[d.reaction_id]);await assert.rejects(()=>reconcileReport(r,'pre_dispatch_ready',readyEvidence()),e=>e.code==='PT409');
  assert.deepEqual(await one('SELECT * FROM exam_document_reaction WHERE id=$1',[d.reaction_id]),before);
  // A repair/corruption of the state flag cannot erase the durable consumed grant.
  await db.query("UPDATE exam_document_reaction SET status='held',submit_started_at=NULL WHERE id=$1",[d.reaction_id]);
  await assert.rejects(()=>reconcileReport(r,'pre_dispatch_ready',readyEvidence()),e=>e.code==='PT409');
  await clock(nowMs+3600000);assert.deepEqual((await reserve()).tasks,[]);
 });
 await check('a historical other-emoji/removal hold is not erased by a later transport failure',async()=>{
  await configure('handoff-choice');await complete();const d=(await reserve()).tasks[0];await report(d,'uncertain',{error_code:'REACTION_EXISTING_SUPPORT_CHOICE'});await clock(nowMs+180000);
  const first=(await reconcile()).tasks[0];await reconcileReport(first,'uncertain',{error_code:'REACTION_HTTP_TIMEOUT'});await clock(nowMs+180000);const r=(await reconcile()).tasks[0];
  await assert.rejects(()=>reconcileReport(r,'pre_dispatch_ready',readyEvidence()),e=>e.code==='PT409');assert.deepEqual((await reserve()).tasks,[]);
 });
 await check('handoff revalidates candidate hash, contacts and current activation after the read',async()=>{
  await configure('handoff-candidate');const doc=await complete();const d=(await reserve()).tasks[0];await report(d,'uncertain',{error_code:'REACTION_WORKER_ERROR'});await clock(nowMs+180000);const r=(await reconcile()).tasks[0];
  await db.query('UPDATE exam_document SET sha256=$2 WHERE id=$1',[doc.id,'f'.repeat(64)]);await assert.rejects(()=>reconcileReport(r,'pre_dispatch_ready',readyEvidence()),e=>e.code==='PT409');
  await db.query('UPDATE exam_document SET sha256=$2 WHERE id=$1',[doc.id,doc.sha]);await db.query("UPDATE exam_document SET deletion_state='deleted' WHERE id=$1",[doc.id]);
  await assert.rejects(()=>reconcileReport(r,'pre_dispatch_ready',readyEvidence()),e=>e.code==='PT409');await db.query('UPDATE exam_document SET deletion_state=NULL WHERE id=$1',[doc.id]);
  await db.query('UPDATE exam_document_item SET contacted_at=NULL,contacted_by=NULL,contact_channel=NULL,contact_note=NULL WHERE document_id=$1',[doc.id]);await assert.rejects(()=>reconcileReport(r,'pre_dispatch_ready',readyEvidence()),e=>e.code==='PT409');
  await db.query("UPDATE exam_document_item SET contacted_at=$2,contacted_by=$3,contact_channel='whatsapp',contact_note='Synthetic contact' WHERE document_id=$1",[doc.id,iso(-1000),actor]);await db.exec('UPDATE exam_reaction_configuration SET enabled=false');
  await assert.rejects(()=>reconcileReport(r,'pre_dispatch_ready',readyEvidence()),e=>e.code==='PT409');
 });
 await check('stale read-claim cannot hand off a held item after a newer read owner was assigned',async()=>{
  await configure('handoff-stale');await complete();const d=(await reserve()).tasks[0];await report(d,'uncertain',{error_code:'REACTION_WORKER_ERROR'});await clock(nowMs+180000);
  const a=(await reconcile()).tasks[0];await clock(nowMs+180000);const b=(await reconcile()).tasks[0];assert.notEqual(a.reconcile_token,b.reconcile_token);
  await assert.rejects(()=>reconcileReport(a,'pre_dispatch_ready',readyEvidence()),e=>e.code==='PT409');assert.equal((await reconcileReport(b,'pre_dispatch_ready',readyEvidence())).status,'pending');
 });
 await check('same-message/current hash/contacts/deleted and disabled guards are revalidated before dispatch',async()=>{
  await configure('guards');const d=await complete();const r=(await reserve()).tasks[0];
  await db.query("UPDATE exam_document SET sha256=$2 WHERE id=$1",[d.id,'f'.repeat(64)]);await assert.rejects(()=>begin(r),e=>e.code==='PT409');
  await db.query('UPDATE exam_document SET sha256=$2 WHERE id=$1',[d.id,d.sha]);await db.query("UPDATE exam_document SET deletion_state='deleted' WHERE id=$1",[d.id]);
  await assert.rejects(()=>begin(r),e=>e.code==='PT409');await clock(nowMs+180000);assert.deepEqual((await reserve()).tasks,[]);
  await db.query('UPDATE exam_document SET deletion_state=NULL WHERE id=$1',[d.id]);await db.exec('UPDATE exam_reaction_configuration SET enabled=false');
  await assert.rejects(()=>begin(r),e=>e.code==='PT409');assert.equal((await reconcile()).paused,true);
 });
 await check('existing own check proves completion without begin and contacts/original/recipient never change',async()=>{
  await configure('existing');const d=await complete();const r=(await reserve()).tasks[0];const doc=await one('SELECT * FROM exam_document WHERE id=$1',[d.id]);
  const delivery=await one('SELECT * FROM exam_document_delivery WHERE id=$1',[d.delivery.id]);const items=(await db.query('SELECT * FROM exam_document_item WHERE document_id=$1',[d.id])).rows;
  await report(r,'already_present',{own_reaction_verified:true,evidence_complete:true,provider_contract:'pamvet_check_v1'});assert.equal((await begin(r)).dispatch_allowed,false);
  assert.deepEqual(await one('SELECT * FROM exam_document WHERE id=$1',[d.id]),doc);assert.deepEqual(await one('SELECT * FROM exam_document_delivery WHERE id=$1',[d.delivery.id]),delivery);
  assert.deepEqual((await db.query('SELECT * FROM exam_document_item WHERE document_id=$1',[d.id])).rows,items);
 });
 console.log(`# ${passed} bounded reaction-queue SQL checks passed; isolated PGlite serializes concurrent requests.`);
}finally{await db.close();await rm(dir,{recursive:true,force:true});}
