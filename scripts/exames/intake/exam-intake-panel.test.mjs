import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {collectionFixtureDB} from '../../../supabase/tests/collection-db.fixture.mjs';

const repository=fileURLToPath(new URL('../../../',import.meta.url));
let db,role,rpc,metadataBefore,mainRun,completeRun,runningRun,documents={};
const member='20000000-0000-4000-8000-000000000001',outsider='20000000-0000-4000-8000-000000000002';
const account='gmail:panel@example.invalid',now=Date.now();
const recent=new Date(now-60000).toISOString(),old=new Date(now-3*86400000).toISOString();
const manifest={provider:'gmail',account_id:account,scope_kind:'all_mail',policy_version:'intake_v2',sender_policy:'all'};
const one=async(sql,args=[])=>(await db.query(sql,args)).rows[0];
const worker=async()=>{await role('service_role');await db.query("SELECT set_config('request.jwt.claim.sub','',false)");};
const asMember=async(id=member)=>{await role('authenticated');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id]);};
const event=(run,value)=>rpc('record_exam_intake_event',[run.sweep_id,run.run_token,JSON.stringify(value)]);
const begin=name=>rpc('begin_exam_intake_sweep',[name,'a'.repeat(64),JSON.stringify(manifest),new Date(now-4*86400000).toISOString(),new Date(now-1000).toISOString(),crypto.randomUUID(),'audit',900]);
const page=(run,ids)=>event(run,{kind:'page_discovered',partition_key:'mailbox',page_key:'first',page_sha256:'b'.repeat(64),message_ids:ids,is_terminal:true});
const declare=(run,id,attachments=['pdf'])=>event(run,{kind:'origins_declared',partition_key:'mailbox',message_id:id,origins:attachments.map(attachment_id=>({attachment_id,artifact_kind:'attachment'})),...(attachments.length?{}:{policy_code:'nonclinical_fixture'})});
async function preserve(id,sha,extra={}){
 const source={channel:'email',account_id:account,message_id:id,attachment_id:'pdf',original_name:'Panel fixture '+id+'.pdf',received_at:recent,metadata:{},...extra};
 const reserved=await rpc('reserve_exam_document_source',[JSON.stringify(source)]);
 const file={sha256:sha,size_bytes:4321,drive_file_id:'fixture-file-'+reserved.document_id,drive_folder_id:'fixture-folder'};
 const staged=await rpc('stage_exam_document_file',[reserved.document_id,JSON.stringify(file),'fixture-worker']);
 if(staged.claimed)await rpc('confirm_exam_document_file',[staged.document_id,JSON.stringify({...file,drive_file_id:staged.drive_file_id}),staged.lease_token]);
 const sourceRow=await one('SELECT id FROM exam_document_source WHERE account_id=$1 AND message_id=$2 AND attachment_id=$3',[account,id,'pdf']);
 return {document_id:staged.document_id,source_id:sourceRow.id};
}
const panel=async(limit=200)=>{await asMember();const result=await rpc('get_exam_intake_panel',[limit]);await worker();return result;};
const metadata=()=>one("SELECT proowner,proacl::text AS acl FROM pg_proc WHERE oid='public.get_exam_intake_panel(integer)'::regprocedure");

