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
let docs, tasks, stageClaimed=true, uploadFails=false, recorded=[];
function reset() {
  objects.clear(); calls.length=0; recorded=[]; stageClaimed=true; uploadFails=false;
  docs=[{id:documentId,sha256:hash,size_bytes:fixtureBytes.byteLength,mime_type:'application/pdf',original_name:'fixture.pdf',
    file_status:'pending',identification_status:'confirmed',pet_id:petId,confirmed_data:{exam_date:'2026-10-09',exam_type:'Fixture'},
    staging_bucket:'exam_documents_staging',staging_path:`${documentId}/original.pdf`,storage_bucket:null,storage_path:null,drive_file_id:null}];
  tasks=[{id:taskId,document_id:documentId,destination:'nexus',status:'reserved',lease_token:token,lease_until:new Date(Date.now()+600_000).toISOString()}];
  env.delete('GOOGLE_DRIVE_ACCESS_TOKEN'); env.delete('GOOGLE_DRIVE_REFRESH_TOKEN');
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
  auth:{async getUser(access){return access==='fixture-user-token' ? {data:{user:{id:userId}},error:null}
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
let handler;
const source=await readFile(new URL('../functions/exam-document-service/index.ts',import.meta.url),'utf8');
const script=ts.transpileModule(source.replace(/^import .*;\s*$/m,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
vm.runInNewContext(script,{createClient:()=>client,Deno:{env:{get:k=>env.get(k)},serve(fn){handler=fn}},Request,Response,File,Blob,FormData,URL,URLSearchParams,
  crypto,TextDecoder,Uint8Array,ArrayBuffer,Date,fetch:async()=>{throw new Error('Unexpected external request in isolated tests')}});
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
await check('expired/unknown user tokens are refused',async()=>assert.equal((await request('file',{document_id:documentId},'invalid-user')).status,401));
await check('authenticated outsider cannot retrieve clinical PDF',async()=>assert.equal((await request('file',{document_id:documentId},'fixture-outsider-token')).status,403));
await check('member cannot use ingestion/service actions',async()=>assert.equal((await request('reserve_source',{},'fixture-user-token')).status,403));
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
await check('signed URLs expire and never become permanent document fields',async()=>{
  const res=await request('file_url',{document_id:documentId},'fixture-user-token');assert.equal(res.status,200);
  assert.equal((await res.json()).expires_in,60);assert.equal(calls.find(c=>c.op==='signed').ttl,60);
});
console.log(`PASS: ${count} Edge handler scenarios with isolated adapters; live Supabase/Drive/WhatsApp still require homologation.`);
