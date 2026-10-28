import test,{before,after} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import crypto from 'node:crypto';
import {collectionFixtureDB} from '../../../supabase/tests/collection-db.fixture.mjs';
import {loadAuditState,nextAuditOperation,applyAuditResponse,applyAuditFailure,auditPersistenceRow,verifyAuditPersistence,auditManifest} from './whatsapp-prospective-audit-runtime.mjs';
let db,rpc,role;const account='chatwoot:1:inbox:2';
before(async()=>{({db,rpc,role}=await collectionFixtureDB());await db.exec('RESET ROLE');
 for(const f of ['20261016000006_exam_operational_flow.sql','20261016000007_exam_clinical_group_eligibility.sql','20261016000008_exam_gmail_origin_identity.sql','20261016000009_exam_group_after_processing.sql','20261016000010_exam_group_without_identification.sql','20261016000011_exam_unique_patient_matching.sql','20261027000023_exam_intake_receipts_incidents.sql','20261027000024_exam_hopelab_notice_snapshots.sql','20261027000026_exam_intake_source_lookup.sql','20261028000030_exam_intake_pending_reconciliation.sql','20261028000034_exam_intake_authorized_chatwoot_scope.sql'])await db.exec(await readFile(new URL('../../../supabase/migrations/'+f,import.meta.url),'utf8'));
 const helper=await readFile(new URL('../../../supabase/migrations/20261019000016_exam_hemogram_normalization.sql',import.meta.url),'utf8');await db.exec(helper.slice(helper.indexOf('CREATE FUNCTION public.exam_document_exam_component_heading'),helper.indexOf('REVOKE ALL ON FUNCTION public.exam_document_exam_component_heading')));
 for(const f of ['20261028000031_exam_intake_exam_failures.sql','20261028000035_exam_attention_scope_update.sql','20261028000036_exam_intake_gmail_part_identity.sql','20261028000037_exam_attention_unreadable_files.sql','20261028000038_exam_intake_receipt_details.sql'])await db.exec(await readFile(new URL('../../../supabase/migrations/'+f,import.meta.url),'utf8'));
 await role('service_role');await db.query("UPDATE exam_document_configuration SET ingestion_enabled=true,enabled_destinations=ARRAY['drive','processing','group'],notification_cutoff=now()-interval '1 day',group_destination_key='fixture-group'");});
after(async()=>db?.close());
const sender={id:5,type:'contact',phone_number:'+55 11 99999-9999'},conversation={id:3,account_id:1,inbox_id:2,created_at:1700000000,meta:{sender},contact_inbox:{source_id:'5511999999999'}};
const cutoff=new Date(Date.now()-3600000).toISOString();
const cfg={enabled:true,allowScheduled:true,provider:'chatwoot',collectorId:'chatwoot_prospective_'+crypto.createHash('sha256').update(cutoff).digest('hex').slice(0,16),
 dataTableId:'table-fixture',serviceUrl:'https://api.example.invalid/functions/v1/exam-document-service',mailbox:'audit@example.invalid',accountId:'1',inboxId:'2',chatwootBaseUrl:'https://chat.example.invalid',
 intakeCutoff:cutoff,authorizedSenders:['5511999999999'],allowBrazilLegacyMobileAlias:false,continuous:true,prospective:true,bridgeEnabled:true,bridgeWorkflowId:'child-fixture',recheckPending:true,resumeFence:true,
 overlapSeconds:300,maxRepeatedFailures:3,notificationMode:'home_only',monitoring:false,auditLookbackSeconds:86400,maxActions:200,maxMillis:180000,leaseMillis:900000};
