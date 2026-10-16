import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {collectionFixtureDB} from './collection-db.fixture.mjs';
const {db,role,rpc}=await collectionFixtureDB();
const staff='10000000-0000-0000-0000-000000000001',pet='20000000-0000-0000-0000-000000000001';
let seq=0,passed=0;
const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
async function check(name,fn){await fn();console.log(`ok ${++passed} - ${name}`);}
async function worker(){await role('service_role');await db.exec("SELECT set_config('request.jwt.claim.sub','',false)");}
async function human(){await role('authenticated');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[staff]);}
async function save(metadata={}){
 const n=++seq;
 const src=await rpc('reserve_exam_document_source',[JSON.stringify({channel:'email',account_id:'tests',message_id:'message-'+n,attachment_id:'pdf',original_name:'original.pdf',received_at:new Date().toISOString(),metadata})]);
 const file={drive_file_id:'drive-'+src.document_id,drive_folder_id:'exams',size_bytes:123,sha256:n.toString(16).padStart(64,'0')};
 const staged=await rpc('stage_exam_document_file',[src.document_id,JSON.stringify(file),'test']);
 return rpc('confirm_exam_document_file',[staged.document_id,JSON.stringify(file),staged.lease_token]);
}
function extraction(classification='exam',fields={}){
 const f={pet_name:'Luna',client_name:'Ana Silva',exam_type:'Hemograma',exam_date:'2026-10-01',...fields};
 return {classification,single_patient:true,fields:f,evidence:Object.entries(f).map(([field,value])=>({field,page:1,excerpt:`${field}: ${value}`})),extractor_version:'clinical-group-test'};
}
async function process(doc,data){
 const t=(await rpc('reserve_exam_document_delivery',['processing','extractor',20])).tasks.find(t=>t.document_id===doc.document_id);
 assert(t);
 const result=await rpc('update_exam_document_extraction',[doc.document_id,JSON.stringify({...data,delivery_id:t.id,lease_token:t.lease_token})]);
 await rpc('complete_exam_document_delivery',[t.id,t.lease_token,JSON.stringify({status:'completed'})]);return result;
}
const claim=async()=> (await rpc('reserve_exam_document_delivery',['group','group-worker',20])).tasks;
try{
 await db.exec(`RESET ROLE; INSERT INTO auth.users(id) VALUES('${staff}'); INSERT INTO exam_document_member(user_id,role) VALUES('${staff}','admin');
 INSERT INTO clients("Código","Nome") VALUES('C1','Ana Silva'); INSERT INTO pets(id,client_code,name) VALUES('${pet}','C1','Luna');`);
 for(const file of ['20261016000006_exam_operational_flow.sql','20261016000007_exam_clinical_group_eligibility.sql']) await db.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
 await worker();
 await db.query("UPDATE exam_document_configuration SET ingestion_enabled=true,enabled_destinations=ARRAY['drive','processing','group','nexus'],notification_cutoff=now()-interval '1 minute',group_destination_key='internal-exam-group'");
 await check('unknown/financial PDFs remain preserved and pending without group delivery',async()=>{
  const unknown=await save(),bill=await save({exam_candidate:false}),stringValue=await save({exam_candidate:'true'});
  const tasks=await claim();for(const d of [unknown,bill,stringValue]){
   assert.equal(d.document.file_status,'saved');assert(!tasks.some(t=>t.document_id===d.document_id));
   assert.equal((await one("SELECT status FROM exam_document_delivery WHERE document_id=$1 AND destination='group'",[d.document_id])).status,'pending');
  }
 });
 await check('explicit clinical subject candidate can be sent before identification without depending on sender',async()=>{
  const d=await save({exam_candidate:true,unknown_sender:true});assert.equal(d.document.pet_id,null);
  const tasks=await claim();assert(tasks.some(t=>t.document_id===d.document_id));
  assert.equal((await claim()).length,0);
 });
 await check('document extraction review/not-exam overrides earlier subject hints',async()=>{
  for(const classification of ['review','not_exam']){
   const d=await process(await save({exam_candidate:true}),extraction(classification));
   assert.equal(d.document.pet_id,null);
   assert(!(await claim()).some(t=>t.document_id===d.document_id));
  }
  const withoutEvidence=await process(await save({exam_candidate:true}),{...extraction(),evidence:[]});
  assert(!(await claim()).some(t=>t.document_id===withoutEvidence.document_id));
 });
 await check('verified clinical extraction releases group without a matching patient, and forwards can auto-match uniquely',async()=>{
  const unmatched=await process(await save({unknown_sender:true,exam_candidate:false}),extraction('exam',{client_name:'Pessoa não cadastrada'}));
  assert.equal(unmatched.document.pet_id,null);assert.equal(unmatched.document.identification_status,'review');
  const matched=await process(await save({unknown_sender:true,exam_candidate:false}),extraction());
  assert.equal(matched.document.pet_id,pet);assert.equal(matched.document.link_method,'automatic');
  const tasks=await claim();assert(tasks.some(t=>t.document_id===unmatched.document_id));assert(tasks.some(t=>t.document_id===matched.document_id));
  assert.equal(Number((await one("SELECT count(*) n FROM exam_document_delivery WHERE document_id=$1 AND destination='nexus'",[matched.document_id])).n),1);
 });
 await check('latest explicit human review or clinical link takes precedence over extraction/hints',async()=>{
  const approved=await save(),declined=await save({exam_candidate:true}),selected=await process(await save(),extraction('review'));
  await human();
  await rpc('review_exam_document',[approved.document_id,approved.document.version,'{}','exam',null]);
  await rpc('review_exam_document',[declined.document_id,declined.document.version,'{}','review','Conferir se é exame']);
  await rpc('confirm_exam_document_link',[selected.document_id,pet,[],selected.document.version,JSON.stringify(extraction().fields)]);
  await worker();const tasks=await claim();assert(tasks.some(t=>t.document_id===approved.document_id));assert(tasks.some(t=>t.document_id===selected.document_id));assert(!tasks.some(t=>t.document_id===declined.document_id));
 });
 console.log(`${passed} clinical group eligibility checks passed`);
}finally{await db.close();}
