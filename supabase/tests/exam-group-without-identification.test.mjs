import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {collectionFixtureDB} from './collection-db.fixture.mjs';

// Actual PostgreSQL RPCs: identification must not prevent delivery of an exam PDF.
const sourceSql=await readFile(new URL('../migrations/20261016000010_exam_group_without_identification.sql',import.meta.url),'utf8');
const installSql=process.env.EXAM_GROUP_IDENTIFICATION_INSTALL_SQL ? await readFile(process.env.EXAM_GROUP_IDENTIFICATION_INSTALL_SQL,'utf8') : sourceSql;
const {db,role,rpc}=await collectionFixtureDB();
const staff='10000000-0000-0000-0000-000000000001';
let seq=0,passed=0;
const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
const check=async(name,fn)=>{await fn();console.log(`ok ${++passed} - ${name}`);};
const worker=async()=>{await role('service_role');await db.exec("SELECT set_config('request.jwt.claim.sub','',false)");};
const human=async()=>{await role('authenticated');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[staff]);};
const document=async id=>one('SELECT * FROM exam_document WHERE id=$1',[id]);
const groupTasks=async()=> (await rpc('reserve_exam_document_delivery',['group','notification-worker',20])).tasks;
const groupState=async id=>one("SELECT * FROM exam_document_delivery WHERE document_id=$1 AND destination='group'",[id]);
const age=async id=>db.query("UPDATE exam_document_delivery SET created_at=now()-interval '6 minutes' WHERE document_id=$1 AND destination='group'",[id]);
const state=async()=>one(`SELECT
 (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM exam_document d) documents,
 (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM exam_document_source s) sources,
 (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM exam_document_event e) events,
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM exam_document_delivery t) deliveries,
 (SELECT to_jsonb(c) FROM exam_document_configuration c) configuration`);
const signatures=[
 'exam_document_group_readiness(jsonb,jsonb)','reserve_exam_document_delivery(text,text,integer)',
 'update_exam_document_extraction(uuid,jsonb)','review_exam_document(uuid,bigint,jsonb,text,text)',
 'auto_link_exam_document(uuid,jsonb)','confirm_exam_document_link(uuid,uuid,uuid[],bigint,jsonb)',
 'apply_exam_document_link(uuid,uuid,uuid[],bigint,jsonb,uuid,text)','reserve_exam_document_source(jsonb)',
 'complete_exam_document_delivery(uuid,uuid,jsonb)','confirm_exam_document_file(uuid,jsonb,uuid)'];
