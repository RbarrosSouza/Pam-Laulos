import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {gmailStabilityLanes,buildGmailStabilityChild,buildGmailStabilityParent,readGmailCollectorConfig,writeGmailStabilityCandidates} from './gmail-stability-build.mjs';
import {buildN8nAuditWorkflow} from './n8n-discovery-audit-build.mjs';
import {validateAuditConfig,loadAuditState,nextAuditOperation,applyAuditResponse,applyAuditFailure,auditPersistenceRow,verifyAuditPersistence} from './n8n-discovery-audit-runtime.mjs';
const cutoff='2026-10-16T13:54:27.886Z',handoff='2026-11-04T23:00:00.000Z',now=Date.parse(handoff)+600000;
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
const auth={id:'syntheticOAuthReference',name:'OAuth fixture'},worker={id:'syntheticWorkerReference',name:'Worker fixture'};
const node=(name,type,parameters={},credentials)=>({id:crypto.randomUUID(),name,type:'n8n-nodes-base.'+type,parameters,...(credentials?{credentials}:{})});
const primaryCfg={enabled:true,mailbox:'fixture@example.invalid',serviceUrl:'https://fixture.supabase.co/functions/v1/exam-document-service',intakeCutoff:cutoff,driveFolderId:'syntheticFolder',manualMessageId:'',includeSpamTrash:true};
const primary={nodes:[node('Configuração','code',{jsCode:'const cfg='+JSON.stringify(primaryCfg,null,2)+';\nif(!cfg.enabled)throw Error("disabled");return [{json:cfg}];'}),node('Gmail - IDs paginados','httpRequest',{}, {oAuth2Api:auth}),node('Reservar origem','httpRequest',{}, {httpHeaderAuth:worker})]};
const previousCutoff='2026-10-28T05:06:39.000Z',previousCollector='gmail_prospective_'+digest(previousCutoff).slice(0,16);
const sourceChild={nodes:[node('Configuração','code',{jsCode:`const request=$input.all()[0].json.payload;if(request.collector_id!==${JSON.stringify(previousCollector)}||request.cutoff!==${JSON.stringify(previousCutoff)}||request.account_id!=='gmail:fixture@example.invalid')throw Error('BRIDGE_INPUT_IDENTITY_INVALID');const cfg=${JSON.stringify({...primaryCfg,intakeCutoff:previousCutoff},null,2)};cfg.manualMessageId=request.message_id;cfg.bridgeTargets=request.targets;return [{json:cfg}];`}),
 node('Receber mensagem prospectiva','executeWorkflowTrigger',{inputSource:'passthrough'}),node('Original reservado recuperável','if'),node('Decidir recebimento','code',{jsCode:'// intake_retry, hash, deletion fence, Hopelab hold preserved'}),node('Registrar falha de origem','httpRequest',{jsonBody:'Gmail/Drive [drive_upload_failed]'}, {httpHeaderAuth:worker}),node('Gmail - MIME sem bytes','httpRequest',{options:{timeout:30000}}, {oAuth2Api:auth})],connections:{'Receber mensagem prospectiva':{main:[[{node:'Configuração',type:'main',index:0}]]}},settings:{binaryMode:'separate',executionOrder:'v1',saveDataErrorExecution:'none'}};
const sourceParent=buildN8nAuditWorkflow('gmail',primary,'syntheticDataTable',{scheduledCandidate:true,prospectiveCutoff:previousCutoff,bridgeWorkflowId:'syntheticOldChild'});
function config(lane='history') {return readGmailCollectorConfig(buildGmailStabilityParent(primary,sourceParent,'syntheticDataTable',handoff,lane,'syntheticChildId'));}
function row(state,cfg) {const expected=auditPersistenceRow(state.lease?.owner?state:{...state,releaseLease:true},cfg,now);return{id:'1',...expected};}
function doneWindow(state,coverage=true) {return{...state,phase:'done',lease:{owner:null,until:0},finishResult:{coverageComplete:coverage,scanFinished:coverage,checkpointAdvanced:false}};}
const ok=body=>({statusCode:200,body});
const run={sweep_id:'11111111-1111-4111-a111-111111111111',run_token:'22222222-2222-4222-a222-222222222222',mode:'audit'};

