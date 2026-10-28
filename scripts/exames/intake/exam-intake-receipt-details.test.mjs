import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {collectionFixtureDB} from '../../../supabase/tests/collection-db.fixture.mjs';
let db,role,rpc,run;const member='20000000-0000-4000-8000-000000000001',account='gmail:fixture@example.invalid',collector='details-fixture',message='deadbeef',partition='mailbox',at=new Date(Date.now()-40*60000).toISOString();
const one=async(sql,p=[])=>(await db.query(sql,p)).rows[0];
const event=async(e)=>rpc('record_exam_intake_event',[run.sweep_id,run.run_token,JSON.stringify(e)]);
const attachment=i=>'gmail-part:'+JSON.stringify([String(i),'old-'+i]);
const detail=i=>({kind:'attachment_details',partition_key:partition,message_id:message,attachment_id:attachment(i),received_at:at,position:i,display_name:i===4?null:`fixture-${i}.pdf`,mime_type:'application/pdf',sender:'lab@example.invalid'});
async function memberRole(){await role('authenticated');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[member]);}
async function save(i){
 await role('service_role');const newId='gmail-part:'+JSON.stringify([String(i),'new-'+i]);
 const src={channel:'email',account_id:account,message_id:message,attachment_id:newId,original_name:'fixture.pdf',mime_type:'application/pdf',received_at:at,metadata:{provider:'gmail',mailbox:'fixture@example.invalid',gmail_message_id:message,gmail_part_id:String(i),gmail_attachment_id:'new-'+i}};
 const reserved=await rpc('reserve_exam_document_source',[JSON.stringify(src)]);const file={sha256:String(i).repeat(64),size_bytes:100,drive_file_id:'test-'+i,drive_folder_id:'folder'};
 const staged=await rpc('stage_exam_document_file',[reserved.document_id,JSON.stringify(file),'worker']);await rpc('confirm_exam_document_file',[staged.document_id,JSON.stringify(file),staged.lease_token]);
 const row=await one('SELECT id FROM exam_document_source WHERE document_id=$1',[staged.document_id]);
 await event({kind:'origin_outcome',partition_key:partition,message_id:message,attachment_id:attachment(i),disposition:'saved',source_id:row.id,document_id:staged.document_id});
 await db.exec('RESET ROLE');await db.query("INSERT INTO exam_document_delivery(document_id,destination,status) VALUES($1,'processing','completed'),($1,'group','sent') ON CONFLICT(document_id,destination,destination_key) DO UPDATE SET status=excluded.status",[staged.document_id]);
}
before(async()=>{
 ({db,role,rpc}=await collectionFixtureDB());await db.exec('RESET ROLE');
 for(const name of ['20261016000006_exam_operational_flow.sql','20261016000007_exam_clinical_group_eligibility.sql','20261016000008_exam_gmail_origin_identity.sql','20261016000009_exam_group_after_processing.sql','20261016000010_exam_group_without_identification.sql','20261016000011_exam_unique_patient_matching.sql','20261027000023_exam_intake_receipts_incidents.sql','20261027000024_exam_hopelab_notice_snapshots.sql','20261027000026_exam_intake_source_lookup.sql','20261028000030_exam_intake_pending_reconciliation.sql'])await db.exec(await readFile(new URL('../../../supabase/migrations/'+name,import.meta.url),'utf8'));
 const helper=await readFile(new URL('../../../supabase/migrations/20261019000016_exam_hemogram_normalization.sql',import.meta.url),'utf8');await db.exec(helper.slice(helper.indexOf('CREATE FUNCTION public.exam_document_exam_component_heading'),helper.indexOf('REVOKE ALL ON FUNCTION public.exam_document_exam_component_heading')));
 for(const name of ['20261028000031_exam_intake_exam_failures.sql','20261028000035_exam_attention_scope_update.sql','20261028000036_exam_intake_gmail_part_identity.sql','20261028000037_exam_attention_unreadable_files.sql','20261028000038_exam_intake_receipt_details.sql','20261028000039_exam_attention_completed_delivery.sql'])await db.exec(await readFile(new URL('../../../supabase/migrations/'+name,import.meta.url),'utf8'));
 await db.query('INSERT INTO auth.users(id) VALUES($1)',[member]);await db.query("INSERT INTO exam_document_member(user_id,role) VALUES($1,'admin')",[member]);
 await db.query("UPDATE exam_document_configuration SET ingestion_enabled=true,attention_cutoff=now()-interval '2 hours',attention_gmail_collector_id=$1",[collector]);await role('service_role');
 const manifest={provider:'gmail',account_id:account,scope_kind:'mailbox',policy_version:'intake_v2',sender_policy:'all',include_spam_trash:true,include_deleted:false,initial_received_from:new Date(Date.now()-7200000).toISOString(),lookback_seconds:86400};
 run=await rpc('begin_exam_intake_sweep',[collector,'a'.repeat(64),JSON.stringify(manifest),new Date(Date.now()-7200000).toISOString(),new Date(Date.now()-1000).toISOString(),crypto.randomUUID(),'audit',900]);
 await event({kind:'page_discovered',partition_key:partition,page_key:'1',page_sha256:'b'.repeat(64),message_ids:[message],is_terminal:true});
 await event({kind:'message_discovered',partition_key:partition,message_id:message,received_at:at});
 await event({kind:'origins_declared',partition_key:partition,message_id:message,origins:[1,2,3,4].map(i=>({attachment_id:attachment(i),artifact_kind:'attachment'}))});
 for(let i=1;i<=4;i++){await event(detail(i));await event({kind:'origin_outcome',partition_key:partition,message_id:message,attachment_id:attachment(i),disposition:'pending',stage:'storage',code:'source_not_found'});}
});
after(async()=>db?.close());
test('detail writes are service-only, fenced, idempotent, sanitized and bound to message timestamp',async()=>{
 await role('anon');await assert.rejects(event(detail(1)));await memberRole();await assert.rejects(event(detail(1)));
 await role('service_role');await event(detail(1));await event({kind:'attachment_retry_failed',partition_key:partition,message_id:message,attachment_id:attachment(4),code:'source_reservation_unproven'});assert.equal((await one('SELECT reason_code FROM exam_intake_receipt WHERE collector_id=$1 AND message_id=$2 AND attachment_id=$3',[collector,message,attachment(4)])).reason_code,'source_reservation_unproven');await assert.rejects(event({...detail(1),display_name:'altered'}),/replay conflicts/);
 await assert.rejects(event({...detail(1),display_name:'https://example.invalid/'}));await assert.rejects(event({...detail(1),received_at:new Date(Date.now()).toISOString()}));
 await assert.rejects(event({...detail(1),position:0}));await role('authenticated');await assert.rejects(db.query('SELECT * FROM exam_intake_receipt_detail'));
});
test('four attachments, three preserved: exactly the unnamed fourth remains; all four saved clears queue',async()=>{
 for(let i=1;i<=3;i++)await save(i);
 await db.exec('RESET ROLE');await db.query("INSERT INTO exam_intake_receipt(collector_id,partition_key,message_id,attachment_id,artifact_kind,disposition,reason_code) VALUES($1,$2,$3,$4,'attachment','pending','source_not_found')",[collector,partition,message,'gmail-part:'+JSON.stringify(['4','alternate-locator'])]);
 await memberRole();let page=await rpc('get_exam_intake_exam_failures',[100,0]);assert.equal(page.total,1);assert.equal(page.rows[0].row_kind,'receipt');assert.equal(page.rows[0].position,4);assert.equal(page.rows[0].original_name,null);assert.equal(page.rows[0].sender,'lab@example.invalid');assert.equal(page.rows[0].document_id,null);
 await save(4);await role('service_role');await event({kind:'attachment_retry_failed',partition_key:partition,message_id:message,attachment_id:attachment(4),code:'source_reservation_unproven'});assert.equal((await one('SELECT disposition FROM exam_intake_receipt WHERE collector_id=$1 AND message_id=$2 AND attachment_id=$3',[collector,message,attachment(4)])).disposition,'saved');await memberRole();page=await rpc('get_exam_intake_exam_failures',[100,0]);assert.equal(page.total,0);
});

