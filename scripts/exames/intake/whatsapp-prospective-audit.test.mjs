import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';import vm from 'node:vm';
import {createRequire} from 'node:module';const require=createRequire(import.meta.url);
import {buildWhatsappWorkflow} from '../whatsapp-intake-build.mjs';
import {buildWhatsappProspectiveAudit} from './whatsapp-prospective-audit-build.mjs';
import {loadAuditState,nextAuditOperation,applyAuditResponse,applyAuditFailure,validateAuditConfig,auditManifest} from './whatsapp-prospective-audit-runtime.mjs';

const cutoff='2026-10-28T10:00:00.000Z',now=Date.parse('2026-10-28T12:00:00.000Z'),sweep='11111111-1111-4111-8111-111111111111',token='22222222-2222-4222-8222-222222222222';
const cfg={enabled:true,allowScheduled:true,provider:'chatwoot',collectorId:'chatwoot_prospective_'+crypto.createHash('sha256').update(cutoff).digest('hex').slice(0,16),
 dataTableId:'table-fixture',serviceUrl:'https://api.example.invalid/functions/v1/exam-document-service',mailbox:'exames@example.invalid',accountId:'1',inboxId:'2',chatwootBaseUrl:'https://chat.example.invalid',
 intakeCutoff:cutoff,authorizedSenders:['5511999999999'],allowBrazilLegacyMobileAlias:false,continuous:true,prospective:true,bridgeEnabled:true,bridgeWorkflowId:'child-fixture',recheckPending:true,
 overlapSeconds:300,maxRepeatedFailures:3,notificationMode:'home_only',monitoring:false,auditLookbackSeconds:86400,maxActions:200,maxMillis:180000,leaseMillis:900000};
const sender={id:5,type:'contact',phone_number:'+55 11 99999-9999'},conversation={id:3,account_id:1,inbox_id:2,created_at:1700000000,meta:{sender},contact_inbox:{source_id:'5511999999999'}};
const stranger={id:6,type:'contact',phone_number:'+55 11 98888-8888'};
const start=()=>({...loadAuditState([],cfg,'execution',now),phase:'chatwoot_conversations',cursor:1,sweepId:sweep,runToken:token});
const apply=(state,body)=>{const ctx=nextAuditOperation(state,cfg,now);return applyAuditResponse(ctx,{statusCode:200,body},cfg,now);};
function drain(state){const events=[];let ctx=nextAuditOperation(state,cfg,now);while(ctx.target==='backend'&&ctx.action==='intake_event'){
 events.push(ctx.payload.event);state=applyAuditResponse(ctx,{statusCode:200,body:{recorded:true,sweep_id:sweep}},cfg,now);ctx=nextAuditOperation(state,cfg,now);
 }return {state,ctx,events};}
const missing=(message,attachment)=>({message_id:String(message),attachment_id:attachment,status:'not_found',reason:'source_missing'});
const saved=(message,attachment)=>({message_id:String(message),attachment_id:attachment,status:'saved',reason:'source_saved',match_kind:'exact_origin',canonical_file_preserved:true,
 source_id:'33333333-3333-4333-8333-333333333333',document_id:'44444444-4444-4444-8444-444444444444',source_document_id:'44444444-4444-4444-8444-444444444444',sha256:'a'.repeat(64),size_bytes:123,file_status:'saved'});
const lookup=items=>({contract:'exam_intake_source_lookup_v1',items});

test('conversation pages request creation ordering and fail visibly on a decrease across pages',()=>{
 let state=start(),ctx=nextAuditOperation(state,cfg,now);assert.match(ctx.url,/sort_by=created_at_asc/);
 state=applyAuditResponse(ctx,{statusCode:200,body:{data:{payload:[conversation]}}},cfg,now);
 state=drain(state).state;ctx=nextAuditOperation(state,cfg,now);
 assert.throws(()=>applyAuditResponse(ctx,{statusCode:200,body:{data:{payload:[{...conversation,id:4,created_at:1699999999}]}}},cfg,now),/CONVERSATION_ORDER_UNPROVEN/);
 state=applyAuditFailure(ctx,'INTAKE_AUDIT_CONVERSATION_ORDER_UNPROVEN',now);
 const d=drain(state);assert.equal(d.events[0].kind,'failure');assert.equal(d.events[0].code,'intake_audit_conversation_order_unproven');assert.equal(d.ctx.target,'stop');
});