async function preserve(index,now){
 const attachment='chatwoot-attachment:'+(600+index),source={channel:'whatsapp',account_id:account,message_id:'44',attachment_id:attachment,original_name:'original.pdf',mime_type:'application/pdf',received_at:new Date(now-60000).toISOString(),metadata:{provider:'chatwoot',chatwoot_account_id:'1',chatwoot_inbox_id:'2',chatwoot_conversation_id:'3',chatwoot_message_id:'44',chatwoot_attachment_id:String(600+index)}};
 const reserved=await rpc('reserve_exam_document_source',[JSON.stringify(source)]),file={sha256:String(index+1).repeat(64),size_bytes:100,drive_file_id:'fixture-file-'+index,drive_folder_id:'fixture-folder'};
 const stage=await rpc('stage_exam_document_file',[reserved.document_id,JSON.stringify(file),'fixture-worker']);
 await rpc('confirm_exam_document_file',[stage.document_id,JSON.stringify({...file,drive_file_id:stage.drive_file_id}),stage.lease_token]);
}
async function run(row,withMessage,saveIndices){
 const clock=Date.now();let state=loadAuditState(row?[row]:[],cfg,'fixture-run',clock),bridges=0;
 for(let step=0;step<1000;step++){
  const saved=auditPersistenceRow(state,cfg);state=verifyAuditPersistence([{...saved,id:1}],saved);
  const ctx=nextAuditOperation(state,cfg,Date.now());if(ctx.target==='stop')return {state,result:ctx.result,row:{id:1,collector_key:saved.collector_key,state_json:saved.state_json,revision:saved.revision},bridges};
  let body;
  if(ctx.target==='bridge'){
   bridges++;const pending=await db.query('SELECT disposition FROM exam_intake_receipt WHERE collector_id=$1 AND message_id=$2',[cfg.collectorId,'44']);assert(pending.rows.length>=1);assert(pending.rows.some(x=>x.disposition==='pending'));
   assert.equal(ctx.payload.conversation_id,'3');assert.equal(ctx.payload.message_id,'44');assert.equal(ctx.payload.attachment_ids.length,1);
   const index=Number(ctx.payload.attachment_ids[0].split(':')[1])-600;if(saveIndices.includes(index))await preserve(index,clock);
   body={completed:true,...(!withMessage&&!saveIndices.includes(index)?{issue:{message_id:'44',attachment_id:ctx.payload.attachment_ids[0],reason:'pdf_url_missing_or_untrusted'}}:{})};
  }else if(ctx.target==='chatwoot'){
   if(ctx.state.phase==='chatwoot_conversations')body={data:{payload:withMessage&&ctx.state.cursor===1?[conversation]:[]}};
   else body={payload:withMessage&&ctx.state.cursor===null?[{id:44,conversation_id:3,message_type:'incoming',private:false,created_at:new Date(clock-60000).toISOString(),attachments:Array.from({length:4},(_,i)=>({id:600+i,file_name:`fixture-${i+1}.pdf`,content_type:'application/pdf'}))},
     {id:43,conversation_id:3,message_type:'incoming',private:false,created_at:new Date(Date.parse(cutoff)-1000).toISOString(),attachments:[{id:699}]}]:[]};
  }else{
   const p=ctx.payload;
   if(ctx.action==='intake_begin')body=await rpc('begin_exam_intake_sweep',[p.collector_id,p.scope_key,JSON.stringify(p.scope_manifest),p.received_from,p.received_through,p.request_id,p.mode,p.ttl_seconds]);
   else if(ctx.action==='intake_resume')body=await rpc('resume_exam_intake_sweep',[p.collector_id,p.scope_key,p.request_id,p.sweep_id,p.run_token,p.resume_request_id,p.ttl_seconds]);
   else if(ctx.action==='intake_event')body=await rpc('record_exam_intake_event',[p.sweep_id,p.run_token,JSON.stringify(p.event)]);
   else if(ctx.action==='intake_lookup_source')body=await rpc('lookup_exam_intake_sources',[p.collector_id,JSON.stringify(p.identities)]);
   else if(ctx.action==='intake_list_pending_sources')body=await rpc('list_exam_intake_pending_sources',[p.collector_id,p.after_receipt_id,p.limit]);
   else if(ctx.action==='intake_resolve_receipt_saved')body=await rpc('resolve_exam_intake_receipt_saved',[p.receipt_id,p.source_id,p.document_id]);
   else if(ctx.action==='intake_finish')body=await rpc('finish_exam_intake_sweep',[p.sweep_id,p.run_token]);else throw new Error('Unexpected action');
  }
  try{state=applyAuditResponse(ctx,{statusCode:200,body},cfg,Date.now());}catch(error){state=applyAuditFailure(ctx,error.message,Date.now());}
 }throw new Error('Fixture did not complete');
}
test('four WhatsApp attachments create durable receipts; missing one remains pending, old message untouched, then retry resolves exact source',async()=>{
 const first=await run(null,true,[0,1,2]);assert.equal(first.bridges,4);assert.equal(first.result.localEnumerationComplete,true);assert.equal(first.result.coverageComplete,false);assert.equal(first.result.scanFinished,false);assert.equal(first.result.checkpointAdvanced,false);
 const receipts=await db.query('SELECT message_id,disposition FROM exam_intake_receipt WHERE collector_id=$1 ORDER BY attachment_id',[cfg.collectorId]);
 assert.equal(receipts.rows.length,4);assert(receipts.rows.every(x=>x.message_id==='44'));assert.equal(receipts.rows.filter(x=>x.disposition==='saved').length,3);assert.equal(receipts.rows.filter(x=>x.disposition==='pending').length,1);
 await db.exec('RESET ROLE');const details=await db.query('SELECT d.position,d.display_name,r.reason_code FROM exam_intake_receipt_detail d JOIN exam_intake_receipt r ON r.id=d.receipt_id WHERE r.collector_id=$1 ORDER BY d.position',[cfg.collectorId]);await role('service_role');
 assert.deepEqual(details.rows.map(x=>x.display_name),['fixture-1.pdf','fixture-2.pdf','fixture-3.pdf','fixture-4.pdf']);assert.equal(details.rows[3].reason_code,'attachment_not_preserved');
 const retry=await run(first.row,false,[]);assert.equal(retry.bridges,1);
 const reason=await db.query("SELECT reason_code FROM exam_intake_receipt WHERE collector_id=$1 AND disposition='pending'",[cfg.collectorId]);assert.equal(reason.rows[0].reason_code,'pdf_url_missing_or_untrusted');
 const later=await run(retry.row,false,[3]);assert.equal(later.bridges,1);
 const remaining=await db.query("SELECT count(*)::int n FROM exam_intake_receipt WHERE collector_id=$1 AND disposition='pending'",[cfg.collectorId]);assert.equal(remaining.rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int n FROM exam_document_source')).rows[0].n,4);
 assert.equal((await db.query('SELECT monitored FROM exam_intake_health WHERE collector_id=$1',[cfg.collectorId])).rows[0].monitored,false);
});
test('all-individual scope is bound to account, inbox and processing allowlist hash without weakening existing scope access',async()=>{
 const manifest=auditManifest(cfg);assert.equal(manifest.sender_policy,'all');assert.match(manifest.sender_policy_sha256,/^[a-f0-9]{64}$/);assert(!JSON.stringify(manifest).includes(cfg.authorizedSenders[0]));
 const invoke=(id,scope)=>rpc('begin_exam_intake_sweep',[id,'b'.repeat(64),JSON.stringify(scope),new Date(Date.now()-120000).toISOString(),new Date(Date.now()-1000).toISOString(),crypto.randomUUID(),'audit',900]);
 for(const [i,bad] of [{...manifest,provider:'gmail',sender_policy:'authorized_only'},{...manifest,scope_kind:'inbox:99:individual'},{...manifest,sender_policy_sha256:'bad'},
  {...manifest,account_id:'chatwoot:1:inbox:99'},{...manifest,sender_policy:null},{provider:'gmail',account_id:'gmail:fixture@example.invalid',scope_kind:'mailbox',policy_version:'intake_v2',sender_policy:'all',sender_policy_sha256:'not-a-hash'}].entries())await assert.rejects(invoke('invalid-scope-'+i,bad),/scope|sender/i);
 const legacy=await invoke('legacy-all-scope',{provider:'gmail',account_id:'gmail:fixture@example.invalid',scope_kind:'mailbox',policy_version:'intake_v2',sender_policy:'all'});assert.equal(legacy.mode,'audit');
 await role('authenticated');await assert.rejects(invoke('member-forbidden',manifest),e=>e.code==='42501');await role('service_role');
});
