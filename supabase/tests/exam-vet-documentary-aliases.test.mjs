// Synthetic names only. Actual resolver SQL; no real alias, API or reprocessing.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {collectionFixtureDB} from './collection-db.fixture.mjs';

const {db,role,rpc}=await collectionFixtureDB();
const actor='10000000-0000-0000-0000-000000000001',vetA='30000000-0000-0000-0000-000000000001',vetB='30000000-0000-0000-0000-000000000002',inactive='30000000-0000-0000-0000-000000000003';
const canonical='Clara Alves',documentary='Clara Ferreira';
let serial=0,passed=0;
const one=async(sql,args=[])=>(await db.query(sql,args)).rows[0];
const check=async(name,fn)=>{await fn();console.log(`ok ${++passed} - ${name}`);};
const responsible=id=>one('SELECT * FROM exam_document_responsibility WHERE document_id=$1',[id]);
const aliases=(id,names)=>db.query('UPDATE veterinarios SET nome_laudo_aliases=$2 WHERE id=$1',[id,names]);
const attributes=()=>one("SELECT proowner,proacl::text,prosecdef,proconfig,prorettype,proargnames FROM pg_proc WHERE oid='public.resolve_exam_document_responsible_vet(uuid)'::regprocedure");
async function document(requester,{extract=true}={}){
 const id=crypto.randomUUID(),n=++serial;
 await db.query("INSERT INTO exam_document(id,original_name,file_status,sha256,size_bytes,drive_file_id,received_at) VALUES($1,'synthetic.pdf','saved',$2,123,$3,now())",[id,n.toString(16).padStart(64,'0'),'synthetic-drive-'+n]);
 if(extract)await setExtraction(id,requester);return id;
}
async function setExtraction(id,requester){
 const fields={pet_name:'Luna Fixture',client_name:'Tutor Fixture',exam_type:'Hemograma',exam_date:'2026-10-17',requesting_vet_name:requester,requesting_vet_crmv:'1234'};
 const quote='Solicitante: '+requester+' — CRMV 1234';
 await db.query('UPDATE exam_document SET extracted_data=$2,evidence=$3 WHERE id=$1',[id,JSON.stringify(fields),JSON.stringify([{field:'requesting_vet_name',page:1,excerpt:quote},{field:'requesting_vet_crmv',page:1,excerpt:quote}])]);
}
try {
 await db.exec('RESET ROLE');
 await db.exec(`ALTER TABLE veterinarios ADD COLUMN ativo boolean DEFAULT true,ADD COLUMN crmv text,ADD COLUMN avatar_url text;
 ALTER TABLE exam_card ADD COLUMN vet_id uuid REFERENCES veterinarios(id);
 ALTER TABLE exam_tracking ALTER COLUMN pet_id TYPE text USING pet_id::text;
 ALTER TABLE exam_tracking ALTER COLUMN veterinario_id TYPE text USING veterinario_id::text;
 ALTER TABLE exam_tracking ADD COLUMN created_at timestamptz DEFAULT now();
 CREATE TABLE sales_header(id uuid PRIMARY KEY,pet_id varchar,customer_id varchar,veterinarian_id varchar,sale_date date,status varchar);
 INSERT INTO auth.users(id) VALUES('${actor}');INSERT INTO exam_document_member(user_id,role) VALUES('${actor}','admin');
 INSERT INTO veterinarios(id,nome,crmv,ativo) VALUES('${vetA}','Clara Alves','SP 1234',true),('${vetB}','Bruna Vieira','RJ 5678',true),('${inactive}','Inativa Fixture','SP 9999',false);`);
 for(const file of ['20261016000006_exam_operational_flow.sql','20261016000007_exam_clinical_group_eligibility.sql','20261016000008_exam_gmail_origin_identity.sql',
  '20261016000009_exam_group_after_processing.sql','20261016000010_exam_group_without_identification.sql','20261016000011_exam_unique_patient_matching.sql',
  '20261018000012_exam_document_responsibility.sql','20261018000013_exam_pending_summary.sql','20261019000015_exam_contact_optional_note.sql',
  '20261019000016_exam_hemogram_normalization.sql','20261019000017_exam_requester_identification_header.sql'])
  await db.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
 await db.exec('UPDATE exam_document_configuration SET ingestion_enabled=true');
 const old=await document(documentary),oldResponsibility=await responsible(old),before=await attributes();
 const catalog=(await db.query('SELECT id,nome,crmv,ativo FROM veterinarios ORDER BY id')).rows;
 const tableAcl=await one("SELECT relacl::text,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.veterinarios'::regclass");
 await db.exec(await readFile(new URL('../migrations/20261019000018_exam_vet_documentary_aliases.sql',import.meta.url),'utf8'));
 await check('migration seeds no alias, changes no name/CRMV or historical responsibility, and preserves ACLs',async()=>{
  assert.deepEqual((await db.query('SELECT id,nome,crmv,ativo FROM veterinarios ORDER BY id')).rows,catalog);assert.deepEqual(await responsible(old),oldResponsibility);
  assert.deepEqual(await attributes(),before);assert.deepEqual(await one("SELECT relacl::text,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.veterinarios'::regclass"),tableAcl);
  for(const row of (await db.query('SELECT nome_laudo_aliases FROM veterinarios')).rows)assert.deepEqual(row.nome_laudo_aliases,[]);
 });
 await check('the changed documentary name resolves only after its alias is explicitly populated',async()=>{
  const missing=await document(documentary);assert.equal((await responsible(missing)).veterinarian_id,null);
  await aliases(vetA,[documentary]);assert.deepEqual(await responsible(old),oldResponsibility,'alias update must not automatically reprocess old documents');
  const matched=await document(documentary),r=await responsible(matched);assert.equal(r.veterinarian_id,vetA);assert.equal(r.source,'pdf');
  assert.equal((await rpc('exam_document_responsibility_fields',[matched])).responsible_vet_name,canonical);
  assert.equal((await one('SELECT nome,crmv FROM veterinarios WHERE id=$1',[vetA])).nome,canonical);
 });
 await check('normalization remains full-name exact, not first-name, substring, phonetic or numeric matching',async()=>{
  assert.equal(await rpc('exam_document_vet_documentary_name_matches',[canonical,[documentary],'Dra. CLARA FERREIRA']),true);
  for(const name of ['Clara','Ferreira','Clara Ferrera','1234','49116'])assert.equal(await rpc('exam_document_vet_documentary_name_matches',[canonical,[documentary],name]),false);
  assert.equal((await responsible(await document('Clara'))).veterinarian_id,null);
 });
 await check('duplicate aliases in one row do not multiply candidates and inactive aliases are ignored',async()=>{
  await aliases(vetA,[documentary,documentary]);await aliases(inactive,[documentary]);
  assert.equal((await responsible(await document(documentary))).veterinarian_id,vetA);
 });
 await check('an alias shared by two active vets is a conflict even when the unqualified CRMV number matches',async()=>{
  await aliases(vetB,[documentary]);const r=await responsible(await document(documentary));assert.equal(r.source,'conflict');assert.equal(r.veterinarian_id,null);
  await aliases(vetB,[]);
 });
 await check('an alias colliding with another active canonical name also refuses implicit assignment',async()=>{
  await aliases(vetA,[documentary,'Bruna Vieira']);const r=await responsible(await document('Bruna Vieira'));assert.equal(r.source,'conflict');assert.equal(r.veterinarian_id,null);
  await aliases(vetA,[documentary]);
 });
 await check('removing an alias blocks a new documentary match without changing the displayed vet',async()=>{
  await aliases(vetA,[]);assert.equal((await responsible(await document(documentary))).veterinarian_id,null);
  assert.equal((await responsible(await document(canonical))).veterinarian_id,vetA);await aliases(vetA,[documentary]);
 });
 await check('manual assignment and its actor/source survive a different matching documentary alias',async()=>{
  const id=await document(documentary,{extract:false});await role('authenticated');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[actor]);
  await rpc('set_exam_document_responsible_vet',[id,vetB,(await one('SELECT version FROM exam_document WHERE id=$1',[id])).version]);
  await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.role','service_role',false); SELECT set_config('request.jwt.claim.sub','',false)");
  await setExtraction(id,documentary);const r=await responsible(id);assert.equal(r.veterinarian_id,vetB);assert.equal(r.source,'manual');assert.equal(r.assigned_by,actor);
 });
 await check('a conflicting proven sale remains a conflict rather than being overwritten by the alias',async()=>{
  const p=crypto.randomUUID(),id=await document(documentary),sale=crypto.randomUUID(),code='ALIAS-FIXTURE';
  await db.query('INSERT INTO clients("Código","Nome") VALUES($1,\'Tutor Fixture\')',[code]);
  await db.query("INSERT INTO pets(id,client_code,name) VALUES($1,$2,'Luna Fixture')",[p,code]);
  await db.query('UPDATE exam_document SET pet_id=$2,client_code=$3 WHERE id=$1',[id,p,code]);
  await db.query("INSERT INTO sales_header(id,pet_id,customer_id,veterinarian_id,sale_date,status) VALUES($1,$2,$3,$4,'2026-10-16','paid')",[sale,p,code,vetB]);
  const card=await one("INSERT INTO exam_card(sale_id,pet_id,client_code,pet_name,client_name,status,origin,vet_id,vet_name) VALUES($1,$2,$3,'Luna Fixture','Tutor Fixture','exame_pronto','venda',$4,'Bruna Vieira') RETURNING id",[sale,p,code,vetB]);
  const item=await one("INSERT INTO exam_item(exam_card_id,exam_type,result_received,result_received_at) VALUES($1,'Hemograma',true,(SELECT received_at FROM exam_document WHERE id=$2)) RETURNING id",[card.id,id]);
  await db.query("INSERT INTO exam_document_item(document_id,exam_item_id,confirmation_method,confirmed_by) VALUES($1,$2,'manual',$3)",[id,item.id,actor]);
  const r=await responsible(id);assert.equal(r.source,'conflict');assert.equal(r.veterinarian_id,null);
  assert.equal((await one('SELECT veterinarian_id FROM sales_header WHERE id=$1',[sale])).veterinarian_id,vetB);
 });
 await check('the alias helper is private and no new execution privilege is granted to team or workers',async()=>{
  for(const name of ['anon','authenticated','service_role']){await role(name);await assert.rejects(()=>rpc('exam_document_vet_documentary_name_matches',[canonical,[documentary],documentary]),e=>e.code==='42501');}
  await db.exec('RESET ROLE');
 });
 console.log(`${passed} documentary vet alias SQL checks passed. Real aliases require separately confirmed identity; none are included here.`);
} catch(error){console.error(error?.message||'Documentary vet alias SQL test failed');process.exitCode=1;}finally{await db.close();}