test('timestamp ties do not falsely reject display IDs and missing creation time is an explicit error',()=>{
 let state=start();state=apply(state,{data:{payload:[{...conversation,id:8},{...conversation,id:3}]}});
 assert.deepEqual(state.conversationIds,['8','3']);
 assert.throws(()=>apply(start(),{data:{payload:[{...conversation,created_at:undefined}]}}),/CONVERSATION_PAGE_INVALID/);
});

test('inactive parent contains 5-minute schedule and child bridge with no webhook',async()=>{
 const source=await buildWhatsappWorkflow({config:{enabled:true,accountId:'1',inboxId:'2',chatwootBaseUrl:'https://chat.example.invalid',serviceUrl:cfg.serviceUrl,authorizedSenders:cfg.authorizedSenders,allowedAttachmentOrigins:[],intakeCutoff:'2026-10-01T00:00:00.000Z'}});
 const parent=buildWhatsappProspectiveAudit(source,'table-fixture',cutoff,'child-fixture');assert.equal(parent.active,false);
 assert(!parent.nodes.some(n=>n.type.endsWith('.webhook')));const schedule=parent.nodes.find(n=>n.type.endsWith('.scheduleTrigger'));assert.equal(schedule.parameters.rule.interval[0].minutesInterval,5);
 assert.equal(parent.nodes.find(n=>n.name==='Processar WhatsApp prospectivo').parameters.options.waitForSubWorkflow,true);
 for(const n of parent.nodes.filter(n=>n.type.endsWith('.code')))new vm.Script('(async()=>{'+n.parameters.jsCode+'})()');
 const configScript=new vm.Script('(async()=>{'+parent.nodes.find(n=>n.name==='Configuração de auditoria').parameters.jsCode+'})()');
 const builtCfg=(await configScript.runInNewContext({$execution:{mode:'trigger'},require,Buffer,Date,Set}))[0].json;assert.equal(builtCfg.provider,'chatwoot');assert.equal(builtCfg.collectorId,cfg.collectorId);
 const filters=parent.nodes.filter(n=>n.type.endsWith('.dataTable')).flatMap(n=>n.parameters?.filters?.conditions||[]).filter(c=>c.keyName==='collector_key');
 assert.equal(filters.length,3);assert(filters.every(c=>c.keyValue===builtCfg.collectorId));
 const manual=buildWhatsappProspectiveAudit(source,'table-fixture',cutoff,'child-fixture',{manualOnly:true});
 assert(manual.nodes.find(n=>n.type.endsWith('.scheduleTrigger')).disabled);
 const manualCode=manual.nodes.find(n=>n.name==='Configuração de auditoria').parameters.jsCode,manualStart=manualCode.lastIndexOf('const cfg=')+'const cfg='.length;
 const manualCfg=JSON.parse(manualCode.slice(manualStart,manualCode.indexOf(';validateAuditConfig',manualStart)));
 assert.equal(manualCfg.allowScheduled,false);assert.equal(manualCfg.bridgeEnabled,true);assert.throws(()=>validateAuditConfig(manualCfg,'trigger'),/MANUAL_REVIEW_ONLY/);
 const canary=buildWhatsappProspectiveAudit(source,'table-fixture',cutoff,'child-fixture',{canaryConversationId:'3',canaryMessageId:'44'});assert(canary.nodes.find(n=>n.type.endsWith('.scheduleTrigger')).disabled);
 const code=canary.nodes.find(n=>n.name==='Configuração de auditoria').parameters.jsCode,at=code.lastIndexOf('const cfg=')+'const cfg='.length,end=code.indexOf(';validateAuditConfig',at),canaryCfg=JSON.parse(code.slice(at,end));
 assert.notEqual(canaryCfg.collectorId,cfg.collectorId);assert.match(auditManifest(canaryCfg).scope_kind,/:canary$/);validateAuditConfig(canaryCfg,'test');
});
test('a restricted canary never reports complete coverage or carries a coverage checkpoint',()=>{
 const c={...cfg,allowScheduled:false,canary:true,canaryConversationId:'3',canaryMessageId:'44'};
 const state={...loadAuditState([],c,'fixture',now),phase:'done',finishResult:{coverageComplete:true,scanFinished:true,checkpointAdvanced:false}};
 const result=nextAuditOperation(state,c,now).result;assert.equal(result.coverageComplete,false);assert.equal(result.scanFinished,false);assert.equal(result.scopeLimited,true);assert.equal(result.auditCoverageThrough,null);
});
test('an old permanently failing window cannot block new windows and remains in the retry queue',()=>{
 const later=Date.parse(cutoff)+3*86400000;
 const row=s=>({id:1,collector_key:cfg.collectorId,revision:s.revision,state_json:JSON.stringify(s)});
 const finish=(s,success)=>({...s,phase:'done',finishResult:{coverageComplete:success}});
 const first=loadAuditState([],cfg,'first',later);assert.equal(first.windowKind,'live');assert.equal(Date.parse(first.receivedThrough),Date.parse(cutoff)+86400000);
 const retry=loadAuditState([row(finish(first,false))],cfg,'second',later);assert.equal(retry.windowKind,'retry');assert.equal(retry.receivedFrom,first.receivedFrom);assert.equal(retry.retryWindows.length,1);
 const live=loadAuditState([row(finish(retry,false))],cfg,'third',later);assert.equal(live.windowKind,'live');assert(Date.parse(live.receivedThrough)>Date.parse(first.receivedThrough));assert.equal(live.retryWindows.length,1);
 const again=loadAuditState([row(finish(live,false))],cfg,'fourth',later);assert.equal(again.windowKind,'retry');assert.equal(again.retryWindows.length,2);
 const next=loadAuditState([row(finish(again,false))],cfg,'fifth',later);assert.equal(next.windowKind,'live');assert(Date.parse(next.receivedThrough)>Date.parse(live.receivedThrough));assert.equal(next.coverageProof,null);
});

