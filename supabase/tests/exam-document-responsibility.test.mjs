import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {collectionFixtureDB} from './collection-db.fixture.mjs';

const {db,role,rpc}=await collectionFixtureDB();
const migration=await readFile(new URL('../migrations/20261018000012_exam_document_responsibility.sql',import.meta.url),'utf8');
const actor='10000000-0000-0000-0000-000000000001',stranger='10000000-0000-0000-0000-000000000002';
const vetA='30000000-0000-0000-0000-000000000001',vetB='30000000-0000-0000-0000-000000000002',inactive='30000000-0000-0000-0000-000000000003';
let sequence=0,passed=0;
const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
const check=async(name,fn)=>{await fn();console.log(`ok ${++passed} - ${name}`);};
const worker=async()=>{await role('service_role');await db.exec("SELECT set_config('request.jwt.claim.sub','',false)");};
const human=async(id=actor)=>{await role('authenticated');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id]);};
const doc=async id=>one('SELECT * FROM exam_document WHERE id=$1',[id]);
const responsible=async id=>one('SELECT * FROM exam_document_responsibility WHERE document_id=$1',[id]);
async function patient(){
 const id=crypto.randomUUID(),code='TUTOR-'+(++sequence),name='Pet '+sequence,tutor='Tutor Fixture '+sequence;
 await db.query('INSERT INTO clients("Código","Nome") VALUES($1,$2)',[code,tutor]);
 await db.query("INSERT INTO pets(id,client_code,name,species) VALUES($1,$2,$3,'Canina')",[id,code,name]);return{id,code,name,tutor};
}
async function save(){
 const serial=++sequence,source={channel:'email',account_id:'synthetic',message_id:'message-'+serial,attachment_id:'pdf',original_name:'synthetic.pdf',metadata:{exam_candidate:true}};
 const result=await rpc('reserve_exam_document_source',[JSON.stringify(source)]);
 const file={drive_file_id:'drive-'+result.document_id,drive_folder_id:'private-fixture',size_bytes:123,sha256:serial.toString(16).padStart(64,'0')};
 const staged=await rpc('stage_exam_document_file',[result.document_id,JSON.stringify(file),'test']);
 return(await rpc('confirm_exam_document_file',[staged.document_id,JSON.stringify(file),staged.lease_token])).document;
}
function extraction(p,{requester,crmv,requesterLabel='Veterinária solicitante',classification='exam'}={}){
 const fields={pet_name:p.name,client_name:p.tutor,exam_type:'Hemograma',exam_date:'2026-10-17'};
 if(requester)fields.requesting_vet_name=requester;if(crmv)fields.requesting_vet_crmv=crmv;
 return{classification,single_patient:true,fields,evidence:Object.entries(fields).map(([field,value])=>({field,page:1,excerpt:field==='requesting_vet_name'?`${requesterLabel}: ${value}`:field==='requesting_vet_crmv'?`${requesterLabel}: ${requester} — CRMV ${value}`:`${field}: ${value}`})),extractor_version:'synthetic-responsibility'};
}
async function process(document,data){
 const existing=await one("SELECT * FROM exam_document_delivery WHERE document_id=$1 AND destination='processing'",[document.id]);
 const task=existing.status==='reserved'?existing:(await rpc('reserve_exam_document_delivery',['processing','extractor',20])).tasks.find(t=>t.document_id===document.id);
 assert(task);await rpc('update_exam_document_extraction',[document.id,JSON.stringify({...data,delivery_id:task.id,lease_token:task.lease_token})]);
 await rpc('complete_exam_document_delivery',[task.id,task.lease_token,JSON.stringify({status:'completed'})]);return doc(document.id);
}
async function sale(p,{vet=vetA,trackingVet=vet,type='Hemograma',date='2026-10-16',received=false,cardVet=null,legacyNull=false}={}){
 const id=crypto.randomUUID();
 await db.query("INSERT INTO sales_header(id,pet_id,customer_id,veterinarian_id,sale_date,status) VALUES($1,$2,$3,$4,$5,'paid')",[id,p.id,p.code,vet,date]);
 await db.query("INSERT INTO exam_tracking(sale_id,pet_id,client_code,origin,veterinario_id,created_at) VALUES($1,$2,$3,'manual',$4,$5::date)",[id,p.id,p.code,trackingVet,date]);
 const c=await one("INSERT INTO exam_card(sale_id,pet_id,client_code,pet_name,client_name,status,origin,vet_name,vet_id) VALUES($1,$2,$3,$4,$5,'aguardando_lab','venda',$6,$7) RETURNING *",[id,legacyNull?null:p.id,legacyNull?null:p.code,p.name,p.tutor,vet===vetB?'Bruna Vieira':vet?'Alice Freitas':null,cardVet]);
 const i=await one('INSERT INTO exam_item(exam_card_id,exam_type,result_received) VALUES($1,$2,$3) RETURNING *',[c.id,type,received]);return{id,card:c,item:i};
}
async function assign(id,vet,version){
 await human();const current=await doc(id);const result=await rpc('set_exam_document_responsible_vet',[id,vet,version??current.version]);await worker();return result;
}
try{
 await db.exec('RESET ROLE');
 await db.exec(`ALTER TABLE veterinarios ADD COLUMN ativo boolean DEFAULT true,ADD COLUMN crmv text,ADD COLUMN avatar_url text;
 ALTER TABLE exam_card ADD COLUMN vet_id uuid REFERENCES veterinarios(id);
 ALTER TABLE exam_tracking ALTER COLUMN pet_id TYPE text USING pet_id::text;
 ALTER TABLE exam_tracking ALTER COLUMN veterinario_id TYPE text USING veterinario_id::text;
 ALTER TABLE exam_tracking ADD COLUMN created_at timestamptz DEFAULT now();
 CREATE TABLE sales_header(id uuid PRIMARY KEY,pet_id varchar,customer_id varchar,veterinarian_id varchar,sale_date date,status varchar);
 INSERT INTO auth.users(id) VALUES('${actor}'),('${stranger}');INSERT INTO exam_document_member(user_id,role) VALUES('${actor}','admin');
 INSERT INTO veterinarios(id,nome,crmv,ativo,avatar_url) VALUES('${vetA}','Alice Freitas','CRMV-SP 1234',true,'https://example.invalid/alice.jpg'),('${vetB}','Bruna Vieira','RJ 1234',true,NULL),('${inactive}','Inativa Fixture','SP 9000',false,NULL);`);
 for(const file of ['20261016000006_exam_operational_flow.sql','20261016000007_exam_clinical_group_eligibility.sql','20261016000008_exam_gmail_origin_identity.sql','20261016000009_exam_group_after_processing.sql','20261016000010_exam_group_without_identification.sql','20261016000011_exam_unique_patient_matching.sql'])await db.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
 await db.exec('GRANT ALL ON public.exam_card,public.exam_item,public.exam_card_log,public.sales_header,public.veterinarios,public.exam_tracking TO service_role');
 await worker();await db.exec("UPDATE exam_document_configuration SET ingestion_enabled=true,enabled_destinations=ARRAY['drive','processing','group','nexus'],notification_cutoff=now()-interval '1 day',group_destination_key='synthetic-group'");
 const untouched=await save(),beforeDoc=await doc(untouched.id);
 const columns=(await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='v_exam_documents' ORDER BY ordinal_position")).rows.map(x=>x.column_name);
 const config=await one('SELECT * FROM exam_document_configuration');
 await db.exec('RESET ROLE');await db.exec(migration);await worker();
 await check('migration preserves old documents, settings, member accounts and the exact original view column order',async()=>{
  assert.deepEqual(await doc(untouched.id),beforeDoc);assert.equal(await responsible(untouched.id),undefined);assert.deepEqual(await one('SELECT * FROM exam_document_configuration'),config);
  const after=(await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='v_exam_documents' ORDER BY ordinal_position")).rows.map(x=>x.column_name);
  assert.deepEqual(after.slice(0,columns.length),columns);assert.deepEqual(after.slice(columns.length),['responsible_vet_id','responsible_vet_name','responsible_vet_avatar_url','responsible_vet_source']);
  assert.equal(Number((await one('SELECT count(*) n FROM exam_document_member')).n),1);assert.equal(Number((await one('SELECT count(*) n FROM auth.users')).n),2);
 });
 await check('a member assigns an active clinical vet without any vet auth account, recording actor and bumping version once',async()=>{
  const d=await save(),result=await assign(d.id,vetB);assert.equal(result.responsible_vet_id,vetB);assert.equal(result.responsible_vet_name,'Bruna Vieira');assert.equal(result.responsible_vet_source,'manual');
  assert.equal(result.version,d.version+1);assert.equal((await responsible(d.id)).assigned_by,actor);assert.equal((await doc(d.id)).assigned_to,null);
  assert.equal(Number((await one('SELECT count(*) n FROM exam_document_member')).n),1);
  const repeat=await assign(d.id,vetB);assert.equal(repeat.version,result.version);
  assert.equal((await one('SELECT contact_status FROM v_exam_documents WHERE id=$1',[d.id])).contact_status,'assigned');
 });
 await check('manual RPC enforces expected version, active vet and membership; the side table is not publicly writable',async()=>{
  const d=await save();await human();
  await assert.rejects(()=>rpc('set_exam_document_responsible_vet',[d.id,vetA,0]),e=>e.code==='40001');
  for(const id of [inactive,crypto.randomUUID()])await assert.rejects(()=>rpc('set_exam_document_responsible_vet',[d.id,id,d.version]),e=>e.code==='22023');
  await assert.rejects(()=>db.query("INSERT INTO exam_document_responsibility(document_id,veterinarian_id,source,assigned_by) VALUES($1,$2,'manual',$3)",[d.id,vetA,actor]));
  await human(stranger);await assert.rejects(()=>rpc('set_exam_document_responsible_vet',[d.id,vetA,d.version]),e=>e.code==='42501');
  assert.equal((await db.query('SELECT * FROM exam_document_responsibility')).rows.length,0);
  await role('anon');await assert.rejects(()=>db.query('SELECT * FROM exam_document_responsibility'));
  await worker();assert.equal(await responsible(d.id),undefined);
 });
 await check('PDF requester evidence resolves an exact unique clinical vet; signer text never resolves a requester',async()=>{
  const p=await patient(),d=await process(await save(),extraction(p,{requester:'Dra. Alice Freitas'}));
  assert.equal((await responsible(d.id)).veterinarian_id,vetA);assert.equal((await responsible(d.id)).source,'pdf');
  const other=await process(await save(),extraction(await patient(),{requester:'Alice Freitas',requesterLabel:'Laudo assinado por'}));assert.equal(await responsible(other.id),undefined);
 });
 await check('manual assignment and explicit manual null survive later extraction and automatic patient linkage',async()=>{
  for(const vet of [vetB,null]){
   const p=await patient(),d=await save();await assign(d.id,vet);const fresh=await process(d,extraction(p,{requester:'Alice Freitas'}));
   const r=await responsible(d.id);assert.equal(r.source,'manual');assert.equal(r.veterinarian_id,vet);assert.equal(r.assigned_by,actor);assert.equal(fresh.pet_id,p.id);
   const c=await one('SELECT c.* FROM exam_document_item di JOIN exam_item i ON i.id=di.exam_item_id JOIN exam_card c ON c.id=i.exam_card_id WHERE di.document_id=$1',[d.id]);
   assert.equal(c.vet_id,vet);assert.equal(c.vet_name,vet?'Bruna Vieira':null);
   const log=await one("SELECT * FROM exam_card_log WHERE exam_card_id=$1 AND change_reason LIKE 'Responsável operacional%' ORDER BY created_at DESC LIMIT 1",[c.id]);
   if(vet)assert.equal(log.changed_by,actor);
  }
 });
 await check('old bridge cards with null patient fields reuse the proven header; tracking alone requires exact real IDs and request timing',async()=>{
  const p=await patient(),s=await sale(p,{legacyNull:true}),d=await process(await save(),extraction(p));
  assert.equal((await one('SELECT exam_item_id FROM exam_document_item WHERE document_id=$1',[d.id])).exam_item_id,s.item.id);
  assert.equal((await one('SELECT pet_id FROM exam_card WHERE id=$1',[s.card.id])).pet_id,p.id);
  for(const mismatch of [false,true]){
   const other=await patient(),s=await sale(other,{legacyNull:true});await db.query('DELETE FROM sales_header WHERE id=$1',[s.id]);
   await db.query("UPDATE exam_tracking SET origin='venda',client_code=$2 WHERE sale_id=$1",[s.id,mismatch?'DIFFERENT':other.code]);
   const d=await process(await save(),extraction(other));
   const linked=await one('SELECT c.sale_id FROM exam_document_item di JOIN exam_item i ON i.id=di.exam_item_id JOIN exam_card c ON c.id=i.exam_card_id WHERE di.document_id=$1',[d.id]);
   assert.equal(linked.sale_id,mismatch?null:s.id);assert.equal((await responsible(d.id))?.veterinarian_id,mismatch?undefined:vetA);
  }
 });
 await check('header, proven tracking and persisted card veterinarian divergence is a conflict instead of a silent priority override',async()=>{
  for(const variant of ['tracking','card','invalid-text']){
   const p=await patient(),s=await sale(p,{trackingVet:variant==='tracking'?vetB:variant==='invalid-text'?'not-a-uuid':vetA,cardVet:variant==='card'?vetB:null});
   await db.query("UPDATE exam_tracking SET origin='venda' WHERE sale_id=$1",[s.id]);
   const d=await process(await save(),extraction(p));assert.equal((await responsible(d.id)).source,'conflict');assert.equal((await responsible(d.id)).veterinarian_id,null);
   assert.equal((await one('SELECT veterinarian_id FROM sales_header WHERE id=$1',[s.id])).veterinarian_id,vetA);
  }
 });
 await check('future PDF dates never consume a real pending sale and confirmed exam fields have precedence over extracted ones',async()=>{
  const p=await patient(),s=await sale(p),d=await save();await db.query("UPDATE exam_document SET received_at='2026-10-16T12:00:00Z' WHERE id=$1",[d.id]);
  const result=await process(d,extraction(p));assert.equal((await one('SELECT result_received FROM exam_item WHERE id=$1',[s.item.id])).result_received,false);
  assert.equal(await responsible(result.id),undefined);
  const other=await patient(),pending=await sale(other),saved=await save();
  await db.query("UPDATE exam_document SET confirmed_data=$2 WHERE id=$1",[saved.id,JSON.stringify({exam_type:'Perfil renal',exam_date:'2026-10-17'})]);
  await db.exec('RESET ROLE');assert.deepEqual(await rpc('pending_exam_document_sale_items',[saved.id,other.id,JSON.stringify(extraction(other).fields)]),[]);await worker();
  assert.equal((await one('SELECT result_received FROM exam_item WHERE id=$1',[pending.item.id])).result_received,false);
 });
 await check('requester label must directly qualify the name; qualified CRMV disambiguates an exact same-name directory entry',async()=>{
  for(const label of ['Requisitante','Solicitado por']){
   const d=await process(await save(),extraction(await patient(),{requester:'Alice Freitas',requesterLabel:label}));assert.equal((await responsible(d.id)).veterinarian_id,vetA);
  }
  const incorrect=extraction(await patient(),{requester:'Alice Freitas'});incorrect.evidence.find(e=>e.field==='requesting_vet_name').excerpt='Solicitante: Bruna Vieira; Laudo assinado por Alice Freitas';
  const d=await process(await save(),incorrect);assert.equal(await responsible(d.id),undefined);
  const duplicate='30000000-0000-0000-0000-000000000099';await db.query("INSERT INTO veterinarios(id,nome,crmv,ativo) VALUES($1,'Alice Freitas','RJ 4455',true)",[duplicate]);
  for(const [crmv,expected] of [['SP 1234',vetA],['1234',null],['RJ 1234',null]]){
   const d=await process(await save(),extraction(await patient(),{requester:'Alice Freitas',crmv}));assert.equal((await responsible(d.id)).veterinarian_id,expected);
  }
  for(const unrelated of ['Responsável técnico','Signatário']){
   const data=extraction(await patient(),{requester:'Alice Freitas',crmv:'SP 1234'});
   data.evidence.find(e=>e.field==='requesting_vet_crmv').excerpt=`Solicitante: Alice Freitas; ${unrelated}: CRMV SP 1234`;
   const d=await process(await save(),data);assert.equal((await responsible(d.id)).source,'conflict');assert.equal((await responsible(d.id)).veterinarian_id,null);
  }
  await db.query('DELETE FROM veterinarios WHERE id=$1',[duplicate]);
 });
 await check('automatic real-item selection is volatile, locks the pending item and rechecks eligibility before returning it',async()=>{
  const fn=await one("SELECT provolatile,pg_get_functiondef(oid) definition FROM pg_proc WHERE oid='public.unique_exam_document_sale_items(uuid,uuid,jsonb)'::regprocedure");
  assert.equal(fn.provolatile,'v');assert.match(fn.definition,/FOR UPDATE/);assert.equal((fn.definition.match(/pending_exam_document_sale_items/g)||[]).length,2);
  const p=await patient(),s=await sale(p);const first=await process(await save(),extraction(p)),second=await process(await save(),extraction(p));
  const firstItem=await one('SELECT exam_item_id FROM exam_document_item WHERE document_id=$1',[first.id]);
  const secondItem=await one('SELECT exam_item_id FROM exam_document_item WHERE document_id=$1',[second.id]);
  assert.equal(firstItem.exam_item_id,s.item.id);assert.notEqual(secondItem.exam_item_id,s.item.id);
 });
 await check('removed requester evidence clears automatic ownership and its own CRM value without using that card as self-evidence',async()=>{
  const p=await patient(),d=await process(await save(),extraction(p,{requester:'Alice Freitas'}));
  const card=await one('SELECT c.* FROM exam_document_item di JOIN exam_item i ON i.id=di.exam_item_id JOIN exam_card c ON c.id=i.exam_card_id WHERE di.document_id=$1',[d.id]);
  assert.equal(card.vet_id,vetA);assert.equal(card.vet_name,'Alice Freitas');
  await db.query('UPDATE exam_document SET extracted_data=$2,evidence=$3 WHERE id=$1',[d.id,JSON.stringify(extraction(p).fields),JSON.stringify(extraction(p).evidence)]);
  assert.equal(await responsible(d.id),undefined);assert.equal((await one('SELECT vet_id FROM exam_card WHERE id=$1',[card.id])).vet_id,null);
  assert.equal((await one('SELECT contact_status FROM v_exam_documents WHERE id=$1',[d.id])).contact_status,'pending');
 });
 await check('one shared CRM card cannot overwrite another document manual owner; manual-before-link retains actor and sale history',async()=>{
  const p=await patient(),s=await sale(p),first=await process(await save(),extraction(p));await assign(first.id,vetA);
  const d=await save();await assign(d.id,vetB);await human();
  await assert.rejects(()=>rpc('confirm_exam_document_link',[d.id,p.id,[s.item.id],(d.version+1),JSON.stringify(extraction(p).fields)]),e=>e.code==='23514'&&/compartilhado/.test(e.message));
  await worker();assert.equal((await doc(d.id)).pet_id,null);assert.equal((await one('SELECT vet_id FROM exam_card WHERE id=$1',[s.card.id])).vet_id,vetA);
  const other=await patient(),sale2=await sale(other),pending=await save();await assign(pending.id,vetB);await human();
  await rpc('confirm_exam_document_link',[pending.id,other.id,[sale2.item.id],(pending.version+1),JSON.stringify(extraction(other).fields)]);await worker();
  assert.equal((await one('SELECT vet_id FROM exam_card WHERE id=$1',[sale2.card.id])).vet_id,vetB);
  assert.equal((await one('SELECT veterinarian_id FROM sales_header WHERE id=$1',[sale2.id])).veterinarian_id,vetA);
  assert.equal((await responsible(pending.id)).details.card_original_vets[0].vet_name,'Alice Freitas');
 });
 await check('one exact unreceived sale item links to the real card and inherits its sale veterinarian',async()=>{
  const p=await patient(),s=await sale(p),d=await process(await save(),extraction(p));
  const links=(await db.query('SELECT * FROM exam_document_item WHERE document_id=$1',[d.id])).rows;
  assert.equal(links.length,1);assert.equal(links[0].exam_item_id,s.item.id);assert.equal((await responsible(d.id)).veterinarian_id,vetA);assert.equal((await responsible(d.id)).source,'sale');
  assert.equal(Number((await one('SELECT count(*) n FROM exam_card WHERE pet_id=$1',[p.id])).n),1);
 });
 await check('concordant PDF/sale resolves jointly; divergent confirmed sources remain conflict with no owner',async()=>{
  for(const [requester,expected] of [['Alice Freitas','pdf_sale'],['Bruna Vieira','conflict']]){
   const p=await patient();await sale(p);const d=await process(await save(),extraction(p,{requester}));const r=await responsible(d.id);
   assert.equal(r.source,expected);assert.equal(r.veterinarian_id,expected==='conflict'?null:vetA);
  }
 });
 await check('ambiguous pending items, fuzzy exam names and future sales never choose a latest sale',async()=>{
  const p=await patient();await sale(p,{vet:vetA});await sale(p,{vet:vetB});const d=await process(await save(),extraction(p));
  assert.equal((await responsible(d.id)).source,'conflict');
  const linked=await one('SELECT c.sale_id FROM exam_document_item di JOIN exam_item i ON i.id=di.exam_item_id JOIN exam_card c ON c.id=i.exam_card_id WHERE di.document_id=$1',[d.id]);assert.equal(linked.sale_id,null);
  for(const options of [{type:'Hemograma completo'},{date:'2026-10-19'},{received:true}]){
   const other=await patient();const s=await sale(other,options),result=await process(await save(),extraction(other));
   assert.equal(await responsible(result.id),undefined);assert.equal((await one('SELECT result_received FROM exam_item WHERE id=$1',[s.item.id])).result_received,options.received??false);
  }
 });
 await check('manual clinical reassignment synchronizes linked CRM cards while retaining original sale vet and an audit snapshot',async()=>{
  const p=await patient(),s=await sale(p),d=await process(await save(),extraction(p));await assign(d.id,vetB);
  const card=await one('SELECT * FROM exam_card WHERE id=$1',[s.card.id]);assert.equal(card.vet_id,vetB);assert.equal(card.vet_name,'Bruna Vieira');
  assert.equal((await one('SELECT veterinarian_id FROM sales_header WHERE id=$1',[s.id])).veterinarian_id,vetA);
  assert.equal((await responsible(d.id)).details.card_original_vets[0].vet_name,'Alice Freitas');
 });
 await check('a stale card veterinarian ID cannot hide a different name selected by the legacy CRM',async()=>{
  const p=await patient(),s=await sale(p);
  await db.query('UPDATE exam_card SET vet_name=$1 WHERE id=$2',['Bruna Vieira',s.card.id]);
  const d=await process(await save(),extraction(p)),r=await responsible(d.id);
  assert.equal(r.source,'conflict');assert.equal(r.veterinarian_id,null);
  assert.equal((await one('SELECT veterinarian_id FROM sales_header WHERE id=$1',[s.id])).veterinarian_id,vetA);
 });
 await check('manual patient/item linkage triggers sale inference and initial group tasks include resolved vet fields without resetting past deliveries',async()=>{
  const p=await patient(),s=await sale(p),d=await save();await human();
  await rpc('confirm_exam_document_link',[d.id,p.id,[s.item.id],d.version,JSON.stringify(extraction(p).fields)]);await worker();
  assert.equal((await responsible(d.id)).veterinarian_id,vetA);
  await db.query("UPDATE exam_document_delivery SET next_attempt_at=now()+interval '1 day' WHERE destination='group' AND document_id<>$1",[d.id]);
  await db.query("UPDATE exam_document_delivery SET created_at=now()-interval '6 minutes' WHERE destination='group' AND document_id=$1",[d.id]);
  const task=(await rpc('reserve_exam_document_delivery',['group','notification',20])).tasks.find(t=>t.document_id===d.id);
  assert(task);assert.equal(task.document.responsible_vet_id,vetA);assert.equal(task.document.responsible_vet_name,'Alice Freitas');
  const before=await one('SELECT status,attempts FROM exam_document_delivery WHERE id=$1',[task.id]);await assign(d.id,vetB);
  assert.deepEqual(await one('SELECT status,attempts FROM exam_document_delivery WHERE id=$1',[task.id]),before);
 });
 console.log(`# ${passed} responsibility checks passed`);
}finally{await db.close();}