test('factory preserves the initial cutoff and published child recovery while splitting fresh/history identities',async()=>{
 const lanes=gmailStabilityLanes(primary,handoff);assert.equal(lanes.history.cutoff,cutoff);assert.equal(lanes.history.historicalThrough,handoff);assert.equal(Date.parse(lanes.fresh.cutoff),Date.parse(handoff)-300000);assert.notEqual(lanes.history.collectorId,lanes.fresh.collectorId);
 for(const lane of ['history','fresh']){
  const c=buildGmailStabilityChild(primary,sourceChild,handoff,lane),p=buildGmailStabilityParent(primary,sourceParent,'syntheticDataTable',handoff,lane,'syntheticChildId');
  assert.equal(c.active,false);assert.equal(p.active,false);assert.equal(c.settings.executionTimeout,180);assert.equal(p.settings.executionTimeout,300);assert.equal(c.settings.saveDataErrorExecution,'none');assert.equal(p.settings.saveDataErrorExecution,'none');
  for(const n of sourceChild.nodes){const after=c.nodes.find(a=>a.name===n.name);assert.equal(after.id,n.id);assert.deepEqual(after.credentials,n.credentials);if(n.name!=='Configuração')assert.deepEqual(after,n);}
  assert.deepEqual(c.connections,sourceChild.connections);assert.equal(c.nodes.filter(n=>n.type.endsWith('.executeWorkflowTrigger')).length,1);
  const note=p.nodes.find(n=>n.name==='Leia antes de habilitar').parameters.content;assert.match(note,/coordenador 300s/);assert.match(note,/subprocessador 180s/);assert.match(note,/preservar o original no Drive/);assert.doesNotMatch(note,/não cria documentos/);
  const cfg=config(lane);validateAuditConfig(cfg,'trigger');assert.equal(cfg.collectorId,lanes[lane].collectorId);assert.equal(cfg.recheckPageSize,1);assert.equal(cfg.monitoring,false);
  assert.equal(p.nodes.find(n=>n.type.endsWith('.scheduleTrigger')).parameters.rule.interval[0].minutesInterval,lane==='fresh'?1:15);
  assert.match(p.name,lane==='fresh'?/a cada 1 minuto$/:/a cada 15 minutos$/);
  const script=new vm.Script('(function(){'+c.nodes[0].parameters.jsCode+'})()');const request={collector_id:cfg.collectorId,cutoff:cfg.intakeCutoff,account_id:'gmail:fixture@example.invalid',message_id:'abcdef01',targets:[{kind:'gmail_part',part_id:'1'}]};
  const result=script.runInNewContext({$input:{all:()=>[{json:{payload:request}}]}})[0].json;assert.equal(result.manualMessageId,request.message_id);assert.equal(result.intakeCutoff,cfg.intakeCutoff);assert.throws(()=>script.runInNewContext({$input:{all:()=>[{json:{payload:{...request,collector_id:previousCollector}}}]}}),/IDENTITY/);
 }
});

