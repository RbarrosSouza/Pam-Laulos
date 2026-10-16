import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {collectionFixtureDB} from './collection-db.fixture.mjs';

// Exercise the actual migrations/RPCs in PostgreSQL (PGlite), without providers.
const sourceSql=await readFile(new URL('../migrations/20261016000009_exam_group_after_processing.sql',import.meta.url),'utf8');
const installSql=process.env.EXAM_GROUP_INSTALL_SQL ? await readFile(process.env.EXAM_GROUP_INSTALL_SQL,'utf8') : sourceSql;
const {db,role,rpc}=await collectionFixtureDB();
const staff='10000000-0000-0000-0000-000000000001';
let seq=0,passed=0;
const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
const check=async(name,fn)=>{await fn();console.log(`ok ${++passed} - ${name}`);};
const worker=async()=>{await role('service_role');await db.exec("SELECT set_config('request.jwt.claim.sub','',false)");};
const human=async()=>{await role('authenticated');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[staff]);};
const document=async id=>one('SELECT * FROM exam_document WHERE id=$1',[id]);
const groupTasks=async()=> (await rpc('reserve_exam_document_delivery',['group','notification-worker',20])).tasks;
const state=async()=>one(`SELECT
 (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM exam_document d) documents,
 (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM exam_document_source s) sources,
 (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM exam_document_event e) events,
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM exam_document_delivery t) deliveries,
 (SELECT to_jsonb(c) FROM exam_document_configuration c) configuration`);
async function save(metadata={exam_candidate:true}){
 const n=++seq, source={channel:'email',account_id:'synthetic',message_id:'message-'+n,attachment_id:'pdf',
  original_name:'original.pdf',received_at:new Date().toISOString(),metadata};
 const result=await rpc('reserve_exam_document_source',[JSON.stringify(source)]);
 const file={drive_file_id:'drive-'+result.document_id,drive_folder_id:'synthetic',size_bytes:123,sha256:n.toString(16).padStart(64,'0')};
 const stage=await rpc('stage_exam_document_file',[result.document_id,JSON.stringify(file),'test']);
 return (await rpc('confirm_exam_document_file',[stage.document_id,JSON.stringify(file),stage.lease_token])).document;
}
function extraction({classification='exam',fields={},reason=null}={}){
 const f={pet_name:'Luna',client_name:'Pessoa sem cadastro',exam_type:'Hemograma',exam_date:'2026-10-01',...fields};
 return {classification,single_patient:true,fields:f,evidence:Object.entries(f).filter(([,v])=>v!=null).map(([field,value])=>({field,page:1,excerpt:`${field}: ${value}`})),
  extractor_version:'group-test',review_reason:reason,drive_name:'Luna - Pessoa sem cadastro - Hemograma - 2026-10-01.pdf'};
}
async function processingTask(id){
 const current=await one("SELECT * FROM exam_document_delivery WHERE document_id=$1 AND destination='processing'",[id]);
 if(current.status==='reserved')return current;
 const tasks=(await rpc('reserve_exam_document_delivery',['processing','extractor',20])).tasks;
 const found=tasks.find(t=>t.document_id===id);assert(found,'processing task must be available');return found;
}
async function persist(doc,data=extraction(),complete=true){
 const task=await processingTask(doc.id);
 await rpc('update_exam_document_extraction',[doc.id,JSON.stringify({...data,delivery_id:task.id,lease_token:task.lease_token})]);
 if(complete)await rpc('complete_exam_document_delivery',[task.id,task.lease_token,JSON.stringify({status:'completed'})]);
 return document(doc.id);
}
async function review(doc,fields,classification='exam',reason=null){
 await human();const fresh=await document(doc.id);
 const result=await rpc('review_exam_document',[doc.id,fresh.version,JSON.stringify(fields),classification,reason]);
 await worker();return result;
}
const groupState=async id=>one("SELECT * FROM exam_document_delivery WHERE document_id=$1 AND destination='group'",[id]);

