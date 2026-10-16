import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {collectionFixtureDB} from './collection-db.fixture.mjs';
import {decideReservation} from '../../scripts/exames/operacional-runtime.mjs';

// Actual migration/RPC SQL in PGlite; no provider, credential or clinical data.
// An explicit path tests the exact private registry installation package too.
const sourceSql=await readFile(new URL('../migrations/20261016000008_exam_gmail_origin_identity.sql',import.meta.url),'utf8');
const installSql=process.env.EXAM_GMAIL_IDENTITY_INSTALL_SQL
  ?await readFile(process.env.EXAM_GMAIL_IDENTITY_INSTALL_SQL,'utf8'):sourceSql;
const {db,role,rpc}=await collectionFixtureDB();
let passed=0;
const check=async(name,fn)=>{await fn();console.log(`ok ${++passed} - ${name}`);};
const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
const registryCount=async()=>{await db.exec('RESET ROLE');const n=Number((await one("SELECT count(*) n FROM supabase_migrations.schema_migrations WHERE version='20261016000008'")).n);await role('service_role');return n;};
const reserve=source=>rpc('reserve_exam_document_source',[JSON.stringify(source)]);
const gmail=(message='message',part='1',locator='locator-A',mailbox='collector@example.invalid')=>({
  channel:'email',account_id:'gmail:'+mailbox,message_id:message,
  attachment_id:'gmail-part:'+JSON.stringify([part,locator]),original_name:'same-name.pdf',mime_type:'application/pdf',
  received_at:'2026-10-16T10:00:00Z',metadata:{provider:'gmail',mailbox,gmail_message_id:message,
    gmail_part_id:part,gmail_attachment_id:locator,exam_candidate:false}
});
const reserveFingerprint=async()=>one(`SELECT md5(prosrc) body,proowner,proacl::text acl,proconfig,prosecdef
 FROM pg_proc WHERE oid='public.reserve_exam_document_source(jsonb)'::regprocedure`);
const state=async()=>one(`SELECT
 (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM exam_document d) docs,
 (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM exam_document_source s) sources,
 (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM exam_document_event e) events,
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM exam_document_delivery t) deliveries,
 (SELECT to_jsonb(c) FROM exam_document_configuration c) configuration`);
async function save(source,hash='a'.repeat(64)){
 const d=await reserve(source),file={sha256:hash,size_bytes:123,drive_file_id:'synthetic-'+d.document_id,drive_folder_id:'synthetic-folder'};
 const staged=await rpc('stage_exam_document_file',[d.document_id,JSON.stringify(file),'synthetic-worker']);
 return staged.document.file_status==='saved'?staged:rpc('confirm_exam_document_file',[staged.document_id,JSON.stringify(file),staged.lease_token]);
}
async function mustRejectUnchanged(source,pattern){const before=await state();await assert.rejects(reserve(source),pattern);assert.deepEqual(await state(),before);}

