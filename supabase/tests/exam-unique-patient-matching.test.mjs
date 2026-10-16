import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {collectionFixtureDB} from './collection-db.fixture.mjs';

const sourceSql=await readFile(new URL('../migrations/20261016000011_exam_unique_patient_matching.sql',import.meta.url),'utf8');
const installSql=process.env.EXAM_UNIQUE_MATCH_INSTALL_SQL ? await readFile(process.env.EXAM_UNIQUE_MATCH_INSTALL_SQL,'utf8') : sourceSql;
const {db,role,rpc}=await collectionFixtureDB();
const staff='10000000-0000-0000-0000-000000000001',stranger='10000000-0000-0000-0000-000000000002';
let seq=0,passed=0;
const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
const check=async(name,fn)=>{await fn();console.log(`ok ${++passed} - ${name}`);};
const worker=async()=>{await role('service_role');await db.exec("SELECT set_config('request.jwt.claim.sub','',false)");};
const human=async(uid=staff)=>{await role('authenticated');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[uid]);};
const doc=async id=>one('SELECT * FROM exam_document WHERE id=$1',[id]);
const state=async()=>one(`SELECT
 (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM exam_document d) documents,
 (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM exam_document_source s) sources,
 (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM exam_document_event e) events,
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM exam_document_delivery t) deliveries,
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM exam_card t) cards,
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM exam_item t) items,
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY document_id,exam_item_id) FROM exam_document_item t) links,
 (SELECT to_jsonb(c) FROM exam_document_configuration c) configuration`);
const signatures=['apply_exam_document_link(uuid,uuid,uuid[],bigint,jsonb,uuid,text)','auto_link_exam_document(uuid,jsonb)',
 'confirm_exam_document_link(uuid,uuid,uuid[],bigint,jsonb)','update_exam_document_extraction(uuid,jsonb)','review_exam_document(uuid,bigint,jsonb,text,text)',
 'normalize_exam_identity(text)','reserve_exam_document_source(jsonb)','reserve_exam_document_delivery(text,text,integer)',
 'complete_exam_document_delivery(uuid,uuid,jsonb)','confirm_exam_document_file(uuid,jsonb,uuid)'];