try{
 await db.exec('RESET ROLE');
 await db.exec(`INSERT INTO auth.users(id) VALUES('${staff}'); INSERT INTO exam_document_member(user_id,role) VALUES('${staff}','admin');`);
 for(const file of ['20261016000006_exam_operational_flow.sql','20261016000007_exam_clinical_group_eligibility.sql','20261016000008_exam_gmail_origin_identity.sql'])
  await db.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
 await db.exec("CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,name text,statements text[]); INSERT INTO supabase_migrations.schema_migrations VALUES('20261016000008','synthetic',ARRAY[]::text[])");
 await worker();
 await db.exec("UPDATE exam_document_configuration SET ingestion_enabled=true,enabled_destinations=ARRAY['drive','processing','group','nexus'],notification_cutoff=now()-interval '1 minute',group_destination_key='synthetic-group'");
 const historical=[];
 for(const status of ['sent','submitted','uncertain']){
  const doc=await save();const task=(await groupTasks()).find(t=>t.document_id===doc.id);assert(task);
  await rpc('complete_exam_document_delivery',[task.id,task.lease_token,JSON.stringify({status,external_id:'synthetic-'+status,external_status:status==='sent'?'delivered':'api_created',error:status==='uncertain'?'unknown provider result':null})]);
  historical.push({doc,task:await groupState(doc.id)});
 }
 const before=await state();
 const oldAcl=await one(`SELECT jsonb_object_agg(oid::regprocedure::text,proacl::text) a FROM pg_proc WHERE oid IN
  ('public.update_exam_document_extraction(uuid,jsonb)'::regprocedure,'public.review_exam_document(uuid,bigint,jsonb,text,text)'::regprocedure,'public.reserve_exam_document_delivery(text,text,integer)'::regprocedure)`);
 const unchangedFunctions=await one(`SELECT jsonb_object_agg(oid::regprocedure::text,md5(pg_get_functiondef(oid))) f FROM pg_proc WHERE oid IN
  ('public.auto_link_exam_document(uuid,jsonb)'::regprocedure,'public.apply_exam_document_link(uuid,uuid,uuid[],bigint,jsonb,uuid,text)'::regprocedure,
   'public.reserve_exam_document_source(jsonb)'::regprocedure,'public.complete_exam_document_delivery(uuid,uuid,jsonb)'::regprocedure,'public.guard_exam_document_admin_phase_insert()'::regprocedure)`);
 await db.exec('RESET ROLE');
 await db.exec(installSql);
 await worker();
 await check('migration preserves all historical rows/settings, ACLs and clinical/link/idempotency functions',async()=>{
  assert.deepEqual(await state(),before);
  assert.deepEqual(await one(`SELECT jsonb_object_agg(oid::regprocedure::text,proacl::text) a FROM pg_proc WHERE oid IN
   ('public.update_exam_document_extraction(uuid,jsonb)'::regprocedure,'public.review_exam_document(uuid,bigint,jsonb,text,text)'::regprocedure,'public.reserve_exam_document_delivery(text,text,integer)'::regprocedure)`),oldAcl);
  assert.deepEqual(await one(`SELECT jsonb_object_agg(oid::regprocedure::text,md5(pg_get_functiondef(oid))) f FROM pg_proc WHERE oid IN
   ('public.auto_link_exam_document(uuid,jsonb)'::regprocedure,'public.apply_exam_document_link(uuid,uuid,uuid[],bigint,jsonb,uuid,text)'::regprocedure,
    'public.reserve_exam_document_source(jsonb)'::regprocedure,'public.complete_exam_document_delivery(uuid,uuid,jsonb)'::regprocedure,'public.guard_exam_document_admin_phase_insert()'::regprocedure)`),unchangedFunctions);
 });
 await check('subject hint never sends before processing, including a reserved or failed extraction',async()=>{
  const pending=await save();assert(!(await groupTasks()).some(t=>t.document_id===pending.id));
  const task=await processingTask(pending.id);assert(!(await groupTasks()).some(t=>t.document_id===pending.id));
  await rpc('complete_exam_document_delivery',[task.id,task.lease_token,JSON.stringify({status:'failed',error:'Unreadable PDF'})]);
  assert(!(await groupTasks()).some(t=>t.document_id===pending.id));assert.equal((await groupState(pending.id)).attempts,0);
 });
 await check('persisted complete fields wait until processing completes, then release without a linked patient',async()=>{
  let doc=await persist(await save(),extraction(),false);assert.equal(doc.pet_id,null);
  assert(!(await groupTasks()).some(t=>t.document_id===doc.id));
  const task=await processingTask(doc.id);
  await rpc('complete_exam_document_delivery',[task.id,task.lease_token,JSON.stringify({status:'completed'})]);
  const notification=(await groupTasks()).find(t=>t.document_id===doc.id);assert(notification);
  assert.deepEqual(notification.notification_fields,extraction().fields);assert.equal(notification.document.pet_id,null);
  assert(!(await groupTasks()).some(t=>t.document_id===doc.id));
 });
 await check('each absent required field stays pending with a readable reason, never receipt date or guessed data',async()=>{
  for(const [key,label] of [['pet_name','pet'],['client_name','tutor'],['exam_type','tipo de exame'],['exam_date','data de realização']]){
   const doc=await persist(await save(),extraction({fields:{[key]:null}}));
   assert.equal(doc.extracted_data[key],null);assert(doc.review_reason.includes(label));
   assert(!(await groupTasks()).some(t=>t.document_id===doc.id));assert.equal((await groupState(doc.id)).attempts,0);
  }
 });
 await check('completed processing classified for review is released after explicit human completion of all fields',async()=>{
  let doc=await persist(await save(),extraction({classification:'review',fields:{exam_date:null},reason:'Data de realização não localizada no PDF'}));
  assert(!(await groupTasks()).some(t=>t.document_id===doc.id));
  doc=await review(doc,{exam_date:'2026-10-02'}); // other fields remain extracted, no patient selection
  const task=(await groupTasks()).find(t=>t.document_id===doc.id);assert(task);
  assert.deepEqual(task.notification_fields,{...extraction().fields,exam_date:'2026-10-02'});assert.equal(task.document.pet_id,null);
 });
 await check('partial confirmations inherit absent keys while explicit null/blank rejects extracted fields',async()=>{
  let doc=await persist(await save(),extraction());
  doc=await review(doc,{pet_name:'Luna revisada',exam_date:'2026-10-03'});
  const task=(await groupTasks()).find(t=>t.document_id===doc.id);assert(task);
  assert.deepEqual(task.notification_fields,{pet_name:'Luna revisada',client_name:'Pessoa sem cadastro',exam_type:'Hemograma',exam_date:'2026-10-03'});
  for(const cleared of [{exam_date:null},{pet_name:''},{client_name:null,tutor_name:'Tentativa de substituir campo apagado'},{exam_type:'  '},{tutor_name:null}]){
   let clearDoc=await persist(await save(),extraction());clearDoc=await review(clearDoc,cleared);
   assert(clearDoc.review_reason?.includes('Dados pendentes'));
   assert(!(await groupTasks()).some(t=>t.document_id===clearDoc.id));
  }
 });
 await check('human review before extraction completion cannot overtake processing and late extraction cannot override rejection',async()=>{
  let doc=await save();doc=await review(doc,extraction().fields);
  assert(!(await groupTasks()).some(t=>t.document_id===doc.id));
  doc=await persist(doc,extraction({classification:'review',fields:{pet_name:null,client_name:null,exam_type:null,exam_date:null},reason:'Extraction could not identify fields'}));
  assert((await groupTasks()).some(t=>t.document_id===doc.id));
  let rejected=await save();await processingTask(rejected.id);rejected=await review(rejected,{},'not_exam','Documento administrativo');
  rejected=await persist(rejected,extraction());assert.equal(rejected.identification_status,'not_exam');
  assert(!(await groupTasks()).some(t=>t.document_id===rejected.id));
 });
 await check('missing date on human confirmation stays readable/pending and a later valid confirmation releases it',async()=>{
  let doc=await persist(await save(),extraction({classification:'review',fields:{exam_date:null},reason:'Data ausente'}));
  doc=await review(doc,{pet_name:'Luna'});assert(doc.review_reason.includes('data de realização'));
  assert(!(await groupTasks()).some(t=>t.document_id===doc.id));
  await assert.rejects(review(doc,{exam_date:'2026-02-30'}),/date|time|range/i);await worker();
  doc=await review(doc,{exam_date:'2026-10-04'});assert((await groupTasks()).some(t=>t.document_id===doc.id));
 });
 await check('malformed persisted dates fail closed without aborting reservations for another valid document',async()=>{
  const invalid=[];
  for(const value of ['2026-02-30','2026-1-01','0000-01-01','not-a-date']){
   const doc=await persist(await save(),extraction());
   await db.query('UPDATE exam_document SET confirmed_data=$2 WHERE id=$1',[doc.id,JSON.stringify({exam_date:value})]);invalid.push(doc.id);
  }
  const valid=await persist(await save(),extraction());const tasks=await groupTasks();
  assert(tasks.some(t=>t.document_id===valid.id));assert(!tasks.some(t=>invalid.includes(t.document_id)));
 });
 await check('punctuation placeholders cannot spend group attempts, while letters and numbers remain valid',async()=>{
  for(const [key,value] of [['pet_name','—'],['client_name','***'],['exam_type','...']]){
   let doc=await persist(await save(),extraction());doc=await review(doc,{[key]:value});
   assert(doc.review_reason?.includes('Dados pendentes'));assert(!(await groupTasks()).some(t=>t.document_id===doc.id));
   assert.equal((await groupState(doc.id)).attempts,0);
  }
  let valid=await persist(await save(),extraction());valid=await review(valid,{pet_name:'Ágata 2',client_name:'João da Silva',exam_type:'Raio-X'});
  assert((await groupTasks()).some(t=>t.document_id===valid.id));
 });
 await check('old sent/submitted/uncertain tasks are never reopened after processing or migration',async()=>{
  for(const entry of historical)await persist(entry.doc,extraction());
  const tasks=await groupTasks();for(const entry of historical){
   assert(!tasks.some(t=>t.document_id===entry.doc.id));assert.deepEqual(await groupState(entry.doc.id),entry.task);
  }
 });
 await check('explicit review/not-exam and missing clinical evidence still block complete candidate data',async()=>{
  const docs=[];
  for(const classification of ['review','not_exam'])docs.push(await persist(await save(),extraction({classification,reason:'Conferência humana necessária'})));
  const noEvidence=extraction();noEvidence.evidence=[];docs.push(await persist(await save(),noEvidence));
  const tasks=await groupTasks();assert(!tasks.some(t=>docs.some(d=>d.id===t.document_id)));
 });
 await check('service-only reservation and private helper remain inaccessible to anonymous/staff; disabled destination stays paused',async()=>{
  for(const r of ['anon','authenticated']){
   await role(r);await assert.rejects(groupTasks(),/permission|permiss|service|serviço/i);
   await assert.rejects(rpc('exam_document_group_readiness',['{}','{}']),/permission|permiss/i);
  }
  await worker();await db.exec("UPDATE exam_document_configuration SET enabled_destinations=ARRAY['drive','processing','nexus']");
  assert.deepEqual(await rpc('reserve_exam_document_delivery',['group','notification-worker',1]),{tasks:[],paused:true});
 });
 if(process.env.EXAM_GROUP_INSTALL_SQL)await check('installer registers migration09 and refuses a repeated application without changing rows or permissions',async()=>{
  await db.exec('RESET ROLE');
  assert.equal(Number((await one("SELECT count(*) n FROM supabase_migrations.schema_migrations WHERE version='20261016000009'")).n),1);
  const saved=await state();
  await assert.rejects(db.exec(installSql),/Precondição da migração09/);
  await db.exec('ROLLBACK');assert.deepEqual(await state(),saved);await worker();
 });
 console.log(`${passed} group-after-processing checks passed`);
}finally{await db.close();}