test('all individual incoming messages after cutoff enter the queue while groups stay out',()=>{
 validateAuditConfig(cfg,'test');let state=start();
 state=apply(state,{data:{payload:[conversation,{...conversation,id:7,additional_attributes:{is_group:true}},{...conversation,id:8,meta:{sender:stranger},contact_inbox:{source_id:'5511988888888'}}]}});
 assert.deepEqual(state.conversationIds,['3','8']);assert.deepEqual(state.authorizedConversationIds,['3']);let d=drain(state);assert.equal(d.events[0].kind,'page_discovered');
 state=apply(d.state,{data:{payload:[]}});d=drain(state);assert.match(d.ctx.url,/conversations\/3\/messages/);
 const rows=[{id:44,conversation_id:3,message_type:'incoming',private:false,created_at:'2026-10-28T11:00:00.000Z',attachments:[{id:600}]},
  {id:43,conversation_id:3,message_type:'incoming',private:false,created_at:'2026-10-28T09:59:59.000Z',attachments:[{id:601}]},
  {id:42,conversation_id:3,message_type:'outgoing',private:false,created_at:'2026-10-28T11:00:00.000Z'}];
 state=apply(d.state,{payload:rows});d=drain(state);assert.deepEqual(d.events[0].message_ids,['44']);assert.equal(d.ctx.action,'intake_lookup_source');
 assert.equal(d.ctx.payload.identities.length,1);assert.equal(d.ctx.payload.identities[0].attachment_id,'chatwoot-attachment:600');
});

test('receipt events are acknowledged before child; independent lookup alone proves saved',()=>{
 let state=start();state=apply(state,{data:{payload:[conversation]}});state=drain(state).state;state=apply(state,{data:{payload:[]}});state=drain(state).state;
 state=apply(state,{payload:[{id:44,conversation_id:3,message_type:'incoming',private:false,created_at:'2026-10-28T11:00:00.000Z',attachments:[{id:600}]}]});let d=drain(state);
 state=applyAuditResponse(d.ctx,{statusCode:200,body:lookup([missing(44,'chatwoot-attachment:600')])},cfg,now);d=drain(state);
 assert.deepEqual(d.events.map(e=>e.kind),['message_discovered','origins_declared','attachment_details','origin_outcome']);assert.equal(d.events[3].disposition,'pending');
 assert.equal(d.ctx.target,'bridge');assert.deepEqual(d.ctx.payload,{message_id:'44',conversation_id:'3',attachment_ids:['chatwoot-attachment:600'],account_id:'chatwoot:1:inbox:2',collector_id:cfg.collectorId,cutoff});
 state=applyAuditResponse(d.ctx,{statusCode:500,body:{}},cfg,now);let lookupCtx=nextAuditOperation(state,cfg,now);assert.equal(lookupCtx.action,'intake_lookup_source');
 state=applyAuditResponse(lookupCtx,{statusCode:200,body:lookup([missing(44,'chatwoot-attachment:600')])},cfg,now);d=drain(state);assert(!d.events.some(e=>e.disposition==='saved'));assert.equal(d.events[0].code,'child_response_uncertain');assert.equal(d.state.lastError.code,'audit_bridge_response_uncertain');
 // A second independent path with matching immutable source can record saved.
 const original={...lookupCtx,state:structuredClone(lookupCtx.state)};
 state=applyAuditResponse(original,{statusCode:200,body:lookup([saved(44,'chatwoot-attachment:600')])},cfg,now);d=drain(state);
 assert.equal(d.events.length,1);assert.equal(d.events[0].disposition,'saved');assert.equal(d.events[0].source_id,'33333333-3333-4333-8333-333333333333');
});

