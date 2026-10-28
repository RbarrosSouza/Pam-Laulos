import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {collectionFixtureDB} from './collection-db.fixture.mjs';
let database;
if(process.env.PAM_DELETION_TEST_PG){
 const {createRequire}=await import('node:module');const require=createRequire(import.meta.url);const {Client}=require('pg');
 const config=JSON.parse(process.env.PAM_DELETION_TEST_PG);
 if(config.host!=='127.0.0.1'||config.database!=='pam_deletion_test')throw new Error('Use only the isolated local pam_deletion_test database');
 const client=new Client(config);await client.connect();
 database={exec:sql=>client.query(sql),query:(sql,args)=>client.query(sql,args),close:()=>client.end()};
}
const {db,role,rpc}=await collectionFixtureDB({database});
const migrations=new URL('../migrations/',import.meta.url);
const actor='10000000-0000-4000-8000-000000000001';
const one=async(sql,args=[])=>(await db.query(sql,args)).rows[0];
try {
  await db.exec('RESET ROLE');
  for(const name of ['20261016000006_exam_operational_flow.sql','20261016000007_exam_clinical_group_eligibility.sql','20261016000008_exam_gmail_origin_identity.sql','20261016000009_exam_group_after_processing.sql','20261016000010_exam_group_without_identification.sql','20261027000023_exam_intake_receipts_incidents.sql','20261027000024_exam_hopelab_notice_snapshots.sql','20261027000025_exam_intake_panel_coverage.sql','20261027000026_exam_intake_source_lookup.sql']) await db.exec(await readFile(new URL(name,migrations),'utf8'));
  await db.exec('CREATE TABLE public.exam_document_responsibility(document_id uuid PRIMARY KEY REFERENCES public.exam_document(id))');
  if(process.env.PAM_DELETION_COMPAT_DIR){
    const {pathToFileURL}=await import('node:url');const {readdir}=await import('node:fs/promises');
    const dir=pathToFileURL(process.env.PAM_DELETION_COMPAT_DIR+'/');
    await db.exec(await readFile(new URL('20261016000011_exam_unique_patient_matching.sql',migrations),'utf8'));
    const helper=await readFile(new URL('20261019000016_exam_hemogram_normalization.sql',migrations),'utf8');
    await db.exec(helper.slice(helper.indexOf('CREATE FUNCTION public.exam_document_exam_component_heading'),helper.indexOf('REVOKE ALL ON FUNCTION public.exam_document_exam_component_heading')));
    for(const name of (await readdir(dir)).filter(x=>/^202610280000(28|30|31|33|34|35|36|37|38|39)_/.test(x)).sort()) await db.exec(await readFile(new URL(name,dir),'utf8'));
  }
  await db.exec(await readFile(new URL('20261028000040_exam_document_deletion.sql',migrations),'utf8'));
  await db.exec('CREATE TABLE public.exam_document_reaction(document_id uuid REFERENCES public.exam_document(id)); GRANT ALL ON public.exam_document_reaction TO service_role');
  await db.exec(await readFile(new URL('20261028000041_exam_delete_after_group.sql',migrations),'utf8'));
  await db.query('INSERT INTO auth.users(id) VALUES($1)',[actor]);await db.query("INSERT INTO exam_document_member(user_id,role) VALUES($1,'vet')",[actor]);
  await role('service_role');
  await db.query("UPDATE exam_document_configuration SET ingestion_enabled=true");
  const active=(await rpc('reserve_exam_document_source',[JSON.stringify({channel:'manual',account_id:'account',message_id:'active',attachment_id:'a',original_name:'active.pdf'})])).document_id;
  await db.query("INSERT INTO exam_document_delivery(document_id,destination,status,worker,lease_token,lease_until) VALUES($1,'processing','reserved','worker',gen_random_uuid(),now()+interval '1 minute')",[active]);
  await assert.rejects(rpc('begin_exam_document_deletion',[active,1,actor,'DELETAR']),/processamento/);
  const sent=(await rpc('reserve_exam_document_source',[JSON.stringify({channel:'manual',account_id:'account',message_id:'sent',attachment_id:'c',original_name:'test.pdf'})])).document_id;
  await db.query("INSERT INTO exam_document_delivery(document_id,destination,status,external_id) VALUES($1,'group','sent','test-group-message')",[sent]);
  const withReaction=(await rpc('reserve_exam_document_source',[JSON.stringify({channel:'manual',account_id:'account',message_id:'reaction',attachment_id:'d',original_name:'test.pdf'})])).document_id;
  await db.query('INSERT INTO exam_document_reaction(document_id) VALUES($1)',[withReaction]);
  await assert.rejects(rpc('begin_exam_document_deletion',[withReaction,1,actor,'DELETAR']),/reação de contato/);
  const sentVersion=(await one('SELECT version FROM exam_document WHERE id=$1',[sent])).version;
  assert.equal((await rpc('begin_exam_document_deletion',[sent,sentVersion,actor,'DELETAR'])).state,'deleting');
  assert.equal((await rpc('finish_exam_document_deletion',[sent,actor,'DELETAR'])).state,'deleted');
  await assert.rejects(db.query('INSERT INTO exam_document_reaction(document_id) VALUES($1)',[sent]),/Ficha em exclusão/);
  const linked=(await rpc('reserve_exam_document_source',[JSON.stringify({channel:'manual',account_id:'account',message_id:'linked',attachment_id:'b',original_name:'linked.pdf'})])).document_id;
  await db.query("INSERT INTO exam_document(original_name,previous_document_id) VALUES('version.pdf',$1)",[linked]);
  await assert.rejects(rpc('begin_exam_document_deletion',[linked,1,actor,'DELETAR']),/outra versão/);
  const input={channel:'email',account_id:'account',message_id:'message',attachment_id:'attachment',original_name:'boleto.pdf',metadata:{subject:'private'}};
  const reserved=await rpc('reserve_exam_document_source',[JSON.stringify(input)]),id=reserved.document_id;
  const source=(await one('SELECT id FROM exam_document_source WHERE document_id=$1',[id])).id;
  await db.query("INSERT INTO exam_collection_cursor(collector_id,scope_key,scope_manifest) VALUES('fixture',$1,$2::jsonb)",['b'.repeat(64),JSON.stringify({provider:'gmail',account_id:'account'})]);
  await db.query("INSERT INTO exam_intake_receipt(collector_id,partition_key,message_id,attachment_id,artifact_kind,disposition,source_id,document_id,sha256,size_bytes) VALUES('fixture','scope','message','attachment','attachment','saved',$1,$2,$3,123)",[source,id,'a'.repeat(64)]);
  const receipt=(await one('SELECT id FROM exam_intake_receipt WHERE document_id=$1',[id])).id;
  await db.query("INSERT INTO exam_intake_incident(incident_key,collector_id,receipt_id,document_id,stage,code) VALUES('issue','fixture',$1,$2,'review','fixture_problem')",[receipt,id]);
  const incident=(await one('SELECT id FROM exam_intake_incident WHERE receipt_id=$1',[receipt])).id;
  await db.query("INSERT INTO exam_intake_alert_outbox(incident_id,generation,status,destination_key) VALUES($1,1,'pending','fixture')",[incident]);
  await db.query("UPDATE exam_document SET sha256=$2,size_bytes=123,staging_bucket='exam_documents_staging',staging_path=$3,extracted_data=$4::jsonb WHERE id=$1",[id,'a'.repeat(64),`${id}/original.pdf`,JSON.stringify({pet_name:'private'})]);
  await db.query("INSERT INTO storage.objects(bucket_id,name) VALUES('exam_documents_staging',$1)",[`${id}/original.pdf`]);
  let doc=await one('SELECT * FROM exam_document WHERE id=$1',[id]);
  await assert.rejects(rpc('begin_exam_document_deletion',[id,doc.version,actor,'delete']));
  await assert.rejects(rpc('begin_exam_document_deletion',[id,doc.version,'10000000-0000-4000-8000-000000000002','DELETAR']));
  const result=await rpc('begin_exam_document_deletion',[id,doc.version,actor,'DELETAR']);assert.equal(result.state,'deleting');
  await assert.rejects(db.query("UPDATE exam_document SET original_name='changed' WHERE id=$1",[id]),/Ficha em exclusão/);
  await assert.rejects(rpc('finish_exam_document_deletion',[id,actor,'DELETAR']),/Arquivo ainda existe/);
  assert.equal((await rpc('begin_exam_document_deletion',[id,doc.version,actor,'DELETAR'])).state,'deleting');
  await db.exec('RESET ROLE');await db.query("DELETE FROM storage.objects WHERE bucket_id='exam_documents_staging' AND name=$1",[`${id}/original.pdf`]);await role('service_role');
  assert.equal((await rpc('finish_exam_document_deletion',[id,actor,'DELETAR'])).state,'deleted');
  doc=await one('SELECT * FROM exam_document WHERE id=$1',[id]);assert.equal(doc.original_name,'Ficha excluída');assert.deepEqual(doc.extracted_data,{});assert.equal(doc.staging_path,null);
  assert.deepEqual((await one('SELECT metadata FROM exam_document_source WHERE document_id=$1',[id])).metadata,{});
  assert.deepEqual(await one('SELECT disposition,reason_code,sha256,size_bytes FROM exam_intake_receipt WHERE id=$1',[receipt]),{disposition:'excluded',reason_code:'user_deleted',sha256:null,size_bytes:null});
  assert.equal((await one('SELECT state FROM exam_intake_incident WHERE id=$1',[incident])).state,'resolved');
  assert.equal((await one('SELECT status FROM exam_intake_alert_outbox WHERE incident_id=$1',[incident])).status,'cancelled');
  const lookup=await rpc('lookup_exam_intake_sources',['fixture',JSON.stringify([{account_id:'account',message_id:'message',attachment_id:'attachment'}])]);
  assert.equal(lookup.items[0].status,'excluded');assert.equal(lookup.items[0].document_id,undefined);
  await assert.rejects(db.query("UPDATE exam_intake_receipt SET disposition='pending' WHERE id=$1",[receipt]),/Origem excluída/);
  assert.equal((await rpc('reserve_exam_document_source',[JSON.stringify(input)])).document_id,id);
  assert.equal((await rpc('stage_exam_document_file',[id,JSON.stringify({sha256:'a'.repeat(64),size_bytes:123}),'worker'])).excluded,true);
  const copy=(await rpc('reserve_exam_document_source',[JSON.stringify({...input,message_id:'other-message'})])).document_id;
  await db.query("INSERT INTO exam_intake_receipt(collector_id,partition_key,message_id,attachment_id,artifact_kind,disposition,reason_code) VALUES('fixture','scope','other-message','attachment','attachment','pending','fixture_pending')");
  const copyReceipt=(await one("SELECT id FROM exam_intake_receipt WHERE message_id='other-message'")).id;
  await db.query("INSERT INTO exam_intake_incident(incident_key,collector_id,receipt_id,stage,code) VALUES('copy-issue','fixture',$1,'review','fixture_pending')",[copyReceipt]);
  const copyIncident=(await one('SELECT id FROM exam_intake_incident WHERE receipt_id=$1',[copyReceipt])).id;
  await db.query("INSERT INTO exam_intake_alert_outbox(incident_id,generation,status,destination_key) VALUES($1,1,'failed','fixture')",[copyIncident]);
  const suppressed=await rpc('stage_exam_document_file',[copy,JSON.stringify({sha256:'a'.repeat(64),size_bytes:123,drive_file_id:'unused'}),'worker']);
  assert.equal(suppressed.excluded,true);assert.equal(suppressed.claimed,false);assert.equal(suppressed.document_id,id);
  assert.equal((await one('SELECT canonical_document_id FROM exam_document WHERE id=$1',[copy])).canonical_document_id,id);
  assert.equal((await one('SELECT document_id FROM exam_document_source WHERE message_id=$1',['other-message'])).document_id,id);
  assert.equal((await one('SELECT disposition FROM exam_intake_receipt WHERE id=$1',[copyReceipt])).disposition,'excluded');
  assert.equal((await one('SELECT status FROM exam_intake_alert_outbox WHERE incident_id=$1',[copyIncident])).status,'cancelled');


  if(database){
    await db.exec('RESET ROLE; GRANT pg_read_all_stats TO service_role');await role('service_role');
    const {createRequire}=await import('node:module');const {Client}=createRequire(import.meta.url)('pg');
    const concurrent=new Client(JSON.parse(process.env.PAM_DELETION_TEST_PG));await concurrent.connect();
    try{
      await concurrent.query("SELECT set_config('request.jwt.claim.role','service_role',false);SET ROLE service_role");
      const race=(await rpc('reserve_exam_document_source',[JSON.stringify({...input,message_id:'race'})])).document_id;
      const version=(await one('SELECT version FROM exam_document WHERE id=$1',[race])).version;
      await db.exec('BEGIN');await rpc('begin_exam_document_deletion',[race,version,actor,'DELETAR']);
      const pid=(await concurrent.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      const waiting=concurrent.query("INSERT INTO exam_document_delivery(document_id,destination) VALUES($1,'processing')",[race]).then(()=>null,error=>error);
      let blocked=false;
      for(let i=0;i<100;i++){
        await db.exec('SELECT pg_stat_clear_snapshot()');
        if((await one("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",[pid]))?.wait_event_type==='Lock'){blocked=true;break;}
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert(blocked,'worker must block behind the deletion transaction');
      await db.exec('COMMIT');assert.match((await waiting).message,/Ficha em exclusão/);
      await assert.rejects(db.query("INSERT INTO exam_document(original_name,previous_document_id) VALUES('resurrect.pdf',$1)",[race]),/Ficha em exclusão/);
      const workerFirst=(await rpc('reserve_exam_document_source',[JSON.stringify({...input,message_id:'worker-first'})])).document_id;
      const before=(await one('SELECT version FROM exam_document WHERE id=$1',[workerFirst])).version;
      await concurrent.query('BEGIN');await concurrent.query("INSERT INTO exam_document_delivery(document_id,destination,status) VALUES($1,'processing','reserved')",[workerFirst]);
      const deletion=rpc('begin_exam_document_deletion',[workerFirst,before,actor,'DELETAR']).then(()=>null,error=>error);
      await concurrent.query('COMMIT');assert.match((await deletion).message,/processamento/);
      console.log('PostgreSQL concurrent deletion/worker guards passed');
    }finally{await db.exec('ROLLBACK');await concurrent.end();}
  }
  const bridgeSource={...input,message_id:'reported-bridge'};
  const bridge=(await rpc('reserve_exam_document_source',[JSON.stringify(bridgeSource)])).document_id;
  const operation=await rpc('begin_exam_document_staging',[JSON.stringify(bridgeSource),JSON.stringify({sha256:'a'.repeat(64),size_bytes:123}),'fixture',45]);
  await assert.rejects(rpc('stage_exam_document_file',[bridge,JSON.stringify({sha256:'a'.repeat(64),size_bytes:123}),'worker']),/revisão/);
  await rpc('record_exam_document_staging',[operation.operation_id,operation.dispatch_nonce,JSON.stringify({state:'reported',sha256:'a'.repeat(64),size_bytes:123,helper_reference_sha256:'b'.repeat(64)})]);
  assert.equal((await rpc('stage_exam_document_file',[bridge,JSON.stringify({sha256:'a'.repeat(64),size_bytes:123}),'worker'])).excluded,true);
  // A new Hopelab notice for the same bytes must not create a visible version.
  const notice={channel:'email',account_id:'account',message_id:'notice-copy',attachment_id:'hopelab-link:'+ 'c'.repeat(64),original_name:'private.pdf',metadata:{provider:'hopelab_link',hopelab_notice_protocol:'gmail_notice_link_v2',gmail_message_id:'notice-copy',link_sha256:'c'.repeat(64),url:'https://private.invalid/token'}};
  const noticeDoc=(await rpc('reserve_exam_intake_source',[JSON.stringify(notice)])).document_id;
  assert.equal((await rpc('stage_exam_intake_file',[noticeDoc,JSON.stringify({sha256:'a'.repeat(64),size_bytes:123}),'worker'])).excluded,true);
  assert.equal(Number((await one('SELECT count(*) n FROM exam_intake_document_hold WHERE document_id=$1',[noticeDoc])).n),0);
  const noticeReplay=await rpc('reserve_exam_intake_source',[JSON.stringify(notice)]);
  assert.equal(noticeReplay.document_id,id);assert.equal(noticeReplay.document.deletion_state,'deleted');
  assert.equal((await one('SELECT metadata FROM exam_document_source WHERE message_id=$1',['notice-copy'])).metadata.url,undefined);
  const changedNotice={...notice,message_id:'changed-bytes',metadata:{...notice.metadata,gmail_message_id:'changed-bytes'}};
  const changed=(await rpc('reserve_exam_intake_source',[JSON.stringify(changedNotice)])).document_id;
  const changedStage=await rpc('stage_exam_intake_file',[changed,JSON.stringify({sha256:'f'.repeat(64),size_bytes:123,drive_file_id:'new-original',drive_folder_id:'folder'}),'worker']);
  assert.equal(changedStage.claimed,true);assert.equal((await one('SELECT previous_document_id FROM exam_intake_snapshot WHERE document_id=$1',[changed])).previous_document_id,null);
  // A standalone preserved notice may be deleted; a shared version may not.
  const standalone=(await rpc('reserve_exam_intake_source',[JSON.stringify({...notice,message_id:'standalone',attachment_id:'hopelab-link:'+'d'.repeat(64),metadata:{...notice.metadata,gmail_message_id:'standalone',link_sha256:'d'.repeat(64)}})])).document_id;
  const file={sha256:'e'.repeat(64),size_bytes:123,drive_file_id:'retained-drive',drive_folder_id:'folder'};
  const stage=await rpc('stage_exam_intake_file',[standalone,JSON.stringify(file),'worker']);
  await rpc('confirm_exam_document_file',[standalone,JSON.stringify({...file,drive_file_id:stage.drive_file_id}),stage.lease_token]);
  const ver=(await one('SELECT version FROM exam_document WHERE id=$1',[standalone])).version;
  await rpc('begin_exam_document_deletion',[standalone,ver,actor,'DELETAR']);
  await rpc('finish_exam_document_deletion',[standalone,actor,'DELETAR']);
  assert.equal(Number((await one('SELECT count(*) n FROM exam_intake_snapshot WHERE document_id=$1',[standalone])).n),0);
  await role('authenticated');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[actor]);assert.equal(Number((await one('SELECT count(*) n FROM v_exam_documents WHERE id IN ($1,$2)',[id,copy])).n),0);
  const panel=await rpc('get_exam_intake_panel',[50]);assert.equal(panel.unresolved_origins.some(item=>item.id===receipt),false);assert.equal(panel.saved_without_group.some(item=>item.document_id===id),false);
  console.log('Deletion SQL checks passed');
} finally {await db.close();}
