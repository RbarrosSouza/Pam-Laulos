import test,{before,after} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {collectionFixtureDB} from './collection-db.fixture.mjs';
let db,role,rpc,seq=0;const migrations=new URL('../migrations/',import.meta.url);const one=async(q,a=[])=>(await db.query(q,a)).rows[0];
const source=(extra={})=>{const message='fixture-'+ ++seq;return {channel:'email',account_id:'gmail:fixture@example.invalid',message_id:message,attachment_id:'gmail-part:'+JSON.stringify(['1','locator-'+seq]),original_name:'fixture.pdf',received_at:new Date(Date.now()-600000).toISOString(),metadata:{provider:'gmail',mailbox:'fixture@example.invalid',gmail_message_id:message,gmail_part_id:'1',gmail_attachment_id:'locator-'+seq,exam_candidate:true},...extra};};
before(async()=>{({db,role,rpc}=await collectionFixtureDB());await db.exec('RESET ROLE');for(const name of ['20261016000006_exam_operational_flow.sql','20261016000007_exam_clinical_group_eligibility.sql','20261016000008_exam_gmail_origin_identity.sql','20261016000009_exam_group_after_processing.sql','20261016000010_exam_group_without_identification.sql','20261027000023_exam_intake_receipts_incidents.sql','20261027000024_exam_hopelab_notice_snapshots.sql','20261027000025_exam_intake_panel_coverage.sql','20261027000026_exam_intake_source_lookup.sql','20261027000027_exam_intake_version_review.sql'])await db.exec(await readFile(new URL(name,migrations),'utf8'));
 await db.exec('CREATE TABLE public.exam_document_responsibility(document_id uuid PRIMARY KEY REFERENCES public.exam_document(id)); CREATE TABLE public.exam_document_reaction(document_id uuid REFERENCES public.exam_document(id)); GRANT ALL ON public.exam_document_reaction TO service_role');
 for(const name of ['20261028000040_exam_document_deletion.sql','20261028000041_exam_delete_after_group.sql','20261028000042_exam_delete_empty_aliases.sql','20261028000043_exam_versions_group_independent.sql','20261104000047_exam_gmail_drive_retry_policy.sql'])await db.exec(await readFile(new URL(name,migrations),'utf8'));
 await role('service_role');await db.query("UPDATE exam_document_configuration SET ingestion_enabled=true,enabled_destinations=ARRAY['drive','processing','group','nexus'],notification_cutoff=now()-interval '2 days',group_destination_key='fixture-group'");});
after(async()=>await db?.close());
const reserve=s=>rpc('reserve_exam_intake_source',[JSON.stringify(s)]);const fail=(id,code='drive_upload_failed')=>rpc('record_exam_document_source_error',[id,'Gmail/Drive ['+code+']','Preservar original']);

test('first failure receives stage code and five minute cooldown; duplicate callbacks do not extend it or duplicate events',async()=>{
 const s=source(),d=await reserve(s),first=await fail(d.document_id);assert.equal(first.intake_retry.failure_count,1);const retry=await one('SELECT * FROM exam_intake_source_retry WHERE document_id=$1',[d.document_id]);assert(Date.parse(retry.next_attempt_at)-Date.now()>290000);
 for(let i=0;i<10;i++)await fail(d.document_id,i%2?'drive_lookup_failed':'drive_upload_failed');
 const now=await one('SELECT * FROM exam_intake_source_retry WHERE document_id=$1',[d.document_id]);assert.equal(now.failure_count,1);assert.equal(Number(now.next_attempt_at),Number(retry.next_attempt_at));assert.equal(Number(now.first_failed_at),Number(retry.first_failed_at));
 assert.equal(Number((await one("SELECT count(*) n FROM exam_document_event WHERE document_id=$1 AND event_type='source_failed'",[d.document_id])).n),1);
 assert.equal((await reserve(s)).intake_retry.deferred,true);
});

test('retry after cooldown grows bounded backoff without overwriting source bytes or reserving another Drive lease',async()=>{
 const s=source(),d=await reserve(s),h='a'.repeat(64);const lease=await rpc('stage_exam_intake_file',[d.document_id,JSON.stringify({sha256:h,size_bytes:100,drive_file_id:'fixture-drive',drive_folder_id:'fixture-folder'}),'n8n:fixture']);await fail(d.document_id);
 const before=await one("SELECT lease_token,lease_until FROM exam_document_delivery WHERE document_id=$1 AND destination='drive'",[d.document_id]);
 for(let i=0;i<9;i++){await db.query("UPDATE exam_intake_source_retry SET next_attempt_at=now()-interval '1 second' WHERE document_id=$1",[d.document_id]);assert.equal((await reserve(s)).intake_retry.deferred,false);await fail(d.document_id);}
 const retry=await one('SELECT * FROM exam_intake_source_retry WHERE document_id=$1',[d.document_id]);assert.equal(retry.failure_count,10);assert(Date.parse(retry.next_attempt_at)-Date.now()>3590000);assert(Date.parse(retry.next_attempt_at)-Date.now()<=3600000);
 const after=await one("SELECT lease_token,lease_until FROM exam_document_delivery WHERE document_id=$1 AND destination='drive'",[d.document_id]);assert.deepEqual(after,before);assert.equal((await one('SELECT sha256 FROM exam_document WHERE id=$1',[d.document_id])).sha256,h);assert.equal(after.lease_token,lease.lease_token);
});

