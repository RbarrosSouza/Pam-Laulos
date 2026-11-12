import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
const source=await readFile(new URL('../functions/exam-whatsapp-fallback/auth.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {authenticateFallbackRequest:auth}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const key='synthetic-auth-test-key-never-used-in-production', now=Date.parse('2026-11-03T20:00:00Z');
const nonce='11111111-1111-4111-8111-111111111111', body='{"action": "run"}';
function request({text=body,timestamp=String(now/1000),id=nonce,headers={},method='POST',signingKey=key}={}) {
 const signature=createHmac('sha256',signingKey).update(timestamp+'\n'+id+'\n'+text).digest('hex');
 return new Request('https://example.invalid/functions/v1/exam-whatsapp-fallback',{method,headers:{'x-exam-fallback-timestamp':timestamp,'x-exam-fallback-nonce':id,'x-exam-fallback-signature':signature,...headers}});
}
test('PostgreSQL JSONB body spelling authenticates against independent Node HMAC',async()=>{
 assert.equal(await auth(request(),key,body,now),true);
 assert.equal(await auth(request(),key,'{"action":"run"}',now),false);
 assert.equal(await auth(request(),key,body,now+120001),false);
 assert.equal(await auth(request({timestamp:String(now/1000+6)}),key,body,now),false);
 assert.equal(await auth(request({timestamp:String(now/1000+5)}),key,body,now),true);
});
test('wrong keys, nonce mutation, invalid signatures, old timestamps and method are rejected',async()=>{
 for(const options of [{signingKey:'another-key'},{id:'not-a-uuid'},
  {headers:{'x-exam-fallback-nonce':'22222222-2222-4222-8222-222222222222'}},
  {headers:{'x-exam-fallback-signature':'0'.repeat(64)}},
  {headers:{'x-exam-fallback-signature':'f'.repeat(65)}},
  {timestamp:String(now/1000-121)},{timestamp:'0'+String(now/1000)},{method:'GET'}])
  assert.equal(await auth(request(options),key,body,now),false);
});
test('HMAC only permits a fixed run action and bounded exact bytes',async()=>{
 for(const text of ['{"action":"preflight"}','{"action":"run","destination":"other"}','[]','null','{"action":',
  '{"action":"run","x":"'+'á'.repeat(600)+'"}']) assert.equal(await auth(request({text}),key,text,now),false);
 assert.equal(await auth(request(),undefined,body,now),false);
 assert.equal(await auth(request(),'short',body,now),false);
});
test('dedicated Bearer remains exact and constant-time compared, with no HMAC downgrade',async()=>{
 assert.equal(await auth(request({headers:{Authorization:'Bearer '+key}}),key,'{"action":"preflight"}',now),true);
 for(const authorization of ['bearer '+key,'Bearer  '+key,'Bearer '+key+'x','Bearer wrong'])
  assert.equal(await auth(request({headers:{Authorization:authorization}}),key,body,now),false);
 assert.equal(await auth(request({headers:{Authorization:'Bearer '+key}}),key,'x'.repeat(1025),now),false);
});

test('actual handler separates native transient failures from business fences before collection or dispatch',async()=>{
 const handlerSource=await readFile(new URL('../functions/exam-whatsapp-fallback/index.ts',import.meta.url),'utf8');
 const script=ts.transpileModule(handlerSource.replace(/^import .*;\s*$/gm,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 const runnerSource=await readFile(new URL('../functions/exam-whatsapp-fallback/runner.ts',import.meta.url),'utf8');
 const runnerScript=ts.transpileModule(runnerSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
 const {safeError,fallbackBackendError,isFallbackTransient}=await import('data:text/javascript;base64,'+Buffer.from(runnerScript).toString('base64'));
 for(const [code,expected,status] of [['40001','fallback_backend_unavailable',503],['PT409','fallback_fence_conflict',409],['42501','fallback_scope_denied',403],['22023','fallback_rpc_failed',422]]) {
  let handler;const calls=[];
  vm.runInNewContext(script,{Request,Response,TextDecoder,TextEncoder,Uint8Array,AbortSignal,Error,safeError,fallbackBackendError,isFallbackTransient,
   authenticateFallbackRequest:(req,secret,text)=>auth(req,secret,text,now),
   selectExamSupabasePrivilegedKey:()=> 'synthetic-service-key',
   createClient:()=>({rpc:async name=>{calls.push(name);return {data:null,error:{code,message:'Provider detail must not leave handler'}};},from:()=>{throw new Error('unexpected_collection');}}),
   Deno:{env:{get:name=>name==='EXAM_FALLBACK_TRIGGER_KEY'?key:name==='SUPABASE_URL'?'https://backend.example.invalid':undefined},serve:fn=>{handler=fn;}},
  });
  const response=await handler(new Request(request(),{body}));
  assert.equal(response.status,status);
  assert.deepEqual(await response.json(),{error:expected,partial:false,nextAction:'reconcile_before_retry'});
  assert.deepEqual(calls,['consume_exam_fallback_scheduler_trigger']);
 }
});