test('one-minute polling changes only the current schedule, retaining node identities and durable configuration',()=>{
 const spec=gmailStabilityLanes(primary,handoff).fresh;
 const options={scheduledCandidate:true,resumeFence:true,prospectiveCutoff:spec.cutoff,bridgeWorkflowId:'syntheticChildId',
  captureAttachmentDetails:true,executionTimeoutSeconds:300,recheckAfterEnumeration:true,recheckPageSize:1,stabilityBudget:true};
 const previous=buildN8nAuditWorkflow('gmail',primary,'syntheticDataTable',{...options,scheduleMinutes:5});
 const current=buildN8nAuditWorkflow('gmail',primary,'syntheticDataTable',{...options,scheduleMinutes:1});
 assert.deepEqual(readGmailCollectorConfig(current),readGmailCollectorConfig(previous));
 const cfg=readGmailCollectorConfig(current);
 assert.deepEqual([cfg.maxActions,cfg.maxMillis,cfg.leaseMillis,cfg.overlapSeconds,cfg.executionBudgetMillis,cfg.bridgeBudgetMillis,cfg.bridgeCheckpointMarginMillis,cfg.recheckPageSize],
  [100,180000,900000,300,300000,180000,30000,1]);
 // IF condition IDs are intentionally fresh on each build; node IDs, credentials,
 // connections and all other parameters must remain identical for this change.
 const normalize=workflow=>{const result=structuredClone(workflow);for(const n of result.nodes)for(const c of n.parameters.conditions?.conditions||[])delete c.id;return result;};
 const normalized=normalize(current);normalized.nodes.find(n=>n.type.endsWith('.scheduleTrigger')).parameters.rule.interval[0].minutesInterval=5;
 assert.deepEqual(normalized,normalize(previous));
 const build=extra=>buildN8nAuditWorkflow('gmail',primary,'syntheticDataTable',{...options,scheduleMinutes:1,...extra});
 assert.throws(()=>build({stabilityBudget:false}),/One-minute polling/);
 assert.throws(()=>build({historicalThrough:handoff}),/One-minute polling/);
 assert.throws(()=>build({canary:true,canaryMessageId:'abcdef01'}),/One-minute polling/);
 for(const interval of [0,2,30,'1'])assert.throws(()=>build({scheduleMinutes:interval}),/Invalid bounded collector settings/);
 assert.equal(buildN8nAuditWorkflow('gmail',primary,'syntheticDataTable',{scheduledCandidate:true}).nodes.find(n=>n.type.endsWith('.scheduleTrigger')).parameters.rule.interval[0].minutesInterval,5);
});

test('minute ticks keep the live lease exclusive and resume the same persisted cursor after release',()=>{
 const cfg=config('fresh');let state=loadAuditState([],cfg,'first-minute',now);
 state=applyAuditResponse(nextAuditOperation(state,cfg,now),ok(run),cfg,now);
 state=applyAuditResponse(nextAuditOperation(state,cfg,now),ok({messages:[{id:'abcdef01'}],nextPageToken:'next-page'}),cfg,now);
 const saved=row(state,cfg);
 const overlapping=loadAuditState([saved],cfg,'next-minute',now+60000);
 assert.equal(overlapping.busy,true);assert.equal(overlapping.lease.owner,'first-minute');
 assert.equal(overlapping.lease.until,now+900000);
 const released=row({...state,releaseLease:true},cfg);
 const resumed=loadAuditState([released],{...cfg,executionStartedAt:now+120000},'after-release',now+120000);
 assert.equal(resumed.busy,false);assert.equal(resumed.lease.owner,'after-release');
 for(const key of ['identityHash','requestId','sweepId','receivedFrom','receivedThrough','cursor','messageQueue','pendingEvents'])assert.deepEqual(resumed[key],state[key],key);
 assert.equal(resumed.revision,JSON.parse(released.state_json).revision);assert(resumed.resumeRequest);
 assert.equal(nextAuditOperation(resumed,{...cfg,executionStartedAt:now+120000},now+120000).action,'intake_resume');
});

test('history advances in at most one-day windows and terminates only after all bounded intervals are acknowledged',()=>{
 const cfg=config();let state=loadAuditState([],cfg,'tick-0',now);assert.equal(state.receivedFrom,cutoff);assert(Date.parse(state.receivedThrough)-Date.parse(state.receivedFrom)<=86400000);
 for(let i=1;i<30&&!state.historicalEnumerationComplete;i++){const previous=doneWindow(state,true);state=loadAuditState([row(previous,cfg)],cfg,'tick-'+i,now);assert(Date.parse(state.receivedThrough)<=Date.parse(handoff));assert(Date.parse(state.receivedThrough)-Date.parse(state.receivedFrom)<=86400000);}
 assert.equal(state.historicalEnumerationComplete,true);assert.equal(state.historicalComplete,false);
 state=applyAuditResponse(nextAuditOperation(state,cfg,now),ok({contract:'exam_intake_pending_source_page_v1',collector_id:cfg.collectorId,items:[],next_cursor:null}),cfg,now);
 assert.equal(state.historicalComplete,true);assert.equal(state.progressThrough,handoff);assert.equal(state.coverageGaps.length,0);
 const stopped=nextAuditOperation(state,cfg,now);assert.equal(stopped.target,'stop');assert.equal(stopped.result.historicalComplete,true);assert.equal(stopped.result.continuationRequired,false);
 const again=loadAuditState([row(doneWindow(state),cfg)],cfg,'tick-again',now);assert.equal(again.historicalComplete,true);assert.equal(nextAuditOperation(again,cfg,now).target,'stop');
});

