import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { stagingJournalChecks } from './exam-staging-journal.checks.mjs';
const require = createRequire(import.meta.url);
const { PGlite } = require('@electric-sql/pglite');
const db = new PGlite();
const root = new URL('../../', import.meta.url);
const staff = '10000000-0000-0000-0000-000000000001';
const stranger = '10000000-0000-0000-0000-000000000002';
const pet = '20000000-0000-0000-0000-000000000001';
const wrongPet = '20000000-0000-0000-0000-000000000002';
let passed = 0;
async function check(name, run) {
  try { await run(); passed++; console.log(`ok ${passed} - ${name}`); }
  catch (e) { console.error(`FAIL - ${name}`); throw e; }
}
async function role(roleName, uid = null) {
  await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.role','${roleName}',false), set_config('request.jwt.claim.sub','${uid || ''}',false); SET ROLE ${roleName}`);
}
async function rpc(name, args) {
  const slots = args.map((_, i) => `$${i + 1}`).join(',');
  const result = await db.query(`SELECT public.${name}(${slots}) AS result`, args);
  return result.rows[0].result;
}
async function row(sql, args = []) { return (await db.query(sql, args)).rows[0]; }
async function source(message, channel = 'email', extras = {}) {
  return rpc('reserve_exam_document_source', [JSON.stringify({ channel, account_id: 'fixture-account', message_id: message, attachment_id: 'attachment',
    original_name: 'fixture.pdf', received_at: new Date(Date.now() - 60_000).toISOString(), ...extras })]);
}
async function preserve(docId, hash, drive = `drive-${docId}`) {
  const file = { sha256: hash, size_bytes: 123, drive_file_id: drive, drive_folder_id: 'fixture-folder' };
  const staged = await rpc('stage_exam_document_file', [docId, JSON.stringify(file), 'fixture-worker']);
  if (staged.claimed) return rpc('confirm_exam_document_file', [staged.document_id, JSON.stringify(file), staged.lease_token]);
  return staged;
}
async function extracted(docId, extra = {}) {
  const existing=await row("SELECT * FROM exam_document_delivery WHERE document_id=$1 AND destination='processing'",[docId]);
  const task=existing.status==='reserved' ? existing : (await rpc('reserve_exam_document_delivery',['processing','fixture-extractor',20])).tasks.find(t=>t.document_id===docId);
  return rpc('update_exam_document_extraction', [docId, JSON.stringify({ delivery_id:task.id,lease_token:task.lease_token,fields: { pet_name: 'Luna', client_name: 'Tutor Fixture', exam_type: 'Ultrassom', exam_date: '2026-10-09' },
    classification: 'exam', single_patient: true, evidence: [{ page: 1, field: 'pet_name', text: 'Luna' }], extractor_version: 'fixture-v1', ...extra })]);
}
try {
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth; CREATE SCHEMA storage;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.role',true) $$;
    GRANT USAGE ON SCHEMA public,auth,storage TO anon,authenticated,service_role;
    CREATE TABLE public.clients(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"Código" text,"Nome" text,"Celular" text,"E-mail" text);
    CREATE TABLE public.pets(id uuid PRIMARY KEY,client_code text,code text,name text,species text,breed text,chip text);
    CREATE TABLE public.veterinarios(id uuid PRIMARY KEY,nome text);
    CREATE TABLE public.exam_tracking(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sale_id text,pet_id uuid,
      origin text NOT NULL DEFAULT 'venda',client_code text,exam_type text,lab_name text,pet_name_parsed text,client_name_parsed text,
      veterinario_id uuid,sale_product_name text);
    ALTER TABLE public.exam_tracking ENABLE ROW LEVEL SECURITY;
    CREATE POLICY authorized_nexus_sales ON public.exam_tracking FOR INSERT TO authenticated WITH CHECK(true);
    GRANT INSERT ON public.exam_tracking TO authenticated;
    CREATE TABLE public.exames(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),pet_id uuid NOT NULL REFERENCES pets(id),nome text NOT NULL,data_exame date NOT NULL DEFAULT current_date,
      arquivo_url text,arquivo_nome text,arquivo_tipo text,arquivo_tamanho integer,observacoes text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    ALTER TABLE public.exames ENABLE ROW LEVEL SECURITY;
    CREATE POLICY old_authenticated_exames ON public.exames FOR ALL TO authenticated USING(true) WITH CHECK(true);
    GRANT SELECT,INSERT,UPDATE,DELETE ON public.exames TO authenticated;
    CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text,metadata jsonb);
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    CREATE POLICY legacy_storage_all ON storage.objects FOR ALL TO anon,authenticated USING(true) WITH CHECK(true);
    GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO anon,authenticated;
    GRANT ALL ON ALL TABLES IN SCHEMA public,storage,auth TO service_role;
    INSERT INTO auth.users(id) VALUES('${staff}'),('${stranger}');
    INSERT INTO clients("Código","Nome") VALUES('C1','Tutor Fixture'),('C2','Outro Tutor');
    INSERT INTO pets(id,client_code,code,name,species) VALUES('${pet}','C1','P1','Luna','Canina'),('${wrongPet}','C2','P2','Luna','Canina');
  `);
  // Exercise the migrations against the preexisting legacy schema/triggers, not a replacement mock API.
  await db.exec(await readFile(new URL('supabase-migration.sql', root), 'utf8'));
  for (const path of [
    '20260324000001_bridge_tracking_to_card.sql',
    '20260327000001_lab_shipment_and_history.sql',
    '20260324000002_rpc_receive_email_result.sql',
    '20260930000001_exams_in_group.sql',
    '20261010000001_exam_documents.sql',
    '20261010000002_exam_document_card_guards.sql',
    '20261010000003_exam_document_staging_journal.sql',
  ]) await db.exec(await readFile(new URL(`supabase/migrations/${path}`, root), 'utf8'));
  await db.exec(`GRANT ALL ON ALL TABLES IN SCHEMA public,storage TO service_role; INSERT INTO exam_document_member(user_id,role) VALUES('${staff}','vet');`);
  await role('service_role');
  await db.query("UPDATE exam_document_configuration SET enabled_destinations=ARRAY['processing','drive']");
  let first, saved, itemId, cardId, groupTask, nexusTask;
  await check('repeat/concurrent source reservations converge to one origin/document', async () => {
    const results = await Promise.all([source('message-1'), source('message-1')]);
    first = results[0]; assert.equal(first.document_id, results[1].document_id);
    assert.equal(Number((await row('SELECT count(*) AS n FROM exam_document_source')).n), 1);
  });
  await check('file metadata cannot declare a result saved without a reserved original', async () => {
    await assert.rejects(rpc('confirm_exam_document_file', [first.document_id, JSON.stringify({drive_file_id:'unreserved',sha256:'a'.repeat(64),size_bytes:123}), crypto.randomUUID()]));
  });
  await check('Drive ID is persisted before external upload and a second worker cannot steal its lease', async () => {
    const f={sha256:'a'.repeat(64),size_bytes:123,drive_file_id:'drive-first',drive_folder_id:'fixture-folder'};
    const one=await rpc('stage_exam_document_file',[first.document_id,JSON.stringify(f),'same-worker']);
    const two=await rpc('stage_exam_document_file',[first.document_id,JSON.stringify({...f,drive_file_id:'another-drive'}),'same-worker']);
    assert.equal(one.claimed,true); assert.equal(two.claimed,false); assert.equal(two.drive_file_id,'drive-first');
    await assert.rejects(rpc('confirm_exam_document_file',[first.document_id,JSON.stringify(f),crypto.randomUUID()]));
    saved=await rpc('confirm_exam_document_file',[first.document_id,JSON.stringify(f),one.lease_token]);
    assert.equal(saved.document.file_status,'saved');
  });
  await check('file confirmation retries do not enqueue duplicate processing', async () => {
    const t=await row("SELECT * FROM exam_document_delivery WHERE document_id=$1 AND destination='drive'",[first.document_id]);
    await rpc('confirm_exam_document_file',[first.document_id,JSON.stringify({sha256:'a'.repeat(64),size_bytes:123,drive_file_id:'drive-first'}),t.lease_token]);
    assert.equal(Number((await row("SELECT count(*) n FROM exam_document_delivery WHERE destination='processing'")).n),1);
  });
  await check('the same PDF in WhatsApp joins email origin without another group task', async () => {
    const second=await source('whatsapp-1','whatsapp');
    const dedup=await preserve(second.document_id,'a'.repeat(64));
    assert.equal(dedup.document_id,first.document_id);
    assert.equal(Number((await row('SELECT count(*) n FROM exam_document_source WHERE document_id=$1',[first.document_id])).n),2);
    assert.equal(Number((await row('SELECT count(*) n FROM v_exam_documents')).n),1);
  });
  await check('same source with different bytes is refused rather than overwriting', async () => {
    await assert.rejects(preserve(first.document_id,'b'.repeat(64)));
  });
  await check('invalid extraction and impossible clinical date fail explicitly', async () => {
    await assert.rejects(extracted(first.document_id,{fields:{exam_date:'2026-02-30'}}));
    await assert.rejects(extracted(first.document_id,{fields:[]}));
    await extracted(first.document_id);
  });
  await check('side effects stay paused before deployment configuration/cutoff', async () => {
    assert.equal((await rpc('reserve_exam_document_delivery',['group','worker',1])).paused,true);
    await db.query("UPDATE exam_document_configuration SET enabled_destinations=ARRAY['processing','drive','group','nexus']");
    assert.deepEqual((await rpc('reserve_exam_document_delivery',['group','worker',1])).tasks,[]);
    await db.query("UPDATE exam_document_configuration SET notification_cutoff=now()-interval '1 day',group_destination_key='fixture-group'");
  });
  await check('anonymous cannot query document/view or use worker RPC', async () => {
    await role('anon');
    await assert.rejects(db.query('SELECT * FROM exam_document'));
    await assert.rejects(db.query('SELECT * FROM v_exam_documents'));
    await assert.rejects(source('unauthenticated'));
    await assert.rejects(rpc('move_exam_card',[crypto.randomUUID(),'exame_pronto','no_grupo']));
  });
  await check('authenticated outsider cannot see documents or use membership RPCs', async () => {
    await role('authenticated',stranger);
    assert.equal((await db.query('SELECT * FROM v_exam_documents')).rows.length,0);
    await assert.rejects(rpc('search_exam_document_candidates',['Luna',20]));
    await assert.rejects(rpc('assign_exam_document',[first.document_id,stranger]));
    await assert.rejects(source('client-forged-service'));
    await assert.rejects(rpc('receive_email_result',['Luna','Tutor Fixture','Ultrassom',null,'https://invalid.example/forged.pdf',new Date().toISOString()]));
  });
  await check('authorized Nexus sale still triggers a card without granting document membership', async () => {
    await role('authenticated',stranger);
    await db.query("INSERT INTO exam_tracking(sale_id,pet_id,client_code,exam_type,origin) VALUES('sale-fixture',$1,'C1','Hemograma','venda')",[pet]);
    assert.equal((await db.query("SELECT * FROM exam_card WHERE sale_id='sale-fixture'")).rows.length,0);
    await assert.rejects(db.query('SELECT bridge_tracking_to_card()'));
    await role('service_role');
    const card=await row("SELECT * FROM exam_card WHERE sale_id='sale-fixture'");assert.ok(card.id);
    assert.equal((await row('SELECT result_received FROM exam_item WHERE exam_card_id=$1',[card.id])).result_received,false);
  });
  await check('member can read documents and search homonyms without guessing a match', async () => {
    await role('authenticated',staff);
    assert.equal((await db.query('SELECT * FROM v_exam_documents')).rows.length,1);
    const candidates=await rpc('search_exam_document_candidates',['Luna',20]);
    assert.equal(candidates.length,2); assert.equal(candidates[0].client_name,'Tutor Fixture');
  });
  await check('optimistic linking rejects a stale version and creates only explicit items', async () => {
    const doc=await row('SELECT * FROM exam_document WHERE id=$1',[first.document_id]);
    await assert.rejects(rpc('confirm_exam_document_link',[doc.id,pet,[],doc.version-1,JSON.stringify({exam_type:'Ultrassom',exam_date:'2026-10-09'})]));
    const linked=await rpc('confirm_exam_document_link',[doc.id,pet,[],doc.version,JSON.stringify({pet_name:'Luna',client_name:'Tutor Fixture',exam_type:'Ultrassom',exam_date:'2026-10-09'})]);
    itemId=linked.item_ids[0]; const item=await row('SELECT * FROM exam_item WHERE id=$1',[itemId]); cardId=item.exam_card_id;
    assert.equal(item.result_received,true); assert.equal(item.contacted,false);
  });
  await check('dragging a document card cannot invent group sending or contact', async () => {
    await assert.rejects(rpc('move_exam_card',[cardId,'exame_pronto','no_grupo']));
    await assert.rejects(rpc('move_exam_card',[cardId,'exame_pronto','contato_realizado']));
    await assert.rejects(db.query('UPDATE exam_item SET contacted=true WHERE id=$1',[itemId]));
  });
  await check('contact rejects unrelated/unreceived item and missing clinical note', async () => {
    await assert.rejects(rpc('record_exam_document_contact',[first.document_id,[crypto.randomUUID()],'whatsapp','Contato fixture',new Date().toISOString()]));
    await assert.rejects(rpc('record_exam_document_contact',[first.document_id,[itemId],'whatsapp','',new Date().toISOString()]));
  });
  await check('contact can precede Nexus archival but does not finish the document', async () => {
    await rpc('record_exam_document_contact',[first.document_id,[itemId],'whatsapp','Tutor recebeu explicação pela veterinária',new Date().toISOString()]);
    const view=await row('SELECT * FROM v_exam_documents WHERE id=$1',[first.document_id]);
    assert.equal(view.contact_status,'completed'); assert.equal(view.completed,false);
  });
  await check('contact replay preserves the original author/time and refuses null channel', async () => {
    const before=await row('SELECT contacted_at,contacted_by FROM exam_item WHERE id=$1',[itemId]);
    await rpc('record_exam_document_contact',[first.document_id,[itemId],'whatsapp','Repetição de chamada',new Date(Date.now()+1000).toISOString()]);
    assert.deepEqual(await row('SELECT contacted_at,contacted_by FROM exam_item WHERE id=$1',[itemId]),before);
    await assert.rejects(rpc('record_exam_document_contact',[first.document_id,[itemId],null,'Canal ausente',new Date().toISOString()]));
    await assert.rejects(db.query('UPDATE exam_item SET contacted=false WHERE id=$1',[itemId]));
    await assert.rejects(db.query("UPDATE exam_item SET contacted_at=now()+interval '1 day' WHERE id=$1",[itemId]));
  });
  await check('two group workers reserve only one task', async () => {
    await role('service_role');
    const one=await rpc('reserve_exam_document_delivery',['group','worker-one',1]);
    const two=await rpc('reserve_exam_document_delivery',['group','worker-two',1]);
    assert.equal(one.tasks.length,1); assert.equal(two.tasks.length,0); groupTask=one.tasks[0];
  });
  await check('HTTP submission is not delivery and cannot become blind retry', async () => {
    await rpc('complete_exam_document_delivery',[groupTask.id,groupTask.lease_token,JSON.stringify({status:'submitted',external_id:'chatwoot-fixture'})]);
    assert.equal((await row('SELECT group_status,completed FROM v_exam_documents WHERE id=$1',[first.document_id])).group_status,'submitted');
    await assert.rejects(rpc('complete_exam_document_delivery',[groupTask.id,groupTask.lease_token,JSON.stringify({status:'failed',error:'timeout'})]));
    await assert.rejects(rpc('complete_exam_document_delivery',[groupTask.id,groupTask.lease_token,JSON.stringify({status:'sent',external_status:'pending'})]));
    await assert.rejects(rpc('complete_exam_document_delivery',[groupTask.id,groupTask.lease_token,JSON.stringify({status:'sent'})]));
    await assert.rejects(rpc('complete_exam_document_delivery',[groupTask.id,groupTask.lease_token,JSON.stringify({status:'sent',external_status:'sent'})]));
    await rpc('complete_exam_document_delivery',[groupTask.id,groupTask.lease_token,JSON.stringify({status:'sent',external_id:'chatwoot-fixture',external_status:'delivered'})]);
    const before=await row('SELECT sent_at FROM exam_document_delivery WHERE id=$1',[groupTask.id]);
    await rpc('complete_exam_document_delivery',[groupTask.id,groupTask.lease_token,JSON.stringify({status:'sent',external_status:'delivered'})]);
    assert.deepEqual((await row('SELECT sent_at FROM exam_document_delivery WHERE id=$1',[groupTask.id])).sent_at,before.sent_at);
  });
  await check('Nexus completion requires correct patient, deterministic object and hash', async () => {
    nexusTask=(await rpc('reserve_exam_document_delivery',['nexus','fixture-nexus',1])).tasks[0];
    await assert.rejects(rpc('complete_exam_document_delivery',[nexusTask.id,nexusTask.lease_token,JSON.stringify({status:'completed',storage_bucket:'exames',storage_path:'fake',sha256:'a'.repeat(64),size_bytes:123})]));
    const path=`${pet}/${first.document_id}/original.pdf`;
    await db.query('INSERT INTO storage.objects(bucket_id,name) VALUES($1,$2)',['exam_documents_private',path]);
    const done=await rpc('complete_exam_document_delivery',[nexusTask.id,nexusTask.lease_token,JSON.stringify({status:'completed',storage_bucket:'exam_documents_private',storage_path:path,sha256:'a'.repeat(64),size_bytes:123})]);
    assert.ok(done.exame_id);
    await rpc('complete_exam_document_delivery',[nexusTask.id,nexusTask.lease_token,JSON.stringify({status:'completed'})]);
    assert.equal(Number((await row('SELECT count(*) n FROM exames WHERE exam_document_id=$1',[first.document_id])).n),1);
    assert.equal((await row('SELECT completed FROM v_exam_documents WHERE id=$1',[first.document_id])).completed,true);
  });
  await check('reconfirming a linked document is idempotent and cannot change archived clinical data', async () => {
    await role('authenticated',staff);
    const doc=await row('SELECT * FROM exam_document WHERE id=$1',[first.document_id]);
    const before=Number((await row('SELECT count(*) n FROM exam_card')).n);
    const contactBefore=await row('SELECT contacted_at,contacted_by FROM exam_item WHERE id=$1',[itemId]);
    const result=await rpc('confirm_exam_document_link',[doc.id,pet,[],doc.version,JSON.stringify(doc.confirmed_data)]);
    assert.equal(result.already_linked,true); assert.equal(Number((await row('SELECT count(*) n FROM exam_card')).n),before);
    assert.deepEqual(await row('SELECT contacted_at,contacted_by FROM exam_item WHERE id=$1',[itemId]),contactBefore);
    await assert.rejects(rpc('review_exam_document',[doc.id,doc.version,JSON.stringify({...doc.confirmed_data,exam_date:'2026-10-08'}),'exam',null]));
    await assert.rejects(rpc('review_exam_document',[doc.id,doc.version,JSON.stringify(doc.confirmed_data),null,null]));
  });
  await check('broad old storage policies do not expose new private PDFs to outsiders', async () => {
    await role('authenticated',stranger);
    assert.equal((await db.query("SELECT * FROM storage.objects WHERE bucket_id='exam_documents_private'")).rows.length,0);
    assert.equal((await db.query('SELECT * FROM exames WHERE exam_document_id=$1',[first.document_id])).rows.length,0);
    await role('authenticated',staff);
    assert.equal((await db.query("SELECT * FROM storage.objects WHERE bucket_id='exam_documents_private'")).rows.length,1);
    await assert.rejects(db.query("INSERT INTO storage.objects(bucket_id,name) VALUES('exam_documents_private','forged')"));
    assert.equal((await db.query("DELETE FROM storage.objects WHERE bucket_id='exam_documents_private' RETURNING id")).rows.length,0);
    await assert.rejects(db.query('DELETE FROM exames WHERE exam_document_id=$1',[first.document_id]));
    await assert.rejects(db.query('DELETE FROM exam_card_log WHERE exam_card_id=$1',[cardId]));
    await role('anon');
    assert.equal((await db.query("SELECT * FROM storage.objects WHERE bucket_id='exam_documents_private'")).rows.length,0);
  });
  let corrected;
  await check('different bytes create a new version and reopen contact while preserving old contact', async () => {
    await role('service_role'); corrected=await source('message-correction');
    await preserve(corrected.document_id,'c'.repeat(64));
    await extracted(corrected.document_id);
    await role('authenticated',staff);
    const newVersion=await row('SELECT * FROM exam_document WHERE id=$1',[corrected.document_id]);
    await rpc('mark_exam_document_correction',[newVersion.id,first.document_id,newVersion.version,'Laboratório enviou correção']);
    const doc=await row('SELECT * FROM exam_document WHERE id=$1',[corrected.document_id]);
    await rpc('confirm_exam_document_link',[doc.id,pet,[itemId],doc.version,JSON.stringify({exam_type:'Ultrassom corrigido',exam_date:'2026-10-09'})]);
    assert.equal((await row('SELECT contacted FROM exam_item WHERE id=$1',[itemId])).contacted,false);
    assert.equal((await row('SELECT contact_status FROM v_exam_documents WHERE id=$1',[corrected.document_id])).contact_status,'pending');
    assert.equal((await row('SELECT contact_status FROM v_exam_documents WHERE id=$1',[first.document_id])).contact_status,'completed');
    assert.equal((await row('SELECT status FROM exam_card WHERE id=$1',[cardId])).status,'exame_pronto');
  });
  await check('wrong patient is rejected even after the name matches', async () => {
    const doc=await row('SELECT * FROM exam_document WHERE id=$1',[corrected.document_id]);
    await assert.rejects(rpc('confirm_exam_document_link',[doc.id,wrongPet,[itemId],doc.version,JSON.stringify({exam_type:'Ultrassom'})]));
  });
  await check('late group confirmation for the old contacted version does not move the new pending card', async () => {
    await role('service_role');
    await db.query("UPDATE exam_document_delivery SET status='submitted',sent_at=null,external_status='pending' WHERE id=$1",[groupTask.id]);
    await rpc('complete_exam_document_delivery',[groupTask.id,groupTask.lease_token,JSON.stringify({status:'sent',external_id:'chatwoot-fixture',external_status:'delivered'})]);
    assert.equal((await row('SELECT status FROM exam_card WHERE id=$1',[cardId])).status,'exame_pronto');
  });
  await check('correction cannot attach an unconfirmed predecessor or cross patient lineages', async () => {
    const original=await source('unconfirmed-predecessor');await preserve(original.document_id,'3'.repeat(64));
    const newer=await source('unconfirmed-correction');await preserve(newer.document_id,'4'.repeat(64));
    await role('authenticated',staff);
    const doc=await row('SELECT * FROM exam_document WHERE id=$1',[newer.document_id]);
    await assert.rejects(rpc('mark_exam_document_correction',[doc.id,original.document_id,doc.version,'Correção sem conferir paciente anterior']));
  });
  await check('expired group lease becomes uncertain, never automatically retryable', async () => {
    await role('service_role');
    const task=(await rpc('reserve_exam_document_delivery',['group','worker-timeout',1])).tasks[0];
    await db.query("UPDATE exam_document_delivery SET lease_until=now()-interval '1 minute' WHERE id=$1",[task.id]);
    const rec=await rpc('reconcile_exam_document_tasks',[]);
    assert.equal(rec.group_tasks[0].status,'uncertain');
    assert.equal((await rpc('reserve_exam_document_delivery',['group','worker-repeat',1])).tasks.length,0);
    await role('authenticated',staff);
    await assert.rejects(rpc('retry_exam_document_delivery',[task.id,'Sem prova de falha']));
  });
  await check('multi-patient/unreadable PDF keeps the original but blocks automatic group', async () => {
    await role('service_role'); const multi=await source('message-multipatient');
    await preserve(multi.document_id,'d'.repeat(64));
    const updated=await extracted(multi.document_id,{classification:'review',single_patient:false,review_reason:'Mais de um paciente'});
    assert.equal(updated.document.file_status,'saved'); assert.equal(updated.document.identification_status,'review');
    assert.equal(Number((await row("SELECT count(*) n FROM exam_document_delivery WHERE document_id=$1 AND destination='group'",[multi.document_id])).n),0);
  });
  await check('notification without PDF stays visible without declaring result received', async () => {
    const missing=await source('message-no-attachment','email',{metadata:{missing_attachment:true}});
    assert.equal(missing.document.identification_status,'review'); assert.equal(missing.document.file_status,'pending');
    assert.equal(Number((await row('SELECT count(*) n FROM exam_document_delivery WHERE document_id=$1',[missing.document_id])).n),0);
  });
  await check('unknown sender stays in review even when extraction identifies one patient', async () => {
    const unknown=await source('new-sender','email',{metadata:{unknown_sender:true}});
    await preserve(unknown.document_id,'e'.repeat(64));
    const doc=await extracted(unknown.document_id);
    assert.equal(doc.document.identification_status,'review'); assert.equal(doc.document.group_release_at,null);
  });
  await check('source download failure is auditable and retry can preserve the original later', async () => {
    const broken=await source('download-failure');
    const failed=await rpc('record_exam_document_source_error',[broken.document_id,'DOWNLOAD_FAILED','Arquivo precisa ser recuperado']);
    assert.equal(failed.document.file_status,'failed');
    const recovered=await preserve(broken.document_id,'f'.repeat(64));
    assert.equal(recovered.document.file_status,'saved');
  });
  await check('paused pipeline still retains a manual staged file for later reconciliation', async () => {
    await db.query("UPDATE exam_document_configuration SET enabled_destinations='{}'");
    const manual=await source('manual-upload','manual');
    const staged=await rpc('stage_exam_document_file',[manual.document_id,JSON.stringify({sha256:'1'.repeat(64),size_bytes:123,staging_bucket:'exam_documents_staging',staging_path:'ignored-path'}),'manual:user']);
    assert.equal(staged.claimed,true); assert.equal(staged.document.staging_path,`${manual.document_id}/original.pdf`);
    await db.query("UPDATE exam_document_delivery SET status='pending',lease_until=null WHERE id=$1",[staged.delivery_id]);
    assert.deepEqual((await rpc('reconcile_exam_document_tasks',[])).drive_tasks,[]);
    await db.query("UPDATE exam_document_configuration SET enabled_destinations=ARRAY['processing','drive','group','nexus']");
    assert.ok((await rpc('reconcile_exam_document_tasks',[])).drive_tasks.some(t=>t.document_id===manual.document_id));
  });
  await check('human group confirmation requires matching message ID and leaves contact pending', async () => {
    const pending=await row("SELECT t.* FROM exam_document_delivery t WHERE t.document_id=$1 AND t.destination='group'",[corrected.document_id]);
    await db.query('UPDATE exam_document_delivery SET external_id=$1 WHERE id=$2',['known-chatwoot',pending.id]);
    await role('authenticated',staff);
    const doc=await row('SELECT * FROM exam_document WHERE id=$1',[corrected.document_id]);
    await assert.rejects(rpc('confirm_exam_document_group_delivery',[doc.id,doc.version,'other-id','Conferi o PDF']));
    await rpc('confirm_exam_document_group_delivery',[doc.id,doc.version,'known-chatwoot','PDF aberto e conferido no grupo']);
    const view=await row('SELECT group_status,contact_status,completed FROM v_exam_documents WHERE id=$1',[doc.id]);
    assert.equal(view.group_status,'sent'); assert.equal(view.contact_status,'pending'); assert.equal(view.completed,false);
  });
  await check('missing clinical date can be completed after contact without changing the previous evidence', async () => {
    await role('service_role');
    const noDate=await source('no-clinical-date'); await preserve(noDate.document_id,'2'.repeat(64));
    await role('authenticated',staff);
    const doc=await row('SELECT * FROM exam_document WHERE id=$1',[noDate.document_id]);
    const fields={pet_name:'Luna',client_name:'Tutor Fixture',exam_type:'Hemograma',exam_date:null,lab_name:null};
    const linked=await rpc('confirm_exam_document_link',[doc.id,pet,[],doc.version,JSON.stringify(fields)]);
    await rpc('record_exam_document_contact',[doc.id,linked.item_ids,'phone','Contato antes da correção da data',new Date().toISOString()]);
    const now=await row('SELECT * FROM exam_document WHERE id=$1',[doc.id]);
    await rpc('review_exam_document',[doc.id,now.version,JSON.stringify({...fields,exam_date:'2026-10-09',lab_name:'Laboratório Fixture'}),'exam','Data conferida no PDF']);
    const reviewed=await row('SELECT * FROM v_exam_documents WHERE id=$1',[doc.id]);
    assert.equal(reviewed.contact_status,'completed'); assert.ok(reviewed.deliveries.some(t=>t.destination==='nexus'));
    await assert.rejects(rpc('review_exam_document',[doc.id,reviewed.version,JSON.stringify({...fields,exam_date:'2026-10-08',lab_name:'Laboratório Fixture'}),'exam','Mudança indevida']));
  });
  await check('merge preserves document links/items and archives the source audit history', async () => {
    await role('authenticated',staff);
    const target=(await db.query("INSERT INTO exam_card(pet_id,client_code,pet_name,status,origin) VALUES($1,'C1','Luna','exame_pronto','manual') RETURNING id",[pet])).rows[0].id;
    const result=await rpc('merge_exam_cards',[target,cardId]);
    assert.equal(result.items_moved,1); assert.equal(result.items_deduped,0);
    assert.equal((await row('SELECT exam_card_id FROM exam_item WHERE id=$1',[itemId])).exam_card_id,target);
    assert.ok((await row('SELECT archived_at FROM exam_card WHERE id=$1',[cardId])).archived_at);
    assert.equal(Number((await row('SELECT count(*) n FROM exam_document_item WHERE exam_item_id=$1',[itemId])).n),2);
    cardId=target;
  });
  await check('delete archives document card and preserves PDF/contact/events', async () => {
    const before=Number((await row('SELECT count(*) n FROM exam_document_event')).n);
    const result=await rpc('delete_exam_cards',[[cardId]]); assert.equal(result.archived,1); assert.equal(result.deleted,0);
    assert.equal(Number((await row('SELECT count(*) n FROM exam_document_event')).n),before);
    assert.equal((await db.query('SELECT * FROM v_exam_cards WHERE id=$1',[cardId])).rows.length,0);
    assert.equal(Number((await row('SELECT count(*) n FROM exam_document_item WHERE exam_item_id=$1',[itemId])).n),2);
    await assert.rejects(db.query('DELETE FROM exam_card WHERE id=$1',[cardId]));
  });
  await check('admin group exception atomically waives pending tasks and prevents any new claim', async () => {
    await role('service_role');
    await db.query("UPDATE exam_document_member SET role='admin' WHERE user_id=$1",[staff]);
    const skip=await source('group-dispensation'); await preserve(skip.document_id,'5'.repeat(64)); await extracted(skip.document_id);
    await role('authenticated',staff);
    const waived=await rpc('confirm_exam_document_group_exception',[skip.document_id,'Aviso dispensado após decisão da equipe']);
    assert.equal(waived.tasks_waived,1);
    assert.equal((await row("SELECT status FROM exam_document_delivery WHERE document_id=$1 AND destination='group'",[skip.document_id])).status,'waived');
    const doc=await row('SELECT * FROM exam_document WHERE id=$1',[skip.document_id]);
    await rpc('review_exam_document',[doc.id,doc.version,JSON.stringify({pet_name:'Luna',client_name:'Tutor Fixture',exam_type:'Ultrassom'}),'exam','Conferência posterior']);
    assert.equal(Number((await row("SELECT count(*) n FROM exam_document_delivery WHERE document_id=$1 AND destination='group'",[skip.document_id])).n),1);
    await role('service_role');
    assert.equal((await rpc('reserve_exam_document_delivery',['group','worker-after-waive',20])).tasks.some(t=>t.document_id===skip.document_id),false);
    // Defense in depth: even a pending task recreated by an older backend cannot bypass the document exception.
    await db.query("UPDATE exam_document_delivery SET status='pending' WHERE document_id=$1 AND destination='group'",[skip.document_id]);
    assert.equal((await rpc('reserve_exam_document_delivery',['group','older-worker',20])).tasks.some(t=>t.document_id===skip.document_id),false);
  });
  await check('a worker that wins the group lease blocks cancellation until its effect is reconciled', async () => {
    const started=await source('group-claim-before-exception');await preserve(started.document_id,'6'.repeat(64));await extracted(started.document_id);
    const task=(await rpc('reserve_exam_document_delivery',['group','worker-first',20])).tasks.find(t=>t.document_id===started.document_id);
    assert.ok(task);
    await role('authenticated',staff);
    await assert.rejects(rpc('confirm_exam_document_group_exception',[started.document_id,'Tentativa de dispensar com envio iniciado']));
    assert.equal((await row('SELECT group_exception_reason FROM exam_document WHERE id=$1',[started.document_id])).group_exception_reason,null);
    assert.equal((await row('SELECT status FROM exam_document_delivery WHERE id=$1',[task.id])).status,'reserved');
    await role('service_role');
    await rpc('complete_exam_document_delivery',[task.id,task.lease_token,JSON.stringify({status:'submitted',external_id:'started-fixture'})]);
    await role('authenticated',staff);
    await assert.rejects(rpc('confirm_exam_document_group_exception',[started.document_id,'Tentativa após submissão']));
    await role('service_role');
    await rpc('complete_exam_document_delivery',[task.id,task.lease_token,JSON.stringify({status:'uncertain',error:'Timeout depois da submissão'})]);
    await role('authenticated',staff);
    await assert.rejects(rpc('confirm_exam_document_group_exception',[started.document_id,'Tentativa com envio incerto']));
    assert.equal((await row('SELECT group_exception_reason FROM exam_document WHERE id=$1',[started.document_id])).group_exception_reason,null);
  });
  await check('confirmed failed group task can be waived without becoming retryable', async () => {
    await role('service_role');
    const failed=await source('group-failed-before-exception');await preserve(failed.document_id,'7'.repeat(64));await extracted(failed.document_id);
    await db.query("UPDATE exam_document_delivery SET status='failed',last_error='Definite rejection' WHERE document_id=$1 AND destination='group'",[failed.document_id]);
    await role('authenticated',staff);
    assert.equal((await rpc('confirm_exam_document_group_exception',[failed.document_id,'Não repetir aviso rejeitado'])).tasks_waived,1);
    const task=await row("SELECT * FROM exam_document_delivery WHERE document_id=$1 AND destination='group'",[failed.document_id]);
    assert.equal(task.status,'waived');await assert.rejects(rpc('retry_exam_document_delivery',[task.id,'Repetição indevida']));
    await role('service_role');
    assert.equal((await rpc('reserve_exam_document_delivery',['group','worker-after-failed-exception',20])).tasks.some(t=>t.document_id===failed.document_id),false);
  });
  await check('all optimistic document RPCs reject NULL and stale versions without changing evidence', async () => {
    const fresh=await source('optimistic-null-version');await preserve(fresh.document_id,'8'.repeat(64));await extracted(fresh.document_id);
    await role('authenticated',staff);
    const doc=await row('SELECT * FROM exam_document WHERE id=$1',[fresh.document_id]);
    const fields={pet_name:'Luna',client_name:'Tutor Fixture',exam_type:'Ultrassom',exam_date:'2026-10-09'};
    for(const version of [null,doc.version-1]) {
      await assert.rejects(rpc('confirm_exam_document_link',[doc.id,pet,[],version,JSON.stringify(fields)]),/Documento mudou/);
      await assert.rejects(rpc('review_exam_document',[doc.id,version,JSON.stringify(fields),'exam','Conferência fixture']),/Documento mudou/);
      await assert.rejects(rpc('release_exam_document_group',[doc.id,version,'Liberação fixture']),/Documento mudou/);
      await assert.rejects(rpc('confirm_exam_document_group_delivery',[doc.id,version,'fixture-id','Conferência fixture']),/Documento mudou/);
      await assert.rejects(rpc('mark_exam_document_correction',[doc.id,first.document_id,version,'Correção fixture']),/Documento mudou/);
    }
    const after=await row('SELECT * FROM exam_document WHERE id=$1',[doc.id]);
    assert.equal(after.version,doc.version);assert.equal(after.pet_id,null);assert.equal(after.previous_document_id,null);
    assert.equal(Number((await row('SELECT count(*) n FROM exam_document_item WHERE document_id=$1',[doc.id])).n),0);
  });
  await stagingJournalChecks({ db, check, rpc, source, row, role, staff, preserve });
  console.log(`PASS: ${passed} database integration scenarios. PGlite executes PostgreSQL SQL/RLS/triggers; external APIs and multi-connection contention still require deployment tests.`);
} catch(e) { console.error(e.message,e.code || '',e.where || ''); process.exitCode=1; } finally { await db.close(); }