test('file name and position are recorded before trying a single attachment and a verified missing source keeps its reason',()=>{
 let state=start();state=apply(state,{data:{payload:[conversation]}});state=drain(state).state;state=apply(state,{data:{payload:[]}});state=drain(state).state;
 state=apply(state,{payload:[{id:44,conversation_id:3,message_type:'incoming',private:false,created_at:'2026-10-28T11:00:00.000Z',attachments:[{id:600,file_name:'hemograma.pdf',content_type:'application/pdf'}]}]});let d=drain(state);
 state=applyAuditResponse(d.ctx,{statusCode:200,body:lookup([missing(44,'chatwoot-attachment:600')])},cfg,now);d=drain(state);
 const details=d.events.find(e=>e.kind==='attachment_details');assert.equal(details.display_name,'hemograma.pdf');assert.equal(details.position,1);assert.equal(details.mime_type,'application/pdf');
 state=applyAuditResponse(d.ctx,{statusCode:200,body:{completed:true,issue:{message_id:'44',attachment_id:'chatwoot-attachment:600',reason:'pdf_url_missing_or_untrusted'}}},cfg,now);
 const check=nextAuditOperation(state,cfg,now);state=applyAuditResponse(check,{statusCode:200,body:lookup([missing(44,'chatwoot-attachment:600')])},cfg,now);d=drain(state);
 assert.equal(d.events[0].attachment_id,'chatwoot-attachment:600');assert.equal(d.events[0].code,'pdf_url_missing_or_untrusted');
});

test('unknown sender and uncertain conversation stay pending for review without reaching child',()=>{
 let state=start();state=apply(state,{data:{payload:[{id:3,inbox_id:2,created_at:1700000000}]}});assert.deepEqual(state.conversationIds,['3']);assert.equal(state.conversationPolicies['3'],'review');
 state=drain(state).state;state=apply(state,{data:{payload:[]}});state=drain(state).state;
 state=apply(state,{payload:[{id:44,conversation_id:3,message_type:'incoming',private:false,created_at:'2026-10-28T11:00:00.000Z',attachments:[{id:600}]}]});let d=drain(state);
 state=applyAuditResponse(d.ctx,{statusCode:200,body:lookup([missing(44,'chatwoot-attachment:600')])},cfg,now);d=drain(state);
 assert.equal(d.events.at(-1).disposition,'pending');assert.equal(d.events.at(-1).code,'sender_review_required');assert.notEqual(d.ctx.target,'bridge');
 const ctx=nextAuditOperation(start(),cfg,now);state=applyAuditFailure(ctx,'INTAKE_AUDIT_MESSAGE_PAGE_INVALID',now);d=drain(state);assert.equal(d.events[0].kind,'failure');assert.equal(d.ctx.target,'stop');
});
test('duplicate provider message IDs fail explicitly even when outside the activation window',()=>{
 const state={...start(),phase:'chatwoot_messages',conversationIds:['3'],conversationPolicies:{'3':'approved'},cursor:null};
 const ctx=nextAuditOperation(state,cfg,now),old={id:8,conversation_id:3,message_type:'incoming',private:false,created_at:'2026-10-28T09:00:00.000Z'};
 assert.throws(()=>applyAuditResponse(ctx,{statusCode:200,body:{payload:[old,{...old}]}},cfg,now),/MESSAGE_PAGE_DUPLICATE/);
});

