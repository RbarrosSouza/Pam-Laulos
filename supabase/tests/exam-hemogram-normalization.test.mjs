// Actual SQL and the shared validator, with synthetic originals only. No APIs.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {collectionFixtureDB} from './collection-db.fixture.mjs';
import {validateExamExtraction} from '../../scripts/exames/extraction-validation.mjs';

const {db,role,rpc}=await collectionFixtureDB();
const migration=new URL('../migrations/20261019000016_exam_hemogram_normalization.sql',import.meta.url);
const actor='10000000-0000-0000-0000-000000000001',vet='30000000-0000-0000-0000-000000000001';
let sequence=0,passed=0;
const check=async(name,fn)=>{await fn();console.log(`ok ${++passed} - ${name}`);};
const one=async(sql,args=[])=>(await db.query(sql,args)).rows[0];
const worker=()=>role('service_role');
const getDoc=id=>one('SELECT * FROM exam_document WHERE id=$1',[id]);
const heading=excerpt=>({field:'exam_type',page:1,excerpt});
const trio=['Eritrograma','Leucograma','Plaquetograma'].map(heading);
const composite=[...trio,{field:'exam_type',page:2,excerpt:'CREATININA'},{field:'exam_type',page:2,excerpt:'URÉIA'}];
const match=(type,evidence=trio,single=true)=>rpc('exam_document_exam_type_evidence_matches',[type,JSON.stringify(evidence),single]);
async function internal(fn){await db.exec('RESET ROLE');try{return await fn();}finally{await worker();}}
async function patient(){
 const id=crypto.randomUUID(),code='HEMO-'+(++sequence),name='Luna Fixture '+sequence,tutor='Tutor Fixture '+sequence;
 await db.query('INSERT INTO clients("Código","Nome") VALUES($1,$2)',[code,tutor]);
 await db.query("INSERT INTO pets(id,client_code,name,species) VALUES($1,$2,$3,'Canina')",[id,code,name]);
 return{id,code,name,tutor};
}
async function save({candidate=false}={}){
 const serial=++sequence;
 const reserved=await rpc('reserve_exam_document_source',[JSON.stringify({channel:'whatsapp',account_id:'synthetic-inbox',message_id:'synthetic-message-'+serial,
  attachment_id:'pdf',original_name:'synthetic.pdf',metadata:{exam_candidate:candidate}})]);
 const file={drive_file_id:'synthetic-drive-'+reserved.document_id,drive_folder_id:'synthetic-private',size_bytes:123,sha256:serial.toString(16).padStart(64,'0')};
 const staged=await rpc('stage_exam_document_file',[reserved.document_id,JSON.stringify(file),'synthetic']);
 return(await rpc('confirm_exam_document_file',[staged.document_id,JSON.stringify(file),staged.lease_token])).document;
}
function extraction(p,{single=true,classification='exam',type='Hemograma',evidence=trio,version='document-evidence-v5',date='2026-10-17'}={}){
 const fields={pet_name:p.name,client_name:p.tutor,exam_type:type,exam_date:date};
 return {classification,single_patient:single,fields,evidence:[
  {field:'pet_name',page:1,excerpt:'Pet: '+p.name},{field:'client_name',page:1,excerpt:'Tutor: '+p.tutor},
  ...(date?[{field:'exam_date',page:1,excerpt:'Data do exame: 17/10/2026'}]:[]),...evidence],extractor_version:version};
}
async function process(document,data){
 const task=(await rpc('reserve_exam_document_delivery',['processing','synthetic-extractor',20])).tasks.find(t=>t.document_id===document.id);
 assert(task,'synthetic processing task must be reserved');
 await rpc('update_exam_document_extraction',[document.id,JSON.stringify({...data,delivery_id:task.id,lease_token:task.lease_token})]);
 await rpc('complete_exam_document_delivery',[task.id,task.lease_token,JSON.stringify({status:'completed'})]);
 return getDoc(document.id);
}
async function sale(p,{type='Hemograma',otherPet=false}={}){
 const id=crypto.randomUUID();
 await db.query("INSERT INTO sales_header(id,pet_id,customer_id,veterinarian_id,sale_date,status) VALUES($1,$2,$3,$4,'2026-10-16','paid')",[id,otherPet?crypto.randomUUID():p.id,p.code,vet]);
 const card=await one("INSERT INTO exam_card(sale_id,pet_id,client_code,pet_name,client_name,status,origin) VALUES($1,$2,$3,$4,$5,'aguardando_lab','venda') RETURNING *",[id,p.id,p.code,p.name,p.tutor]);
 const item=await one('INSERT INTO exam_item(exam_card_id,exam_type) VALUES($1,$2) RETURNING *',[card.id,type]);
 return{id,card,item};
}
const groupTask=async id=>(await rpc('reserve_exam_document_delivery',['group','synthetic-group-worker',20])).tasks.find(t=>t.document_id===id);
function fromValidator(p,{single=true,classification='exam',type='Eritrograma',pages:providedPages}={}){
 const pages=providedPages||[`Pet: ${p.name}\nTutor: ${p.tutor}\nData do exame: 17/10/2026\nERITROGRAMA\nHemácias 5,0\nLEUCOGRAMA\nLeucócitos 10,0\nPLAQUETOGRAMA\nPlaquetas 300`];
 const data=extraction(p,{single,classification,type,evidence:[heading(type)]});
 return validateExamExtraction({pages,totalPages:pages.length},{choices:[{message:{content:JSON.stringify(data)}}]});
}
const functionNames=['auto_link_exam_document(uuid,jsonb)','update_exam_document_extraction(uuid,jsonb)','reserve_exam_document_delivery(text,text,integer)'];
const contracts=async()=>Promise.all(functionNames.map(signature=>one("SELECT proowner,proacl::text,prosecdef,proconfig,prorettype,proargtypes::text,proargnames FROM pg_proc WHERE oid=$1::regprocedure",['public.'+signature])));
try {
 await db.exec('RESET ROLE');
 await db.exec(`ALTER TABLE veterinarios ADD COLUMN ativo boolean DEFAULT true,ADD COLUMN crmv text,ADD COLUMN avatar_url text;
 ALTER TABLE exam_card ADD COLUMN vet_id uuid REFERENCES veterinarios(id);
 ALTER TABLE exam_tracking ALTER COLUMN pet_id TYPE text USING pet_id::text;
 ALTER TABLE exam_tracking ALTER COLUMN veterinario_id TYPE text USING veterinario_id::text;
 ALTER TABLE exam_tracking ADD COLUMN created_at timestamptz DEFAULT now();
 CREATE TABLE sales_header(id uuid PRIMARY KEY,pet_id varchar,customer_id varchar,veterinarian_id varchar,sale_date date,status varchar);
 INSERT INTO auth.users(id) VALUES('${actor}');INSERT INTO exam_document_member(user_id,role) VALUES('${actor}','admin');
 INSERT INTO veterinarios(id,nome,crmv,ativo) VALUES('${vet}','Veterinária Fixture','SP 1234',true);`);
 for(const file of ['20261016000006_exam_operational_flow.sql','20261016000007_exam_clinical_group_eligibility.sql','20261016000008_exam_gmail_origin_identity.sql',
  '20261016000009_exam_group_after_processing.sql','20261016000010_exam_group_without_identification.sql','20261016000011_exam_unique_patient_matching.sql',
  '20261018000012_exam_document_responsibility.sql','20261018000013_exam_pending_summary.sql','20261019000015_exam_contact_optional_note.sql'])
  await db.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
 await db.exec('GRANT ALL ON public.exam_card,public.exam_item,public.exam_card_log,public.sales_header,public.veterinarios,public.exam_tracking TO service_role');
 await worker();await db.exec("UPDATE exam_document_configuration SET ingestion_enabled=true,enabled_destinations=ARRAY['drive','processing','group','nexus'],notification_cutoff=now()-interval '1 day',group_destination_key='synthetic-group'");
 const historical=await process(await save(),extraction(await patient(),{version:'document-evidence-v4'}));
 const historicalBefore=await getDoc(historical.id),configBefore=await one('SELECT * FROM exam_document_configuration');
 const contractBefore=await contracts();
 await db.exec('RESET ROLE');await db.exec(await readFile(migration,'utf8'));await worker();

 await check('migration preserves function contracts, permissions, existing originals, tasks and configuration',async()=>{
  assert.deepEqual(await contracts(),contractBefore);assert.deepEqual(await getDoc(historical.id),historicalBefore);
  assert.deepEqual(await one('SELECT * FROM exam_document_configuration'),configBefore);
  assert.equal(await groupTask(historical.id),undefined,'old extraction has no proven single_patient event; installation must not authorize it');
 });
 await check('literal type evidence retains its old semantics without requiring the new derivation gate',async()=>internal(async()=>{
  for(const type of ['Hemograma','Perfil renal','RELATÓRIO RADIOGRÁFICO'])assert.equal(await match(type,[heading('Exame: '+type)],false),true);
  assert.equal(await match('Perfil renal',[heading('Perfil hepático')]),false);assert.equal(await match('',trio),false);
 }));
 await check('the complete current trio qualifies Hemograma only for an explicitly single patient',async()=>internal(async()=>{
  assert.equal(await match('Hemograma'),true);assert.equal(await match('hemograma'),true);
  assert.equal(await match('Hemograma',trio,false),false);assert.equal(await match('Hemograma',trio,null),false);
  assert.equal(await match('Hemograma completo'),false,'only the approved commercial name is inferred');
 }));
 await check('the four approved compositions require exactly the corresponding real headings and retain every extra',async()=>internal(async()=>{
  const creatinina=[...trio,composite[3]],ureia=[...trio,composite[4]];
  for(const [type,evidence] of [['Hemograma',trio],['Hemograma + Creatinina',creatinina],['Hemograma + Ureia',ureia],['Hemograma + Creatinina + Ureia',composite]]){
   assert.equal(await match(type,evidence),true);assert.equal(await match(type,evidence,false),false);
  }
  assert.equal(await match('HEMOGRAMA + CREATININA + URÉIA',composite),true);
  for(const [type,evidence] of [['Hemograma',composite],['Hemograma + Creatinina',composite],['Hemograma + Creatinina + Ureia',trio],
   ['Hemograma + Ureia',creatinina],['Hemograma + ALT',[...trio,heading('ALT')]],['Hemograma',[...trio,heading('ALT')]]])assert.equal(await match(type,evidence),false);
 }));
 await check('one or two components, duplicates, mentions in prose and wrong field/page never prove the trio',async()=>internal(async()=>{
  for(const evidence of [trio.slice(0,1),trio.slice(0,2),[trio[0],trio[1],trio[1]],
   trio.map(e=>({...e,excerpt:'Foi solicitado '+e.excerpt})),trio.map(e=>({...e,field:'lab_name'})),
   trio.map(e=>({...e,page:0})),trio.map(e=>({...e,page:'invalid'})),trio.map(e=>({...e,excerpt:null}))])assert.equal(await match('Hemograma',evidence),false);
  assert.equal(await match('Hemograma',{}),false);assert.equal(await match('Hemograma',null),false);
 }));
 await check('heading whitespace, case, Unicode, ordinal and result columns match the shared validator contract',async()=>internal(async()=>{
  for(const line of ['ERITROGRAMA','  1. Eritrograma: Resultado Valores de Referência  ', 'II - LEUCOGRAMA — Resultados | Unidade','Plaquetograma\tUnidade Referência','Eritrograma Valor de referência','LEUCOGRAMA Relativo Absoluto Valor Rel. Ref. Valor Abs. Ref.'])
   assert.ok(await rpc('exam_document_exam_component_heading',[line]),line);
  for(const line of ['Eritrogramas','Histórico: Eritrograma','Eritrograma resultados anteriores','Eritrograma resultado esperado amanhã','Leucograma - pendente','Plaquetograma não realizado'])
   assert.equal(await rpc('exam_document_exam_component_heading',[line]),null,line);
 }));
 await check('new evidence helpers are internal even for authenticated team and worker roles',async()=>{
  for(const name of ['anon','authenticated','service_role']){
   await role(name);await assert.rejects(()=>match('Hemograma'),e=>e.code==='42501');
  }await worker();
 });
 await check('normalized Hemograma reuses only the unique proven pending commercial sale item and its vet',async()=>{
  const p=await patient(),s=await sale(p),d=await process(await save(),extraction(p));
  assert.equal(d.pet_id,p.id);assert.equal(d.confirmed_data.exam_type,'Hemograma');
  assert.equal((await one('SELECT exam_item_id FROM exam_document_item WHERE document_id=$1',[d.id])).exam_item_id,s.item.id);
  assert.equal((await one('SELECT result_received FROM exam_item WHERE id=$1',[s.item.id])).result_received,true);
  assert.equal((await one('SELECT veterinarian_id FROM exam_document_responsibility WHERE document_id=$1',[d.id])).veterinarian_id,vet);
  const event=await one("SELECT details FROM exam_document_event WHERE document_id=$1 AND event_type='extraction_updated' ORDER BY id DESC LIMIT 1",[d.id]);assert.equal(event.details.single_patient,true);
  assert.ok(await groupTask(d.id));
 });
 await check('normalized review remains review, never consumes a sale item, but keeps the existing partial group path',async()=>{
  const p=await patient(),s=await sale(p),d=await process(await save(),extraction(p,{classification:'review'}));
  assert.equal(d.pet_id,null);assert.equal(d.extracted_data.exam_type,'Hemograma');
  assert.equal((await one('SELECT result_received FROM exam_item WHERE id=$1',[s.item.id])).result_received,false);
  assert.ok(await groupTask(d.id));
 });
 await check('false or absent single-patient evidence never grants derived linkage or the evidence-based group path',async()=>{
  for(const single of [false,null]){
   const p=await patient(),s=await sale(p),d=await process(await save(),extraction(p,{single}));
   assert.equal(d.pet_id,null);assert.equal((await one('SELECT result_received FROM exam_item WHERE id=$1',[s.item.id])).result_received,false);
   assert.equal(await groupTask(d.id),undefined);
  }
 });
 await check('a new extractor version alone cannot substitute for a missing component',async()=>{
  const p=await patient(),s=await sale(p),d=await process(await save(),extraction(p,{evidence:trio.slice(0,2)}));
  assert.equal(d.pet_id,null);assert.equal(await groupTask(d.id),undefined);
  assert.equal((await one('SELECT result_received FROM exam_item WHERE id=$1',[s.item.id])).result_received,false);
 });
 await check('a literal individual component remains its own type and never claims a sold Hemograma',async()=>{
  const p=await patient(),s=await sale(p),d=await process(await save(),extraction(p,{type:'Eritrograma',evidence:[heading('Eritrograma')]}));
  assert.equal(d.pet_id,p.id);assert.equal(d.confirmed_data.exam_type,'Eritrograma');
  assert.equal((await one('SELECT result_received FROM exam_item WHERE id=$1',[s.item.id])).result_received,false);
  assert.notEqual((await one('SELECT exam_item_id FROM exam_document_item WHERE document_id=$1',[d.id])).exam_item_id,s.item.id);
 });
 await check('a composite type claims only an exact unique commercial item, never an individual Hemograma sale',async()=>{
  for(const exact of [true,false]){
   const p=await patient(),type='Hemograma + Creatinina + Ureia',s=await sale(p,{type:exact?type:'Hemograma'}),d=await process(await save(),extraction(p,{type,evidence:composite}));
   assert.equal(d.pet_id,p.id);assert.equal(d.confirmed_data.exam_type,type);
   const linked=(await one('SELECT exam_item_id FROM exam_document_item WHERE document_id=$1',[d.id])).exam_item_id;
   if(exact)assert.equal(linked,s.item.id);else assert.notEqual(linked,s.item.id);
   assert.equal((await one('SELECT result_received FROM exam_item WHERE id=$1',[s.item.id])).result_received,exact);
   assert.ok(await groupTask(d.id));
  }
 });
 await check('multiple matching sales or wrong patient metadata never become an automatic sale claim',async()=>{
  for(const kind of ['multiple','wrong-patient']){
   const p=await patient(),s=await sale(p,{otherPet:kind==='wrong-patient'});if(kind==='multiple')await sale(p);
   const d=await process(await save(),extraction(p));assert.equal(d.pet_id,p.id);
   assert.equal((await one('SELECT result_received FROM exam_item WHERE id=$1',[s.item.id])).result_received,false);
   assert.notEqual((await one('SELECT exam_item_id FROM exam_document_item WHERE document_id=$1',[d.id])).exam_item_id,s.item.id);
  }
 });
 await check('not-exam, missing clinical date and ambiguous patient matching retain the existing clinical guards',async()=>{
  const rejected=await process(await save(),extraction(await patient(),{classification:'not_exam'}));assert.equal(rejected.pet_id,null);assert.equal(await groupTask(rejected.id),undefined);
  const p=await patient(),undated=await process(await save(),extraction(p,{date:null}));assert.equal(undated.pet_id,null);
  assert.equal(Number((await one("SELECT count(*) n FROM exam_document_delivery WHERE document_id=$1 AND destination='nexus'",[undated.id])).n),0);
  const ambiguous=await patient();await db.query("INSERT INTO pets(id,client_code,name) VALUES($1,$2,$3)",[crypto.randomUUID(),ambiguous.code,ambiguous.name]);
  const d=await process(await save(),extraction(ambiguous));assert.equal(d.pet_id,null);assert.equal(d.identification_status,'review');
 });
 await check('group pause, cutoff and destination guards still apply to a proven normalized trio',async()=>{
  const d=await process(await save(),extraction(await patient()));
  await db.exec("UPDATE exam_document_configuration SET enabled_destinations=ARRAY['drive','processing','nexus']");
  const paused=await rpc('reserve_exam_document_delivery',['group','synthetic-worker',20]);assert.equal(paused.paused,true);assert.deepEqual(paused.tasks,[]);
  await db.exec("UPDATE exam_document_configuration SET enabled_destinations=ARRAY['drive','processing','group','nexus'],notification_cutoff=now()+interval '1 day'");assert.equal(await groupTask(d.id),undefined);
  await db.exec("UPDATE exam_document_configuration SET notification_cutoff=now()-interval '1 day',group_destination_key=NULL");assert.equal(await groupTask(d.id),undefined);
  await db.exec("UPDATE exam_document_configuration SET group_destination_key='synthetic-group'");assert.ok(await groupTask(d.id));
 });
 await check('processing rejects a wrong or expired lease before persisting new derivation evidence',async()=>{
  const d=await save(),data=extraction(await patient());
  const task=(await rpc('reserve_exam_document_delivery',['processing','synthetic-fenced-worker',20])).tasks.find(t=>t.document_id===d.id);assert(task);
  for(const token of [crypto.randomUUID(),task.lease_token]){
   if(token===task.lease_token)await db.query("UPDATE exam_document_delivery SET lease_until=now()-interval '1 minute' WHERE id=$1",[task.id]);
   await assert.rejects(()=>rpc('update_exam_document_extraction',[d.id,JSON.stringify({...data,delivery_id:task.id,lease_token:token})]),e=>e.code==='40001');
  }
  assert.deepEqual((await getDoc(d.id)).extracted_data,{});
  assert.equal(Number((await one("SELECT count(*) n FROM exam_document_event WHERE document_id=$1 AND event_type='extraction_updated'",[d.id])).n),0);
 });
 await check('two group claims never return a second dispatch lease for the same normalized original',async()=>{
  const d=await process(await save(),extraction(await patient()));const first=await groupTask(d.id);assert(first);
  assert.equal(await groupTask(d.id),undefined);
  assert.equal((await one('SELECT lease_token FROM exam_document_delivery WHERE id=$1',[first.id])).lease_token,first.lease_token);
 });
 await check('actual validator output round-trips its three original excerpts through SQL and the commercial item',async()=>{
  const p=await patient(),s=await sale(p),data=fromValidator(p);
  assert.equal(data.fields.exam_type,'Hemograma');assert.equal(data.single_patient,true);assert.equal(data.extractor_version,'document-evidence-v5');
  assert.deepEqual(data.evidence.filter(e=>e.field==='exam_type').map(e=>e.excerpt),['ERITROGRAMA','LEUCOGRAMA','PLAQUETOGRAMA']);
  const d=await process(await save(),data);assert.equal(d.pet_id,p.id);assert.equal((await one('SELECT exam_item_id FROM exam_document_item WHERE document_id=$1',[d.id])).exam_item_id,s.item.id);
 });
 await check('actual validator preserves the five real native-text headings in the mixed-panel SQL round-trip',async()=>{
  const p=await patient(),type='Hemograma + Creatinina + Ureia',s=await sale(p,{type});
  const pages=[`Pet: ${p.name}\nTutor: ${p.tutor}\nData do exame: 17/10/2026\nERITROGRAMA Valor de Referência\nHemácias 5,0\nLEUCOGRAMA Relativo Absoluto Valor Rel. Ref. Valor Abs. Ref.\nLeucócitos 10,0\nPLAQUETOGRAMA Valor de Referência\nPlaquetas 300`,
   'CREATININA Valor de Referência\nResultado 1,0\nURÉIA Valor de Referência\nResultado 30'];
  const data=fromValidator(p,{type,pages});assert.equal(data.fields.exam_type,type);
  assert.equal(data.evidence.filter(e=>e.field==='exam_type').length,5);
  const d=await process(await save(),data);assert.equal(d.pet_id,p.id);assert.equal((await one('SELECT exam_item_id FROM exam_document_item WHERE document_id=$1',[d.id])).exam_item_id,s.item.id);
 });
 await check('validator rejects historical, cancelled or multipatient derivation before any SQL normalized claim',async()=>{
  for(const variant of ['history','cancelled','multipatient']){
   const p=await patient(),s=await sale(p),base=`Pet: ${p.name}\nTutor: ${p.tutor}\nData do exame: 17/10/2026\n`;
   const text=base+(variant==='history'?'Histórico\nERITROGRAMA\nLEUCOGRAMA\nPLAQUETOGRAMA':variant==='cancelled'?'ERITROGRAMA\nnão realizado\nLEUCOGRAMA\nPLAQUETOGRAMA':'ERITROGRAMA\nLEUCOGRAMA\nPLAQUETOGRAMA');
   const data=fromValidator(p,{single:variant!=='multipatient',type:null,pages:[text]});assert.notEqual(data.fields.exam_type,'Hemograma');
   const d=await process(await save(),data);assert.equal(d.pet_id,null);assert.equal((await one('SELECT result_received FROM exam_item WHERE id=$1',[s.item.id])).result_received,false);
  }
 });
 await check('literal extraction and generic veterinarian label behavior are unchanged by this migration',async()=>{
  const p=await patient(),data=extraction(p,{type:'Hemograma',evidence:[heading('Exame: Hemograma')]});
  data.fields.requesting_vet_name='Veterinária Fixture';data.evidence.push({field:'requesting_vet_name',page:1,excerpt:'Médico Veterinário: Veterinária Fixture'});
  const d=await process(await save(),data);assert.equal(d.pet_id,p.id);assert.equal(await one('SELECT * FROM exam_document_responsibility WHERE document_id=$1',[d.id]),undefined);assert.ok(await groupTask(d.id));
 });
 console.log(`${passed} hemogram normalization SQL checks passed. External PDF layout/provider calls and concurrent PostgreSQL sessions are not exercised.`);
} catch(error) {console.error(error?.message||'Hemogram normalization SQL test failed');process.exitCode=1;} finally {await db.close();}
