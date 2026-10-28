import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import {loadAuditState,nextAuditOperation,applyAuditResponse,applyAuditFailure,auditPersistenceRow,verifyAuditPersistence} from './n8n-discovery-audit-runtime.mjs';

const repository=resolve(process.env.EXAM_REPO||process.cwd());
const {collectionFixtureDB}=await import(pathToFileURL(join(repository,'supabase/tests/collection-db.fixture.mjs')));
const ts=createRequire(join(repository,'package.json'))('typescript'),routes={};
vm.runInNewContext(ts.transpileModule(await readFile(join(repository,'supabase/functions/exam-document-service/intake-service-routes.ts'),'utf8'),
  {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports:routes,TextEncoder});
let db,rpc,role;
const scope='a'.repeat(64), one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
const manifest={provider:'gmail',account_id:'gmail:resume@example.invalid',scope_kind:'mailbox',policy_version:'intake_v2',sender_policy:'all'};
async function begin(collector,mode='audit') {
  const request=crypto.randomUUID(), result=await rpc('begin_exam_intake_sweep',[collector,scope,JSON.stringify(manifest),new Date(Date.now()-86400000).toISOString(),new Date(Date.now()-1000).toISOString(),request,mode,3600]);
  return {collector_id:collector,scope_key:scope,request_id:request,sweep_id:result.sweep_id,run_token:result.run_token,resume_request_id:crypto.randomUUID(),ttl_seconds:3600};
}
const resume = p=>rpc('resume_exam_intake_sweep',[p.collector_id,p.scope_key,p.request_id,p.sweep_id,p.run_token,p.resume_request_id,p.ttl_seconds]);
const event = (p,data)=>rpc('record_exam_intake_event',[p.sweep_id,p.run_token,JSON.stringify(data)]);
const page = (ids=[],terminal=true)=>({kind:'page_discovered',partition_key:'mailbox',page_key:'b'.repeat(64),page_sha256:'c'.repeat(64),message_ids:ids,is_terminal:terminal});
before(async()=>{
  ({db,rpc,role}=await collectionFixtureDB());await db.exec('RESET ROLE');
  for(const name of ['20261027000023_exam_intake_receipts_incidents.sql','20261027000024_exam_hopelab_notice_snapshots.sql','20261028000028_exam_intake_resume_fence.sql']) await db.exec(await readFile(join(repository,'supabase/migrations',name),'utf8'));
  await role('service_role');
});
after(async()=>{await db?.close();});

test('resume RPC and nonce journal remain service-only; no raw historical tokens are stored',async()=>{
  const p=await begin('resume-acl');
  for(const name of ['anon','authenticated']) {await role(name);await assert.rejects(resume(p),e=>e.code==='42501');}
  await role('service_role');
  const access=await one("SELECT has_function_privilege('service_role','public.resume_exam_intake_sweep(text,text,uuid,uuid,uuid,uuid,integer)','EXECUTE') worker,has_function_privilege('authenticated','public.resume_exam_intake_sweep(text,text,uuid,uuid,uuid,uuid,integer)','EXECUTE') member,has_table_privilege('authenticated','public.exam_intake_resume_request','SELECT') member_table");
  assert.deepEqual(access,{worker:true,member:false,member_table:false});
  await resume(p);
  const journal=await one('SELECT * FROM exam_intake_resume_request WHERE resume_request_id=$1',[p.resume_request_id]);
  assert(!JSON.stringify(journal).includes(p.run_token));assert.equal(journal.previous_token_sha256.length,64);
});

test('expired running audit is resumed in place while pages, IDs, receipts and clinical records remain unchanged',async()=>{
  const p=await begin('resume-preserve');await event(p,page(['abcdef01','abcdef02'],false));
  await event(p,{kind:'origins_declared',partition_key:'mailbox',message_id:'abcdef01',origins:[{attachment_id:'pdf',artifact_kind:'attachment'}]});
  await event(p,{kind:'origin_outcome',partition_key:'mailbox',message_id:'abcdef01',attachment_id:'pdf',disposition:'pending',stage:'review',code:'proof_pending'});
  await db.query("UPDATE exam_collection_sweep SET started_at=now()-interval '3 hours',expires_at=now()-interval '2 hours' WHERE id=$1",[p.sweep_id]);
  await assert.rejects(event(p,{kind:'heartbeat'}),/fence expired/);
  const snapshot=async()=>{
    const result={};for(const table of ['exam_intake_page','exam_collection_message','exam_collection_origin','exam_intake_receipt','exam_intake_incident','exam_intake_alert_outbox','exam_document','exam_document_source','exam_document_delivery','exam_document_event']) result[table]=(await one('SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,\'[]\')) hash FROM '+table+' t')).hash;
    return result;
  };
  const before=await snapshot(), prior=await one('SELECT event_count,intake_enumeration_complete,received_from,received_through FROM exam_collection_sweep WHERE id=$1',[p.sweep_id]);
  const result=await resume(p);assert.equal(result.sweep_id,p.sweep_id);assert.notEqual(result.run_token,p.run_token);assert.equal(result.mode,'audit');assert.equal(result.replayed,false);assert(Date.parse(result.expires_at)>Date.now());
  assert.deepEqual(await snapshot(),before);
  const after=await one('SELECT event_count,intake_enumeration_complete,received_from,received_through FROM exam_collection_sweep WHERE id=$1',[p.sweep_id]);
  assert.equal(after.event_count,prior.event_count+1);assert.equal(after.intake_enumeration_complete,false);assert.equal(String(after.received_from),String(prior.received_from));assert.equal(String(after.received_through),String(prior.received_through));
  await assert.rejects(event(p,{kind:'heartbeat'}),/fence expired/);
  assert.equal((await event({...p,run_token:result.run_token},{kind:'heartbeat'})).recorded,true);
});

test('lost resume ACK replays one nonce to the same new fence, with no second journal row or progress event',async()=>{
  const p=await begin('resume-acklost'),first=await resume(p),before=await one('SELECT event_count,expires_at FROM exam_collection_sweep WHERE id=$1',[p.sweep_id]);
  const replay=await resume(p),after=await one('SELECT event_count,expires_at FROM exam_collection_sweep WHERE id=$1',[p.sweep_id]);
  assert.equal(replay.replayed,true);assert.equal(replay.run_token,first.run_token);assert.deepEqual(after,before);
  assert.equal(Number((await one('SELECT count(*) n FROM exam_intake_resume_request WHERE resume_request_id=$1',[p.resume_request_id])).n),1);
  await db.query("UPDATE exam_collection_sweep SET started_at=now()-interval '3 hours',expires_at=now()-interval '2 hours' WHERE id=$1",[p.sweep_id]);
  const delayed=await resume(p);assert.equal(delayed.run_token,first.run_token);assert.equal(delayed.replayed,true);assert(Date.parse(delayed.expires_at)>Date.now());
  assert.equal((await one('SELECT event_count FROM exam_collection_sweep WHERE id=$1',[p.sweep_id])).event_count,before.event_count);
  assert.equal((await event({...p,run_token:delayed.run_token},{kind:'heartbeat'})).recorded,true);
});

test('a nonce cannot change collector, scope, request, sweep, previous token or TTL, including reuse against another audit',async()=>{
  const p=await begin('resume-identity');await resume(p);const other=await begin('resume-other');
  for(const changed of [{...p,collector_id:other.collector_id},{...p,scope_key:'d'.repeat(64)},{...p,request_id:crypto.randomUUID()},
    {...p,sweep_id:other.sweep_id},{...p,run_token:crypto.randomUUID()},{...p,ttl_seconds:900},{...other,resume_request_id:p.resume_request_id}]) await assert.rejects(resume(changed),/mismatch|changed|conflict/);
});

test('completed and inconclusive finished sweeps are not silently reopened; operational mode is not resumable here',async()=>{
  const complete=await begin('resume-complete');await event(complete,page());await event(complete,{kind:'enumeration_complete',expected_message_count:0,page_count:1});
  assert.equal((await rpc('finish_exam_intake_sweep',[complete.sweep_id,complete.run_token])).scanFinished,true);
  await assert.rejects(resume(complete),/lifecycle mismatch/);
  const failed=await begin('resume-finished-failed');assert.equal((await rpc('finish_exam_intake_sweep',[failed.sweep_id,failed.run_token])).coverageComplete,false);
  await assert.rejects(resume(failed),/lifecycle mismatch/);
  await assert.rejects(resume(await begin('resume-operational','operational')),/lifecycle mismatch/);
});

test('two competing resume requests using the old token cannot both rotate the fence',async()=>{
  const p=await begin('resume-race'),responses=await Promise.allSettled([resume(p),resume({...p,resume_request_id:crypto.randomUUID()})]);
  assert.equal(responses.filter(item=>item.status==='fulfilled').length,1);assert.equal(responses.filter(item=>item.status==='rejected').length,1);
  const current=responses.find(item=>item.status==='fulfilled').value;
  await assert.rejects(event(p,{kind:'heartbeat'}),/fence expired/);assert.equal((await event({...p,run_token:current.run_token},{kind:'heartbeat'})).recorded,true);
});

test('a later fence rotation rejects old nonce replays and altered cursor revisions refuse resumption',async()=>{
  const p=await begin('resume-generation'),first=await resume(p);
  await resume({...p,run_token:first.run_token,resume_request_id:crypto.randomUUID()});await assert.rejects(resume(p),/fence changed/);
  const revision=await begin('resume-revision');await db.query('UPDATE exam_collection_cursor SET revision=revision+1,received_through=now()-interval \'1 second\' WHERE collector_id=$1',[revision.collector_id]);await assert.rejects(resume(revision),/lifecycle mismatch/);
});

test('the actual Edge adapter resumes the real expired SQL sweep and rejects malformed input before RPC',async()=>{
  const p=await begin('resume-edge');await db.query("UPDATE exam_collection_sweep SET started_at=now()-interval '3 hours',expires_at=now()-interval '2 hours' WHERE id=$1",[p.sweep_id]);
  let calls=0;
  const adapter=async(name,args)=>{calls++;assert.equal(name,'resume_exam_intake_sweep');return rpc(name,[args.p_collector_id,args.p_scope_key,args.p_request_id,args.p_sweep_id,args.p_run_token,args.p_resume_request_id,args.p_ttl_seconds]);};
  const helpers={uuid:value=>{if(typeof value!=='string'||!/^[a-f\d-]{36}$/i.test(value))throw new Error('UUID_REQUIRED');return value;},hash:()=>{throw new Error('No file bytes in resume');}};
  const result=await routes.runIntakeAction('intake_resume',p,adapter,helpers);assert.notEqual(result.run_token,p.run_token);assert.equal(result.sweep_id,p.sweep_id);assert.equal(calls,1);
  await assert.rejects(routes.runIntakeAction('intake_resume',{...p,ttl_seconds:1.5},adapter,helpers),/INVALID/);assert.equal(calls,1);
});

test('a new begin that superseded an expired attempt prevents that old attempt from being resumed',async()=>{
  const first=await begin('resume-superseded');await db.query("UPDATE exam_collection_sweep SET started_at=now()-interval '3 hours',expires_at=now()-interval '2 hours' WHERE id=$1",[first.sweep_id]);
  const newer=await begin('resume-superseded');assert.notEqual(newer.sweep_id,first.sweep_id);
  assert.equal((await one('SELECT status FROM exam_collection_sweep WHERE id=$1',[first.sweep_id])).status,'failed');
  await assert.rejects(resume(first),/lifecycle mismatch/);
  assert.equal((await one('SELECT status FROM exam_collection_sweep WHERE id=$1',[newer.sweep_id])).status,'running');
});

test('runtime → actual Edge → SQL preserves a durable page across expiry and lost resume ACK, fencing the old token',async()=>{
  const now=Date.now(),cfg={enabled:true,allowScheduled:false,provider:'gmail',collectorId:'resume-runtime-edge',dataTableId:'syntheticPrivateTable',mailbox:'resume@example.invalid',
    serviceUrl:'https://fixture.supabase.co/functions/v1/exam-document-service',intakeCutoff:new Date(now-86400000).toISOString(),auditLookbackSeconds:86400,
    maxActions:100,maxMillis:180000,leaseMillis:900000,monitoring:false,resumeFence:true};
  const helpers={uuid:value=>String(value),hash:()=>{throw new Error('No file bytes in resume');}};
  const invoke=context=>routes.runIntakeAction(context.action,context.payload,(name,args)=>rpc(name,Object.values(args).map(value=>value&&typeof value==='object'?JSON.stringify(value):value)),helpers);
  const save=state=>{const expected=auditPersistenceRow(state,cfg),row={id:1,collector_key:expected.collector_key,state_json:expected.state_json,revision:expected.revision};return {row,state:verifyAuditPersistence([row],expected)};};
  let state=loadAuditState([],cfg,'runtime-one',now),context=nextAuditOperation(state,cfg,now);
  state=applyAuditResponse(context,{statusCode:200,body:await invoke(context)},cfg,now);
  state=applyAuditResponse(nextAuditOperation(state,cfg,now),{statusCode:200,body:{messages:[{id:'abcdef99'}],nextPageToken:'private-cursor'}},cfg,now);
  context=nextAuditOperation(state,cfg,now);await invoke(context); // Page persisted, event ACK lost before state advancement.
  const oldToken=state.runToken,originalPage=state.pendingEvents[0],saved=save({...state,releaseLease:true});
  await db.query("UPDATE exam_collection_sweep SET started_at=now()-interval '3 hours',expires_at=now()-interval '2 hours' WHERE id=$1",[state.sweepId]);
  state=loadAuditState([saved.row],cfg,'runtime-two',Date.now());const nonceRow=save(state);context=nextAuditOperation(nonceRow.state,cfg,Date.now());
  assert.equal(context.action,'intake_resume');assert.equal(JSON.parse(nonceRow.row.state_json).resumeRequest.resumeRequestId,context.payload.resume_request_id);
  const resumed=await invoke(context);state=applyAuditFailure(context,'AUDIT_BACKEND_UNAVAILABLE',Date.now());
  const lost=save({...state,releaseLease:true});state=loadAuditState([lost.row],cfg,'runtime-three',Date.now());context=nextAuditOperation(save(state).state,cfg,Date.now());
  const replay=await invoke(context);assert.equal(replay.replayed,true);assert.equal(replay.run_token,resumed.run_token);
  state=applyAuditResponse(context,{statusCode:200,body:replay},cfg,Date.now());context=nextAuditOperation(save(state).state,cfg,Date.now());
  assert.equal(context.action,'intake_event');assert.deepEqual(context.payload.event,originalPage);assert.equal(context.payload.run_token,resumed.run_token);
  await invoke(context);
  assert.equal(Number((await one('SELECT count(*) n FROM exam_intake_page WHERE sweep_id=$1',[state.sweepId])).n),1);
  assert.equal(Number((await one('SELECT count(*) n FROM exam_collection_message WHERE sweep_id=$1',[state.sweepId])).n),1);
  await assert.rejects(rpc('record_exam_intake_event',[state.sweepId,oldToken,JSON.stringify({kind:'heartbeat'})]),/fence expired/);
});

test('runtime recovers a committed finish whose ACK was lost by replaying real finish without resuming or reopening it',async()=>{
  const now=Date.now(),cfg={enabled:true,allowScheduled:false,provider:'gmail',collectorId:'resume-finish-ack',dataTableId:'syntheticPrivateTable',mailbox:'resume@example.invalid',
    serviceUrl:'https://fixture.supabase.co/functions/v1/exam-document-service',intakeCutoff:new Date(now-86400000).toISOString(),auditLookbackSeconds:86400,
    maxActions:100,maxMillis:180000,leaseMillis:900000,monitoring:false,resumeFence:true};
  const invoke=context=>routes.runIntakeAction(context.action,context.payload,(name,args)=>rpc(name,Object.values(args).map(value=>value&&typeof value==='object'?JSON.stringify(value):value)),{uuid:value=>String(value),hash(){throw new Error('No original bytes');}});
  let state=loadAuditState([],cfg,'finish-original',now),context,finishResult;
  for(let guard=0;guard<20;guard++) {
    context=nextAuditOperation(state,cfg,Date.now());
    const body=context.target==='gmail'?{messages:[]}:await invoke(context);
    if(context.action==='intake_finish') {finishResult=body;break;}
    state=applyAuditResponse(context,{statusCode:200,body},cfg,Date.now());
  }
  assert.equal(finishResult.scanFinished,true);
  state=applyAuditFailure(context,'AUDIT_BACKEND_UNAVAILABLE',Date.now());
  const expected=auditPersistenceRow({...state,releaseLease:true},cfg),row={id:1,collector_key:expected.collector_key,state_json:expected.state_json,revision:expected.revision};
  state=loadAuditState([row],cfg,'finish-retry',Date.now());context=nextAuditOperation(state,cfg,Date.now());
  assert.equal(context.action,'intake_finish');assert.equal(state.resumeRequest,undefined);
  const replay=await invoke(context);assert.deepEqual(replay,finishResult);
  state=applyAuditResponse(context,{statusCode:200,body:replay},cfg,Date.now());
  assert.equal(state.phase,'done');assert.equal(state.finishResult.coverageComplete,true);
  assert.equal(Number((await one('SELECT count(*) n FROM exam_intake_resume_request WHERE sweep_id=$1',[state.sweepId])).n),0);
  assert.equal((await one('SELECT status FROM exam_collection_sweep WHERE id=$1',[state.sweepId])).status,'committed');
});
