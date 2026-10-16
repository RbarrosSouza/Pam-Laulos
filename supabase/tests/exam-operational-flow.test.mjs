import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { collectionFixtureDB } from './collection-db.fixture.mjs';
const { db, role, rpc } = await collectionFixtureDB();
const staff = '10000000-0000-0000-0000-000000000001';
const stranger = '10000000-0000-0000-0000-000000000002';
const pet = '20000000-0000-0000-0000-000000000001';
const pet2 = '20000000-0000-0000-0000-000000000002';
let count = 0, seq = 0;
async function check(name, work) { await work(); console.log(`ok ${++count} - ${name}`); }
async function one(sql,args=[]) {return (await db.query(sql,args)).rows[0];}
async function member(uid=staff) { await role('authenticated'); await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[uid]); }
async function worker() {await role('service_role'); await db.exec("SELECT set_config('request.jwt.claim.sub','',false)");}
async function source(message='email-'+(++seq)) { return rpc('reserve_exam_document_source',[JSON.stringify({channel:'email',account_id:'tests',message_id:message,attachment_id:'pdf',original_name:'original.pdf',received_at:new Date().toISOString()})]); }
async function preserve(doc,hash=(++seq).toString(16).padStart(64,'0')) {
 const file={sha256:hash,size_bytes:123,drive_file_id:'drive-'+doc.document_id,drive_folder_id:'exams'};
 const stage=await rpc('stage_exam_document_file',[doc.document_id,JSON.stringify(file),'test']);
 if (!stage.claimed) return stage;
 return rpc('confirm_exam_document_file',[stage.document_id,JSON.stringify(file),stage.lease_token]);
}
function extraction(fields={}) {
 const values={client_name:'Ana Silva',pet_name:'Luna',exam_type:'Hemograma',exam_date:'2026-10-01',...fields};
 return {classification:'exam',single_patient:true,fields:values,evidence:Object.entries(values).filter(([,v])=>v).map(([field,value])=>({field,page:1,excerpt:`${field}: ${value}`})),extractor_version:'operational-test'};
}
async function process(doc,body=extraction()) {
 const task=(await rpc('reserve_exam_document_delivery',['processing','test',20])).tasks.find(t=>t.document_id===doc.document_id);
 assert(task,'processing reservation must exist');
 const result=await rpc('update_exam_document_extraction',[doc.document_id,JSON.stringify({...body,delivery_id:task.id,lease_token:task.lease_token})]);
 await rpc('complete_exam_document_delivery',[task.id,task.lease_token,JSON.stringify({status:'completed'})]);
 return result;
}
try {
 await db.exec(`RESET ROLE; INSERT INTO auth.users(id) VALUES('${staff}'),('${stranger}');
 INSERT INTO exam_document_member(user_id,role) VALUES('${staff}','admin');
 INSERT INTO clients("Código","Nome") VALUES('C1','Ana Silva'),('C2','Outra Pessoa');
 INSERT INTO pets(id,client_code,name,species) VALUES('${pet}','C1','Luna','Canina'),('${pet2}','C2','Luna','Canina');`);
 const legacyBefore=await one("SELECT md5(pg_get_functiondef('public.receive_email_result(text,text,text,text,text,timestamptz)'::regprocedure)) body,proacl::text acl FROM pg_proc WHERE oid='public.receive_email_result(text,text,text,text,text,timestamptz)'::regprocedure");
 const adminMigration=await readFile(new URL('../migrations/20261012000005_exam_legacy_rpc_admin_transition.sql',import.meta.url),'utf8');
 await db.exec(adminMigration.slice(adminMigration.indexOf('CREATE FUNCTION public.guard_exam_document_admin_phase_insert()'),adminMigration.lastIndexOf('COMMIT;')));
 await db.exec(await readFile(new URL('../migrations/20261016000006_exam_operational_flow.sql',import.meta.url),'utf8'));
 await worker();
 await check('installation is paused and preserves legacy body/ACL and destination configuration',async()=>{
  assert.equal((await one('SELECT ingestion_enabled FROM exam_document_configuration')).ingestion_enabled,false);
  await assert.rejects(source('paused'),/pausado/);
  assert.deepEqual(await one("SELECT md5(pg_get_functiondef('public.receive_email_result(text,text,text,text,text,timestamptz)'::regprocedure)) body,proacl::text acl FROM pg_proc WHERE oid='public.receive_email_result(text,text,text,text,text,timestamptz)'::regprocedure"),legacyBefore);
  assert.deepEqual((await one('SELECT enabled_destinations FROM exam_document_configuration')).enabled_destinations,['processing','drive']);
  assert.equal((await one("SELECT tgenabled FROM pg_trigger WHERE tgname='guard_exam_document_admin_phase_insert'")).tgenabled,'A');
 });
 await check('service-only and member authorization boundaries remain closed',async()=>{
  await role('anon'); await assert.rejects(source());
  await member(stranger); await assert.rejects(rpc('confirm_exam_document_link',[crypto.randomUUID(),pet,[],1,'{}']),/autorizada/);
  await assert.rejects(db.query('SELECT public.auto_link_exam_document($1,$2)',[crypto.randomUUID(),'{}']),/permission/);
  await worker(); await assert.rejects(db.query('SELECT public.apply_exam_document_link($1,$2,$3,$4,$5,$6,$7)',[crypto.randomUUID(),pet,[],1,'{}',null,'automatic']),/permission/);
  await db.query("UPDATE exam_document_configuration SET ingestion_enabled=true, enabled_destinations=ARRAY['drive','processing','group','nexus'],notification_cutoff=now()-interval '1 minute',group_destination_key='internal-exam-group'");
 });
 let pending;
 await check('saved original without identity is immediately available for group delivery exactly once',async()=>{
  pending=await preserve(await source('pending'));
  assert.equal(pending.document.identification_status,'unidentified');
  const tasks=(await rpc('reserve_exam_document_delivery',['group','group-worker',20])).tasks;
  assert.equal(tasks.filter(t=>t.document_id===pending.document_id).length,1);
  assert.equal((await rpc('reserve_exam_document_delivery',['group','other-worker',20])).tasks.length,0);
  const retry=await source('pending');assert.equal(retry.document_id,pending.document_id);
  const duplicate=await preserve(await source('same-bytes'),pending.document.sha256);
  assert.equal(duplicate.document_id,pending.document_id);assert.equal(duplicate.upload_required,false);
  assert.equal(Number((await one("SELECT count(*) n FROM exam_document_delivery WHERE document_id=$1 AND destination='group'",[pending.document_id])).n),1);
 });
 let automatic;
 await check('unique exact tutor and pet creates one audited automatic link/card/task with no human author',async()=>{
  automatic=await process(await preserve(await source('automatic')),extraction({client_name:'  ANA   SILVA ',pet_name:' luna '}));
  assert.equal(automatic.document.identification_status,'confirmed');assert.equal(automatic.document.pet_id,pet);
  assert.equal(automatic.document.link_method,'automatic');assert.equal(automatic.document.link_confirmed_by,null);
  assert.equal((await one("SELECT actor_id FROM exam_document_event WHERE document_id=$1 AND event_type='link_auto_confirmed'",[automatic.document_id])).actor_id,null);
  assert.equal((await one('SELECT confirmed_by,confirmation_method FROM exam_document_item WHERE document_id=$1',[automatic.document_id])).confirmation_method,'automatic');
  assert.equal(Number((await one("SELECT count(*) n FROM exam_document_delivery WHERE document_id=$1 AND destination='nexus'",[automatic.document_id])).n),1);
 });
 await check('automatic patient follows the same verified Nexus attachment path, idempotently',async()=>{
  const task=(await rpc('reserve_exam_document_delivery',['nexus','nexus-worker',20])).tasks.find(t=>t.document_id===automatic.document_id);
  const path=`${pet}/${automatic.document_id}/original.pdf`;
  await db.query("INSERT INTO storage.objects(bucket_id,name) VALUES('exam_documents_private',$1)",[path]);
  await rpc('complete_exam_document_delivery',[task.id,task.lease_token,JSON.stringify({status:'completed',storage_bucket:'exam_documents_private',storage_path:path,sha256:automatic.document.sha256,size_bytes:123})]);
  await rpc('complete_exam_document_delivery',[task.id,task.lease_token,JSON.stringify({status:'completed'})]);
  assert.equal(Number((await one('SELECT count(*) n FROM exames WHERE exam_document_id=$1',[automatic.document_id])).n),1);
 });
 let unknown;
 await check('zero exact pairs remain visible for manual selection, never guessed from pet name',async()=>{
  unknown=await process(await preserve(await source('unknown')),extraction({client_name:'Ana'}));
  assert.equal(unknown.document.pet_id,null);assert.equal(unknown.document.identification_status,'review');
  assert.match(unknown.document.review_reason,/não encontrados/);
  assert.equal(Number((await one("SELECT count(*) n FROM exam_document_delivery WHERE document_id=$1 AND destination='nexus'",[unknown.document_id])).n),0);
 });
 await check('two matching patients are ambiguous even with the same tutor; duplicates in clients are ambiguous too',async()=>{
  const duplicatePet=crypto.randomUUID();
  await db.query("INSERT INTO pets(id,client_code,name) VALUES($1,'C1','Luna')",[duplicatePet]);
  let ambiguous=await process(await preserve(await source('ambiguous')));
  assert.equal(ambiguous.document.pet_id,null);assert.equal(ambiguous.document.identification_status,'review');assert.match(ambiguous.document.review_reason,/Mais de um/);
  await db.query('DELETE FROM pets WHERE id=$1',[duplicatePet]);
  const duplicateClient=crypto.randomUUID();await db.query('INSERT INTO clients(id,"Código","Nome") VALUES($1,\'C1\',\'Ana Silva\')',[duplicateClient]);
  ambiguous=await process(await preserve(await source('duplicate-client')));assert.equal(ambiguous.document.pet_id,null);
  await db.query('DELETE FROM clients WHERE id=$1',[duplicateClient]);
 });
 await check('missing documentary evidence, multiple patients, missing dates and near names never autolink',async()=>{
  for(const data of [ {...extraction(),evidence:[]}, {...extraction(),single_patient:false}, {...extraction(),evidence:extraction().evidence.map(e=>e.field==='exam_date'?{...e,excerpt:'Data: 15/10/2025'}:e)}, extraction({exam_date:null}), extraction({pet_name:'Luninha'}), {...extraction(),classification:'review'} ]) {
   const saved=await process(await preserve(await source()),data);
   assert.equal(saved.document.pet_id,null);assert.notEqual(saved.document.identification_status,'confirmed');
   assert.equal(Number((await one("SELECT count(*) n FROM exam_document_delivery WHERE document_id=$1 AND destination='nexus'",[saved.document_id])).n),0);
  }
 });
 await check('Brazilian date evidence is accepted only when it matches the extracted clinical date',async()=>{
  const data=extraction();data.evidence=data.evidence.map(e=>e.field==='exam_date'?{...e,excerpt:'Data: 1/10/2026'}:e);
  const linked=await process(await preserve(await source('br-date')),data);assert.equal(linked.document.pet_id,pet);
 });
 await check('manual selection after unresolved identification still works with optimistic version and human audit',async()=>{
  await member();
  await assert.rejects(rpc('confirm_exam_document_link',[unknown.document_id,pet,[],unknown.document.version-1,JSON.stringify(extraction().fields)]),/mudou/);
  const manual=await rpc('confirm_exam_document_link',[unknown.document_id,pet,[],unknown.document.version,JSON.stringify(extraction().fields)]);
  assert.equal(manual.document.identification_status,'confirmed');assert.equal(manual.document.link_method,'manual');assert.equal(manual.document.link_confirmed_by,staff);
  const replay=await rpc('confirm_exam_document_link',[unknown.document_id,pet,[],manual.document.version,JSON.stringify(extraction().fields)]);
  assert.equal(replay.already_linked,true);
  await worker();
  assert.equal(Number((await one("SELECT count(*) n FROM exam_document_delivery WHERE document_id=$1 AND destination='nexus'",[unknown.document_id])).n),1);
 });
 await check('a late processing result never overrides an explicit human rejection or review, including empty fields',async()=>{
  for (const classification of ['not_exam','review']) {
   const saved=await preserve(await source('human-first-'+classification));
   const task=(await rpc('reserve_exam_document_delivery',['processing','late-worker',20])).tasks.find(t=>t.document_id===saved.document_id);
   await member();
   const reviewed=await rpc('review_exam_document',[saved.document_id,saved.document.version,'{}',classification,'Decisão humana já conferida']);
   await worker();
   const late=await rpc('update_exam_document_extraction',[saved.document_id,JSON.stringify({...extraction(),delivery_id:task.id,lease_token:task.lease_token})]);
   assert.equal(late.document.identification_status,reviewed.identification_status);
   assert.equal(late.document.review_reason,'Decisão humana já conferida');
   assert.equal(late.document.group_release_at,reviewed.group_release_at);
   assert.equal(late.document.pet_id,null);assert.equal(late.document.extractor_version,'operational-test');
   assert.deepEqual(late.document.confirmed_data,{});
   assert.equal(Number((await one("SELECT count(*) n FROM exam_document_delivery WHERE document_id=$1 AND destination='nexus'",[saved.document_id])).n),0);
   await rpc('complete_exam_document_delivery',[task.id,task.lease_token,JSON.stringify({status:'completed'})]);
   assert.equal((await one("SELECT details->>'human_review_preserved' preserved FROM exam_document_event WHERE document_id=$1 AND event_type='extraction_updated'",[saved.document_id])).preserved,'true');
  }
 });
 await check('classification review keeps group delivery available; not-exam classification blocks unsent group tasks',async()=>{
  const review=await process(await preserve(await source()),{...extraction(),classification:'review',single_patient:false,fields:{},evidence:[]});
  const notExam=await process(await preserve(await source()),{...extraction(),classification:'not_exam',single_patient:false,fields:{},evidence:[]});
  const tasks=(await rpc('reserve_exam_document_delivery',['group','group-worker-2',20])).tasks;
  assert(tasks.some(t=>t.document_id===review.document_id));assert(!tasks.some(t=>t.document_id===notExam.document_id));
 });
 console.log(`${count} operational integration checks passed`);
} finally { await db.close(); }
