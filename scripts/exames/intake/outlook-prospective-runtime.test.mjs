import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';import{readFile}from'node:fs/promises';
import {collectionFixtureDB} from '../../../supabase/tests/collection-db.fixture.mjs';
import {validateOutlookConfig,loadOutlookState,nextOutlookOperation,applyOutlookResponse,applyOutlookFailure} from './outlook-prospective-runtime.mjs';
const config=()=>({enabled:true,mailbox:'fixture@example.invalid',collectorId:'outlook-new',serviceUrl:'https://fixture.invalid/functions/v1/exam-document-service',provider:'outlook',intakeCutoff:new Date(Date.now()-3600000).toISOString(),activationId:crypto.randomUUID(),maxActions:100,maxMillis:180000,leaseMillis:900000,childWorkflowId:'fixtureChild12345'});
const rows=[{id:'inbox',childFolderCount:1},{id:'archive',childFolderCount:0},{id:'sentitems',childFolderCount:0},{id:'drafts',childFolderCount:0},{id:'outbox',childFolderCount:0}];
test('failed interval is retried even after 10 minutes, alternating with new arrivals indefinitely',()=>{
 const c=config(),now=Date.now(),row=s=>({id:1,collector_key:c.collectorId,revision:s.revision,state_json:JSON.stringify(s)});
 const first=loadOutlookState([],c,'first',now),backfill=first.receivedFrom;
 let completed={...first,phase:'done',progressThrough:first.receivedThrough,pendingBackfillFrom:backfill,replay:false};
 const retry=loadOutlookState([row(completed)],c,'retry',now+11*60000);assert.equal(retry.replay,true);assert.equal(retry.receivedFrom,backfill);
 completed={...retry,phase:'done',progressThrough:first.receivedThrough,pendingBackfillFrom:backfill};
 const live=loadOutlookState([row(completed)],c,'live',now+22*60000);assert.equal(live.replay,false);assert(Date.parse(live.receivedFrom)>Date.parse(backfill));assert.equal(live.pendingBackfillFrom,backfill);
 completed={...live,phase:'done',progressThrough:live.receivedThrough,pendingBackfillFrom:backfill};
 const nextRetry=loadOutlookState([row(completed)],c,'retry-again',now+33*60000);assert.equal(nextRetry.replay,true);assert.equal(nextRetry.receivedFrom,backfill);
 assert.doesNotThrow(()=>validateOutlookConfig({...c,maxActions:200}));assert.throws(()=>validateOutlookConfig({...c,maxActions:201}),/CONFIG_INVALID/);
});
test('resuming an old event queue adds exact metadata and checks saved sources before any replay',()=>{
 const c=config(),now=Date.now(),old=loadOutlookState([],c,'old',now),sweep=crypto.randomUUID();
 const event={kind:'origin_outcome',partition_key:'inbox',message_id:'m1',attachment_id:'outlook-attachment:a1',disposition:'pending',stage:'storage',code:'outlook_attachment_unprocessed'};
 Object.assign(old,{phase:'events',afterEvents:'jobs',sweepId:sweep,runToken:crypto.randomUUID(),lease:{owner:null,until:0},messageQueue:[{id:'m1',received_at:new Date(now-60000).toISOString()}],messageIndex:0,jobs:[{event,kind:'attachment',metadata:{id:'a1',name:'',contentType:'application/pdf'}}],pendingEvents:[event]});
 let s=loadOutlookState([{id:1,collector_key:c.collectorId,revision:old.revision,state_json:JSON.stringify(old)}],c,'new',now);assert.equal(s.pendingEvents[0].kind,'attachment_details');assert.equal(s.pendingEvents[0].position,1);assert.equal(s.pendingEvents[0].display_name,null);
 delete s.resumeRequest;let op=nextOutlookOperation(s,c,now);s=applyOutlookResponse(op,{recorded:true,sweep_id:sweep},c,now);
 s.lease={owner:null,until:0};s=loadOutlookState([{id:1,collector_key:c.collectorId,revision:s.revision,state_json:JSON.stringify(s)}],c,'resumed-again',now);delete s.resumeRequest;assert.equal(s.pendingEvents.filter(x=>x.kind==='attachment_details').length,0);
 op=nextOutlookOperation(s,c,now);assert.equal(op.action,'intake_lookup_source');
 const sourceId=crypto.randomUUID(),docId=crypto.randomUUID();s=applyOutlookResponse(op,{contract:'exam_intake_source_lookup_v1',items:[{message_id:'m1',attachment_id:'outlook-attachment:a1',status:'saved',match_kind:'exact_origin',canonical_file_preserved:true,source_id:sourceId,document_id:docId,source_document_id:docId,sha256:'a'.repeat(64),size_bytes:10}]},c,now);
 op=nextOutlookOperation(s,c,now);assert.equal(op.action,'intake_event');assert.equal(op.payload.event.disposition,'saved');assert.equal(op.state.jobs[0].kind,'saved');
});
test('continues accessible folders with persisted failure for an inconsistent folder',async()=>{
 const {db,rpc,role}=await collectionFixtureDB();try{
 await db.exec('RESET ROLE');
 for(const f of ['20261016000006_exam_operational_flow.sql','20261016000007_exam_clinical_group_eligibility.sql','20261016000008_exam_gmail_origin_identity.sql','20261016000009_exam_group_after_processing.sql','20261016000010_exam_group_without_identification.sql','20261016000011_exam_unique_patient_matching.sql','20261027000023_exam_intake_receipts_incidents.sql','20261027000024_exam_hopelab_notice_snapshots.sql','20261027000026_exam_intake_source_lookup.sql','20261028000030_exam_intake_pending_reconciliation.sql'])await db.exec(await readFile(new URL('../../../supabase/migrations/'+f,import.meta.url),'utf8'));
 const helper=await readFile(new URL('../../../supabase/migrations/20261019000016_exam_hemogram_normalization.sql',import.meta.url),'utf8');await db.exec(helper.slice(helper.indexOf('CREATE FUNCTION public.exam_document_exam_component_heading'),helper.indexOf('REVOKE ALL ON FUNCTION public.exam_document_exam_component_heading')));
 for(const f of ['20261028000031_exam_intake_exam_failures.sql','20261028000035_exam_attention_scope_update.sql','20261028000036_exam_intake_gmail_part_identity.sql','20261028000037_exam_attention_unreadable_files.sql','20261028000038_exam_intake_receipt_details.sql'])await db.exec(await readFile(new URL('../../../supabase/migrations/'+f,import.meta.url),'utf8'));
 await role('service_role');
 const c=validateOutlookConfig(config()),now=Date.now(),state0=loadOutlookState([],c,'fixture-exec',now);let state=state0,childCount=0,finish;
 for(let count=0;count<200;count++){
  const op=nextOutlookOperation(state,c,now);state=op.state;
  if(op.target==='stop'){finish=op.result;break;}
  if(op.target==='backend'){
   const names={intake_begin:'begin_exam_intake_sweep',intake_event:'record_exam_intake_event',intake_finish:'finish_exam_intake_sweep'};
   let values;if(op.action==='intake_begin'){let p=op.payload;values=[p.collector_id,p.scope_key,JSON.stringify(p.scope_manifest),p.received_from,p.received_through,p.request_id,p.mode,p.ttl_seconds];}
   else if(op.action==='intake_event'){let p=op.payload;values=[p.sweep_id,p.run_token,JSON.stringify(p.event)];}
   else if(op.action==='intake_finish'){values=[op.payload.sweep_id,op.payload.run_token];}
   else if(op.action==='intake_lookup_source'){state=applyOutlookResponse(op,{contract:'exam_intake_source_lookup_v1',items:[{message_id:op.payload.identities[0].message_id,attachment_id:op.payload.identities[0].attachment_id,status:'not_found'}]},c,now);continue;}
   else throw Error('unexpected '+op.action);
   state=applyOutlookResponse(op,await rpc(names[op.action],values),c,now);continue;
  }
  if(op.target==='child'){childCount++;state=applyOutlookResponse(op,{pending:true},c,now);continue;}
  let data;
  if(op.slug==='OUTLOOK_LIST_MAIL_FOLDERS')data={value:rows};
  else if(op.slug==='OUTLOOK_GET_MAIL_FOLDER')data={id:op.args.mail_folder_id};
  else if(op.slug==='OUTLOOK_LIST_CHILD_MAIL_FOLDERS')data={value:[]};
  else if(op.slug==='OUTLOOK_QUERY_EMAILS')data={value:op.args.folder==='archive'?[{id:'message',receivedDateTime:new Date(now-60000).toISOString(),from:{emailAddress:{address:'laboratory@example.invalid'}},isDraft:false}]:[]};
  else if(op.slug==='OUTLOOK_LIST_MAIL_FOLDER_MESSAGE_ATTACHMENTS')data={value:[1,2,3,4].map(i=>({id:'part-'+i,'@odata.type':'#microsoft.graph.fileAttachment',name:'',size:100}))};
  else throw Error(op.slug);
  state=applyOutlookResponse(op,{successful:true,data},c,now);
 }
 assert.equal(childCount,4);assert.equal(finish.coverageComplete,false);assert.equal(finish.scanFinished,false);assert(state.issues.some(x=>x.code==='outlook_folder_children_incomplete'));
 const pending=await db.query("SELECT count(*)::int n FROM exam_intake_receipt WHERE disposition='pending'");assert.equal(pending.rows[0].n,4);
 await db.exec('RESET ROLE');const details=await db.query('SELECT position,display_name FROM exam_intake_receipt_detail ORDER BY position');assert.deepEqual(details.rows.map(x=>x.position),[1,2,3,4]);assert(details.rows.every(x=>x.display_name===null));await role('service_role');
 assert(state.pendingBackfillFrom);assert(state.progressThrough);assert.equal(state.retryQueue.length,4);
 let retry=loadOutlookState([{collector_key:c.collectorId,state_json:JSON.stringify(state),revision:state.revision,id:1}],c,'retry-exec',now+300000);
 let operation=nextOutlookOperation(retry,c,now+300000);assert.equal(operation.action,'intake_begin');
 retry=applyOutlookResponse(operation,{sweep_id:crypto.randomUUID(),run_token:crypto.randomUUID()},c,now+300000);
 operation=nextOutlookOperation(retry,c,now+300000);assert.equal(operation.target,'child');
 retry=applyOutlookResponse(operation,{pending:false},c,now+300000);operation=nextOutlookOperation(retry,c,now+300000);assert.equal(operation.action,'intake_lookup_source');
 const sourceId=crypto.randomUUID(),docId=crypto.randomUUID();retry=applyOutlookResponse(operation,{contract:'exam_intake_source_lookup_v1',items:[{...operation.payload.identities[0],status:'saved',match_kind:'exact_origin',canonical_file_preserved:true,source_id:sourceId,document_id:docId,source_document_id:docId,sha256:'a'.repeat(64),size_bytes:10}]},c,now+300000);
 operation=nextOutlookOperation(retry,c,now+300000);assert.equal(operation.action,'intake_resolve_receipt_saved');
 retry=applyOutlookResponse(operation,{contract:'exam_intake_receipt_resolution_v1',...operation.payload,disposition:'saved'},c,now+300000);assert.equal(retry.retryQueue.length,3);
 }finally{await db.close();}
});
test('unsupported attachment pagination persists a failed receipt and advances to next message',()=>{
 const c=config(),now=Date.now(),s=loadOutlookState([],c,'x',now);Object.assign(s,{phase:'messages',sweepId:crypto.randomUUID(),runToken:crypto.randomUUID(),messageQueue:[{id:'A',received_at:new Date(now-1000).toISOString()}],messageIndex:0,scanFolders:['inbox'],mailIndex:0});
 const op=nextOutlookOperation(s,c,now);const failed=applyOutlookFailure(op,c);assert.equal(failed.messageIndex,1);assert(failed.pendingEvents.some(e=>e.kind==='failure'&&e.code==='outlook_attachment_inventory_failed'));assert(failed.issues.length);
});
test('repeated message cursor fails closed and records the folder failure',()=>{
 const c=config(),now=Date.now(),s=loadOutlookState([],c,'x',now);Object.assign(s,{phase:'mail_page',sweepId:crypto.randomUUID(),runToken:crypto.randomUUID(),scanFolders:['inbox'],mailIndex:0,mailTokens:['previous'],mailSeen:[],mailCursor:'current'});
 const op=nextOutlookOperation(s,c,now);assert.throws(()=>applyOutlookResponse(op,{successful:true,data:{value:[],next_page_token:'previous'}},c,now),/PAGINATION_CYCLE/);
 const failed=applyOutlookFailure(op,c);assert.equal(failed.mailIndex,1);assert(failed.pendingEvents.some(e=>e.kind==='failure'&&e.code==='outlook_message_listing_failed'));
});

