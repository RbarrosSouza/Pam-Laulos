import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');
const source=readFileSync(new URL('../../src/lib/document-service-request.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const mod={exports:{}};new Function('exports',code)(mod.exports);const {requestDocumentDeletion}=mod.exports;
const session={data:{session:{access_token:'synthetic-token'}}},payload={document_id:'synthetic-document',confirmation:'DELETAR',expected_version:1};
const deps=overrides=>({url:'https://fixture.invalid/functions/v1/exam-document-service',apiKey:'synthetic-key',getSession:async()=>session,fetch:async()=>new Response(JSON.stringify({state:'deleted'})),authTimeoutMs:15,timeoutMs:15,...overrides});
const tick=()=>new Promise(r=>setImmediate(r));
test('a stalled session times out and a late session cannot send a destructive request',async()=>{
 let release,calls=0;const d=deps({getSession:()=>new Promise(r=>release=r),fetch:async()=>{calls++;return new Response('{}')}});
 await assert.rejects(requestDocumentDeletion('delete',payload,d),e=>e.code==='DOCUMENT_AUTH_TIMEOUT');release(session);await tick();assert.equal(calls,0);
});
test('a stalled fetch is aborted once and does not retry deletion',async()=>{
 let calls=0,signal;await assert.rejects(requestDocumentDeletion('delete',payload,deps({fetch:async(_url,options)=>{calls++;signal=options.signal;return new Promise(()=>{})}})),e=>e.code==='DOCUMENT_SERVICE_TIMEOUT');assert.equal(calls,1);assert.equal(signal.aborted,true);
});
test('a response whose body never finishes is also bounded',async()=>{
 await assert.rejects(requestDocumentDeletion('delete',payload,deps({fetch:async()=>({ok:true,json:()=>new Promise(()=>{})})})),e=>e.code==='DOCUMENT_SERVICE_TIMEOUT');
});
test('successful status reads remain read-only and clear the deadline',async()=>{
 let body,signal;const result=await requestDocumentDeletion('delete_status',{document_id:payload.document_id},deps({fetch:async(_url,options)=>{body=JSON.parse(options.body);signal=options.signal;return new Response(JSON.stringify({state:'deleted'}))}}));assert.equal(result.state,'deleted');assert.deepEqual(body,{action:'delete_status',payload:{document_id:payload.document_id}});await new Promise(r=>setTimeout(r,25));assert.equal(signal.aborted,false);
});
test('HTTP failures and absent sessions cannot become a success',async()=>{
 await assert.rejects(requestDocumentDeletion('delete',payload,deps({fetch:async()=>new Response(JSON.stringify({error:'Ficha ocupada'}),{status:409})})),/Ficha ocupada/);
 let sent=false;await assert.rejects(requestDocumentDeletion('delete',payload,deps({getSession:async()=>({data:{session:null}}),fetch:async()=>{sent=true}})),/Entre novamente/);assert.equal(sent,false);
});
