// Actual migration SQL on isolated PostgreSQL/PGlite. No clinical/provider I/O.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectionFixtureDB} from './collection-db.fixture.mjs';

const dir=await mkdtemp(join(tmpdir(),'exam-summary-'));
let {db,role,rpc}=await collectionFixtureDB({dataDir:dir});
const actor='10000000-0000-0000-0000-000000000001',vet='30000000-0000-0000-0000-000000000001';
let serial=0,passed=0,currentDestination='';
const hash='a'.repeat(64);
const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
const check=async(name,fn)=>{await fn();console.log(`ok ${++passed} - ${name}`);};
async function clock(value){
  assert.match(value,/^2026-10-[0-9]{2}T[0-9:.]+Z$/);
  await db.exec('RESET ROLE');
  await db.exec(`CREATE OR REPLACE FUNCTION public.exam_pending_summary_clock() RETURNS timestamptz LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$ SELECT '${value}'::timestamptz $$`);
  await role('service_role');
}
async function configure(key){currentDestination=key;await db.query("UPDATE exam_document_configuration SET group_destination_key=$1,enabled_destinations=ARRAY['group','drive','processing']",[key]);}
const preview=()=>rpc('preview_exam_pending_summary',[]);
const reserve=worker=>rpc('reserve_exam_pending_summary',[worker||'fixture-worker']);
const begin=(r,extra={})=>rpc('begin_exam_pending_summary',[r.summary_id,extra.token??r.lease_token,extra.destination??r.destination_key,extra.hash??hash,extra.characters??100]);
const result=(r,status,extra={})=>rpc('record_exam_pending_summary_result',[r.summary_id,r.lease_token,JSON.stringify({status,content_sha256:hash,...extra})]);
async function document(options={}){
  const n=++serial,id=options.id??crypto.randomUUID(),fields={pet_name:'Pet Fixture '+n,client_name:'Tutor Fixture '+n,exam_type:'Hemograma'};
  await db.query(`INSERT INTO exam_document(id,original_name,file_status,sha256,size_bytes,drive_file_id,extracted_data,confirmed_data,
    pet_id,previous_document_id,canonical_document_id,identification_status,link_method,link_confirmed_at,assigned_to,group_exception_reason)
    VALUES($1,$2,$3,$4,123,$5,$6,$7,$8,$9,$10,$11,'automatic',CASE WHEN $11='confirmed' THEN now() END,$12,$13)`,
  [id,options.name??'resultado-'+n+'.pdf',options.fileStatus??'saved',n.toString(16).padStart(64,'0'),'file-'+n,
    JSON.stringify({...fields,...options.fields}),JSON.stringify(options.confirmed??{}),options.pet??null,options.previous??null,options.canonical??null,
    options.identification??'unidentified',options.assignedTo??null,options.exception??null]);
  if(options.source)await db.query("INSERT INTO exam_document_source(document_id,channel,account_id,message_id,attachment_id,metadata) VALUES($1,'email','fixture',$2,'pdf',$3)",[id,'message-'+n,JSON.stringify(options.source)]);
  if(options.event)await db.query('INSERT INTO exam_document_event(document_id,event_type) VALUES($1,$2)',[id,options.event]);
  if(options.sent!==false)await db.query(`INSERT INTO exam_document_delivery(document_id,destination,destination_key,status,sent_at,external_id)
    VALUES($1,'group',$2,$3,$4,$5)`,[id,options.destination??currentDestination,options.status??'sent',options.sentAt===null?null:(options.sentAt??'2026-10-16T12:00:00Z'),options.externalId===null?null:String(n)]);
  return id;
}
async function item(id,{contacted=false}={}){
  const card=await one("INSERT INTO exam_card(pet_name,client_name,status,origin) VALUES('Pet Fixture','Tutor Fixture','exame_pronto','manual') RETURNING id");
  const i=await one("INSERT INTO exam_item(exam_card_id,exam_type,result_received) VALUES($1,'Hemograma',true) RETURNING id",[card.id]);
  await db.query(`INSERT INTO exam_document_item(document_id,exam_item_id,confirmation_method,confirmed_by,contacted_by,contacted_at,contact_note)
    VALUES($1,$2,'automatic',NULL,$3,$4,$5)`,[id,i.id,contacted?actor:null,contacted?'2026-10-17T13:00:00Z':null,contacted?'Contato fixture':null]);
  return i.id;
}