test('failed historical intervals remain round-robin gaps even after reaching the frozen end',()=>{
 const cfg=config();let state=loadAuditState([],cfg,'tick-0',now);let failures=0;
 for(let i=1;i<45&&!state.historicalEnumerationComplete;i++){
  const isFirstOrLast=(state.receivedFrom===cutoff||state.receivedThrough===handoff)&&state.windowKind==='current';
  const previous=doneWindow(state,!isFirstOrLast);if(isFirstOrLast)failures++;
  state=loadAuditState([row(previous,cfg)],cfg,'tick-'+i,now);
  if(Date.parse(state.progressThrough)>=Date.parse(handoff)&&state.coverageGaps.length){assert.equal(state.windowKind,'retry');assert.equal(state.historicalComplete,undefined);}
 }
 assert(failures>=2);assert.equal(state.historicalEnumerationComplete,true);assert.equal(state.historicalComplete,false);assert.equal(state.coverageGaps.length,0);assert.equal(state.coverageHadGap,true);
 assert.equal(state.coverageProof,null); // Do not manufacture a backend proof spanning several windows.
});

test('handoff boundary and state identity cannot silently change under an existing cursor',()=>{
 const cfg=config(),initial=loadAuditState([],cfg,'a',now),saved=row(initial,cfg);
 const changed={...cfg,historicalThrough:new Date(Date.parse(handoff)+60000).toISOString()};assert.throws(()=>loadAuditState([saved],changed,'b',now),/IDENTITY_INVALID/);
 assert.throws(()=>validateAuditConfig({...cfg,historicalThrough:cutoff},'trigger'),/HISTORY_BOUND/);
 const forged={...doneWindow(initial),historicalComplete:true,progressThrough:handoff,coverageGaps:[{from:cutoff,through:handoff}]};assert.throws(()=>loadAuditState([row(forged,cfg)],cfg,'b',now),/COMPLETION_UNPROVEN/);
});

test('fresh enumeration starts independently while historical work remains incomplete',()=>{
 const hist=config(),fresh=config('fresh'),old=loadAuditState([],hist,'old-owner',now),freshState=loadAuditState([],fresh,'fresh-owner',now);
 assert.equal(loadAuditState([row(old,hist)],hist,'duplicate-owner',now).busy,true);
 assert.equal(freshState.receivedFrom,new Date(Date.parse(handoff)-300000).toISOString());assert.equal(freshState.busy,false);
 const started=applyAuditResponse(nextAuditOperation(freshState,fresh,now),ok(run),fresh,now);assert.equal(started.phase,'gmail_list');assert.equal(nextAuditOperation(started,fresh,now).target,'gmail');
});

test('a late bridge yields its exact durable pending origin and resumes without pretending it was saved',()=>{
 const cfg={...config('fresh'),executionStartedAt:now};const base=loadAuditState([],cfg,'a',now),job={partitionKey:'mailbox',messageId:'abcdef01',receivedAt:handoff,origins:[{attachment_id:'gmail-part:["1",null]',artifact_kind:'attachment'}],lookupItems:[{status:'pending'}],unsupportedIds:[]};
 const state={...base,sweepId:run.sweep_id,runToken:run.run_token,phase:'bridge',bridgeMode:'new',bridgeMessageId:'abcdef01',bridgeJob:job};
 const yielded=nextAuditOperation(state,cfg,now+90001);assert.equal(yielded.target,'stop');assert.equal(yielded.result.code,'INTAKE_AUDIT_BRIDGE_YIELD');assert.equal(yielded.result.coverageComplete,false);assert.deepEqual(yielded.state.bridgeJob,job);
 const persisted=row({...yielded.state,lease:{owner:null,until:0}},cfg),restored=loadAuditState([persisted],{...cfg,executionStartedAt:now+300000},'b',now+300000);
 assert(restored.resumeRequest);const op=nextAuditOperation({...restored,resumeRequest:undefined}, {...cfg,executionStartedAt:now+300000},now+300000);assert.equal(op.target,'bridge');assert.equal(op.payload.message_id,'abcdef01');assert.deepEqual(op.payload.targets,[{kind:'gmail_part',part_id:'1'}]);
 const uncertain=applyAuditResponse(op,{statusCode:200,body:{completed:false}},cfg,now);assert.equal(uncertain.phase,'lookup');assert.equal(uncertain.lookupJobs[0].bridgeRechecked,true);assert.equal(uncertain.originsSaved,0);
});

