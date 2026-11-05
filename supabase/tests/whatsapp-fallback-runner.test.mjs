import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';
const text = await readFile(new URL('../functions/exam-whatsapp-fallback/runner.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { processFallbackOrigin, sha256, fallbackRetrySeconds, groupTask } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const id='11111111-1111-4111-8111-111111111111', delivery='22222222-2222-4222-8222-222222222222', lease='33333333-3333-4333-8333-333333333333';
const bytes=new TextEncoder().encode('%PDF-1.4\nfixture only\n%%EOF');
const hash=await sha256(bytes);
function fixture(options={}) {
 const state={group:options.group??null,posts:0,downloads:0,uploads:0,proofs:0,failures:[],stored:options.stored??null,doc:{id,original_name:'fixture original.pdf',received_at:'2026-11-03T10:00:00Z',file_status:'pending',sha256:options.hasBytes?hash:null,size_bytes:options.hasBytes?bytes.length:null,...(options.hasStorage?{staging_bucket:'exam_documents_staging',staging_path:id+'/original.pdf'}:{})}};
 const origin={source:{channel:'whatsapp',account_id:'chatwoot:1:inbox:2',message_id:'100',attachment_id:'chatwoot-attachment:200',original_name:'fixture original.pdf',mime_type:'application/pdf',received_at:state.doc.received_at,metadata:{provider:'chatwoot',sender_allowlisted:true}},attachment:{id:'chatwoot-attachment:200',chatwootAttachmentId:'200',name:'fixture original.pdf',contentType:'application/pdf',size:bytes.length,downloadUrl:options.expired?null:'https://chatwoot.example.invalid/media.pdf?transient'},missing:Boolean(options.expired),pendingReason:options.expired?'pdf_url_missing_or_untrusted':null};
 const ports={
  groupState:async()=>state.group,
  upload:async(bucket,path,data)=>{assert.equal(bucket,'exam_documents_staging');assert.equal(path,id+'/original.pdf');state.uploads++;if(!state.stored)state.stored=data;},
  download:async()=>{if(!state.stored)throw new Error('fallback_storage_read_failed');return state.stored;},
  failure:async(doc,code)=>state.failures.push({doc,code}),
  rpc:async(name,args)=>{
   if(name==='reserve_exam_intake_source'){assert(!JSON.stringify(args).includes('transient'));assert.match(args.p_source.metadata.attachment_url_sha256??'',options.expired?/^$/:/^[a-f0-9]{64}$/);return{document_id:id,document:state.doc};}
   if(name==='reserve_exam_fallback_original'){state.doc.sha256=hash;state.doc.size_bytes=bytes.length;return{document_id:id,document:state.doc,claimed:!options.verified,already_verified:Boolean(options.verified),bucket:'exam_documents_staging',path:id+'/original.pdf',lease_token:lease};}
   if(name==='confirm_exam_fallback_original'){assert.equal(await sha256(state.stored),hash);state.proofs++;return{document_id:id,verified:true};}
   if(name==='reserve_exam_fallback_group'){assert(state.stored);state.group='reserved';return{claimed:true,task:{id:delivery,document:state.doc,lease_token:lease,status:'reserved',created_at:state.doc.received_at,destination_key:'chatwoot:1:2:23:123@g.us'}};}
   if(name==='prepare_exam_fallback_group_dispatch')return{dispatch_ready:true,presentation_revision:'a'.repeat(32),task:{id:delivery,document:state.doc,lease_token:lease,status:'reserved',created_at:state.doc.received_at,destination_key:'chatwoot:1:2:23:123@g.us'}};
   if(name==='begin_exam_fallback_group_dispatch_v2'){assert.equal(state.group,'reserved');assert.equal(args.p_presentation_revision,'a'.repeat(32));state.group='uncertain';if(options.lostGrant)throw new Error('fallback_rpc_failed');return{dispatch_allowed:true};}
   if(name==='complete_exam_document_delivery'){if(options.lostReceipt)throw new Error('fallback_rpc_failed');state.group=args.p_outcome.status;return{status:state.group};}
   throw new Error('unexpected_rpc');
  }
 };
 const transport={downloadPdf:async()=>{state.downloads++;if(options.expired)throw new Error('expired_url_used');return{bytes,sha256:hash,sizeBytes:bytes.length};},sendGroupOnce:async(task,pdf,callbacks)=>{assert.equal(pdf.sha256,hash);assert.equal(task.deliveryId,delivery);const grant=await callbacks.beginDispatch({deliveryId:delivery,leaseToken:lease,contentSha256:hash,presentationRevision:task.presentationRevision});assert(grant.dispatch_allowed);state.posts++;return{status:'submitted',external_id:'300',external_status:'sent',correlation:delivery};},reconcileGroup:async()=>({status:'sent',external_id:'300',external_status:'delivered',correlation:delivery})};
 return{state,origin,ports,transport};
}
test('n8n and Drive absent: verified Storage permits one group submission while Drive remains pending',async()=>{const f=fixture();const r=await processFallbackOrigin(f.origin,'fallback:test',f.ports,f.transport);assert.equal(r.state,'submitted');assert.equal(r.attempted,true);assert.equal(f.state.uploads,1);assert.equal(f.state.proofs,1);assert.equal(f.state.posts,1);assert.equal(f.state.doc.file_status,'pending');});
test('provider URL expired after preservation: retry sends the verified Storage bytes without fetching source',async()=>{const f=fixture({hasBytes:true,hasStorage:true,stored:bytes,verified:true,expired:true});const r=await processFallbackOrigin(f.origin,'fallback:test',f.ports,f.transport);assert.equal(r.state,'submitted');assert.equal(f.state.downloads,0);assert.equal(f.state.uploads,0);assert.equal(f.state.posts,1);});
test('delivered input never downloads, uploads or consumes expensive work budget again',async()=>{const f=fixture({group:'sent'});const r=await processFallbackOrigin(f.origin,'fallback:test',f.ports,f.transport);assert.equal(r.state,'sent');assert(!r.attempted);assert.equal(f.state.downloads,0);assert.equal(f.state.posts,0);});
test('lost result after POST retains uncertain identity: replay cannot submit again',async()=>{const f=fixture({lostReceipt:true});const first=await processFallbackOrigin(f.origin,'fallback:test',f.ports,f.transport);assert.equal(first.state,'failed');assert.equal(f.state.group,'uncertain');const second=await processFallbackOrigin(f.origin,'fallback:next',f.ports,f.transport);assert.equal(second.state,'uncertain');assert.equal(f.state.posts,1);});
test('lost dispatch grant never sends and remains uncertain for readback',async()=>{const f=fixture({lostGrant:true});const first=await processFallbackOrigin(f.origin,'fallback:test',f.ports,f.transport);assert.equal(first.state,'failed');assert.equal(f.state.posts,0);assert.equal(f.state.group,'uncertain');const second=await processFallbackOrigin(f.origin,'fallback:next',f.ports,f.transport);assert.equal(second.state,'uncertain');assert.equal(f.state.posts,0);});
test('Storage collision must pass full readback before group release',async()=>{const f=fixture({stored:new TextEncoder().encode('corrupt')});const r=await processFallbackOrigin(f.origin,'fallback:test',f.ports,f.transport);assert.equal(r.state,'failed');assert.equal(r.code,'fallback_storage_readback_mismatch');assert.equal(f.state.proofs,0);assert.equal(f.state.posts,0);});
test('existing corrupted backup is not overwritten or bypassed by silently taking different source bytes',async()=>{const f=fixture({hasBytes:true,hasStorage:true,stored:new TextEncoder().encode('corrupt')});const r=await processFallbackOrigin(f.origin,'fallback:test',f.ports,f.transport);assert.equal(r.state,'failed');assert.equal(r.code,'fallback_existing_original_mismatch');assert.equal(f.state.downloads,0);assert.equal(f.state.uploads,0);assert.equal(f.state.posts,0);});
test('retry after failed PUT refreshes source even though the reserved staging path already exists',async()=>{
 const f=fixture({hasBytes:true,hasStorage:true,expired:true}); let refreshes=0;
 f.ports.refreshOrigin=async()=>{refreshes++;return fixture().origin;};
 f.transport.downloadPdf=async(url,expected)=>{assert.match(url,/media.pdf/);assert.equal(expected.sha256,hash);assert.equal(expected.sizeBytes,bytes.length);f.state.downloads++;return{bytes,sha256:hash,sizeBytes:bytes.length};};
 const r=await processFallbackOrigin(f.origin,'fallback:retry',f.ports,f.transport);
 assert.equal(r.state,'submitted');assert.equal(refreshes,1);assert.equal(f.state.uploads,1);assert.equal(f.state.posts,1);
});
test('source refresh cannot substitute another attachment for a reserved origin',async()=>{
 const f=fixture({hasBytes:true,hasStorage:true,expired:true});
 f.ports.refreshOrigin=async()=>{const fresh=fixture().origin;fresh.source.attachment_id='chatwoot-attachment:999';return fresh;};
 const r=await processFallbackOrigin(f.origin,'fallback:retry',f.ports,f.transport);
 assert.equal(r.code,'fallback_refreshed_source_mismatch');assert.equal(f.state.posts,0);assert.equal(f.state.downloads,0);
});
test('valid preserved bytes need no provider refresh or available source API',async()=>{
 const f=fixture({hasBytes:true,hasStorage:true,stored:bytes,verified:true,expired:true});
 f.ports.refreshOrigin=async()=>{throw new Error('unexpected_provider_dependency');};
 const r=await processFallbackOrigin(f.origin,'fallback:retry',f.ports,f.transport);
 assert.equal(r.state,'submitted');assert.equal(f.state.posts,1);
});
test('a saved Drive original remains a recovery path when a stale staging path has no object',async()=>{
 const f=fixture({hasBytes:true,hasStorage:true,expired:true});f.state.doc.file_status='saved';let driveReads=0;
 f.ports.readSavedOriginal=async()=>{driveReads++;return bytes;};
 f.ports.refreshOrigin=async()=>{throw new Error('unexpected_provider_dependency');};
 const r=await processFallbackOrigin(f.origin,'fallback:retry',f.ports,f.transport);
 assert.equal(r.state,'submitted');assert.equal(driveReads,1);assert.equal(f.state.posts,1);
});


test('primary priority deferral preserves bytes without POST or operational failure',async()=>{
 const f=fixture();const rpc=f.ports.rpc;
 f.ports.rpc=async(name,args)=>name==='reserve_exam_fallback_group'?{claimed:false,reason:'primary_active'}:rpc(name,args);
 const result=await processFallbackOrigin(f.origin,'fallback:test',f.ports,f.transport);
 assert.equal(result.state,'preserved');assert.equal(result.code,'primary_active');assert.equal(f.state.posts,0);assert.equal(f.state.failures.length,0);assert.equal(f.state.proofs,1);
 assert.equal(fallbackRetrySeconds(result,50),60);assert.equal(fallbackRetrySeconds({code:'download_failed'},50),900);
});

test('primary resumes during provider preflight: a revoked POST grant is a normal preservation',async()=>{
 const f=fixture();const rpc=f.ports.rpc;
 f.ports.rpc=async(name,args)=>name==='begin_exam_fallback_group_dispatch_v2'?{dispatch_allowed:false,reason:'primary_progress'}:rpc(name,args);
 const result=await processFallbackOrigin(f.origin,'fallback:test',f.ports,f.transport);
 assert.equal(result.state,'preserved');assert.equal(result.code,'primary_progress');assert.equal(f.state.posts,0);assert.equal(f.state.failures.length,0);
});

test('group task retains authoritative presentation fields and explicit human nulls without importing unrelated metadata',()=>{
 const f=fixture({hasBytes:true});
 const task=groupTask({id:delivery,document:{...f.state.doc,extracted_data:{pet_name:'Luna',client_name:'Ana Clara',internal_id:'hidden'},
   confirmed_data:{pet_name:'Luna corrigida',client_name:null,exam_date:123},responsible_vet_id:'vet-fixture',responsible_vet_name:'Marina Costa',responsible_vet_source:'confirmed'},
   notification_fields:{pet_name:'Luna corrigida',client_name:null,exam_type:'Hemograma',exam_date:null,internal_id:'hidden'},
   presentation_revision:'a'.repeat(32),lease_token:lease,status:'reserved',created_at:f.state.doc.received_at,destination_key:'chatwoot:1:2:23:123@g.us'});
 assert.deepEqual(task.confirmedData,{pet_name:'Luna corrigida',client_name:null,exam_date:null});
 assert.deepEqual(task.notificationFields,{pet_name:'Luna corrigida',client_name:null,exam_type:'Hemograma',exam_date:null});
 assert.equal(task.extractedData.internal_id,undefined);assert.equal(task.responsibleVetName,'Marina Costa');
 assert.equal(task.originalName,f.state.doc.original_name);assert.equal(task.documentId,id);assert.equal(task.leaseToken,lease);
});

test('prepare snapshot replaces claim identity before caption and v2 grant',async()=>{
 const f=fixture();const rpc=f.ports.rpc;let observed;
 f.ports.rpc=async(name,args)=>{
  const result=await rpc(name,args);
  if(name==='prepare_exam_fallback_group_dispatch')result.task.notification_fields={pet_name:'Luna revisada',client_name:null,exam_type:'Hemograma',exam_date:'2026-11-03'};
  return result;
 };
 const send=f.transport.sendGroupOnce;f.transport.sendGroupOnce=async(task,pdf,callbacks)=>{observed=task;return send(task,pdf,callbacks);};
 const result=await processFallbackOrigin(f.origin,'fallback:test',f.ports,f.transport);
 assert.equal(result.state,'submitted');assert.equal(observed.notificationFields.pet_name,'Luna revisada');assert.equal(observed.notificationFields.client_name,null);
 assert.equal(observed.presentationRevision,'a'.repeat(32));assert.equal(f.state.posts,1);
});

test('human correction during provider preflight defers without POST or failure and retries normally',async()=>{
 const f=fixture();const rpc=f.ports.rpc;
 f.ports.rpc=async(name,args)=>name==='begin_exam_fallback_group_dispatch_v2'?{dispatch_allowed:false,reason:'presentation_changed'}:rpc(name,args);
 const result=await processFallbackOrigin(f.origin,'fallback:test',f.ports,f.transport);
 assert.equal(result.state,'preserved');assert.equal(result.code,'presentation_changed');assert.equal(result.durable,true);
 assert.equal(f.state.posts,0);assert.equal(f.state.failures.length,0);assert.equal(fallbackRetrySeconds(result,50),60);
});

test('human rejection, hold, deletion or an already-started grant never becomes an operational failure',async()=>{
 for(const reason of ['fallback_document_ineligible','document_deleted','dispatch_already_started']){
  const f=fixture();const rpc=f.ports.rpc;
  f.ports.rpc=async(name,args)=>name==='begin_exam_fallback_group_dispatch_v2'?{dispatch_allowed:false,reason}:rpc(name,args);
  const result=await processFallbackOrigin(f.origin,'fallback:test',f.ports,f.transport);
  assert.equal(result.state,'preserved');assert.equal(result.code,reason);assert.equal(result.durable,true);
  assert.equal(f.state.posts,0);assert.equal(f.state.failures.length,0);
 }
});

test('unavailable, mismatched or unfenced fresh presentation cannot authorize a POST',async()=>{
 for(const kind of ['denied','missing_revision','wrong_identity','wrong_bytes','wrong_destination']){
  const f=fixture();const rpc=f.ports.rpc;
  f.ports.rpc=async(name,args)=>{
   const result=await rpc(name,args);if(name!=='prepare_exam_fallback_group_dispatch')return result;
   if(kind==='denied')return{dispatch_ready:false,reason:'primary_progress'};
   if(kind==='missing_revision')delete result.presentation_revision;
   if(kind==='wrong_identity')result.task.id='44444444-4444-4444-8444-444444444444';
   if(kind==='wrong_bytes')result.task.document={...result.task.document,sha256:'b'.repeat(64)};
   if(kind==='wrong_destination')result.task.destination_key='chatwoot:1:2:99:123@g.us';
   return result;
  };
  const result=await processFallbackOrigin(f.origin,'fallback:test',f.ports,f.transport);
  assert.equal(f.state.posts,0,kind);assert.equal(result.state,kind==='denied'?'preserved':'failed',kind);
 }
});

test('post-grant rejection is durably uncertain and a replay cannot submit another message',async()=>{
 const f=fixture();
 f.transport.sendGroupOnce=async(task,pdf,callbacks)=>{
  const grant=await callbacks.beginDispatch({deliveryId:task.deliveryId,leaseToken:task.leaseToken,contentSha256:hash,presentationRevision:task.presentationRevision});
  assert(grant.dispatch_allowed);f.state.posts++;return{status:'uncertain',external_status:'rejected',error:'provider_rejected_422',correlation:delivery};
 };
 const first=await processFallbackOrigin(f.origin,'fallback:test',f.ports,f.transport);
 assert.equal(first.state,'uncertain');assert.equal(first.durable,true);assert.equal(f.state.failures.length,0);assert.equal(f.state.group,'uncertain');
 const second=await processFallbackOrigin(f.origin,'fallback:replay',f.ports,f.transport);
 assert.equal(second.state,'uncertain');assert.equal(f.state.posts,1);
});