test('completed unidentified saved PDF with group pending remains visible for review',async()=>{
 await db.exec('RESET ROLE');const doc=await one("SELECT document_id FROM exam_intake_receipt WHERE collector_id=$1 AND attachment_id=$2",[collector,attachment(4)]);
 await db.query("DELETE FROM exam_document_event WHERE document_id=$1 AND event_type='reviewed'",[doc.document_id]);
 await db.query("UPDATE exam_document_delivery SET status='pending' WHERE document_id=$1 AND destination='group'",[doc.document_id]);
 await memberRole();const v=await rpc('get_exam_intake_exam_failures',[100,0]),row=v.rows.find(x=>x.document_id===doc.document_id);assert(row);assert.equal(row.reason,'review_file');assert.equal(row.pet_name,null);assert.equal(row.exam_type,null);assert.equal(row.issue_kind,'processing');
 await db.exec('RESET ROLE');await db.query("UPDATE exam_document_delivery SET status='sent' WHERE document_id=$1 AND destination='group'",[doc.document_id]);
 await db.query("UPDATE exam_document SET mime_type='application/octet-stream' WHERE id=$1",[doc.document_id]);
 await memberRole();assert.equal((await rpc('get_exam_intake_exam_failures',[100,0])).rows.find(x=>x.document_id===doc.document_id),undefined);
 await db.exec('RESET ROLE');await db.query("UPDATE exam_document_delivery SET status='waived' WHERE document_id=$1 AND destination='group'",[doc.document_id]);await memberRole();assert.equal((await rpc('get_exam_intake_exam_failures',[100,0])).rows.find(x=>x.document_id===doc.document_id),undefined);
 await db.exec('RESET ROLE');await db.query("UPDATE exam_document_delivery SET status='failed' WHERE document_id=$1 AND destination='group'",[doc.document_id]);await memberRole();assert((await rpc('get_exam_intake_exam_failures',[100,0])).rows.some(x=>x.document_id===doc.document_id));
 await db.exec('RESET ROLE');await db.query("UPDATE exam_document_delivery SET status='sent' WHERE document_id=$1 AND destination='group'",[doc.document_id]);await db.query("UPDATE exam_document_delivery SET status='failed' WHERE document_id=$1 AND destination='processing'",[doc.document_id]);await memberRole();assert((await rpc('get_exam_intake_exam_failures',[100,0])).rows.some(x=>x.document_id===doc.document_id));
 await db.exec('RESET ROLE');await db.query("UPDATE exam_document_delivery SET status='completed' WHERE document_id=$1 AND destination='processing'",[doc.document_id]);
});
test('a pending real attachment without details stays visible when received time is known',async()=>{
 await role('service_role');const msg='feedbeef';await event({kind:'message_discovered',partition_key:partition,message_id:msg,received_at:at});await event({kind:'origins_declared',partition_key:partition,message_id:msg,origins:[{attachment_id:'part-without-details',artifact_kind:'attachment'}]});
 await event({kind:'origin_outcome',partition_key:partition,message_id:msg,attachment_id:'part-without-details',disposition:'pending',stage:'storage',code:'source_reservation_unproven'});
 await memberRole();const v=await rpc('get_exam_intake_exam_failures',[100,0]),row=v.rows.find(x=>x.row_kind==='receipt');assert(row);assert.equal(row.position,null);assert.equal(row.original_name,null);assert.equal(Date.parse(row.received_at),Date.parse(at));assert.equal(row.reason,'source_reservation_unproven');
});

test('unresolved discovered attachment appears only after its running sweep has expired',async()=>{
 await role('service_role');const msg='cafeaaaa';await event({kind:'message_discovered',partition_key:partition,message_id:msg,received_at:at});await event({kind:'origins_declared',partition_key:partition,message_id:msg,origins:[{attachment_id:'undecided-attachment',artifact_kind:'attachment'}]});
 await memberRole();let v=await rpc('get_exam_intake_exam_failures',[100,0]);assert.equal(v.rows.filter(r=>r.row_kind==='receipt').length,1);
 await db.exec('RESET ROLE');await db.query("UPDATE exam_collection_sweep SET started_at=now()-interval '1 hour',expires_at=now()-interval '1 second' WHERE id=$1",[run.sweep_id]);
 await memberRole();v=await rpc('get_exam_intake_exam_failures',[100,0]);assert.equal(v.rows.filter(r=>r.row_kind==='receipt').length,2);
});
