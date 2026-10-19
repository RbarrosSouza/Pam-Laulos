// Actual migrations and shared JS, synthetic header values only. No provider I/O.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {collectionFixtureDB} from './collection-db.fixture.mjs';
import {validateExamExtraction} from '../../scripts/exames/extraction-validation.mjs';

const {db,role,rpc}=await collectionFixtureDB();
const actor='10000000-0000-0000-0000-000000000001',vetA='30000000-0000-0000-0000-000000000001',vetB='30000000-0000-0000-0000-000000000002';
let sequence=0,passed=0;
const one=async(sql,args=[])=>(await db.query(sql,args)).rows[0];
const check=async(name,fn)=>{await fn();console.log(`ok ${++passed} - ${name}`);};
const worker=()=>role('service_role');
const getDoc=id=>one('SELECT * FROM exam_document WHERE id=$1',[id]);
const responsible=id=>one('SELECT * FROM exam_document_responsibility WHERE document_id=$1',[id]);
async function internal(fn){await db.exec('RESET ROLE');try{return await fn();}finally{await worker();}}
async function patient(){
 const id=crypto.randomUUID(),code='HEADER-'+(++sequence),name='Luna Fixture '+sequence,tutor='Carla Fixture '+sequence;
 await db.query('INSERT INTO clients("Código","Nome") VALUES($1,$2)',[code,tutor]);
 await db.query("INSERT INTO pets(id,client_code,name,species) VALUES($1,$2,$3,'Canina')",[id,code,name]);return{id,code,name,tutor};
}
async function save(){
 const serial=++sequence,reserved=await rpc('reserve_exam_document_source',[JSON.stringify({channel:'whatsapp',account_id:'synthetic-inbox',message_id:'header-message-'+serial,
  attachment_id:'pdf',original_name:'synthetic.pdf',metadata:{exam_candidate:true}})]);
 const file={drive_file_id:'synthetic-drive-'+reserved.document_id,drive_folder_id:'synthetic-private',size_bytes:123,sha256:serial.toString(16).padStart(64,'0')};
 const staged=await rpc('stage_exam_document_file',[reserved.document_id,JSON.stringify(file),'synthetic']);
 return(await rpc('confirm_exam_document_file',[staged.document_id,JSON.stringify(file),staged.lease_token])).document;
}
function header(p,{wide=false,name='Alice Freitas',registration='1234',date='17/10/2026',pet=p.name,tutor=p.tutor}={}){
 const gap=wide?'   ':' ';
 return [['Clínica veterinária','Médico veterinário','CRMV'].join(gap),['CLÍNICA FIXTURE',name,registration].join(gap),
  ['Paciente','Idade','Sexo'].join(gap),[pet,'10a','Fêmea'].join(gap),
  ['Responsável','Raça','Data coleta'].join(gap),[tutor,'Canino / MALTÊS',date].join(gap)].join('\n');
}
function inline(p){return `Paciente: ${p.name}\nTutor: ${p.tutor}\nData coleta: 17/10/2026\nMédica Veterinária: Alice Freitas`;}
const matches=(quote,p,name='Alice Freitas')=>rpc('exam_document_requester_identity_evidence_matches',[quote,name,p.name,p.tutor]);
function extraction(p,{quote=header(p),name='Alice Freitas',registration='1234',single=true,classification='exam'}={}){
 const fields={pet_name:p.name,client_name:p.tutor,exam_type:'Hemograma',exam_date:'2026-10-17',requesting_vet_name:name,requesting_vet_crmv:registration};
 const data={classification,single_patient:single,fields,evidence:[{field:'pet_name',page:1,excerpt:p.name},{field:'client_name',page:1,excerpt:p.tutor},
  {field:'exam_type',page:1,excerpt:'Exame: Hemograma'},...['exam_date','requesting_vet_name','requesting_vet_crmv'].map(field=>({field,page:1,excerpt:quote}))]};
 const page=quote+'\nExame: Hemograma';
 return validateExamExtraction({pages:[page],totalPages:1},{choices:[{message:{content:JSON.stringify(data)}}]});
}
async function process(d,data){
 const task=(await rpc('reserve_exam_document_delivery',['processing','synthetic-extractor',20])).tasks.find(t=>t.document_id===d.id);assert(task);
 await rpc('update_exam_document_extraction',[d.id,JSON.stringify({...data,delivery_id:task.id,lease_token:task.lease_token})]);
 await rpc('complete_exam_document_delivery',[task.id,task.lease_token,JSON.stringify({status:'completed'})]);return getDoc(d.id);
}
async function sale(p,vet){
 const id=crypto.randomUUID();await db.query("INSERT INTO sales_header(id,pet_id,customer_id,veterinarian_id,sale_date,status) VALUES($1,$2,$3,$4,'2026-10-16','paid')",[id,p.id,p.code,vet]);
 const c=await one("INSERT INTO exam_card(sale_id,pet_id,client_code,pet_name,client_name,status,origin) VALUES($1,$2,$3,$4,$5,'aguardando_lab','venda') RETURNING *",[id,p.id,p.code,p.name,p.tutor]);
 await db.query("INSERT INTO exam_item(exam_card_id,exam_type) VALUES($1,'Hemograma')",[c.id]);return id;
}
const signature='public.resolve_exam_document_responsible_vet(uuid)';
const attributes=()=>one('SELECT proowner,proacl::text,prosecdef,proconfig,prorettype,proargnames FROM pg_proc WHERE oid=$1::regprocedure',[signature]);
const definition=signature=>one('SELECT md5(pg_get_functiondef($1::regprocedure)) hash',[signature]);
try {
 await db.exec('RESET ROLE');
 await db.exec(`ALTER TABLE veterinarios ADD COLUMN ativo boolean DEFAULT true,ADD COLUMN crmv text,ADD COLUMN avatar_url text;
 ALTER TABLE exam_card ADD COLUMN vet_id uuid REFERENCES veterinarios(id);
 ALTER TABLE exam_tracking ALTER COLUMN pet_id TYPE text USING pet_id::text;
 ALTER TABLE exam_tracking ALTER COLUMN veterinario_id TYPE text USING veterinario_id::text;
 ALTER TABLE exam_tracking ADD COLUMN created_at timestamptz DEFAULT now();
 CREATE TABLE sales_header(id uuid PRIMARY KEY,pet_id varchar,customer_id varchar,veterinarian_id varchar,sale_date date,status varchar);
 INSERT INTO auth.users(id) VALUES('${actor}');INSERT INTO exam_document_member(user_id,role) VALUES('${actor}','admin');
 INSERT INTO veterinarios(id,nome,crmv,ativo) VALUES('${vetA}','Alice Freitas','SP 1234',true),('${vetB}','Bruna Vieira','RJ 5678',true);`);
 for(const file of ['20261016000006_exam_operational_flow.sql','20261016000007_exam_clinical_group_eligibility.sql','20261016000008_exam_gmail_origin_identity.sql',
  '20261016000009_exam_group_after_processing.sql','20261016000010_exam_group_without_identification.sql','20261016000011_exam_unique_patient_matching.sql',
  '20261018000012_exam_document_responsibility.sql','20261018000013_exam_pending_summary.sql','20261019000015_exam_contact_optional_note.sql','20261019000016_exam_hemogram_normalization.sql'])
  await db.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
 await db.exec('GRANT ALL ON public.exam_card,public.exam_item,public.exam_card_log,public.sales_header,public.veterinarios,public.exam_tracking TO service_role');
 await worker();await db.exec("UPDATE exam_document_configuration SET ingestion_enabled=true,enabled_destinations=ARRAY['drive','processing','group','nexus'],notification_cutoff=now()-interval '1 day',group_destination_key='synthetic-group'");
 const old=await save(),before=await getDoc(old.id),config=await one('SELECT * FROM exam_document_configuration'),attrs=await attributes();
 const explicitBefore=await definition('public.exam_document_requester_evidence_matches(text,text)'),dateBefore=await definition('public.exam_document_date_evidence_matches(text,text)');
 await db.exec('RESET ROLE');await db.exec(await readFile(new URL('../migrations/20261019000017_exam_requester_identification_header.sql',import.meta.url),'utf8'));await worker();
 await check('migration preserves existing evidence helper, date helper, resolver ACL, originals and operational settings',async()=>{
  assert.deepEqual(await getDoc(old.id),before);assert.deepEqual(await one('SELECT * FROM exam_document_configuration'),config);assert.deepEqual(await attributes(),attrs);
  assert.deepEqual(await definition('public.exam_document_requester_evidence_matches(text,text)'),explicitBefore);assert.deepEqual(await definition('public.exam_document_date_evidence_matches(text,text)'),dateBefore);
 });
 await check('explicit requester labels keep the prior semantics while a generic title alone remains insufficient',async()=>internal(async()=>{
  const p=await patient();for(const label of ['Solicitante','Requisitante','Solicitado por'])assert.equal(await matches(`${label}: Alice Freitas`,p),true);
  assert.equal(await matches('Médico Veterinário: Alice Freitas',p),false);
  assert.equal(await matches('Solicitante: Bruna Vieira; Laudante: Alice Freitas',p),false);
 }));
 await check('both native single-space and physical-column headers identify only the documented vet',async()=>internal(async()=>{
  const p=await patient();for(const wide of [false,true]){
   const quote=header(p,{wide});assert.equal(await matches(quote,p),true);
   assert.equal(await matches(quote,p,'Alice'),false);assert.equal(await matches(quote,p,'Bruna Vieira'),false);
  }assert.equal(await matches(inline(p),p),true);
 }));
 await check('a header for another pet or guardian never qualifies the generic veterinarian',async()=>internal(async()=>{
  const p=await patient();for(const options of [{pet:'Outro Pet'},{tutor:'Outra Tutora'},{pet:'Outro Pet',tutor:'Outra Tutora'}])assert.equal(await matches(header(p,options),p),false);
  assert.equal(await rpc('exam_document_requester_identity_evidence_matches',[header(p),'Alice Freitas',null,p.tutor]),false);
 }));
 await check('missing identity/date blocks, invalid dates, duplicate dates and displaced collection values fail closed',async()=>internal(async()=>{
  const p=await patient(),good=header(p);
  for(const quote of [good.replace('Paciente Idade Sexo','Dados gerais'),good.replace('Responsável Raça Data coleta','Responsável Raça Nascimento'),
   header(p,{date:'31/02/2026'}),header(p,{date:'17/10/2026 18/10/2026'}),header(p,{date:'17/10/2026 pendente'}),header(p,{date:'17/10/2026\n'}).replace('10a Fêmea','idade desconhecida')])assert.equal(await matches(quote,p),false);
  assert.equal(await matches(good+'\n'+('x'.repeat(1501)),p),false);
 }));
 await check('signature, liberator, radiologist and technical-director evidence cannot become a generic requester',async()=>internal(async()=>{
  const p=await patient();for(const role of ['Laudante','Radiologista','Assinado por','Assinatura','Signatário','Liberado por','RT','Responsável técnico','Responsável pelo laudo'])
   assert.equal(await matches(header(p)+'\n'+role+': Outra Pessoa',p),false,role);
 }));
 await check('header helpers and resolver remain inaccessible to anonymous, team and worker direct calls',async()=>{
  const p=await patient();for(const name of ['anon','authenticated','service_role']){
   await role(name);await assert.rejects(()=>matches(header(p),p),e=>e.code==='42501');
  }await worker();
 });
 await check('actual validator header/date/name output round-trips into the exact unique active directory entry',async()=>{
  for(const wide of [false,true]){
   const p=await patient(),data=extraction(p,{quote:header(p,{wide})});
   assert.equal(data.fields.requesting_vet_name,'Alice Freitas');assert.equal(data.fields.requesting_vet_crmv,null);assert.equal(data.fields.exam_date,'2026-10-17');
   const d=await process(await save(),data);assert.equal(d.pet_id,p.id);assert.equal(d.extracted_data.requesting_vet_crmv,null);
   const r=await responsible(d.id);assert.equal(r.veterinarian_id,vetA);assert.equal(r.source,'pdf');
  }
 });
 await check('an inline identification block also round-trips without granting a bare medical title',async()=>{
  const p=await patient(),data=extraction(p,{quote:inline(p),registration:null});assert.equal(data.fields.requesting_vet_name,'Alice Freitas');
  const d=await process(await save(),data);assert.equal((await responsible(d.id)).veterinarian_id,vetA);
 });
 await check('the validator prevents cross-patient, cross-guardian and multipatient generic assignments',async()=>{
  for(const kind of ['pet','guardian','multi']){
   const p=await patient(),data=extraction(p,{quote:header(p,{pet:kind==='pet'?'Outro Pet':p.name,tutor:kind==='guardian'?'Outra Tutora':p.tutor}),single:kind!=='multi'});
   assert.equal(data.fields.requesting_vet_name,null);const d=await process(await save(),data);assert.equal(await responsible(d.id),undefined);
  }
 });
 await check('numeric CRMV never disambiguates homonyms; a qualified CRMV still requires the same exact name',async()=>{
  const duplicate='30000000-0000-0000-0000-000000000099';await db.query("INSERT INTO veterinarios(id,nome,crmv,ativo) VALUES($1,'Alice Freitas','RJ 9988',true)",[duplicate]);
  for(const [registration,expected] of [['1234',null],['SP 1234',vetA],['RJ 1234',null]]){
   const p=await patient(),data=extraction(p,{quote:header(p,{registration}),registration});
   const d=await process(await save(),data);assert.equal((await responsible(d.id)).veterinarian_id,expected);
  }await db.query('DELETE FROM veterinarios WHERE id=$1',[duplicate]);
 });
 await check('manual ownership survives later contextual extraction with its original actor and source',async()=>{
  const p=await patient(),d=await save();await role('authenticated');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[actor]);
  await rpc('set_exam_document_responsible_vet',[d.id,vetB,d.version]);await worker();await process(d,extraction(p));
  const r=await responsible(d.id);assert.equal(r.veterinarian_id,vetB);assert.equal(r.source,'manual');assert.equal(r.assigned_by,actor);
 });
 await check('conflicting proven sale and contextual PDF vets remain a conflict with no silent assignment',async()=>{
  const p=await patient();await sale(p,vetB);const d=await process(await save(),extraction(p));
  const r=await responsible(d.id);assert.equal(r.source,'conflict');assert.equal(r.veterinarian_id,null);
 });
 console.log(`${passed} requester identification-header SQL checks passed. No production/provider calls or historical reprocessing were performed.`);
} catch(error){console.error(error?.message||'Requester header SQL test failed');process.exitCode=1;}finally{await db.close();}