const metadata=async()=> (await db.query(`SELECT oid::regprocedure::text signature,proowner::regrole::text owner,proacl::text acl,proconfig,prosecdef,md5(prosrc) body_md5 FROM pg_proc WHERE oid=ANY($1::regprocedure[]) ORDER BY signature`,[signatures])).rows;
async function patient(name,tutor){
 const id=crypto.randomUUID(),code='C-'+(++seq);
 await db.query('INSERT INTO clients("Código","Nome") VALUES($1,$2)',[code,tutor]);
 await db.query('INSERT INTO pets(id,client_code,name,species) VALUES($1,$2,$3,\'Canina\')',[id,code,name]);
 return {id,code,name,tutor};
}
async function save(){
 const n=++seq,source={channel:'email',account_id:'synthetic',message_id:'message-'+n,attachment_id:'pdf',
  original_name:'original.pdf',received_at:new Date().toISOString(),metadata:{exam_candidate:true}};
 const reserve=await rpc('reserve_exam_document_source',[JSON.stringify(source)]);
 const file={drive_file_id:'drive-'+reserve.document_id,drive_folder_id:'synthetic',size_bytes:123,sha256:n.toString(16).padStart(64,'0')};
 const stage=await rpc('stage_exam_document_file',[reserve.document_id,JSON.stringify(file),'test']);
 return (await rpc('confirm_exam_document_file',[stage.document_id,JSON.stringify(file),stage.lease_token])).document;
}
function extraction(fields={},options={}){
 const f={client_name:'Clara',pet_name:'Max',exam_type:'Hemograma',exam_date:'2026-10-01',...fields};
 return {classification:'exam',single_patient:true,fields:f,
  evidence:Object.entries(f).filter(([,v])=>v).map(([field,value])=>({field,page:1,excerpt:`${field}: ${value}`})),
  extractor_version:'synthetic-unique-pair',...options};
}
async function processingTask(id){
 const current=await one("SELECT * FROM exam_document_delivery WHERE document_id=$1 AND destination='processing'",[id]);
 if(current?.status==='reserved')return current;
 const tasks=(await rpc('reserve_exam_document_delivery',['processing','extractor',20])).tasks;
 const found=tasks.find(t=>t.document_id===id);assert(found);return found;
}
async function processDocument(document,data=extraction()){
 const task=await processingTask(document.id);
 const result=await rpc('update_exam_document_extraction',[document.id,JSON.stringify({...data,delivery_id:task.id,lease_token:task.lease_token})]);
 await rpc('complete_exam_document_delivery',[task.id,task.lease_token,JSON.stringify({status:'completed'})]);return result.document;
}
async function confirm(document,patient,fields=extraction().fields,items=[]){
 await human();const fresh=await doc(document.id);
 const result=await rpc('confirm_exam_document_link',[fresh.id,patient.id,items,fresh.version,JSON.stringify(fields)]);
 await worker();return result;
}
async function saleItem(patient,trackingPet=patient.id){
 const sale='S-'+(++seq);
 await db.query("INSERT INTO exam_tracking(sale_id,pet_id,origin) VALUES($1,$2,'manual')",[sale,trackingPet]);
 const card=await one("INSERT INTO exam_card(pet_id,client_code,pet_name,client_name,sale_id,status,origin) VALUES($1,$2,$3,$4,$5,'aguardando_lab','venda') RETURNING id",[patient.id,patient.code,patient.name,patient.tutor,sale]);
 const item=await one("INSERT INTO exam_item(exam_card_id,exam_type) VALUES($1,'Hemograma') RETURNING id",[card.id]);
 return item.id;
}
try{
 await db.exec('RESET ROLE');
 // Production schema: the historical tracking identifier is text, while pets/cards/documents use UUID.
 await db.exec('ALTER TABLE public.exam_tracking ALTER COLUMN pet_id TYPE text USING pet_id::text');
 await db.exec(`INSERT INTO auth.users(id) VALUES('${staff}'),('${stranger}'); INSERT INTO exam_document_member(user_id,role) VALUES('${staff}','admin');`);
 for(const file of ['20261016000006_exam_operational_flow.sql','20261016000007_exam_clinical_group_eligibility.sql','20261016000008_exam_gmail_origin_identity.sql','20261016000009_exam_group_after_processing.sql','20261016000010_exam_group_without_identification.sql'])
  await db.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
 // Fixture-only legacy setup: Supabase's default grants are not modeled for tables created later.
 await db.exec('GRANT ALL ON public.exam_card,public.exam_item,public.exam_card_log TO service_role');
 await db.exec("CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,name text,statements text[]); INSERT INTO supabase_migrations.schema_migrations VALUES('20261016000010','synthetic',ARRAY[]::text[])");
 await worker();await db.exec("UPDATE exam_document_configuration SET ingestion_enabled=true,enabled_destinations=ARRAY['drive','processing','group','nexus'],notification_cutoff=now()-interval '1 day',group_destination_key='synthetic-group'");
 const clara=await patient('Max','Clara Souza'),bianca=await patient('Max','Bianca Santos');
 const reproduced=await save();const beforeFailure=await state();await human();
 await check('pre-migration reproduces the real text <> uuid error and rolls back all manual-link writes',async()=>{
  await assert.rejects(()=>rpc('confirm_exam_document_link',[reproduced.id,clara.id,[],reproduced.version,JSON.stringify(extraction().fields)]),error=>error.code==='42883'&&/text <> uuid/.test(error.message));
  await worker();assert.deepEqual(await state(),beforeFailure);
 });
 const before=await state(),beforeMeta=await metadata();await db.exec('RESET ROLE');await db.exec(installSql);await worker();
 await check('installation preserves documents, destinations, ACLs and all unrelated RPCs',async()=>{
  assert.deepEqual(await state(),before);const changed=new Set(['apply_exam_document_link(uuid,uuid,uuid[],bigint,jsonb,uuid,text)','auto_link_exam_document(uuid,jsonb)']);
  const after=await metadata();for(let i=0;i<beforeMeta.length;i++){assert.deepEqual({...after[i],body_md5:null},{...beforeMeta[i],body_md5:null});if(!changed.has(beforeMeta[i].signature))assert.equal(after[i].body_md5,beforeMeta[i].body_md5);}
 });
 await check('manual confirmation works with text tracking schema, creates one external result and is idempotent',async()=>{
  const result=await confirm(reproduced,clara,{...extraction().fields,client_name:clara.tutor});
  assert.equal(result.document.pet_id,clara.id);assert.equal(result.document.link_method,'manual');assert.equal(result.document.link_confirmed_by,staff);
  assert.equal(result.item_ids.length,1);const counts=await state();
  const replay=await confirm(result.document,clara,result.document.confirmed_data);assert.equal(replay.already_linked,true);assert.deepEqual(await state(),counts);
  assert.equal(Number((await one("SELECT count(*) n FROM exam_document_delivery WHERE document_id=$1 AND destination='nexus'",[reproduced.id])).n),1);
 });
 await check('manual existing sale item accepts matching text UUID and rejects another patient or a non-UUID historical code safely',async()=>{
  const validItem=await saleItem(clara,' '+clara.id.toUpperCase()+' ');
  const linked=await confirm(await save(),clara,extraction().fields,[validItem]);assert.equal(linked.document.pet_id,clara.id);
  for(const other of [bianca.id,'legacy-patient-code']){
   const item=await saleItem(clara,other),document=await save(),beforeAttempt=await state();
   await assert.rejects(()=>confirm(document,clara,extraction().fields,[item]),error=>error.code==='P0001'&&/Venda vinculada a outro paciente/.test(error.message));
   await worker();assert.deepEqual(await state(),beforeAttempt);
  }
 });
 await check('unique exact pet plus complete first name selects the correct tutor among pets with the same name',async()=>{
  const linked=await processDocument(await save());assert.equal(linked.pet_id,clara.id);assert.equal(linked.link_method,'automatic');assert.equal(linked.link_confirmed_by,null);
  const event=await one("SELECT * FROM exam_document_event WHERE document_id=$1 AND event_type='link_auto_confirmed'",[linked.id]);
  assert.equal(event.actor_id,null);assert.equal(event.details.method,'unique_client_pet_v2');assert.equal(event.details.matching_rule,'unique_first_name');assert.equal(event.details.extracted_names.client_name,'Clara');
  assert.equal(Number((await one("SELECT count(*) n FROM exam_document_delivery WHERE document_id=$1 AND destination='nexus'",[linked.id])).n),1);
 });
 await check('full tutor names continue to require full equality and are audited as full-name matching',async()=>{
  const linked=await processDocument(await save(),extraction({client_name:'  CLARA   SOUZA ',pet_name:' max '}));assert.equal(linked.pet_id,clara.id);
  assert.equal((await one("SELECT details FROM exam_document_event WHERE document_id=$1 AND event_type='link_auto_confirmed'",[linked.id])).details.matching_rule,'exact_full_name');
  const extended=await patient('Milo','Maria Clara Santos');
  const partial=await processDocument(await save(),extraction({client_name:'Maria Clara',pet_name:extended.name}));assert.equal(partial.pet_id,null);
 });
 await check('NFC, accents, case and spacing normalize for matching without changing original extracted names',async()=>{
  const accented=await patient('Ágata','José Antônio');
  const data=extraction({pet_name:' aGATA ',client_name:'JOSE'});const linked=await processDocument(await save(),data);assert.equal(linked.pet_id,accented.id);assert.equal(linked.extracted_data.client_name,'JOSE');
  const decomposed=await processDocument(await save(),extraction({pet_name:'A\u0301gata',client_name:'Jose\u0301 Anto\u0302nio'}));assert.equal(decomposed.pet_id,accented.id);
 });
 await check('two matching tutor-first-name/pet pairs remain ambiguous even when one client has an exact one-token full name',async()=>{
  const full=await patient('Lua','Lia Souza'),single=await patient('Lua','Lia');
  const ambiguous=await processDocument(await save(),extraction({pet_name:full.name,client_name:'Lia'}));assert.equal(ambiguous.pet_id,null);assert.match(ambiguous.review_reason,/Mais de um/);
  assert.equal(Number((await one("SELECT count(*) n FROM exam_document_delivery WHERE document_id=$1 AND destination='nexus'",[ambiguous.id])).n),0);
  assert.notEqual(full.id,single.id);
 });
 await check('same-tutor duplicate pets and duplicated client rows stay ambiguous',async()=>{
  const a=await patient('Nina','Bruna Almeida');await db.query('INSERT INTO pets(id,client_code,name) VALUES($1,$2,$3)',[crypto.randomUUID(),a.code,a.name]);
  assert.equal((await processDocument(await save(),extraction({pet_name:a.name,client_name:'Bruna'}))).pet_id,null);
  const b=await patient('Kiko','Paula Souza');await db.query('INSERT INTO clients("Código","Nome") VALUES($1,$2)',[b.code,b.tutor]);
  assert.equal((await processDocument(await save(),extraction({pet_name:b.name,client_name:'Paula'}))).pet_id,null);
 });
 await check('prefixes, suffixes, reordered names and partial pet names never auto-link',async()=>{
  for(const fields of [{client_name:'Cla'},{client_name:'ClaraS'},{client_name:'Souza'},{client_name:'Souza Clara'},{pet_name:'Ma'},{pet_name:'Max Junior'}]){
   const unresolved=await processDocument(await save(),extraction(fields));assert.equal(unresolved.pet_id,null);assert.notEqual(unresolved.identification_status,'confirmed');
  }
 });
 await check('missing proof, multiple patients, missing clinical dates/type and non-exam classifications retain existing safeguards',async()=>{
  for(const data of [extraction({}, {evidence:[]}),extraction({}, {single_patient:false}),extraction({exam_date:null}),extraction({exam_type:null}),extraction({}, {classification:'review'}),extraction({}, {classification:'not_exam'})]){
   const unresolved=await processDocument(await save(),data);assert.equal(unresolved.pet_id,null);
  }
 });
 await check('explicit human review and a late worker result cannot be overwritten by first-name matching',async()=>{
  for(const classification of ['review','not_exam']){
   const document=await save(),task=await processingTask(document.id);await human();
   await rpc('review_exam_document',[document.id,document.version,'{}',classification,'Conferência humana']);await worker();
   await rpc('update_exam_document_extraction',[document.id,JSON.stringify({...extraction(),delivery_id:task.id,lease_token:task.lease_token})]);
   const result=await doc(document.id);assert.equal(result.pet_id,null);assert.equal(result.identification_status,classification);
  }
 });
 await check('manual confirmation keeps optimistic version, member authorization and missing-date handling',async()=>{
  const document=await save();await human();
  await assert.rejects(()=>rpc('confirm_exam_document_link',[document.id,clara.id,[],document.version-1,JSON.stringify(extraction().fields)]),error=>error.code==='40001');await worker();
  const undated=await confirm(document,clara,{...extraction().fields,exam_date:null});assert.equal(undated.document.pet_id,clara.id);
  assert.equal(Number((await one("SELECT count(*) n FROM exam_document_delivery WHERE document_id=$1 AND destination='nexus'",[document.id])).n),0);
  await human(stranger);await assert.rejects(()=>rpc('confirm_exam_document_link',[document.id,clara.id,[],undated.document.version,JSON.stringify(extraction().fields)]));
  for(const caller of ['anon','authenticated','service_role']){await role(caller);await assert.rejects(()=>rpc('auto_link_exam_document',[document.id,JSON.stringify(extraction())]));await assert.rejects(()=>rpc('normalize_exam_match_name',['Clara']));}
  await worker();
 });
 if(process.env.EXAM_UNIQUE_MATCH_INSTALL_SQL)await check('guarded installer registers once and refuses replay without changing data or permissions',async()=>{
  await db.exec('RESET ROLE');assert.equal(Number((await one("SELECT count(*) n FROM supabase_migrations.schema_migrations WHERE version='20261016000011'")).n),1);
  const rows=await state(),functions=await metadata();await assert.rejects(()=>db.exec(installSql));await db.exec('ROLLBACK');assert.deepEqual(await state(),rows);assert.deepEqual(await metadata(),functions);
 });
 console.log(`${passed} unique-patient-matching checks passed`);
}finally{await db.close();}
