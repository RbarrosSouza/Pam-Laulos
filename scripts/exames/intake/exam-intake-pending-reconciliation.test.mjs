import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {collectionFixtureDB} from '../../../supabase/tests/collection-db.fixture.mjs';
let db,role,rpc,run,source,doc;const account='gmail:fixture@example.invalid',collector='fixture-reconciliation';
const one=async(s,p=[])=>(await db.query(s,p)).rows[0];
const event=(v)=>rpc('record_exam_intake_event',[run.sweep_id,run.run_token,JSON.stringify(v)]);
const list=(cursor=null,limit=50)=>rpc('list_exam_intake_pending_sources',[collector,cursor,limit]);
const resolve=(id,src=source,document=doc)=>rpc('resolve_exam_intake_receipt_saved',[id,src,document]);
before(async()=>{
 ({db,role,rpc}=await collectionFixtureDB());await db.exec('RESET ROLE');
 for(const f of ['20261016000006_exam_operational_flow.sql','20261016000007_exam_clinical_group_eligibility.sql','20261016000008_exam_gmail_origin_identity.sql','20261016000009_exam_group_after_processing.sql','20261016000010_exam_group_without_identification.sql','20261027000023_exam_intake_receipts_incidents.sql','20261027000024_exam_hopelab_notice_snapshots.sql','20261027000026_exam_intake_source_lookup.sql','20261028000030_exam_intake_pending_reconciliation.sql'])await db.exec(await readFile(new URL('../../../supabase/migrations/'+f,import.meta.url),'utf8'));
 await role('service_role');await db.query("UPDATE exam_document_configuration SET ingestion_enabled=true");
 run=await rpc('begin_exam_intake_sweep',[collector,'a'.repeat(64),JSON.stringify({provider:'gmail',account_id:account,scope_kind:'mailbox',policy_version:'intake_v2',sender_policy:'all'}),new Date(Date.now()-86400000).toISOString(),new Date(Date.now()-1000).toISOString(),crypto.randomUUID(),'audit',900]);
 await event({kind:'page_discovered',partition_key:'mailbox',page_key:'one',page_sha256:'b'.repeat(64),message_ids:['first','second','third'],is_terminal:true});
 for(const id of ['first','second','third']){await event({kind:'origins_declared',partition_key:'mailbox',message_id:id,origins:[{attachment_id:'pdf',artifact_kind:'attachment'}]});await event({kind:'origin_outcome',partition_key:'mailbox',message_id:id,attachment_id:'pdf',disposition:'pending',code:'fixture_pending'});}
 const res=await rpc('reserve_exam_document_source',[JSON.stringify({channel:'email',account_id:account,message_id:'first',attachment_id:'pdf',original_name:'fixture.pdf',received_at:new Date().toISOString()})]);
 const file={sha256:'c'.repeat(64),size_bytes:100,drive_file_id:'private-file',drive_folder_id:'private-folder'};
 const stage=await rpc('stage_exam_document_file',[res.document_id,JSON.stringify(file),'fixture-worker']);await rpc('confirm_exam_document_file',[stage.document_id,JSON.stringify({...file,drive_file_id:stage.drive_file_id}),stage.lease_token]);
 doc=stage.document_id;source=(await one('SELECT id FROM exam_document_source WHERE document_id=$1',[doc])).id;
});
after(async()=>{await db?.close()});
test('page and reconciliation are service-only',async()=>{
 for(const r of ['anon','authenticated']){await role(r);await assert.rejects(list(),e=>e.code==='42501');await assert.rejects(resolve(crypto.randomUUID()),e=>e.code==='42501');}await role('service_role');
 await assert.rejects(list(null,101),/Invalid pending/);await assert.rejects(list(null,0),/Invalid pending/);
});
test('stable pages expose only identities, and full pass includes all pending',async()=>{
 const all=await list(),a=await list(null,2),b=await list(a.next_cursor,2);
 assert.equal(all.contract,'exam_intake_pending_source_page_v1');assert.equal(all.items.length,3);assert.equal(a.items.length,2);assert.equal(b.items.length,1);assert.equal(b.next_cursor,null);
 assert.equal(new Set([...a.items,...b.items].map(x=>x.receipt_id)).size,3);
 assert(!JSON.stringify(all).includes('private-file'));assert(all.items.every(x=>x.account_id===account));
});
test('only exact saved canonical source can resolve, does not send anything and is idempotent',async()=>{
 const receipt=(await list()).items.find(x=>x.message_id==='first').receipt_id;
 const before=(await one("SELECT jsonb_agg(to_jsonb(t) ORDER BY id) value FROM exam_document_delivery t WHERE document_id=$1",[doc])).value;
 const saved=await resolve(receipt);assert.equal(saved.disposition,'saved');assert.equal(saved.already_saved,false);assert.equal(saved.sha256,'c'.repeat(64));
 assert.equal((await resolve(receipt)).already_saved,true);assert.equal((await list()).items.length,2);
 const after=(await one("SELECT jsonb_agg(to_jsonb(t) ORDER BY id) value FROM exam_document_delivery t WHERE document_id=$1",[doc])).value;assert.deepEqual(after,before);
 const incidents=(await one("SELECT count(*)::int n FROM exam_intake_incident WHERE receipt_id=$1 AND state<>'resolved'",[receipt])).n;assert.equal(incidents,0);
});
test('mismatched identity, non-saved and excluded cannot become saved',async()=>{
 const second=(await list()).items.find(x=>x.message_id==='second').receipt_id;
 await assert.rejects(resolve(second),/identity not proven/);
 await db.query("UPDATE exam_intake_receipt SET disposition='excluded' WHERE id=$1",[second]);await assert.rejects(resolve(second),/identity not proven|Excluded/);
 assert.equal((await one('SELECT disposition FROM exam_intake_receipt WHERE id=$1',[second])).disposition,'excluded');
});

