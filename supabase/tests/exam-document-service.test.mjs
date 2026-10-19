// Executes the actual Edge handler with isolated Supabase/Storage/OAuth adapters.
// SQL behavior is covered separately by exam-documents.test.mjs. No live service is contacted.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const ts=require('typescript');
const documentId='30000000-0000-0000-0000-000000000001';
const sourceId='30000000-0000-0000-0000-000000000002';
const petId='20000000-0000-0000-0000-000000000001';
const userId='10000000-0000-0000-0000-000000000001';
const taskId='40000000-0000-0000-0000-000000000001';
const token='50000000-0000-0000-0000-000000000001';
const fixtureBytes=new TextEncoder().encode('%PDF-1.4\nSynthetic fixture; no patient data.\n%%EOF');
const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',fixtureBytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
const env=new Map([['SUPABASE_URL','https://fixture.invalid'],['SUPABASE_SERVICE_ROLE_KEY','fixture-service-secret'],['EXAM_INGESTION_API_KEY','fixture-worker-secret']]);
const objects=new Map();
const calls=[];
const clientKeys=[];
const authCalls=[];
let docs, tasks, stageClaimed=true, uploadFails=false, recorded=[], composioCalls=[], composioFails=false, driveFetchEnabled=false;
function reset() {
  objects.clear(); calls.length=0; clientKeys.length=0; authCalls.length=0; recorded=[];
  env.set("EXAM_INGESTION_API_KEY","fixture-worker-secret"); stageClaimed=true; uploadFails=false;
  env.delete("EXAM_SUPABASE_SECRET_KEY_NAME"); env.delete("SUPABASE_SECRET_KEYS");
  composioCalls=[]; composioFails=false; driveFetchEnabled=false;
  docs=[{id:documentId,sha256:hash,size_bytes:fixtureBytes.byteLength,mime_type:'application/pdf',original_name:'fixture.pdf',
    file_status:'pending',identification_status:'confirmed',pet_id:petId,confirmed_data:{exam_date:'2026-10-09',exam_type:'Fixture'},
    staging_bucket:'exam_documents_staging',staging_path:`${documentId}/original.pdf`,storage_bucket:null,storage_path:null,drive_file_id:null}];
  tasks=[{id:taskId,document_id:documentId,destination:'nexus',status:'reserved',lease_token:token,lease_until:new Date(Date.now()+600_000).toISOString()}];
  env.delete('GOOGLE_DRIVE_ACCESS_TOKEN'); env.delete('GOOGLE_DRIVE_REFRESH_TOKEN');
  for(const key of ['EXAM_DRIVE_READER','COMPOSIO_CONSUMER_API_KEY','COMPOSIO_DRIVE_ACCOUNT','COMPOSIO_FILE_DOWNLOAD_HOSTS','COMPOSIO_STAGING_SCOPE']) env.delete(key);
}
function tableRows(name) {
  if(name==='exam_document') return docs;
  if(name==='exam_document_delivery') return tasks;
  if(name==='exam_document_member') return [{user_id:userId,active:true}];
  if(name==='exam_document_configuration') return [{max_file_bytes:20*1024*1024}];
  return [];
}
function table(name) {
  let filters=[],mode='select',patch;
  const chain={
    select(){return chain},eq(k,v){filters.push([k,v]);return chain},
    update(value){mode='update';patch=value;return chain},
    insert(value){mode='insert';patch=value;return chain},
    async result(single=false){
      const rows=tableRows(name).filter(r=>filters.every(([k,v])=>r[k]===v));
      if(mode==='update'){rows.forEach(r=>Object.assign(r,patch));return {data:rows,error:null}}
      if(mode==='insert'){recorded.push({table:name,value:patch});return {data:null,error:null}}
      return {data:single ? rows[0] || null : rows,error:single && !rows[0] ? {code:'NOT_FOUND'} : null};
    },maybeSingle(){return chain.result(true)},single(){return chain.result(true)},
    then(resolve,reject){return chain.result().then(resolve,reject)},
  };
  return chain;
}
const client={
  auth:{async getUser(access){authCalls.push(access);return access==='fixture-user-token' ? {data:{user:{id:userId}},error:null}
    : access==='fixture-outsider-token' ? {data:{user:{id:sourceId}},error:null} : {data:{user:null},error:{message:'invalid'}}}},
  from:table,
  storage:{from(bucket){return {
    async download(path){const bytes=objects.get(`${bucket}:${path}`);return bytes ? {data:new Blob([bytes]),error:null} : {data:null,error:{statusCode:'404'}}},
    async upload(path,bytes,options){calls.push({op:'upload',bucket,path,options});
      if(uploadFails) return {error:{statusCode:'503'}};
      if(objects.has(`${bucket}:${path}`)) return {error:{statusCode:'409'}};
      objects.set(`${bucket}:${path}`,new Uint8Array(bytes));return {error:null};},
    async createSignedUrl(path,ttl){calls.push({op:'signed',bucket,path,ttl});return {data:{signedUrl:'https://fixture.invalid/signed-private-url'},error:null}},
  }}},
  async rpc(name,args){calls.push({op:'rpc',name,args});
    if(name==='reserve_exam_document_source') return {data:{document_id:sourceId},error:null};
    if(name==='stage_exam_document_file') return {data:{document_id:documentId,document:{...docs[0]},claimed:stageClaimed,delivery_id:taskId,lease_token:token},error:null};
    if(name==='complete_exam_document_delivery') return {data:{task:{status:'completed'},exame_id:'fixture-exam'},error:null};
    return {data:{name,args},error:null};
  },
};
// Execute the real OAuth reader with an injected HTTP provider; no real account/network.
async function fixtureFetch(url,init) {
  calls.push({op:'fetch',url:String(url),init});
  if(!driveFetchEnabled) throw new Error('Unexpected external request in isolated tests');
  if(String(url).includes('fields=')) return Response.json({id:'fixture-drive',parents:['fixture-folder'],mimeType:'application/pdf',trashed:false,size:String(fixtureBytes.length),sha256Checksum:hash});
  return new Response(fixtureBytes,{headers:{'Content-Type':'application/pdf'}});
}
const readerExports={};
const readerSource=await readFile(new URL('../functions/exam-document-service/composio-original-reader.ts',import.meta.url),'utf8');
const readerScript=ts.transpileModule(readerSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
vm.runInNewContext(readerScript,{exports:readerExports,Request,Response,URL,URLSearchParams,AbortController,
  crypto,TextDecoder,TextEncoder,Uint8Array,ArrayBuffer,Date,setTimeout,clearTimeout,fetch:fixtureFetch});
const keyExports={};
const keySource=await readFile(new URL('../functions/exam-document-service/supabase-privileged-key.ts',import.meta.url),'utf8');
vm.runInNewContext(ts.transpileModule(keySource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports:keyExports});
let handler;
const source=await readFile(new URL('../functions/exam-document-service/index.ts',import.meta.url),'utf8');
const script=ts.transpileModule(source.replace(/^import .*;\s*$/gm,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
vm.runInNewContext(script,{selectExamSupabasePrivilegedKey:keyExports.selectExamSupabasePrivilegedKey,createClient:(_url,key)=>{clientKeys.push(key);return client},Deno:{env:{get:k=>env.get(k)},serve(fn){handler=fn}},Request,Response,File,Blob,FormData,URL,URLSearchParams,
  crypto,TextDecoder,TextEncoder,Uint8Array,ArrayBuffer,Date,
  oauthDriveReaderConfig:readerExports.oauthDriveReaderConfig,
  readOAuthDriveOriginal:readerExports.readOAuthDriveOriginal,
  // The adapter itself, including real SDK JSON/SSE transport, is tested by composio-original-reader.test.ts.
  composioReaderConfig(get){
    const value={apiKey:get('COMPOSIO_CONSUMER_API_KEY'),driveAccount:get('COMPOSIO_DRIVE_ACCOUNT'),downloadHosts:[get('COMPOSIO_FILE_DOWNLOAD_HOSTS')]};
    if(!value.apiKey || !value.driveAccount || !value.downloadHosts[0]) throw Object.assign(new Error('Leitura Composio incompleta no servidor'),{status:503});
    return value;
  },
  async readComposioDriveOriginal(expected,config){composioCalls.push({expected,config});
    if(composioFails) throw Object.assign(new Error('Leitura Composio indisponível; preservar pendência'),{status:503});
    return fixtureBytes.slice().buffer;
  },
  fetch:async(url,init)=>{calls.push({op:'fetch',url:String(url),init});
    if(driveFetchEnabled) return new Response(fixtureBytes);throw new Error('Unexpected external request in isolated tests');
  },
});
async function request(action,payload={},auth='fixture-worker-secret') {
  return handler(new Request('https://fixture.invalid/exam-document-service',{method:'POST',headers:{'Content-Type':'application/json',...(auth ? {Authorization:`Bearer ${auth}`} : {})},body:JSON.stringify({action,payload})}));
}
async function manual() {
  const form=new FormData();form.set('action','upload');form.set('payload',JSON.stringify({message_id:'fixture-upload'}));
  form.set('file',new File([fixtureBytes],'fixture.pdf',{type:'application/pdf'}));
  return handler(new Request('https://fixture.invalid/exam-document-service',{method:'POST',headers:{Authorization:'Bearer fixture-user-token'},body:form}));
}
let count=0;
async function check(name,run){reset();await run();count++;console.log(`ok ${count} - ${name}`)}
await check('missing authorization is refused',async()=>assert.equal((await request('file',{document_id:documentId},null)).status,401));
await check('named modern key reaches the actual handler client without changing worker authorization',async()=>{
  env.set('EXAM_SUPABASE_SECRET_KEY_NAME','exams-only');
  env.set('SUPABASE_SECRET_KEYS',JSON.stringify({default:'sb_secret_wrong_fixture','exams-only':'sb_secret_selected_fixture'}));
  assert.equal((await request('reserve_source',{})).status,200);
  assert.deepEqual(clientKeys,['sb_secret_selected_fixture']);
});
await check('invalid explicit modern key stops before client/auth/RPC and does not expose values or use legacy',async()=>{
  env.set('EXAM_SUPABASE_SECRET_KEY_NAME','missing-name');
  env.set('SUPABASE_SECRET_KEYS',JSON.stringify({default:'sb_secret_hidden_fixture'}));
  const res=await request('reserve_source',{});assert.equal(res.status,503);
  assert.deepEqual(await res.json(),{error:'EXAM_SUPABASE_SECRET_KEY_NOT_FOUND',code:'EXAM_DOCUMENT_ERROR'});
  assert.equal(clientKeys.length,0);assert.equal(calls.length,0);
});
async function rawAuthorizationRequest(value) {
  return handler(new Request('https://fixture.invalid/exam-document-service',{method:'POST',headers:{'Content-Type':'application/json',Authorization:value},body:JSON.stringify({action:'reserve_source',payload:{}})}));
}
await check('raw 32-byte worker token reaches worker action only when equal to the dedicated secret',async()=>{
  env.set('EXAM_INGESTION_API_KEY','c'.repeat(64));
  assert.equal((await rawAuthorizationRequest('c'.repeat(64))).status,200);
  assert.equal(calls.filter(c=>c.op==='rpc').length,1);
});
await check('different raw worker token is refused before all RPCs',async()=>{
  env.set('EXAM_INGESTION_API_KEY','c'.repeat(64));
  assert.equal((await rawAuthorizationRequest('d'.repeat(64))).status,401);assert.equal(calls.length,0);assert.equal(authCalls.length,0);
});
await check('missing dedicated worker key refuses raw token',async()=>{
  env.delete('EXAM_INGESTION_API_KEY');assert.equal((await rawAuthorizationRequest('c'.repeat(64))).status,401);assert.equal(calls.length,0);assert.equal(authCalls.length,0);
});
await check('raw user JWT-like marker cannot bypass Bearer and active membership',async()=>{
  assert.equal((await rawAuthorizationRequest('fixture-user-token')).status,401);assert.equal(calls.length,0);assert.equal(authCalls.length,0);
});
await check('malformed raw scheme, length and whitespace cannot become worker authorization',async()=>{
  env.set('EXAM_INGESTION_API_KEY','c'.repeat(64));
  for(const value of ['Token '+'c'.repeat(64),'c'.repeat(63),'c'.repeat(65),'Bearer'+'c'.repeat(64),'c'.repeat(32)+' '+'c'.repeat(32),'c'.repeat(64)+','+'c'.repeat(64),'C'.repeat(64)])
    assert.equal((await rawAuthorizationRequest(value)).status,401);
  assert.equal(calls.length,0);
});
await check('expired/unknown user tokens are refused',async()=>assert.equal((await request('file',{document_id:documentId},'invalid-user')).status,401));
await check('authenticated outsider cannot retrieve clinical PDF',async()=>assert.equal((await request('file',{document_id:documentId},'fixture-outsider-token')).status,403));
await check('member cannot use ingestion/service actions',async()=>assert.equal((await request('reserve_source',{},'fixture-user-token')).status,403));
await check('daily summary preview/reserve/begin/result are worker-only, including active members',async()=>{
  for(const action of ['pending_summary_preview','pending_summary_reserve','pending_summary_begin','pending_summary_result']){
    assert.equal((await request(action,{},'fixture-user-token')).status,403);
    assert.equal((await request(action,{},'fixture-outsider-token')).status,403);
    assert.equal((await request(action,{},null)).status,401);
  }
  assert.equal(calls.length,0);
});
await check('summary preview performs one read-only RPC and no provider/storage call or client clock override',async()=>{
  assert.equal((await request('pending_summary_preview',{day:'1900-01-01',as_of:'1900-01-01T00:00:00Z',destination_key:'forged'})).status,200);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{op:'rpc',name:'preview_exam_pending_summary',args:{}}]);
});
await check('summary reserve forwards only the worker; destination/day/dry-run cannot bypass server gates',async()=>{
  assert.equal((await request('pending_summary_reserve',{worker:'n8n:fixture',day:'1900-01-01',destination_key:'forged',dry_run:false,as_of:'1900-01-01'})).status,200);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{op:'rpc',name:'reserve_exam_pending_summary',args:{p_worker:'n8n:fixture'}}]);
});
await check('summary begin hashes the actual final content and never accepts a caller-provided hash',async()=>{
  const content='🧪 Resumo fixture\nSem dados clínicos.',expected=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(content)))].map(x=>x.toString(16).padStart(2,'0')).join('');
  assert.equal((await request('pending_summary_begin',{summary_id:taskId,lease_token:token,destination_key:'fixture-group',content,content_sha256:'forged'})).status,200);
  const actual=calls[0];assert.equal(actual.name,'begin_exam_pending_summary');assert.equal(actual.args.p_content_sha256,expected);
  assert.equal(actual.args.p_content_characters,Array.from(content).length);assert.equal(actual.args.p_destination_key,'fixture-group');
  assert.equal(JSON.stringify(calls).includes(content),false);assert.equal(calls.length,1);
});
await check('summary begin rejects absent/blank/oversize/NUL content or invalid UUID before any RPC',async()=>{
  for(const content of [undefined,null,'','   ','a'.repeat(12001),'bad\u0000content'])
    assert.equal((await request('pending_summary_begin',{summary_id:taskId,lease_token:token,destination_key:'fixture',content})).status,400);
  assert.equal((await request('pending_summary_begin',{summary_id:'invalid',lease_token:token,content:'fixture'})).status,400);
  assert.equal(calls.length,0);
});
await check('summary result requires UUID fences and forwards outcome only to the summary ledger RPC',async()=>{
  const outcome={status:'created',external_id:'9001',external_status:'sent',content_sha256:hash};
  assert.equal((await request('pending_summary_result',{summary_id:taskId,lease_token:'invalid',outcome})).status,400);assert.equal(calls.length,0);
  assert.equal((await request('pending_summary_result',{summary_id:taskId,lease_token:token,outcome})).status,200);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{op:'rpc',name:'record_exam_pending_summary_result',args:{p_summary_id:taskId,p_lease_token:token,p_outcome:outcome}}]);
});
await check('member cannot begin staging or report a helper result',async()=>{
  for(const action of ['begin_staging','staging_result']) assert.equal((await request(action,{},'fixture-user-token')).status,403);
  assert.equal(calls.length,0);
});
await check('shared staging stays disabled until server scope is configured',async()=>{
  assert.equal((await request('begin_staging',{})).status,503);
  env.set('COMPOSIO_STAGING_SCOPE','invalid scope');assert.equal((await request('begin_staging',{})).status,503);
  assert.equal(calls.length,0);
});
await check('begin staging uses the server scope and performs no helper/external call',async()=>{
  env.set('COMPOSIO_STAGING_SCOPE','fixture-workspace:fixture-account');
  const origin={channel:'email',account_id:'fixture-account',message_id:'fixture-message',attachment_id:'fixture-attachment'};
  assert.equal((await request('begin_staging',{source:origin,file:{sha256:hash,size_bytes:fixtureBytes.length},provider_scope:'payload-cannot-change-scope',deadline_seconds:45})).status,200);
  assert.deepEqual(calls.map(c=>c.name),['begin_exam_document_staging']);
  assert.equal(calls[0].args.p_provider_scope,'fixture-workspace:fixture-account');
  assert.deepEqual(calls[0].args.p_source,origin);
  assert.equal(calls[0].args.p_deadline_seconds,45);
  assert.equal((await request('begin_staging',{source:origin})).status,200);
  assert.equal(calls[1].args.p_file,null);
});
await check('result action requires UUID operation and nonce before its worker RPC',async()=>{
  const outcome={state:'reported',sha256:hash,size_bytes:fixtureBytes.length,helper_reference_sha256:'a'.repeat(64)};
  assert.equal((await request('staging_result',{operation_id:taskId,outcome})).status,400);
  assert.equal(calls.length,0);
  assert.equal((await request('staging_result',{operation_id:taskId,dispatch_nonce:token,outcome})).status,200);
  assert.deepEqual(calls.map(c=>c.name),['record_exam_document_staging']);
  assert.equal(calls[0].args.p_dispatch_nonce,token);
  assert.deepEqual(calls[0].args.p_outcome,outcome);
});
await check('private PDF read checks original hash and returns verified bytes',async()=>{
  objects.set(`exam_documents_staging:${documentId}/original.pdf`,fixtureBytes);
  const res=await request('file',{document_id:documentId},'fixture-user-token');assert.equal(res.status,200);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()),fixtureBytes);assert.match(res.headers.get('cache-control'),/no-store/);
});
await check('private PDF read refuses corrupted object',async()=>{
  objects.set(`exam_documents_staging:${documentId}/original.pdf`,new Uint8Array(fixtureBytes.length));
  assert.equal((await request('file',{document_id:documentId},'fixture-user-token')).status,409);
});
await check('manual retry repairs the canonical staged object, not the duplicate origin',async()=>{
  const res=await manual();assert.equal(res.status,201);assert.equal((await res.json()).document_id,documentId);
  assert.ok(objects.has(`exam_documents_staging:${documentId}/original.pdf`));
  assert.equal(calls.find(c=>c.op==='upload').path,`${documentId}/original.pdf`);
  assert.equal(recorded.find(x=>x.value.event_type==='manual_uploaded').value.actor_id,userId);
});
await check('manual retry with active lease cannot report upload success when bytes are missing',async()=>{
  stageClaimed=false;const res=await manual();assert.equal(res.status,503);assert.equal(recorded.length,0);
});
await check('failed manual storage releases lease for a recoverable retry',async()=>{
  uploadFails=true;assert.equal((await manual()).status,503);assert.equal(tasks[0].status,'failed');assert.equal(tasks[0].lease_until,null);
});
await check('Nexus attaches deterministic private copy and verifies it before completing SQL',async()=>{
  objects.set(`exam_documents_staging:${documentId}/original.pdf`,fixtureBytes);
  const res=await request('attach_nexus',{delivery_id:taskId,lease_token:token});assert.equal(res.status,200);
  const effect=calls.find(c=>c.name==='complete_exam_document_delivery');
  assert.equal(effect.args.p_outcome.storage_path,`${petId}/${documentId}/original.pdf`);assert.equal(effect.args.p_outcome.sha256,hash);
  assert.ok(objects.has(`exam_documents_private:${petId}/${documentId}/original.pdf`));
});
await check('Nexus refuses an already-existing different object instead of replacing it',async()=>{
  objects.set(`exam_documents_staging:${documentId}/original.pdf`,fixtureBytes);
  objects.set(`exam_documents_private:${petId}/${documentId}/original.pdf`,new Uint8Array(fixtureBytes.length));
  assert.equal((await request('attach_nexus',{delivery_id:taskId,lease_token:token})).status,409);
  assert.equal(calls.some(c=>c.op==='upload'),false);
});
await check('expired Nexus lease performs no external upload',async()=>{
  tasks[0].lease_until=new Date(Date.now()-1).toISOString();
  assert.equal((await request('attach_nexus',{delivery_id:taskId,lease_token:token})).status,409);assert.equal(calls.some(c=>c.op==='upload'),false);
});
await check('server lacking private Drive OAuth returns explicit configuration error',async()=>{
  docs[0].staging_bucket=null;docs[0].staging_path=null;docs[0].drive_file_id='fixture-drive';
  assert.equal((await request('file',{document_id:documentId},'fixture-user-token')).status,503);
});
function driveOriginal() {
  docs[0].staging_bucket=null;docs[0].staging_path=null;docs[0].drive_file_id='fixture-drive';docs[0].drive_folder_id='fixture-folder';
}
function useComposio() {
  env.set('EXAM_DRIVE_READER','composio');env.set('COMPOSIO_CONSUMER_API_KEY','ck_offline_fixture');
  env.set('COMPOSIO_DRIVE_ACCOUNT','googledrive_fixture');env.set('COMPOSIO_FILE_DOWNLOAD_HOSTS','fixture.r2.cloudflarestorage.com');
}
await check('default Drive reader keeps the existing OAuth path',async()=>{
  driveOriginal();env.set('GOOGLE_DRIVE_ACCESS_TOKEN','fixture-oauth');driveFetchEnabled=true;
  assert.equal((await request('file',{document_id:documentId},'fixture-user-token')).status,200);
  assert.equal(composioCalls.length,0);assert.equal(calls.filter(c=>c.op==='fetch').length,2);
  assert.match(calls.filter(c=>c.op==='fetch').at(-1).url,/www.googleapis.com\/drive\/v3\/files\/fixture-drive\?alt=media&supportsAllDrives=true$/);
  assert.equal(calls.find(c=>c.op==='fetch').init.headers.Authorization,'Bearer fixture-oauth');
});
await check('explicit Composio mode passes persisted ID, folder, size and hash to the reader',async()=>{
  driveOriginal();useComposio();const res=await request('file',{document_id:documentId},'fixture-user-token');assert.equal(res.status,200);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()),fixtureBytes);assert.equal(composioCalls.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(composioCalls[0].expected)),{fileId:'fixture-drive',folderId:'fixture-folder',sha256:hash,sizeBytes:fixtureBytes.length});
  assert.equal(composioCalls[0].config.driveAccount,'googledrive_fixture');assert.equal(calls.some(c=>c.op==='fetch'),false);
});
await check('Composio failure does not fall back to configured OAuth credentials',async()=>{
  driveOriginal();useComposio();composioFails=true;env.set('GOOGLE_DRIVE_ACCESS_TOKEN','fixture-oauth');driveFetchEnabled=true;
  assert.equal((await request('file',{document_id:documentId},'fixture-user-token')).status,503);
  assert.equal(composioCalls.length,1);assert.equal(calls.some(c=>c.op==='fetch'),false);
});
await check('explicit Composio missing config and unknown reader mode fail closed',async()=>{
  driveOriginal();env.set('EXAM_DRIVE_READER','composio');env.set('GOOGLE_DRIVE_ACCESS_TOKEN','fixture-oauth');driveFetchEnabled=true;
  assert.equal((await request('file',{document_id:documentId},'fixture-user-token')).status,503);
  env.set('EXAM_DRIVE_READER','unknown');assert.equal((await request('file',{document_id:documentId},'fixture-user-token')).status,503);
  assert.equal(composioCalls.length,0);assert.equal(calls.some(c=>c.op==='fetch'),false);
});
await check('private Storage stays first even with Composio selected but unconfigured',async()=>{
  env.set('EXAM_DRIVE_READER','composio');docs[0].drive_file_id='fixture-drive';
  objects.set(`exam_documents_staging:${documentId}/original.pdf`,fixtureBytes);
  assert.equal((await request('file',{document_id:documentId},'fixture-user-token')).status,200);
  assert.equal(composioCalls.length,0);assert.equal(calls.some(c=>c.op==='fetch'),false);
});
await check('signed URLs expire and never become permanent document fields',async()=>{
  const res=await request('file_url',{document_id:documentId},'fixture-user-token');assert.equal(res.status,200);
  assert.equal((await res.json()).expires_in,60);assert.equal(calls.find(c=>c.op==='signed').ttl,60);
});
console.log(`PASS: ${count} Edge handler scenarios with isolated adapters; live Supabase/Drive/WhatsApp still require homologation.`);