const metadata=async()=> (await db.query(`SELECT oid::regprocedure::text signature,proowner::regrole::text owner,proacl::text acl,proconfig,prosecdef,md5(prosrc) body_md5 FROM pg_proc WHERE oid=ANY($1::regprocedure[]) ORDER BY signature`,[signatures])).rows;
async function save(metadata={exam_candidate:true}){
 const n=++seq, source={channel:'email',account_id:'synthetic',message_id:'message-'+n,attachment_id:'pdf',
  original_name:'original.pdf',received_at:new Date().toISOString(),metadata};
 const result=await rpc('reserve_exam_document_source',[JSON.stringify(source)]);
 const file={drive_file_id:'drive-'+result.document_id,drive_folder_id:'synthetic',size_bytes:123,sha256:n.toString(16).padStart(64,'0')};
 const stage=await rpc('stage_exam_document_file',[result.document_id,JSON.stringify(file),'test']);
 return (await rpc('confirm_exam_document_file',[stage.document_id,JSON.stringify(file),stage.lease_token])).document;
}
function extraction({classification='exam',fields={pet_name:'Luna',client_name:'Pessoa sem cadastro',exam_type:'Hemograma',exam_date:'2026-10-01'},evidence}={}){
 return {classification,single_patient:true,fields,
  evidence:evidence??Object.entries(fields).filter(([,v])=>v!=null).map(([field,value])=>({field,page:1,excerpt:`${field}: ${value}`})),
  extractor_version:'group-incomplete-test',drive_name:'original.pdf'};
}
async function processingTask(id){
 const current=await one("SELECT * FROM exam_document_delivery WHERE document_id=$1 AND destination='processing'",[id]);
 if(current?.status==='reserved')return current;
 const tasks=(await rpc('reserve_exam_document_delivery',['processing','extractor',20])).tasks;
 const found=tasks.find(t=>t.document_id===id);assert(found,'processing task must be available');return found;
}
async function finishProcessing(doc,status='failed',data){
 const task=await processingTask(doc.id);
 if(data)await rpc('update_exam_document_extraction',[doc.id,JSON.stringify({...data,delivery_id:task.id,lease_token:task.lease_token})]);
 if(status==='waived')await db.query("UPDATE exam_document_delivery SET status='waived',lease_until=NULL WHERE id=$1",[task.id]);
 else await rpc('complete_exam_document_delivery',[task.id,task.lease_token,JSON.stringify({status,error:status==='failed'?'Synthetic extractor failure':undefined})]);
 return document(doc.id);
}
async function review(doc,fields={},classification='exam',reason=null){
 await human();const fresh=await document(doc.id);
 const result=await rpc('review_exam_document',[doc.id,fresh.version,JSON.stringify(fields),classification,reason]);
 await worker();return result;
}
try{
 await db.exec('RESET ROLE');
 await db.exec(`INSERT INTO auth.users(id) VALUES('${staff}'); INSERT INTO exam_document_member(user_id,role) VALUES('${staff}','admin');`);
 for(const file of ['20261016000006_exam_operational_flow.sql','20261016000007_exam_clinical_group_eligibility.sql','20261016000008_exam_gmail_origin_identity.sql','20261016000009_exam_group_after_processing.sql'])
  await db.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
 // The already-existing production review ACL is preserved even though migration10 does not replace it.
 await db.exec('GRANT EXECUTE ON FUNCTION public.review_exam_document(uuid,bigint,jsonb,text,text) TO service_role');
 await db.exec("CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,name text,statements text[]); INSERT INTO supabase_migrations.schema_migrations VALUES('20261016000009','synthetic',ARRAY[]::text[])");
 await worker();
 await db.exec("UPDATE exam_document_configuration SET ingestion_enabled=true,enabled_destinations=ARRAY['drive','processing','group','nexus'],notification_cutoff=now()-interval '1 day',group_destination_key='synthetic-group'");
 const historical=[];
 for(const status of ['sent','submitted','uncertain','waived']){
  const doc=await finishProcessing(await save(),'completed',extraction());const task=(await groupTasks()).find(t=>t.document_id===doc.id);assert(task);
  if(status==='waived')await db.query("UPDATE exam_document_delivery SET status='waived',lease_until=NULL,external_id='synthetic-waived' WHERE id=$1",[task.id]);
  else await rpc('complete_exam_document_delivery',[task.id,task.lease_token,JSON.stringify({status,external_id:'synthetic-'+status,external_status:status==='sent'?'delivered':'api_created',error:status==='uncertain'?'unknown provider result':null})]);
  historical.push({doc,task:await groupState(doc.id)});
 }
 const before=await state(),beforeMeta=await metadata();
 await db.exec('RESET ROLE');await db.exec(installSql);await worker();
 await check('migration changes only group selection/helper wording, preserving rows, settings, ACLs and clinical/idempotency RPCs',async()=>{
  assert.deepEqual(await state(),before);
  const changed=new Set(['exam_document_group_readiness(jsonb,jsonb)','reserve_exam_document_delivery(text,text,integer)']);
  const afterMeta=await metadata();
  for(let i=0;i<beforeMeta.length;i++){
   assert.deepEqual({...afterMeta[i],body_md5:null},{...beforeMeta[i],body_md5:null});
   if(!changed.has(beforeMeta[i].signature))assert.equal(afterMeta[i].body_md5,beforeMeta[i].body_md5);
  }
 });
 await check('completed processing sends a candidate PDF with every identification field absent and no clinical link',async()=>{
  const doc=await finishProcessing(await save(),'completed',extraction({classification:'review',fields:{}}));
  const task=(await groupTasks()).find(t=>t.document_id===doc.id);assert(task);assert.equal(task.document.pet_id,null);
  assert.deepEqual(task.notification_fields,{pet_name:null,client_name:null,exam_type:null,exam_date:null});
  assert.match(task.document.review_reason,/Dados pendentes de identificação/);assert(!task.document.review_reason.includes('para envio ao grupo'));
  assert(!(await rpc('reserve_exam_document_delivery',['nexus','clinical-worker',20])).tasks.some(t=>t.document_id===doc.id));
  assert(!(await groupTasks()).some(t=>t.document_id===doc.id));
 });
 await check('every missing field and an explicitly cleared human value remain unknown without blocking the exam group',async()=>{
  for(const field of ['pet_name','client_name','exam_type','exam_date']){
   const fields={pet_name:'Luna',client_name:'Pessoa sem cadastro',exam_type:'Hemograma',exam_date:'2026-10-01',[field]:null};
   const doc=await finishProcessing(await save(),'completed',extraction({fields}));
   const task=(await groupTasks()).find(t=>t.document_id===doc.id);assert(task);assert.equal(task.notification_fields[field],null);assert.equal(task.document.pet_id,null);
  }
  const doc=await finishProcessing(await save(),'completed',extraction());
  await review(doc,{pet_name:null,exam_date:''});
  const task=(await groupTasks()).find(t=>t.document_id===doc.id);assert(task);assert.equal(task.notification_fields.pet_name,null);assert.equal(task.notification_fields.exam_date,null);assert.equal(task.notification_fields.client_name,'Pessoa sem cadastro');
 });
 await check('failed or waived extraction releases an exam candidate without waiting for retry or fields',async()=>{
  for(const status of ['failed','waived']){
   const doc=await finishProcessing(await save(),status);const task=(await groupTasks()).find(t=>t.document_id===doc.id);assert(task);
   assert.equal(task.notification_fields.exam_date,null);assert.equal(task.document.identification_status,'unidentified');
  }
 });
 await check('pending, stalled reserved and missing processing get a bounded five-minute window without spending group attempts',async()=>{
  for(const status of ['pending','reserved','missing']){
   const doc=await save();if(status==='reserved')await processingTask(doc.id);
   if(status==='missing')await db.query("DELETE FROM exam_document_delivery WHERE document_id=$1 AND destination='processing'",[doc.id]);
   assert(!(await groupTasks()).some(t=>t.document_id===doc.id));assert.equal((await groupState(doc.id)).attempts,0);
   await age(doc.id);assert((await groupTasks()).some(t=>t.document_id===doc.id));
  }
 });
 await check('fresh PDF uses available complete extraction immediately, while the window starts at saved task creation rather than email date',async()=>{
  const oldEmail=await save();await db.query("UPDATE exam_document SET received_at=now()-interval '6 hours' WHERE id=$1",[oldEmail.id]);
  assert(!(await groupTasks()).some(t=>t.document_id===oldEmail.id));
  const doc=await finishProcessing(await save(),'completed',extraction());
  assert((await groupTasks()).some(t=>t.document_id===doc.id));
 });
 await check('mixed-mailbox PDFs remain preserved without clinical indication, including a string-valued candidate flag',async()=>{
  for(const metadata of [{},{exam_candidate:false},{exam_candidate:'true'}]){
   const doc=await finishProcessing(await save(metadata),'failed');await age(doc.id);
   assert.equal(doc.file_status,'saved');assert(!(await groupTasks()).some(t=>t.document_id===doc.id));assert.equal((await groupState(doc.id)).attempts,0);
  }
 });
 await check('clinical evidence may release review/ambiguous identification without a subject hint or complete patient fields',async()=>{
  for(const classification of ['exam','review']){
   const doc=await finishProcessing(await save({exam_candidate:false}),'completed',extraction({classification,fields:{exam_type:'Hemograma'}}));
   const task=(await groupTasks()).find(t=>t.document_id===doc.id);assert(task);assert.equal(task.notification_fields.pet_name,null);assert.equal(task.notification_fields.exam_date,null);
  }
  const unproven=await finishProcessing(await save({exam_candidate:false}),'completed',extraction({classification:'review',fields:{exam_type:'Hemograma'},evidence:[]}));
  await age(unproven.id);assert(!(await groupTasks()).some(t=>t.document_id===unproven.id));
 });
 await check('automatic and human not-exam decisions override subject hints; later human exam review releases without inventing fields',async()=>{
  const automated=await finishProcessing(await save(),'completed',extraction({classification:'not_exam',fields:{}}));await age(automated.id);
  assert(!(await groupTasks()).some(t=>t.document_id===automated.id));
  const rejected=await finishProcessing(await save(),'failed');await review(rejected,{},'not_exam','Documento financeiro');await age(rejected.id);
  assert(!(await groupTasks()).some(t=>t.document_id===rejected.id));
  await review(automated,{},'exam');await review(rejected,{},'exam');
  const tasks=await groupTasks();assert(tasks.some(t=>t.document_id===automated.id));assert(tasks.some(t=>t.document_id===rejected.id));
 });
 await check('manual ambiguous review does not reject a candidate, while explicit exam review can release an unhinted PDF',async()=>{
  const ambiguous=await finishProcessing(await save(),'failed');await review(ambiguous,{},'review','Tutor ainda não identificado');
  const unhinted=await finishProcessing(await save({}),'failed');await review(unhinted,{},'exam');
  const tasks=await groupTasks();assert(tasks.some(t=>t.document_id===ambiguous.id));assert(tasks.some(t=>t.document_id===unhinted.id));
 });
 await check('saved file, canonical identity, correct destination, cutoff, explicit waiver and retry bounds remain required',async()=>{
  const cases=[['unsaved',"UPDATE exam_document SET file_status='failed' WHERE id=$1"],
   ['old',"UPDATE exam_document SET received_at=now()-interval '2 days' WHERE id=$1"],
   ['wrong-group',"UPDATE exam_document_delivery SET destination_key='another-group' WHERE document_id=$1 AND destination='group'"],
   ['waiver',"UPDATE exam_document SET group_exception_reason='Dispensado pela equipe' WHERE id=$1"],
   ['attempts',"UPDATE exam_document_delivery SET attempts=max_attempts WHERE document_id=$1 AND destination='group'"],
   ['backoff',"UPDATE exam_document_delivery SET next_attempt_at=now()+interval '1 hour' WHERE document_id=$1 AND destination='group'"]];
  for(const [,sql] of cases){const doc=await finishProcessing(await save(),'failed');await age(doc.id);await db.query(sql,[doc.id]);assert(!(await groupTasks()).some(t=>t.document_id===doc.id));}
  const canonical=await save(),alias=await finishProcessing(await save(),'failed');
  await db.query('UPDATE exam_document SET canonical_document_id=$2 WHERE id=$1',[alias.id,canonical.id]);assert(!(await groupTasks()).some(t=>t.document_id===alias.id));
 });
 await check('sent/submitted/uncertain/waived deliveries and original message references are never reopened',async()=>{
  for(const {doc,task} of historical){await age(doc.id);assert(!(await groupTasks()).some(t=>t.document_id===doc.id));const current=await groupState(doc.id);assert.equal(current.status,task.status);assert.equal(current.external_id,task.external_id);assert.equal(current.attempts,task.attempts);}
 });
 await check('workers remain isolated from team/anonymous callers and disabling destination still pauses reservations',async()=>{
  for(const roleName of ['anon','authenticated']){
   await role(roleName);await assert.rejects(()=>rpc('reserve_exam_document_delivery',['group','forbidden',1]));
   await assert.rejects(()=>rpc('exam_document_group_readiness',['{}','{}']));
  }
  await worker();await db.exec("UPDATE exam_document_configuration SET enabled_destinations=ARRAY['drive','processing','nexus']");
  assert.deepEqual(await rpc('reserve_exam_document_delivery',['group','paused-worker',1]),{tasks:[],paused:true});
 });
 if(process.env.EXAM_GROUP_IDENTIFICATION_INSTALL_SQL)await check('exact installer registers once and repeated application rolls back without changing data or ACLs',async()=>{
  await db.exec('RESET ROLE');assert.equal(Number((await one("SELECT count(*) n FROM supabase_migrations.schema_migrations WHERE version='20261016000010'")).n),1);
  const rows=await state(),functions=await metadata();await assert.rejects(()=>db.exec(installSql));await db.exec('ROLLBACK');assert.deepEqual(await state(),rows);assert.deepEqual(await metadata(),functions);
 });
 console.log(`${passed} group-without-identification checks passed`);
}finally{await db.close();}
