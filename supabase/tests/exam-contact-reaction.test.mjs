// Actual SQL with isolated PostgreSQL/PGlite; no provider/session/clinical I/O.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectionFixtureDB} from './collection-db.fixture.mjs';
const dir=await mkdtemp(join(tmpdir(),'exam-reaction-'));
let {db,role,rpc}=await collectionFixtureDB({dataDir:dir});
const actor='10000000-0000-0000-0000-000000000001';
let serial=0,passed=0,nowMs=Date.now(),destination='';
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
 await clock();
 await check('installation changes no existing configuration/contact and starts disabled without any queued reaction',async()=>{
  assert.deepEqual(await one('SELECT * FROM exam_document_configuration'),old);const cfg=await one('SELECT * FROM exam_reaction_configuration');
  assert.equal(cfg.enabled,false);assert.equal(cfg.activation_cutoff,null);assert.equal(cfg.chatwoot_actor_id,null);assert.equal(Number((await one('SELECT count(*) n FROM exam_document_reaction')).n),0);
  assert.equal((await reserve()).paused,true);
 });
 await check('table/RPC/internal helpers stay inaccessible to anon and authenticated, including members',async()=>{
  for(const r of ['anon','authenticated']){await role(r);
   for(const t of ['exam_reaction_configuration','exam_document_reaction','exam_document_reaction_event'])await assert.rejects(()=>db.query('SELECT * FROM '+t),e=>e.code==='42501');
   for(const [name,args] of [['preview_exam_contact_reactions',[]],['reserve_exam_contact_reactions',['x',1]],['exam_reaction_clock',[]],
    ['exam_contact_reaction_candidates',[iso(-60000),'fixture',iso(0)]],['begin_exam_contact_reaction',[actor,actor,'x','1','✅',1]],['record_exam_contact_reaction_result',[actor,actor,'{}']]])
    await assert.rejects(()=>rpc(name,args),e=>e.code==='42501');
  }await role('service_role');
 });
 await check('activation requires an explicit cutoff and actor, while paused group/reaction cannot issue tasks',async()=>{
  await assert.rejects(()=>db.exec('UPDATE exam_reaction_configuration SET enabled=true'));
  await configure('paused',{enabled:false});await complete();assert.equal((await reserve()).paused,true);
  await configure('paused');await db.exec("UPDATE exam_document_configuration SET enabled_destinations='{}'");assert.equal((await reserve()).paused,true);
 });
 await check('preview is read-only; eligibility requires all contacts and at least one item, never a summary or Nexus state',async()=>{
  await configure('all-items');const good=await complete(),none=await document(),partial=await document();await item(partial.id);await item(partial.id,{contacted:false});
  const p=await preview();assert.equal(p.eligible_total,1);assert.equal(p.tasks[0].document_id,good.id);assert.equal(p.tasks[0].sha256,good.sha);assert.equal(p.tasks[0].actor_id,1);assert.equal(p.dispatch_allowed,false);
  assert.equal(Number((await one('SELECT count(*) n FROM exam_document_reaction')).n),0);assert.ok(none.id);
 });
 await check('prospective saved-event cutoff excludes historical completion but accepts today recording yesterday contact',async()=>{
  await configure('cutoff');await complete({eventAt:iso(-120000)});const good=await complete();await complete({event:false});await complete({eventAt:iso(60000)});
  assert.deepEqual((await preview()).tasks.map(x=>x.document_id),[good.id]);
 });
 await check('only SENT original group evidence in the current destination is eligible',async()=>{
  await configure('original');const good=await complete();
  for(const opts of [{destination:'other'},{deliveryStatus:'submitted'},{deliveryStatus:'uncertain'},{sentAt:null},{sentAt:iso(60000)},{message:null},{message:'../unsafe'},{fileStatus:'pending'},{identification:'not_exam'},{exception:'waived'}, {canonical:good.id}])await complete(opts);
  assert.deepEqual((await preview()).tasks.map(x=>x.delivery_id),[good.delivery.id]);
  assert.equal(Number((await one('SELECT count(*) n FROM exam_pending_summary')).n),0);
 });
 await check('two reserve requests claim one delivery+emoji; repeated contact events never enqueue another toggle',async()=>{
  await configure('unique');const d=await complete();const rs=await Promise.all([reserve('worker-a'),reserve('worker-b')]);
  assert.equal(rs.flatMap(x=>x.tasks).length,1);await contactEvent(d.id);assert.deepEqual((await reserve()).tasks,[]);
  assert.equal(Number((await one('SELECT count(*) n FROM exam_document_reaction WHERE delivery_id=$1',[d.delivery.id])).n),1);
 });
 await check('ambiguous duplicate mappings of one provider message cannot cause two toggles or premature completion',async()=>{
  await configure('ambiguous-message');await complete({message:'999999'});await complete({message:'999999'});
  assert.equal((await preview()).eligible_total,0);assert.deepEqual((await reserve()).tasks,[]);
 });
 await check('a lease expires/reclaims only before a dispatch; the prior token is fenced',async()=>{
  await configure('before-start');await complete();const first=(await reserve()).tasks[0];await clock(nowMs+180000);const second=(await reserve()).tasks[0];
  assert.equal(first.reaction_id,second.reaction_id);assert.notEqual(first.lease_token,second.lease_token);await assert.rejects(()=>begin(first),e=>e.code==='40001');
 });
 await check('begin revalidates current actor/emoji/destination/original and every contact item before granting POST',async()=>{
  await configure('begin-guards');const d=await complete(),r=(await reserve()).tasks[0];
  for(const extra of [{token:crypto.randomUUID()},{actorId:2},{emoji:'👍'},{message:'9999'},{destination:'other'}])await assert.rejects(()=>begin(r,extra),e=>e.code==='40001');
  await configure('changed');await assert.rejects(()=>begin(r),e=>e.code==='40001');await configure('begin-guards');
  await item(d.id,{contacted:false});await assert.rejects(()=>begin(r),e=>e.message==='REACTION_CONTACT_OR_ORIGINAL_CHANGED');
  assert.equal((await one('SELECT submit_started_at FROM exam_document_reaction WHERE id=$1',[r.reaction_id])).submit_started_at,null);
 });
 let started;
 await check('toggle permission is persisted exactly once, including concurrent begin and lost acknowledgment',async()=>{
  await configure('one-toggle');await complete();started=(await reserve()).tasks[0];const rs=await Promise.all([begin(started),begin(started)]);assert.equal(rs.filter(x=>x.dispatch_allowed).length,1);
  assert.equal((await begin(started)).dispatch_allowed,false);assert.equal((await one('SELECT status FROM exam_document_reaction WHERE id=$1',[started.reaction_id])).status,'started');
  assert.equal(Number((await one("SELECT count(*) n FROM exam_document_reaction_event WHERE reaction_id=$1 AND event_type='submit_started'",[started.reaction_id])).n),1);
 });
 await check('started survives close/reopen and enters GET-only reconciliation after lease expiry without a new POST grant',async()=>{
  await db.close();({db,role,rpc}=await collectionFixtureDB({dataDir:dir,initialize:false}));await clock(nowMs+180000);const r=await reserve();
  assert.deepEqual(r.tasks,[]);assert.equal(r.reconcile_tasks[0].reaction_id,started.reaction_id);assert.equal(r.reconcile_tasks[0].reconcile_only,true);assert.equal((await begin(started)).dispatch_allowed,false);
 });
 await check('uncertain or failed after start never requeues the toggle and provider text is sanitized',async()=>{
  await report(started,'uncertain',{error_code:'https://signed.invalid/?SYNTHETIC_SECRET'});let r=await reserve();assert.deepEqual(r.tasks,[]);assert.equal(r.reconcile_tasks[0].status,'uncertain');
  await report(started,'failed',{error_code:'REACTION_POST_REJECTED'});assert.deepEqual((await reserve()).tasks,[]);assert.equal((await begin(started)).dispatch_allowed,false);
  const events=JSON.stringify((await db.query('SELECT details FROM exam_document_reaction_event WHERE reaction_id=$1',[started.reaction_id])).rows);assert(!events.includes('SYNTHETIC_SECRET'));assert(!events.includes('signed.invalid'));
 });
 await check('result requires matching token, target, actor, emoji and proof of our reaction, even for late acknowledgments',async()=>{
  for(const extra of [{external_message_id:'9999'},{emoji:'👍'},{actor_id:2},{actor_id:null}])await assert.rejects(()=>report(started,'uncertain',extra),e=>e.code==='40001');
  await assert.rejects(()=>rpc('record_exam_contact_reaction_result',[started.reaction_id,null,JSON.stringify({status:'uncertain',external_message_id:started.external_message_id,emoji:'✅',actor_id:1})]),e=>e.code==='40001');
  for(const proof of [undefined,false,'true'])await assert.rejects(()=>report(started,'confirmed',{own_reaction_verified:proof}),e=>e.code==='22023');
  const r=await report(started,'confirmed',{own_reaction_verified:true});assert.equal(r.status,'confirmed');assert.equal(r.retry_allowed,false);assert.deepEqual((await reserve()).reconcile_tasks,[]);
  const at=(await one('SELECT confirmed_at FROM exam_document_reaction WHERE id=$1',[started.reaction_id])).confirmed_at;
  await report(started,'uncertain');assert.deepEqual((await one('SELECT confirmed_at FROM exam_document_reaction WHERE id=$1',[started.reaction_id])).confirmed_at,at);
 });
 await check('our existing checkmark completes before begin without authorizing any toggle and is idempotent',async()=>{
  await configure('already');await complete();const r=(await reserve()).tasks[0];await report(r,'already_present',{own_reaction_verified:true});
  assert.equal((await begin(r)).dispatch_allowed,false);const row=await one('SELECT * FROM exam_document_reaction WHERE id=$1',[r.reaction_id]);assert.equal(row.status,'confirmed');assert.equal(row.submit_started_at,null);
  assert.equal((await report(r,'already_present',{own_reaction_verified:true})).status,'confirmed');assert.deepEqual((await reserve()).tasks,[]);
 });
 await check('failed preflight holds permanently without inventing a started POST; only a positive own-GET can finish it',async()=>{
  await configure('preflight');await complete();const r=(await reserve()).tasks[0];const held=await report(r,'uncertain',{error_code:'REACTION_OWN_OTHER_EMOJI'});assert.equal(held.status,'held');
  assert.equal((await one('SELECT submit_started_at FROM exam_document_reaction WHERE id=$1',[r.reaction_id])).submit_started_at,null);
  await clock(nowMs+180000);assert.deepEqual((await reserve()).tasks,[]);assert.equal((await reserve()).reconcile_tasks[0].reconcile_only,true);assert.equal((await begin(r)).dispatch_allowed,false);
  assert.equal((await report(r,'already_present',{own_reaction_verified:true})).status,'confirmed');
 });
 await check('an actual contact RPC saved now, with a previous-day clinical date, makes only the original message eligible',async()=>{
  await configure('actual-contact');const d=await document({event:false}),i=await item(d.id,{contacted:false});
  const pet=crypto.randomUUID();await db.query("INSERT INTO pets(id,name) VALUES($1,'Synthetic isolated patient')",[pet]);
  await db.query("UPDATE exam_document SET pet_id=$2,identification_status='confirmed',link_method='automatic',link_confirmed_at=now() WHERE id=$1",[d.id,pet]);
  await db.query('UPDATE exam_item SET result_received_at=(SELECT received_at FROM exam_document WHERE id=$1) WHERE id=$2',[d.id,i]);
  const before=await one('SELECT count(*) n FROM exam_document_event WHERE document_id=$1 AND event_type=\'contact_recorded\'',[d.id]);assert.equal(Number(before.n),0);
  await role('authenticated');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[actor]);
  await rpc('record_exam_document_contact',[d.id,[i],'whatsapp','Synthetic contact confirmation',new Date(Date.now()-86400000).toISOString()]);
  await role('service_role');const event=await one("SELECT * FROM exam_document_event WHERE document_id=$1 AND event_type='contact_recorded' ORDER BY id DESC LIMIT 1",[d.id]);
  const eventMs=new Date(event.created_at).getTime();await clock(eventMs+1000);await configure('actual-contact',{cutoff:new Date(eventMs-1000).toISOString()});
  const r=(await reserve()).tasks[0];assert.equal(r.document_id,d.id);assert.equal(r.external_message_id,d.delivery.external_id);
  const evidence=await one('SELECT contacted_at FROM exam_document_item WHERE document_id=$1',[d.id]);assert(new Date(evidence.contacted_at).getTime()<new Date(event.created_at).getTime()-3600000);
 });
 await check('disabled feature after reservation prevents POST and invalid reservation arguments cannot change configuration',async()=>{
  await configure('disable');await complete();const r=(await reserve()).tasks[0];await db.exec('UPDATE exam_reaction_configuration SET enabled=false');await assert.rejects(()=>begin(r),e=>e.code==='40001');
  for(const args of [[null,1],['worker',0],['worker',21],['bad worker',1]])await assert.rejects(()=>rpc('reserve_exam_contact_reactions',args),e=>e.code==='22023');
  assert.equal((await one('SELECT enabled FROM exam_reaction_configuration')).enabled,false);
 });
 await check('reaction records never mutate contact, original delivery, message/PDF or summary ledgers',async()=>{
  await configure('no-side-effects');const d=await complete(),r=(await reserve()).tasks[0];
  const beforeDoc=await one('SELECT * FROM exam_document WHERE id=$1',[d.id]),beforeDelivery=await one('SELECT * FROM exam_document_delivery WHERE id=$1',[d.delivery.id]);
  const beforeItems=(await db.query('SELECT * FROM exam_document_item WHERE document_id=$1',[d.id])).rows;
  await begin(r);await report(r,'submitted');await report(r,'confirmed',{own_reaction_verified:true});
  assert.deepEqual(await one('SELECT * FROM exam_document WHERE id=$1',[d.id]),beforeDoc);assert.deepEqual(await one('SELECT * FROM exam_document_delivery WHERE id=$1',[d.delivery.id]),beforeDelivery);
  assert.deepEqual((await db.query('SELECT * FROM exam_document_item WHERE document_id=$1',[d.id])).rows,beforeItems);assert.equal(Number((await one('SELECT count(*) n FROM exam_pending_summary')).n),0);
 });
 console.log(`# ${passed} contact-reaction SQL checks passed; PGlite serializes concurrent query requests.`);
}finally{await db.close();await rm(dir,{recursive:true,force:true});}