test('deleted source exits current lookup and retry queues without reprocessing',()=>{
 const c=config(),now=Date.now(),event={kind:'origin_outcome',partition_key:'inbox',message_id:'deleted-mail',attachment_id:'outlook-attachment:deleted',disposition:'pending',stage:'storage',code:'pending'};
 const ack={contract:'exam_intake_source_lookup_v1',items:[{message_id:event.message_id,attachment_id:event.attachment_id,status:'excluded',reason:'user_deleted'}]};
 let state=loadOutlookState([],c,'deletion',now);Object.assign(state,{phase:'events',outcomeLookup:event,pendingEvents:[event],jobs:[{event,kind:'attachment'}]});
 state=applyOutlookResponse({target:'backend',action:'intake_lookup_source',state},ack,c,now);
 assert.equal(state.pendingEvents[0].disposition,'excluded');assert.equal(state.jobs[0].kind,'review');
 assert.throws(()=>applyOutlookResponse({target:'backend',action:'intake_lookup_source',state:{...state,outcomeLookup:event}}, {...ack,items:[{...ack.items[0],reason:'unknown'}]},c,now),/LOOKUP_ACK_INVALID/);
 Object.assign(state,{phase:'lookup',lookupEvent:event,retrying:true,retryRemaining:1,retryQueue:[{event}],pendingEvents:[]});
 state=applyOutlookResponse({target:'backend',action:'intake_lookup_source',state},ack,c,now);
 assert.equal(state.phase,'retry_jobs');assert.equal(state.retryQueue.length,0);assert.equal(state.retryRemaining,0);
});