test('pending message and page ACKs remain fenced when persistence or HTTP response is lost',()=>{
 const cfg=config('fresh'),initial=loadAuditState([],cfg,'a',now);const state={...initial,phase:'events',sweepId:run.sweep_id,runToken:run.run_token,pendingEvents:[{kind:'page_discovered',partition_key:'mailbox',page_key:'page-1',message_ids:['abcdef01'],next_cursor:'token-2'}],afterEvents:'gmail_metadata'};
 const op=nextAuditOperation(state,cfg,now),lost=applyAuditFailure(op,'ACK_LOST',now);assert.deepEqual(lost.pendingEvents,state.pendingEvents);assert.deepEqual(nextAuditOperation({...lost,halt:false},cfg,now).payload,op.payload);
 const expected=auditPersistenceRow(lost,cfg,now);assert.throws(()=>verifyAuditPersistence([{...expected,id:'1',revision:expected.revision+1}],expected),/UNPROVEN/);
});

test('only one pending-origin recheck runs per fresh window; poison retries cannot starve the next arrival',()=>{
 const cfg=config('fresh');let s=loadAuditState([],cfg,'a',now);s=applyAuditResponse(nextAuditOperation(s,cfg,now),ok(run),cfg,now);assert.equal(s.phase,'gmail_list');
 // Enumeration already persisted all fresh IDs. There are 200 old pending receipts,
 // but the backend returns only one and preserves a round-robin next cursor.
 s={...s,phase:'enumeration',pendingEvents:[]};s=applyAuditResponse(nextAuditOperation(s,cfg,now),ok({recorded:true,sweep_id:run.sweep_id}),cfg,now);assert.equal(s.phase,'recheck_list');
 let op=nextAuditOperation(s,cfg,now);assert.equal(op.payload.limit,1);
 const pending=Array.from({length:200},(_,i)=>({receipt_id:'10000000-0000-4000-a000-'+String(i+1).padStart(12,'0'),account_id:'gmail:fixture@example.invalid',partition_key:'mailbox',message_id:(0xabcdef01+i).toString(16),attachment_id:'gmail-part:["1",null]',artifact_kind:'attachment'}));
 const items=pending.slice(0,op.payload.limit),rid=items[0].receipt_id;assert.equal(items.length,1);assert.equal(pending.length,200);
 s=applyAuditResponse(op,ok({contract:'exam_intake_pending_source_page_v1',collector_id:cfg.collectorId,items,next_cursor:rid}),cfg,now);
 // One failed retry has been durably recorded; completing this page must finish,
 // not request another page or repeat the Gmail enumeration.
 s={...s,phase:'recheck_resolve',recheckResolutions:[]};op=nextAuditOperation(s,cfg,now);assert.equal(op.action,'intake_finish');assert.equal(op.state.recheckCursor,rid);
 const finished=applyAuditResponse(op,ok({coverageComplete:true,scanFinished:true,checkpointAdvanced:false}),cfg,now);
 const next=loadAuditState([row({...finished,lease:{owner:null,until:0}},cfg)],cfg,'b',now+300000);assert.equal(next.recheckCursor,rid);assert.notEqual(next.requestId,finished.requestId);
 const begin=applyAuditResponse(nextAuditOperation(next,cfg,now+300000),ok(run),cfg,now+300000);assert.equal(begin.phase,'gmail_list');assert.equal(nextAuditOperation(begin,cfg,now+300000).target,'gmail');
 const newArrival=applyAuditResponse(nextAuditOperation(begin,cfg,now+300000),ok({messages:[{id:'abcdef99'}]}),cfg,now+300000);assert.deepEqual(newArrival.pendingEvents[0].message_ids,['abcdef99']);assert.equal(newArrival.phase,'events');
});