try{
 await db.exec('RESET ROLE');
 for(const f of ['20261016000006_exam_operational_flow.sql','20261016000007_exam_clinical_group_eligibility.sql'])
  await db.exec(await readFile(new URL('../migrations/'+f,import.meta.url),'utf8'));
 await db.exec("CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,name text,statements text[]); INSERT INTO supabase_migrations.schema_migrations VALUES('20261016000007','synthetic',ARRAY[]::text[])");
 await role('service_role');
 await db.exec("UPDATE exam_document_configuration SET ingestion_enabled=true");
 // Produce the same historical shape as the real bug, using the old RPC.
 const saved=await save(gmail('historical','1','old-A'));
 await save(gmail('historical','1','old-B'));
 const divergentA=await reserve(gmail('ambiguous','1','old-A'));
 await reserve(gmail('ambiguous','1','old-B'));
 const pending=await reserve(gmail('pending','1','old-A'));
 const malformed=await reserve(gmail('missing-history','1','old-A'));
 await db.query("UPDATE exam_document_source SET metadata=metadata-'gmail_part_id' WHERE document_id=$1",[malformed.document_id]);
 const initialState=await state(),initialFingerprint=await reserveFingerprint();
 const otherFunctions=await one(`SELECT jsonb_object_agg(oid::regprocedure::text,md5(pg_get_functiondef(oid))) bodies
  FROM pg_proc WHERE oid IN ('public.stage_exam_document_file(uuid,jsonb,text)'::regprocedure,
  'public.confirm_exam_document_file(uuid,jsonb,uuid)'::regprocedure,
  'public.guard_exam_document_admin_phase_insert()'::regprocedure,
  'public.require_exam_document_service()'::regprocedure)`);

 await check('late package failure rolls function and registry back atomically',async()=>{
  await db.exec('RESET ROLE');
  const at=installSql.lastIndexOf('COMMIT;');assert(at>0);
  await assert.rejects(db.exec(installSql.slice(0,at)+"DO $$ BEGIN RAISE EXCEPTION 'synthetic_late_failure'; END $$;\n"+installSql.slice(at)),/synthetic_late_failure/);
  await db.exec('ROLLBACK');await role('service_role');
  assert.deepEqual(await reserveFingerprint(),initialFingerprint);assert.deepEqual(await state(),initialState);
  assert.equal(await registryCount(),0);
 });
 await check('expected-body guard refuses drift before replacing the RPC',async()=>{
  await db.exec('RESET ROLE');
  await assert.rejects(db.exec(installSql.replace("md5(p.prosrc)<>'6108dcc3da7e1fb64afa062ea2c1f462'","md5(p.prosrc)<>'00000000000000000000000000000000'")),/Contrato original/);
  await db.exec('ROLLBACK');await role('service_role');assert.deepEqual(await reserveFingerprint(),initialFingerprint);
 });
 await check('installation changes only RPC body and preserves ACL, gates, active configuration and history',async()=>{
  await db.exec('RESET ROLE');await db.exec(installSql);await role('service_role');
  const after=await reserveFingerprint();assert.notEqual(after.body,initialFingerprint.body);
  assert.deepEqual({...after,body:null},{...initialFingerprint,body:null});assert.deepEqual(await state(),initialState);
  assert.deepEqual(await one(`SELECT jsonb_object_agg(oid::regprocedure::text,md5(pg_get_functiondef(oid))) bodies
   FROM pg_proc WHERE oid IN ('public.stage_exam_document_file(uuid,jsonb,text)'::regprocedure,
   'public.confirm_exam_document_file(uuid,jsonb,uuid)'::regprocedure,
   'public.guard_exam_document_admin_phase_insert()'::regprocedure,
   'public.require_exam_document_service()'::regprocedure)`),otherFunctions);
  if(process.env.EXAM_GMAIL_IDENTITY_INSTALL_SQL)assert.equal(await registryCount(),1);
 });
 await check('historical aliases converging on one saved canonical return it with zero row mutations',async()=>{
  const before=await state();
  for(const locator of ['new-C','new-D','new-E']){
   const r=await reserve(gmail('historical','1',locator));assert.equal(r.document_id,saved.document_id);
   assert.equal(r.document.id,saved.document_id);assert.equal(r.document.canonical_document_id,null);
   assert.equal(r.duplicate,true);assert.equal(r.document.file_status,'saved');
   const decision=decideReservation({attachment:{gmailAttachmentId:locator}},r);assert.equal(decision.skip,true);
  }
  assert.deepEqual(await state(),before);
 });
 await check('pending origin retains current download locator while reusing original document without writes',async()=>{
  const source=gmail('pending','1','CURRENT-download-locator'),before=await state(),r=await reserve(source);
  assert.equal(r.document_id,pending.document_id);assert.equal(r.duplicate,true);
  const current={source,attachment:{gmailAttachmentId:source.metadata.gmail_attachment_id},message:{id:source.message_id}};
  const decision=decideReservation(current,r);assert.equal(decision.skip,false);
  assert.equal(decision.attachment.gmailAttachmentId,'CURRENT-download-locator');
  assert.deepEqual(await state(),before);
 });
 await check('new logical origin is inserted once and repeated locators are read-only',async()=>{
  const first=await reserve(gmail('new-message','1','new-A'));assert.equal(first.duplicate,false);
  const before=await state();
  for(const locator of ['new-B','new-C']){const r=await reserve(gmail('new-message','1',locator));assert.equal(r.document_id,first.document_id);assert.equal(r.duplicate,true);}
  assert.deepEqual(await state(),before);
 });
 await check('same filename in different parts, messages or accounts remains separate',async()=>{
  const ids=[];
  for(const source of [gmail('separate','1','same'),gmail('separate','2','same'),gmail('other-message','1','same'),gmail('separate','1','same','other@example.invalid')])
   ids.push((await reserve(source)).document_id);
  assert.equal(new Set(ids).size,4);
 });
 await check('empty root part, notice without attachment and opaque part IDs retain distinct identities',async()=>{
  const root=await reserve(gmail('root','','A'));assert.equal((await reserve(gmail('root','','B'))).document_id,root.document_id);
  const notice=gmail('root');notice.attachment_id='missing-pdf';delete notice.metadata.gmail_part_id;delete notice.metadata.gmail_attachment_id;notice.metadata.missing_attachment=true;
  const n=await reserve(notice);assert.notEqual(n.document_id,root.document_id);assert.equal((await reserve(notice)).document_id,n.document_id);
  const part='opaque-"\\-ç-'+('x'.repeat(1100));const d=await reserve(gmail('opaque',part,'A'));assert.equal((await reserve(gmail('opaque',part,'B'))).document_id,d.document_id);
 });
 await check('divergent or unverifiable historical identities fail closed without alias or event',async()=>{
  await mustRejectUnchanged(gmail('ambiguous','1','new-C'),/documentos divergentes/);
  await mustRejectUnchanged(gmail('missing-history','1','new-B'),/sem identidade comprovada/);
  const invalid=gmail('new-message','1','new-B');invalid.metadata.gmail_message_id='different';await mustRejectUnchanged(invalid,/inválida/);
  const reused=gmail('pending','2','old-A');reused.attachment_id=gmail('pending','1','old-A').attachment_id;await mustRejectUnchanged(reused,/sem identidade comprovada/);
  assert(divergentA.document_id);
 });
 await check('non-Gmail reservations keep the existing exact-key behavior',async()=>{
  const s={channel:'email',account_id:'synthetic-outlook',message_id:'message',attachment_id:'part-A',original_name:'synthetic.pdf'};
  const a=await reserve(s);assert.equal((await reserve(s)).document_id,a.document_id);
  assert.notEqual((await reserve({...s,attachment_id:'part-B'})).document_id,a.document_id);
 });
 await check('anon/authenticated remain denied; ingestion pause rejects new originals without changing saved reuse',async()=>{
  for(const name of ['anon','authenticated']){await role(name);await assert.rejects(reserve(gmail('denied')),/permission/);}
  await role('service_role');await db.exec('UPDATE exam_document_configuration SET ingestion_enabled=false');
  await mustRejectUnchanged(gmail('new-while-paused'),/pausado/);
  const before=await state();assert.equal((await reserve(gmail('historical','1','latest'))).document_id,saved.document_id);assert.deepEqual(await state(),before);
 });
 console.log(JSON.stringify({checks:passed,providers:0,applied_to_production:false,
  source_sha256:createHash('sha256').update(sourceSql).digest('hex'),tested_sql_sha256:createHash('sha256').update(installSql).digest('hex')}));
}catch(e){console.error({message:e.message,code:e.code,where:e.where});process.exitCode=1;}finally{await db.close();}