try{
  await db.exec('RESET ROLE');
  await db.exec(`ALTER TABLE veterinarios ADD COLUMN ativo boolean DEFAULT true,ADD COLUMN crmv text,ADD COLUMN avatar_url text;
    ALTER TABLE exam_card ADD COLUMN vet_id uuid REFERENCES veterinarios(id);
    ALTER TABLE exam_tracking ALTER COLUMN pet_id TYPE text USING pet_id::text;
    ALTER TABLE exam_tracking ALTER COLUMN veterinario_id TYPE text USING veterinario_id::text;
    ALTER TABLE exam_tracking ADD COLUMN created_at timestamptz DEFAULT now();
    CREATE TABLE sales_header(id uuid PRIMARY KEY,pet_id varchar,customer_id varchar,veterinarian_id varchar,sale_date date,status varchar);
    INSERT INTO auth.users(id) VALUES('${actor}');
    INSERT INTO veterinarios(id,nome,ativo) VALUES('${vet}','Vet Clínica Fixture',true);`);
  for(const file of ['20261016000006_exam_operational_flow.sql','20261016000007_exam_clinical_group_eligibility.sql',
    '20261016000008_exam_gmail_origin_identity.sql','20261016000009_exam_group_after_processing.sql','20261016000010_exam_group_without_identification.sql',
    '20261016000011_exam_unique_patient_matching.sql','20261018000012_exam_document_responsibility.sql'])
    await db.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
  await db.exec('GRANT ALL ON public.exam_card,public.exam_item,public.exam_card_log,public.sales_header,public.veterinarios,public.exam_tracking TO service_role');
  await role('service_role');await db.exec('UPDATE exam_document_configuration SET ingestion_enabled=true');
  const oldConfig=await one('SELECT * FROM exam_document_configuration');
  await db.exec('RESET ROLE');await db.exec(await readFile(new URL('../migrations/20261018000013_exam_pending_summary.sql',import.meta.url),'utf8'));await role('service_role');

  await check('installation is additive and starts with an empty ledger without changing configuration',async()=>{
    assert.deepEqual(await one('SELECT * FROM exam_document_configuration'),oldConfig);
    assert.equal(Number((await one('SELECT count(*) n FROM exam_pending_summary')).n),0);
  });
  await check('anon and authenticated cannot read tables, helpers, preview or worker transitions',async()=>{
    for(const r of ['anon','authenticated']){
      await role(r);
      for(const table of ['exam_pending_summary','exam_pending_summary_event'])await assert.rejects(()=>db.query('SELECT * FROM '+table),e=>e.code==='42501');
      for(const [name,args] of [['preview_exam_pending_summary',[]],['reserve_exam_pending_summary',['x']],['exam_pending_summary_clock',[]],
        ['exam_pending_summary_snapshot',['2026-10-18T11:00:00Z','fixture']],['begin_exam_pending_summary',[actor,actor,'x',hash,10]],['record_exam_pending_summary_result',[actor,actor,'{}']]])
        await assert.rejects(()=>rpc(name,args),e=>e.code==='42501');
    }await role('service_role');
  });
  await check('preview outside the send window is complete and causes no ledger or clinical writes',async()=>{
    await clock('2026-10-18T01:00:00Z');await configure('preview');const id=await document();
    const before=await one('SELECT * FROM exam_document WHERE id=$1',[id]);const p=await preview();
    assert.equal(p.total,1);assert.equal(p.preview,true);assert.equal(p.claimed,false);assert.equal(p.dispatch_allowed,false);assert.equal(p.has_more,false);
    assert.equal(p.day,'2026-10-17');assert.equal(p.documents[0].document_id,id);
    assert.equal(Number((await one('SELECT count(*) n FROM exam_pending_summary')).n),0);assert.deepEqual(await one('SELECT * FROM exam_document WHERE id=$1',[id]),before);
  });
  await check('server clock enforces 08:00 inclusive to 09:00 exclusive and accepts weekends',async()=>{
    await configure('weekend');await document();
    for(const t of ['2026-10-17T10:59:59Z','2026-10-17T12:00:00Z']){await clock(t);assert.equal((await reserve()).reason,'OUTSIDE_DAILY_WINDOW');}
    await clock('2026-10-17T11:00:00Z');assert.equal((await reserve()).claimed,true); // Saturday
    await clock('2026-10-18T11:00:00Z');assert.equal((await reserve()).claimed,true); // Sunday, separate day
  });
  await check('paused/missing group configuration never reserves a day',async()=>{
    await configure('paused');await db.query("UPDATE exam_document_configuration SET enabled_destinations='{}'");
    assert.equal((await reserve()).reason,'GROUP_CONFIGURATION_PAUSED');assert.equal(Number((await one("SELECT count(*) n FROM exam_pending_summary WHERE destination_key='paused'")).n),0);
    await configure('');assert.equal((await reserve()).reason,'GROUP_CONFIGURATION_PAUSED');
  });
  await check('two competing reserve requests yield one grant and the same durable day/destination identity',async()=>{
    await configure('concurrent');await document();const rs=await Promise.all([reserve('worker-a'),reserve('worker-b')]);
    assert.equal(rs.filter(r=>r.claimed).length,1);assert.equal(rs[0].summary_id,rs[1].summary_id);
    assert.equal(Number((await one("SELECT count(*) n FROM exam_pending_summary WHERE destination_key='concurrent'")).n),1);
  });
  await check('empty snapshot consumes the day without issuing any dispatch lease',async()=>{
    await configure('empty');const r=await reserve();assert.equal(r.claimed,false);assert.equal(r.status,'empty');assert.equal(r.total,0);assert.equal(r.lease_token,null);
    await document();assert.equal((await reserve()).claimed,false);assert.equal((await reserve()).status,'empty');
    assert.equal(Number((await one("SELECT count(*) n FROM exam_pending_summary_event WHERE summary_id=$1",[r.summary_id])).n),1);
  });
  await check('only a reservation which never began dispatch may be reclaimed after lease expiry with a new token/snapshot',async()=>{
    await configure('reclaim');const id=await document(),r=await reserve();await item(id,{contacted:true});
    await clock('2026-10-18T11:03:00Z');const later=await reserve('new-worker');assert.equal(later.summary_id,r.summary_id);assert.equal(later.status,'empty');
    await assert.rejects(()=>begin(r),e=>e.code==='40001');
  });
  await check('begin requires current destination, a nonexpired lease and a bounded nonempty content commitment',async()=>{
    await configure('guards');await document();const r=await reserve();
    for(const extra of [{token:null},{token:crypto.randomUUID()},{hash:'bad'},{hash:null},{characters:0},{characters:12001},{destination:'wrong'}]){
      if(extra.token===null)await assert.rejects(()=>rpc('begin_exam_pending_summary',[r.summary_id,null,r.destination_key,hash,100]),e=>e.code==='40001');
      else if(extra.hash===null)await assert.rejects(()=>rpc('begin_exam_pending_summary',[r.summary_id,r.lease_token,r.destination_key,null,100]),e=>e.code==='22023');
      else await assert.rejects(()=>begin(r,extra));
    }
    await configure('changed');await assert.rejects(()=>begin(r),e=>e.message==='SUMMARY_DESTINATION_CHANGED');
    await configure('guards');await clock('2026-10-18T11:05:00Z');await assert.rejects(()=>begin(r),e=>e.code==='40001');
  });
  let irreversible;
  await check('dispatch permission is committed once before POST, including concurrent/repeated begin and lost acknowledgements',async()=>{
    await configure('single-dispatch');await document();irreversible=await reserve();
    const replies=await Promise.all([begin(irreversible),begin(irreversible)]);assert.equal(replies.filter(x=>x.dispatch_allowed).length,1);
    assert.equal((await begin(irreversible)).dispatch_allowed,false);
    const row=await one('SELECT * FROM exam_pending_summary WHERE id=$1',[irreversible.summary_id]);assert.equal(row.status,'started');assert.ok(row.submit_started_at);assert.equal(row.content_sha256,hash);
    assert.equal(Number((await one("SELECT count(*) n FROM exam_pending_summary_event WHERE summary_id=$1 AND event_type='submit_started'",[row.id])).n),1);
  });
  await check('a started operation survives process close/reopen and cannot acquire another lease after expiry',async()=>{
    await db.close();({db,role,rpc}=await collectionFixtureDB({dataDir:dir,initialize:false}));
    await clock('2026-10-18T11:10:00Z');const repeated=await reserve('after-restart');assert.equal(repeated.claimed,false);assert.equal(repeated.status,'started');
    assert.equal((await begin(irreversible)).dispatch_allowed,false);
  });
  await check('uncertain late result keeps HOLD even after new reserve attempts and sanitizes provider errors',async()=>{
    const r=await result(irreversible,'uncertain',{error_code:'https://signed.invalid/?SYNTHETIC_SECRET'});assert.equal(r.retry_allowed,false);
    const row=await one('SELECT * FROM exam_pending_summary WHERE id=$1',[irreversible.summary_id]);assert.equal(row.status,'uncertain');assert.equal(row.last_error_code,'SUMMARY_WORKER_ERROR');
    assert.equal((await reserve()).claimed,false);assert.equal((await begin(irreversible)).dispatch_allowed,false);
    const events=JSON.stringify((await db.query('SELECT details FROM exam_pending_summary_event WHERE summary_id=$1',[row.id])).rows);assert(!events.includes('SYNTHETIC_SECRET'));assert(!events.includes('signed.invalid'));
  });
  await check('late created/sent acknowledgment records one immutable ID but does not claim WhatsApp delivery',async()=>{
    await result(irreversible,'created',{external_id:'9001',external_status:'sent'});
    assert.equal((await one('SELECT status FROM exam_pending_summary WHERE id=$1',[irreversible.summary_id])).status,'submitted');
    await result(irreversible,'sent',{external_id:'9001',external_status:'sent'});
    await assert.rejects(()=>result(irreversible,'created',{external_id:'9002'}),e=>e.code==='40001');
    assert.equal((await reserve()).claimed,false);
  });
  await check('result fencing requires token/hash and explicit delivery proof; delivered/read never downgrade',async()=>{
    await assert.rejects(()=>result(irreversible,'delivered',{external_id:'9001'}),e=>e.message==='SUMMARY_DELIVERY_EVIDENCE_REQUIRED');
    await assert.rejects(()=>result(irreversible,'read',{external_id:'9001',content_sha256:'b'.repeat(64)}),e=>e.code==='40001');
    await assert.rejects(()=>rpc('record_exam_pending_summary_result',[irreversible.summary_id,null,JSON.stringify({status:'uncertain',content_sha256:hash})]),e=>e.code==='40001');
    await result(irreversible,'delivered',{external_id:'9001',external_status:'delivered'});const first=await one('SELECT sent_at FROM exam_pending_summary WHERE id=$1',[irreversible.summary_id]);
    await result(irreversible,'failed',{external_id:'9001',external_status:'failed'});await result(irreversible,'read',{external_id:'9001',external_status:'read'});
    const row=await one('SELECT * FROM exam_pending_summary WHERE id=$1',[irreversible.summary_id]);assert.equal(row.status,'sent');assert.deepEqual(row.sent_at,first.sent_at);assert.equal(row.external_status,'delivered');
  });
  await check('failed creation/provider outcome is terminal for POST even without an external ID',async()=>{
    await configure('failure');await document();const r=await reserve();await begin(r);await result(r,'failed',{error_code:'SUMMARY_POST_FAILED'});
    await clock('2026-10-18T11:15:00Z');assert.equal((await reserve()).claimed,false);assert.equal((await begin(r)).dispatch_allowed,false);
  });
  await check('send window also applies at begin, while a late result can be recorded after 09h',async()=>{
    await clock('2026-10-18T11:59:30Z');await configure('late-begin');await document();const r=await reserve();
    await clock('2026-10-18T12:00:00Z');await assert.rejects(()=>begin(r),e=>e.code==='40001');
    const acknowledged=await result(irreversible,'read',{external_id:'9001',external_status:'read'});assert.equal(acknowledged.status,'sent');
  });
  await check('filter requires real SENT evidence in the configured group and ages from its first sent_at',async()=>{
    await configure('filter-evidence');const good=await document({sentAt:'2026-10-17T11:00:00Z'});
    for(const options of [{sent:false},{status:'submitted'},{status:'uncertain'},{externalId:null},{sentAt:null},{destination:'another-group'},{sentAt:'2026-10-19T11:00:00Z'}])await document(options);
    await db.query("INSERT INTO exam_document_delivery(document_id,destination,destination_key,status,sent_at,external_id) VALUES($1,'group','ancient-group','sent','2026-10-01T12:00:00Z','12345')",[good]);
    const p=await preview();assert.equal(p.total,1);assert.equal(p.documents[0].document_id,good);assert.equal(p.documents[0].age_seconds,90000);assert.equal(new Date(p.documents[0].first_group_sent_at).toISOString(),'2026-10-17T11:00:00.000Z');
  });
  await check('canonical, rejected, waived and explicitly flagged fixtures stay excluded without a broad teste-name filter',async()=>{
    await configure('filter-fixtures');const good=await document({name:'Exame de teste de supressão.pdf'});
    await document({fileStatus:'pending'});await document({identification:'not_exam'});await document({exception:'dispensa fixture'});await document({canonical:good});
    await document({id:'595e61de-fb0b-4cda-86bf-ebdce543b6fc'});await document({name:'PAMVET_TESTE_EX26_renome.pdf'});
    for(const key of ['test_fixture','synthetic_fixture','homologation_fixture','is_test','fixture','synthetic'])await document({source:{[key]:true}});
    await document({source:{subject:'PAMVET-TESTE-EX99-pdf'}});
    for(const event of ['homologation_fixture_preseeded','synthetic_fixture_created'])await document({event});
    assert.deepEqual((await preview()).documents.map(d=>d.document_id),[good]);
  });
  await check('contact uses per-document evidence: no item or any open item qualifies, all contacted does not',async()=>{
    await configure('filter-contact');const noItems=await document(),partial=await document(),done=await document();
    await item(partial,{contacted:true});const pendingId=await item(partial);await item(done,{contacted:true});
    const p=await preview();assert.equal(p.total,2);assert(p.documents.some(d=>d.document_id===noItems));
    const d=p.documents.find(d=>d.document_id===partial);assert.equal(d.item_count,2);assert.equal(d.pending_item_count,1);assert.deepEqual(d.pending_item_ids,[pendingId]);
  });
  await check('a correction suppresses its predecessor only after same-patient confirmation and SENT in this destination',async()=>{
    await configure('filter-correction');const pet=crypto.randomUUID(),otherPet=crypto.randomUUID();
    await db.query("INSERT INTO pets(id,name) VALUES($1,'Pet Correction'),($2,'Other Pet')",[pet,otherPet]);
    const kept=[];
    for(const variant of ['same-sent','unconfirmed','not-sent','other-group','other-patient']){
      const original=await document({pet});const replacement=await document({previous:original,pet:variant==='other-patient'?otherPet:pet,
        identification:variant==='unconfirmed'?'unidentified':'confirmed',sent:variant!=='not-sent',destination:variant==='other-group'?'different':currentDestination});
      if(variant!=='same-sent')kept.push(original);
      assert.ok(replacement);
    }
    const ids=(await preview()).documents.map(d=>d.document_id);for(const id of kept)assert(ids.includes(id));assert.equal(ids.length,7);
  });
  await check('clinical vet side-table is authoritative; assigned_to is never a veterinarian, conflict and blank names stay unassigned',async()=>{
    await configure('filter-vet');const linked=await document(),loginOnly=await document({assignedTo:actor}),conflict=await document();
    await db.query("INSERT INTO exam_document_responsibility(document_id,veterinarian_id,source) VALUES($1,$2,'pdf'),($3,NULL,'conflict')",[linked,vet,conflict]);
    const p=await preview(),byId=Object.fromEntries(p.documents.map(d=>[d.document_id,d]));assert.equal(byId[linked].responsible_vet_id,vet);assert.equal(byId[linked].responsible_vet_name,'Vet Clínica Fixture');
    assert.equal(byId[loginOnly].responsible_vet_id,null);assert.equal(byId[conflict].responsible_vet_id,null);
    await db.query("UPDATE exam_document SET extracted_data=extracted_data||'{\"client_name\":\"Extraction\"}',confirmed_data='{\"client_name\":null}' WHERE id=$1",[loginOnly]);
    assert.equal((await preview()).documents.find(d=>d.document_id===loginOnly).client_name,null);
  });
  await check('more than 200 documents explicitly blocks the whole day and never yields a partial sendable list',async()=>{
    await configure('overflow');for(let i=0;i<201;i++)await document();
    const p=await preview();assert.equal(p.total,201);assert.equal(p.has_more,true);assert.deepEqual(p.documents,[]);
    await clock('2026-10-18T11:20:00Z');const r=await reserve();assert.equal(r.claimed,false);assert.equal(r.status,'blocked');assert.equal(r.reason,'SUMMARY_DOCUMENT_LIMIT_EXCEEDED');
    assert.equal((await reserve()).claimed,false);
  });
  await check('summary actions do not change original exam delivery/contact records',async()=>{
    const noPost=(await db.query("SELECT * FROM exam_pending_summary WHERE status IN ('empty','blocked')")).rows;
    for(const r of noPost)assert.equal(r.submit_started_at,null);
    assert.equal(Number((await one("SELECT count(*) n FROM exam_document_event WHERE event_type LIKE 'pending_summary%'")).n),0);
    assert.equal(Number((await one("SELECT count(*) n FROM exam_document_delivery WHERE destination NOT IN ('drive','processing','group','nexus')")).n),0);
  });
  console.log(`# ${passed} pending-summary SQL checks passed; PGlite serializes concurrent query requests.`);
}finally{await db.close();await rm(dir,{recursive:true,force:true});}