test('large saved history is bounded by operations, keeps pagination and never calls a child for saved origins',()=>{
 const cfg=config(),base=loadAuditState([],cfg,'a',now);let s={...base,phase:'gmail_list',sweepId:run.sweep_id,runToken:run.run_token};
 const messages=Array.from({length:100},(_,i)=>({id:(0xabcdef00+i).toString(16)}));s=applyAuditResponse(nextAuditOperation(s,cfg,now),ok({messages,nextPageToken:'token-page-2'}),cfg,now);
 assert.equal(s.pendingEvents[0].kind,'page_discovered');assert.equal(s.messageQueue.length,100);assert.equal(s.cursor,'token-page-2');assert(s.pendingEvents[0].next_cursor_sha256);
 const bounded=nextAuditOperation({...s,tick:{...s.tick,actions:100}},cfg,now);assert.equal(bounded.target,'stop');assert.equal(bounded.result.continuationRequired,true);assert.equal(bounded.state.messageQueue.length,100);
 const identity={account_id:'gmail:fixture@example.invalid',partition_key:'mailbox',message_id:'abcdef01',attachment_id:'gmail-part:["1",null]'};
 const lookupState={...base,phase:'lookup',lookupJobs:[{partitionKey:'mailbox',messageId:identity.message_id,receivedAt:handoff,origins:[{attachment_id:identity.attachment_id,artifact_kind:'attachment'}],unsupportedIds:[],lookupItems:[],lookupOffset:0}],afterLookup:'gmail_metadata'};
 const op=nextAuditOperation(lookupState,cfg,now),proof={...identity,status:'saved',reason:'canonical_original_preserved',match_kind:'exact_origin',source_id:'33333333-3333-4333-a333-333333333333',document_id:'44444444-4444-4444-a444-444444444444',source_document_id:'44444444-4444-4444-a444-444444444444',sha256:'a'.repeat(64),size_bytes:100,file_status:'saved',canonical_file_preserved:true};
 const accepted=applyAuditResponse(op,ok({contract:'exam_intake_source_lookup_v1',items:[proof]}),cfg,now);assert.notEqual(accepted.phase,'bridge');assert(accepted.pendingEvents.some(e=>e.kind==='origin_outcome'&&e.disposition==='saved'));
});

