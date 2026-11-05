import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),ts=require('typescript');
const source=await readFile(new URL('../functions/exam-document-service/pipeline-service-routes.ts',import.meta.url),'utf8');
const exports={};
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,URL,TextEncoder,AbortSignal,fetch:async()=>{throw Error('No live network in tests')}});
const {runPipelineAction:run,examPipelineWakeupStages:wakeStages,dispatchExamPipelineWakeups:dispatch}=exports;
const id='10000000-0000-0000-0000-000000000001',lease='20000000-0000-0000-0000-000000000001';
const calls=[];
const rpc=async(name,args)=>{calls.push({name,args});return {name,args}};
const hash=async bytes=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
const helpers={uuid(v){if(typeof v!=='string'||!/^[-0-9a-f]{36}$/.test(v))throw Error('UUID_INVALID');return v},hash};
test('worker acquisition and reservation contract keeps the global stage fence',async()=>{
 calls.length=0;await run('worker_acquire',{stage:'processing',worker:'n8n:123'},rpc,helpers);
 assert.equal(calls[0].name,'acquire_exam_pipeline_worker');assert.equal(calls[0].args.p_lease_seconds,660);
 await assert.rejects(run('worker_acquire',{stage:'group',worker:'n8n:123',lease_seconds:901},rpc,helpers),/LEASE_INVALID/);
 await assert.rejects(run('worker_acquire',{stage:'reaction',worker:'n8n:123'},rpc,helpers),/STAGE_INVALID/);
 assert.equal(calls.length,1);
});
test('group begin hashes exact Unicode caption and disregards a client hash',async()=>{
 calls.length=0;const content='🧪 Paciente de teste\nHemograma';
 await run('group_begin',{delivery_id:id,lease_token:lease,presentation_revision:'a'.repeat(32),content,content_sha256:'f'.repeat(64)},rpc,helpers);
 assert.equal(calls[0].name,'begin_exam_group_dispatch');assert.equal(calls[0].args.p_content_sha256,await hash(new TextEncoder().encode(content)));
 await assert.rejects(run('group_begin',{delivery_id:id,lease_token:lease,presentation_revision:'a'.repeat(32),content:''},rpc,helpers),/CONTENT_INVALID/);
 await assert.rejects(run('group_begin',{delivery_id:id,lease_token:lease,presentation_revision:'a'.repeat(31),content},rpc,helpers),/REVISION_INVALID/);
 assert.equal(calls.length,1);
});
test('rename preparation fences document version and name before physical mutation',async()=>{
 calls.length=0;await run('rename_prepare',{delivery_id:id,lease_token:lease,document_version:7,name:'Fixture.pdf'},rpc,helpers);
 assert.equal(calls[0].name,'prepare_exam_document_rename');assert.equal(calls[0].args.p_document_version,7);
 await assert.rejects(run('rename_prepare',{delivery_id:id,lease_token:lease,document_version:0,name:'Fixture.pdf'},rpc,helpers),/VERSION_INVALID/);
 await assert.rejects(run('rename_prepare',{delivery_id:id,lease_token:lease,document_version:7,name:'bad\nname.pdf'},rpc,helpers),/NAME_INVALID/);
});
test('independent reconciliation is bounded and requires the worker lease',async()=>{
 calls.length=0;await run('group_reconcile',{worker:'n8n:123',worker_lease_token:lease,limit:4},rpc,helpers);
 assert.equal(calls[0].name,'list_exam_pipeline_group_reconciliation');assert.equal(calls[0].args.p_worker_lease_token,lease);
 await assert.rejects(run('group_reconcile',{worker:'n8n:123',worker_lease_token:lease,limit:5},rpc,helpers),/LIMIT_INVALID/);
});
test('wakeup stages require persisted results and never loop on empty/submitted reconciliation',()=>{
 assert.deepEqual([...wakeStages('confirm_file',{}, {})],['processing']);
 assert.deepEqual([...wakeStages('extraction',{}, {})],['rename','nexus']);
 assert.deepEqual([...wakeStages('task_result',{}, {task:{destination:'processing',status:'completed'}})],['group','nexus','rename']);
 for(const status of ['failed','pending','reserved'])assert.deepEqual([...wakeStages('task_result',{}, {task:{destination:'processing',status}})],[]);
 assert.deepEqual([...wakeStages('task_result',{}, {task:{destination:'group',status:'submitted'}})],['reconcile']);
 assert.deepEqual([...wakeStages('task_result',{reconciliation:true}, {task:{destination:'group',status:'submitted'}})],[]);
 assert.deepEqual([...wakeStages('worker_release',{stage:'processing',continue:true},{released:true})],['processing']);
 assert.deepEqual([...wakeStages('worker_release',{stage:'processing',continue:true},{released:false})],[]);
 assert.deepEqual([...wakeStages('worker_release',{stage:'processing'},{released:true})],[]);
 assert.deepEqual([...wakeStages('worker_release',{stage:'processing'},{released:true,has_more:true})],['processing']);
 assert.deepEqual([...wakeStages('reaction_result',{}, {})],[]);
});
test('notifications use the existing credential only for the authorized origin, with no clinical payload',async()=>{
 const requests=[];
 const config=async()=>({enabled:true,n8n_base_url:'https://n8n.joaoai.com'});
 const result=await dispatch(['processing','processing','group','reaction'],'fixture-only-secret',config,async(url,init)=>{
  requests.push({url:String(url),init});return new Response('accepted',{status:200});
 });
 assert.equal(result.attempted,2);assert.equal(result.accepted,2);
 assert.equal(requests[0].url,'https://n8n.joaoai.com/webhook/pamvet-exam-processing-wakeup');
 for(const {init} of requests){assert.equal(init.headers.Authorization,'fixture-only-secret');assert.equal(init.redirect,'error');assert.ok(init.signal);assert.deepEqual(Object.keys(JSON.parse(init.body)).sort(),['stage','trigger']);}
});
test('disabled, unavailable, or changed recipient never prevents the committed operation',async()=>{
 let requests=0;const network=async()=>{requests++;throw Error('down')};
 for(const config of [{enabled:false,n8n_base_url:'https://n8n.joaoai.com'},{enabled:true,n8n_base_url:'https://evil.invalid'},{enabled:true,n8n_base_url:'http://n8n.joaoai.com'},{enabled:true,n8n_base_url:'https://n8n.joaoai.com/other'},{enabled:true,n8n_base_url:'https://someone:secret@n8n.joaoai.com'}]){
  assert.equal((await dispatch(['processing'],'fixture',async()=>config,network)).attempted,0);
 }
 assert.equal((await dispatch(['processing'],'fixture',async()=>{throw Error('schema rollout')},network)).attempted,0);
 assert.equal(requests,0);
 const result=await dispatch(['processing'],'fixture',async()=>({enabled:true,n8n_base_url:'https://n8n.joaoai.com'}),network);
 assert.equal(result.attempted,1);assert.equal(result.accepted,0);
});