before(async()=>{
 ({db,role,rpc}=await collectionFixtureDB());await db.exec('RESET ROLE');
 for(const name of ['20261016000006_exam_operational_flow.sql','20261016000007_exam_clinical_group_eligibility.sql','20261016000008_exam_gmail_origin_identity.sql','20261016000009_exam_group_after_processing.sql','20261016000010_exam_group_without_identification.sql','20261027000023_exam_intake_receipts_incidents.sql','20261027000024_exam_hopelab_notice_snapshots.sql'])await db.exec(await readFile(join(repository,'supabase/migrations',name),'utf8'));
 metadataBefore=await metadata();await db.exec(await readFile(join(repository,'supabase/migrations/20261027000025_exam_intake_panel_coverage.sql'),'utf8'));
 await db.query('INSERT INTO auth.users(id) VALUES($1),($2)',[member,outsider]);await db.query("INSERT INTO exam_document_member(user_id,role) VALUES($1,'admin')",[member]);
 await worker();await db.query("UPDATE exam_document_configuration SET ingestion_enabled=true,enabled_destinations=ARRAY['drive','processing','group'],notification_cutoff=now()-interval '2 days',group_destination_key='fixture-group'");
 mainRun=await begin('panel-main');await page(mainRun,['no-doc','old-no-doc','empty','saved','unknown-date']);
 for(const id of ['no-doc','old-no-doc','empty','saved'])await event(mainRun,{kind:'message_discovered',partition_key:'mailbox',message_id:id,received_at:id==='old-no-doc'?old:recent});
 await declare(mainRun,'no-doc',['a','b']);await declare(mainRun,'old-no-doc');await declare(mainRun,'unknown-date');await declare(mainRun,'empty',[]);await declare(mainRun,'saved');
 for(const [id,attachment] of [['no-doc','a'],['no-doc','b'],['old-no-doc','pdf'],['unknown-date','pdf']])await event(mainRun,{kind:'origin_outcome',partition_key:'mailbox',message_id:id,attachment_id:attachment,disposition:'pending',code:'fixture_pending'});
 documents.saved=await preserve('saved','1'.repeat(64));
 await event(mainRun,{kind:'origin_outcome',partition_key:'mailbox',message_id:'saved',attachment_id:'pdf',disposition:'saved',...documents.saved});
 await event(mainRun,{kind:'enumeration_complete',expected_message_count:5,page_count:1});await rpc('finish_exam_intake_sweep',[mainRun.sweep_id,mainRun.run_token]);
 for(const [id,hash,extra] of [['uncertain','2',{}],['pending','3',{}],['sent','4',{}],['exception','5',{}],['nonexam','6',{}],['fixture','7',{metadata:{test_fixture:true}}],['historical','8',{received_at:old}]])documents[id]=await preserve(id,hash.repeat(64),extra);
 await db.query("UPDATE exam_document_delivery SET status='uncertain' WHERE document_id=$1 AND destination='group'",[documents.uncertain.document_id]);
 await db.query("UPDATE exam_document_delivery SET status='sent' WHERE document_id=$1 AND destination='group'",[documents.sent.document_id]);
 await db.query("INSERT INTO exam_document_delivery(document_id,destination,destination_key) VALUES($1,'group','old-destination')",[documents.sent.document_id]);
 await db.query("UPDATE exam_document SET group_exception_reason='fixture_human_exception' WHERE id=$1",[documents.exception.document_id]);
 await db.query("UPDATE exam_document SET identification_status='not_exam' WHERE id=$1",[documents.nonexam.document_id]);
 await db.query("INSERT INTO exam_intake_document_hold(document_id,reason) VALUES($1,'changed_content_review')",[documents.pending.document_id]);
 await preserve('same-content-alias','1'.repeat(64));
 completeRun=await begin('panel-complete');await page(completeRun,[]);await event(completeRun,{kind:'enumeration_complete',expected_message_count:0,page_count:1});await rpc('finish_exam_intake_sweep',[completeRun.sweep_id,completeRun.run_token]);
 runningRun=await begin('panel-running');
});
after(async()=>{await db?.close();});

test('panel replacement preserves owner/ACL and member guard rejects anonymous users and outsiders',async()=>{
 await db.exec('RESET ROLE');assert.deepEqual(await metadata(),metadataBefore);
 await role('anon');await assert.rejects(rpc('get_exam_intake_panel',[10]),error=>error.code==='42501');
 await asMember(outsider);await assert.rejects(rpc('get_exam_intake_panel',[10]),error=>error.code==='42501');
 await asMember();await assert.rejects(rpc('get_exam_intake_panel',[null]),/Invalid panel limit/);await worker();
});