test('private candidate writer refuses repository paths and symlinks into the repository',async()=>{
 await assert.rejects(writeGmailStabilityCandidates({primarySource:primary,publishedChild:sourceChild,publishedCollector:sourceParent,dataTableId:'syntheticDataTable',handoff,out:new URL('../../../',import.meta.url).pathname}),/outside_repository/);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pam-stability-'));try{const target=path.join(dir,'repo');await fs.symlink(new URL('../../../',import.meta.url).pathname,target);await assert.rejects(writeGmailStabilityCandidates({primarySource:primary,publishedChild:sourceChild,publishedCollector:sourceParent,dataTableId:'syntheticDataTable',handoff,out:path.join(target,'private-fixture')}),/outside_repository/);}finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('finished history enumeration retains failed originals and revisits the same receipt until verified recovery',()=>{
 const cfg=config(),base=loadAuditState([],cfg,'a',now);
 let s={...doneWindow(base),historicalEnumerationComplete:true,historicalComplete:false,phase:'recheck_list',progressThrough:handoff,coverageGaps:[],recheckCursor:null};
 const rid='10000000-0000-4000-a000-000000000001',receipt={receipt_id:rid,account_id:'gmail:fixture@example.invalid',partition_key:'mailbox',message_id:'abcdef01',attachment_id:'gmail-part:["1",null]',artifact_kind:'attachment'};
 const pendingPage={contract:'exam_intake_pending_source_page_v1',collector_id:cfg.collectorId,items:[receipt],next_cursor:rid};
 s=applyAuditResponse(nextAuditOperation(s,cfg,now),ok(pendingPage),cfg,now);
 let op=nextAuditOperation(s,cfg,now);const identity=op.payload.identities[0];
 const pending={...identity,status:'pending',reason:'original_not_preserved'};
 s=applyAuditResponse(op,ok({contract:'exam_intake_source_lookup_v1',items:[pending]}),cfg,now);op=nextAuditOperation(s,cfg,now);assert.equal(op.target,'bridge');
 s=applyAuditResponse(op,ok({completed:false}),cfg,now);assert.equal(s.phase,'recheck_lookup');
 s=applyAuditResponse(nextAuditOperation(s,cfg,now),ok({contract:'exam_intake_source_lookup_v1',items:[pending]}),cfg,now);
 assert.equal(s.phase,'recheck_resolve');assert.equal(s.pendingEvents.length,0);assert.equal(s.lastError.code,'historical_original_still_pending');
 op=nextAuditOperation(s,cfg,now);assert.equal(op.target,'stop');assert.equal(op.result.continuationRequired,true);assert.equal(op.result.historicalComplete,false);assert.equal(op.state.recheckCursor,rid);
 s=loadAuditState([row({...op.state,lease:{owner:null,until:0}},cfg)],cfg,'b',now+900000);assert.equal(s.phase,'recheck_list');assert.equal(s.resumeRequest,undefined);
 // The empty tail wraps; it must not claim that the earlier failed receipt vanished.
 s=applyAuditResponse(nextAuditOperation(s,cfg,now+900000),ok({...pendingPage,items:[],next_cursor:null}),cfg,now+900000);assert.equal(s.historicalComplete,false);assert.equal(s.recheckCursor,null);
 s=loadAuditState([row({...s,lease:{owner:null,until:0}},cfg)],cfg,'c',now+1800000);
 s=applyAuditResponse(nextAuditOperation(s,cfg,now+1800000),ok(pendingPage),cfg,now+1800000);op=nextAuditOperation(s,cfg,now+1800000);
 const proof={...identity,status:'saved',reason:'canonical_original_preserved',match_kind:'exact_origin',source_id:'33333333-3333-4333-a333-333333333333',document_id:'44444444-4444-4444-a444-444444444444',source_document_id:'44444444-4444-4444-a444-444444444444',sha256:'a'.repeat(64),size_bytes:100,file_status:'saved',canonical_file_preserved:true};
 s=applyAuditResponse(op,ok({contract:'exam_intake_source_lookup_v1',items:[proof]}),cfg,now+1800000);op=nextAuditOperation(s,cfg,now+1800000);assert.equal(op.action,'intake_resolve_receipt_saved');assert.equal(op.payload.receipt_id,rid);assert.equal(op.payload.document_id,proof.document_id);
 s=applyAuditResponse(op,ok({contract:'exam_intake_receipt_resolution_v1',receipt_id:rid,source_id:proof.source_id,document_id:proof.document_id,sha256:proof.sha256,size_bytes:proof.size_bytes,disposition:'saved',already_saved:true}),cfg,now+1800000);
 assert.equal(nextAuditOperation(s,cfg,now+1800000).target,'stop');
});

test('preseeded null state gives two first runs one native revision-CAS winner before any provider effect',()=>{
 const cfg=config('fresh'),bootstrap={id:'9',collector_key:cfg.collectorId,revision:0,state_json:'null'};
 assert.throws(()=>loadAuditState([{...bootstrap,revision:1}],cfg,'invalid-reset',now),/BOOTSTRAP_STATE_INVALID/);
 const a=loadAuditState([bootstrap],cfg,'first-owner',now),b=loadAuditState([bootstrap],cfg,'overlapping-owner',now);
 assert.equal(a.rowId,'9');assert.equal(b.rowId,'9');assert.equal(a.revision,0);assert.equal(b.revision,0);
 const wa=auditPersistenceRow(a,cfg,now),wb=auditPersistenceRow(b,cfg,now);assert.equal(wa.expected_revision,0);assert.equal(wb.expected_revision,0);assert.notEqual(wa.state_json,wb.state_json);
 // Native Data Table UPDATE WHERE id/key/revision permits one update; the loser
 // rereads the winner and must fail closed before driving any provider/backend call.
 const won={id:'9',collector_key:cfg.collectorId,revision:1,state_json:wa.state_json};
 assert.equal(verifyAuditPersistence([won],wa).lease.owner,'first-owner');assert.throws(()=>verifyAuditPersistence([won],wb),/WRITE_UNPROVEN/);
 assert.equal(loadAuditState([won],cfg,'overlapping-owner',now).busy,true);
});