test('processing one bridge preserves every other message from the same provider page',()=>{
 let state=start();state=apply(state,{data:{payload:[conversation]}});state=drain(state).state;state=apply(state,{data:{payload:[]}});state=drain(state).state;
 state=apply(state,{payload:[{id:44,conversation_id:3,message_type:'incoming',private:false,created_at:'2026-10-28T11:00:00.000Z',attachments:[{id:600}]},
  {id:43,conversation_id:3,message_type:'incoming',private:false,created_at:'2026-10-28T11:00:00.000Z',attachments:[{id:601}]}]});let d=drain(state);
 state=applyAuditResponse(d.ctx,{statusCode:200,body:lookup([missing(44,'chatwoot-attachment:600')])},cfg,now);d=drain(state);assert.equal(d.ctx.target,'bridge');
 state=applyAuditResponse(d.ctx,{statusCode:200,body:{completed:true}},cfg,now);let ctx=nextAuditOperation(state,cfg,now);
 state=applyAuditResponse(ctx,{statusCode:200,body:lookup([missing(44,'chatwoot-attachment:600')])},cfg,now);d=drain(state);
 assert.equal(d.ctx.action,'intake_lookup_source');assert.equal(d.ctx.payload.identities[0].message_id,'43');
});

test('recheck bridges each missing attachment independently, then looks up all attachments again',()=>{
 let state={...start(),authorizedConversationIds:['3'],phase:'recheck_lookup',recheckItems:[{receipt_id:'33333333-3333-4333-8333-333333333331',account_id:'chatwoot:1:inbox:2',partition_key:'conversation:3',message_id:'44',attachment_id:'chatwoot-attachment:600',artifact_kind:'attachment'},
  {receipt_id:'33333333-3333-4333-8333-333333333332',account_id:'chatwoot:1:inbox:2',partition_key:'conversation:3',message_id:'44',attachment_id:'chatwoot-attachment:601',artifact_kind:'attachment'}],recheckNextCursor:null};
 let ctx=nextAuditOperation(state,cfg,now);state=applyAuditResponse(ctx,{statusCode:200,body:lookup([missing(44,'chatwoot-attachment:600'),missing(44,'chatwoot-attachment:601')])},cfg,now);
 ctx=nextAuditOperation(state,cfg,now);assert.equal(ctx.target,'bridge');assert.equal(ctx.payload.conversation_id,'3');
 assert.deepEqual(ctx.payload.attachment_ids,['chatwoot-attachment:600']);
 state=applyAuditResponse(ctx,{statusCode:500,body:{}},cfg,now);ctx=nextAuditOperation(state,cfg,now);assert.equal(ctx.target,'bridge');assert.deepEqual(ctx.payload.attachment_ids,['chatwoot-attachment:601']);
 state=applyAuditResponse(ctx,{statusCode:200,body:{completed:true}},cfg,now);ctx=nextAuditOperation(state,cfg,now);assert.equal(ctx.action,'intake_lookup_source');assert.equal(ctx.payload.identities.length,2);
 state=applyAuditResponse(ctx,{statusCode:200,body:lookup([missing(44,'chatwoot-attachment:600'),saved(44,'chatwoot-attachment:601')])},cfg,now);
 const d=drain(state);assert.equal(d.events.length,1);assert.equal(d.events[0].kind,'attachment_retry_failed');assert.equal(d.events[0].attachment_id,'chatwoot-attachment:600');assert.equal(d.events[0].code,'child_response_uncertain');
});

test('a user-deleted WhatsApp file is excluded while a missing sibling still reaches its exact bridge',()=>{
 let state=start();state=apply(state,{data:{payload:[conversation]}});state=drain(state).state;state=apply(state,{data:{payload:[]}});state=drain(state).state;
 state=apply(state,{payload:[{id:44,conversation_id:3,message_type:'incoming',private:false,created_at:'2026-10-28T11:00:00.000Z',attachments:[{id:600},{id:601}]}]});let d=drain(state);
 const deleted={message_id:'44',attachment_id:'chatwoot-attachment:600',status:'excluded',reason:'user_deleted'};
 assert.throws(()=>applyAuditResponse(d.ctx,{statusCode:200,body:lookup([{...deleted,reason:'unknown'},missing(44,'chatwoot-attachment:601')])},cfg,now),/LOOKUP_IDENTITY_INVALID/);
 state=applyAuditResponse(d.ctx,{statusCode:200,body:lookup([deleted,missing(44,'chatwoot-attachment:601')])},cfg,now);d=drain(state);
 assert.equal(d.ctx.target,'bridge');assert.deepEqual(d.ctx.payload.attachment_ids,['chatwoot-attachment:601']);
 const exclusion=d.events.find(e=>e.attachment_id===deleted.attachment_id&&e.kind==='origin_outcome');assert.equal(exclusion.disposition,'excluded');assert.equal(exclusion.code,'user_deleted');assert.equal(state.originsExcluded,1);
});