test('counts and capped queues use the same deduplicated population, preserving pre-cutoff history separately',async()=>{
 const all=await panel(),limited=await panel(1);
 assert.equal(all.summary.entries_without_document_total,2);assert.equal(all.summary.unresolved_origin_total,3);assert.equal(all.summary.saved_without_group_total,3);assert.equal(all.summary.group_uncertain_total,1);assert.equal(all.summary.version_hold_total,1);assert.equal(all.summary.received_at_unknown_total,1);
 assert.equal(all.historical.pre_cutoff_entries_without_document_total,1);assert.equal(all.historical.pre_cutoff_unresolved_origin_total,1);assert.equal(all.historical.pre_cutoff_saved_without_group_total,1);
 assert.deepEqual(new Set(all.saved_without_group.map(r=>r.document_id)),new Set([documents.saved.document_id,documents.uncertain.document_id,documents.pending.document_id]));
 for(const [list,total,more] of [['entries_without_document','entries_without_document_total','entries_without_document_has_more'],['unresolved_origins','unresolved_origin_total','unresolved_origins_has_more'],['saved_without_group','saved_without_group_total','saved_without_group_has_more'],['group_uncertain','group_uncertain_total','group_uncertain_has_more'],['pending_alerts','pending_alert_total','pending_alert_has_more'],['version_holds','version_hold_total','version_hold_has_more']]){assert.equal(all[list].length,all[total]);assert.equal(limited[list].length,Math.min(1,all[total]));assert.equal(limited[more],all[total]>1);}
 assert.equal(all.version_holds[0].reason,'changed_content_review');assert(all.pending_alert_total>0);
 const serialized=JSON.stringify(all);for(const forbidden of ['lease_token','intake_token','scope_manifest','content_sha256','request_id'])assert(!serialized.includes(forbidden));
});

test('collector window distinguishes complete audit, incomplete processing and an uncompleted running sweep',async()=>{
 const value=await panel();const collector=id=>value.collectors.find(c=>c.collector_id===id);
 assert.equal(collector('panel-main').latest_sweep.id,mainRun.sweep_id);assert.equal(collector('panel-main').latest_sweep.coverageComplete,true);assert.equal(collector('panel-main').latest_sweep.allPreserved,false);assert.equal(collector('panel-main').latest_sweep.scanFinished,false);
 assert.equal(collector('panel-complete').latest_sweep.scanFinished,true);assert.equal(collector('panel-complete').latest_sweep.allPreserved,true);assert.equal(collector('panel-complete').checkpoint.received_through,null);
 assert.equal(collector('panel-running').latest_sweep.coverageComplete,null);assert.equal(collector('panel-running').latest_sweep.scanFinished,null);assert(collector('panel-main').latest_sweep.received_from);assert(collector('panel-main').latest_sweep.received_through);
});

test('panel reads have no side effects and proved group delivery leaves only the remaining queue',async()=>{
 const snapshot=async()=>one("SELECT (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM exam_intake_alert_outbox t) alerts,(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM exam_document_delivery t) deliveries,(SELECT jsonb_agg(to_jsonb(t) ORDER BY document_id) FROM exam_intake_document_hold t) holds,(SELECT jsonb_agg(to_jsonb(t) ORDER BY collector_id) FROM exam_collection_cursor t) checkpoints");
 const before=await snapshot();await panel();assert.deepEqual(await snapshot(),before);
 await db.query("UPDATE exam_document_delivery SET status='sent' WHERE document_id=$1 AND destination='group'",[documents.uncertain.document_id]);
 const recovered=await panel();assert.equal(recovered.saved_without_group_total,2);assert.equal(recovered.group_uncertain_total,0);assert(!recovered.saved_without_group.some(r=>r.document_id===documents.uncertain.document_id));assert.equal(recovered.historical.pre_cutoff_saved_without_group_total,1);
});