test('Gmail cooldown never blocks an authorized WhatsApp origin',async()=>{
 const d=await reserve(source());await fail(d.document_id);
 const s=source({channel:'whatsapp',account_id:'chatwoot:1:inbox:2',metadata:{provider:'chatwoot',exam_candidate:true}}),w=await reserve(s);assert.equal(w.intake_retry,undefined);
});

test('late failing scan does not degrade a saved original or a human not-exam decision',async()=>{
 const d=await reserve(source());await db.query("UPDATE exam_document SET identification_status='not_exam' WHERE id=$1",[d.document_id]);assert.equal((await fail(d.document_id)).excluded,true);assert.equal((await one('SELECT identification_status,file_status FROM exam_document WHERE id=$1',[d.document_id])).identification_status,'not_exam');
 const s=source(),saved=await reserve(s);await db.query("UPDATE exam_document SET sha256=$2,size_bytes=100,drive_file_id='saved-file',drive_folder_id='folder',file_status='saved' WHERE id=$1",[saved.document_id,'b'.repeat(64)]);assert.equal((await fail(saved.document_id)).already_saved,true);assert.equal((await reserve(s)).intake_retry,undefined);
});

test('wrapper preserves excluded/tombstone and Hopelab reservation contracts and browser denial',async()=>{
 const hopelab=source({attachment_id:'hopelab-link:'+'d'.repeat(64)});hopelab.metadata={provider:'hopelab_link',gmail_message_id:hopelab.message_id,hopelab_notice_protocol:'gmail_notice_link_v2',link_sha256:'d'.repeat(64),exam_candidate:true};const hop=await reserve(hopelab);assert.equal(hop.hopelab_notice_v2.contract,'hopelab_notice_v2_hold_v1');assert.equal(hop.hopelab_notice_v2.group_hold_enforced,true);await fail(hop.document_id);assert.equal((await reserve(hopelab)).hopelab_notice_v2.source_id,hop.hopelab_notice_v2.source_id);

 const s=source();const d=await reserve(s);await db.query("UPDATE exam_document SET deletion_state='deleted',file_status='failed' WHERE id=$1",[d.document_id]);const excluded=await reserve(s);assert(excluded.excluded||excluded.document?.deletion_state==='deleted');
 for(const browser of ['anon','authenticated']){await role(browser);await assert.rejects(db.query('SELECT * FROM exam_intake_source_retry'),{code:'42501'});await assert.rejects(fail(d.document_id),{code:'42501'});}await role('service_role');
});


test('retry rows cascade when an empty document is physically removed; tombstones never resume',async()=>{
 await db.exec('RESET ROLE');await db.exec('BEGIN');
 try{
  const d=await one("INSERT INTO exam_document(original_name) VALUES('fixture-to-remove.pdf') RETURNING id");await fail(d.id);assert.equal(Number((await one('SELECT count(*) n FROM exam_intake_source_retry WHERE document_id=$1',[d.id])).n),1);
  await db.query('DELETE FROM exam_document_event WHERE document_id=$1',[d.id]);await db.query('DELETE FROM exam_document WHERE id=$1',[d.id]);assert.equal(Number((await one('SELECT count(*) n FROM exam_intake_source_retry WHERE document_id=$1',[d.id])).n),0);
 }finally{await db.exec('ROLLBACK');await role('service_role');}
});

test('a late error addressed to an alias cannot degrade its saved canonical',async()=>{
 const s=source(),saved=await reserve(s);await db.query("UPDATE exam_document SET sha256=$2,size_bytes=100,drive_file_id='saved-file',drive_folder_id='folder',file_status='saved' WHERE id=$1",[saved.document_id,'c'.repeat(64)]);
 const alias=await one("INSERT INTO exam_document(original_name,canonical_document_id) VALUES('alias.pdf',$1) RETURNING id",[saved.document_id]);const result=await fail(alias.id);assert.equal(result.already_saved,true);assert.equal(result.document_id,saved.document_id);
 assert.equal(Number((await one('SELECT count(*) n FROM exam_intake_source_retry WHERE document_id IN ($1,$2)',[alias.id,saved.document_id])).n),0);
});
