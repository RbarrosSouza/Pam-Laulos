import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';import vm from 'node:vm';
import {buildWorkflows} from '../operacional-build.mjs';
import {buildGmailDriveRecoveryCandidate} from './gmail-drive-recovery-build.mjs';
import {canRecoverReservedDrive,inspectReservedDrive,decodeReservedDriveOriginal,classifyGmailDriveFailure} from './gmail-drive-recovery-runtime.mjs';
const bytes=Buffer.from('%PDF-1.4\nFICTITIOUS ORIGINAL A\n%%EOF'),regenerated=Buffer.from('%PDF-1.4\nFICTITIOUS REGENERATION B\n%%EOF');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const docId='11111111-1111-4111-a111-111111111111';
const origin=(id=docId)=>({documentId:id,skip:false,message:{id:'abcdef01'},attachment:{gmailAttachmentId:'fixture',size:bytes.length},source:{message_id:'abcdef01',metadata:{provider:'gmail'},original_name:'fixture.pdf',attachment_id:'part-'+id},reservation:{document_id:id,document:{id,file_status:'failed',drive_file_id:'drive-'+id,drive_folder_id:'folder',sha256:hash(bytes),size_bytes:bytes.length}}});
const metadata=o=>({statusCode:200,body:{id:o.reservation.document.drive_file_id,mimeType:'application/pdf',trashed:false,ownedByMe:true,shared:false,parents:['folder'],size:String(bytes.length),appProperties:{exam_document_id:o.documentId,sha256:hash(bytes)}}});
const evalNode=async(w,name,json,o,pdf=bytes)=>{
 const n=w.nodes.find(n=>n.name===name);return new vm.Script('(async function(){'+n.parameters.jsCode+'}).call(this)').runInNewContext({Buffer,require:()=>crypto,$json:json,$input:{first:()=>({json,binary:{data:{fixture:true}}})},$:name=>({first:()=>({json:{maxBytes:20971520}}),item:{json:o}}),helpers:{getBinaryDataBuffer:async()=>pdf,prepareBinaryData:async(b,name,mime)=>({data:Buffer.from(b),fileName:name,mimeType:mime})}});
};

test('lost Drive confirmation reconciles original A before mutable Hopelab can return B',async()=>{
 const o=origin();assert(canRecoverReservedDrive(o));assert.notEqual(hash(bytes),hash(regenerated));
 // The old provider-first path observes B, which cannot replace A's reserved hash.
 assert.notEqual(hash(regenerated),o.reservation.document.sha256);
 const inspected=inspectReservedDrive(metadata(o),o);assert.equal(inspected.restoreReservedOriginal,true);
 const {intake:baseline}=await buildWorkflows(),{workflow}=buildGmailDriveRecoveryCandidate(baseline);
 assert.equal(workflow.connections['Precisa baixar'].main[0][0].node,'Original reservado recuperável');
 assert.equal(workflow.connections['Original reservado contém bytes'].main[0][0].node,'Drive - recuperar bytes reservados');
 const validated=await evalNode(workflow,'Validar bytes e SHA-256',{restoreReservedOriginal:true},o);
 assert.equal(validated[0].json.sha256,hash(bytes));assert.equal(validated[0].json.recoveredReservedOriginal,true);
 assert.equal(validated[0].json.documentId,o.documentId);assert.equal(validated[0].json.folderId,'folder');
 assert.equal(workflow.connections['Marcar original reservado recuperado'].main[0][0].node,'Validar bytes e SHA-256');
});

test('zero-byte and missing objects return to provider without changing reserved identity; conflicts never overwrite',()=>{
 const o=origin();for(const response of [{statusCode:404},{...metadata(o),body:{...metadata(o).body,size:'0'}}])assert.equal(inspectReservedDrive(response,o).restoreReservedOriginal,false);
 for(const mutate of [f=>{f.parents=['wrong'];},f=>{f.appProperties.sha256='f'.repeat(64);},f=>{f.size=1;},f=>{f.trashed=true;},f=>{f.shared=true;}]){const r=metadata(o);mutate(r.body);assert.throws(()=>inspectReservedDrive(r,o),/conflict/);}
 assert.throws(()=>inspectReservedDrive({statusCode:503},o),/lookup_failed/);
 assert.throws(()=>decodeReservedDriveOriginal.call({},regenerated,o,{maxBytes:20971520}),/conflict/);
});

test('recovery refuses another origin even in the same multi-attachment execution',async()=>{
 const {intake:baseline}=await buildWorkflows(),{workflow}=buildGmailDriveRecoveryCandidate(baseline);
 const a=origin(),b=origin('22222222-2222-4222-a222-222222222222');
 assert.throws(()=>inspectReservedDrive(metadata(a),b),/binding_conflict/);
 for(const o of [a,b]){const r=await evalNode(workflow,'Validar bytes e SHA-256',{restoreReservedOriginal:true},o);assert.equal(r[0].json.documentId,o.documentId);assert.equal(r[0].json.reservation.document.drive_file_id,o.reservation.document.drive_file_id);}
});

test('patch preserves configuration, credential references, IDs and settings and fails closed on drift',async()=>{
 const {intake:baseline}=await buildWorkflows();baseline.settings={saveDataSuccessExecution:'none',custom:'preserve'};baseline.nodes.find(n=>n.name==='Configuração').parameters.jsCode+='\n// existing private operator configuration';
 const {workflow,manifest}=buildGmailDriveRecoveryCandidate(baseline);
 assert.deepEqual(workflow.settings,baseline.settings);
 for(const n of baseline.nodes){const after=workflow.nodes.find(a=>a.name===n.name);assert.equal(after.id,n.id);assert.deepEqual(after.credentials,n.credentials);}
 assert.deepEqual(workflow.nodes.find(n=>n.name==='Configuração'),baseline.nodes.find(n=>n.name==='Configuração'));
 assert(manifest.changedNodes.includes('Validar bytes e SHA-256'));assert.throws(()=>buildGmailDriveRecoveryCandidate(workflow),/already_applied/);
 const drift=structuredClone(baseline);drift.nodes.find(n=>n.name==='Decidir recebimento').parameters.jsCode='return [];';assert.throws(()=>buildGmailDriveRecoveryCandidate(drift),/contract_drift/);
});

test('failure routes produce only bounded stage codes and never provider secrets',async()=>{
 const {intake:baseline}=await buildWorkflows(),{workflow}=buildGmailDriveRecoveryCandidate(baseline),o=origin();
 for(const [nodeName,expected] of [['Drive - gravar bytes no ID fixo','drive_upload_failed'],['Gmail - baixar PDF reservado','gmail_download_failed'],['Drive - recuperar bytes reservados','drive_readback_failed']]){
  const marker=workflow.connections[nodeName].main[1][0].node;
  const marked=await evalNode(workflow,marker,{error:{message:'secret signed-url token'}},o);
  const found=await evalNode(workflow,'Identificar falha exata de origem',marked[0].json,o);
  assert.equal(found[0].json.originFailureCode,expected);assert(!JSON.stringify(found).includes('secret'));
 }
 assert.equal(classifyGmailDriveFailure({error:'gmail_pdf_signature_missing [line 3]'},'original_validation_failed'),'invalid_pdf_signature');
 assert.equal(classifyGmailDriveFailure({error:'prefix gmail_pdf_signature_missing'},'gmail_download_failed'),'gmail_download_failed');
});

test('backoff is pending without source_failed or provider work, not a fake saved receipt',async()=>{
 const {intake:baseline}=await buildWorkflows(),{workflow}=buildGmailDriveRecoveryCandidate(baseline);
 const o=origin(),response={...o.reservation,intake_retry:{deferred:true,next_attempt_at:'2026-11-05T00:00:00Z'}};
 const decision=await evalNode(workflow,'Decidir recebimento',response,{...o,reservation:undefined});assert.equal(decision[0].json.skip,true);assert.equal(decision[0].json.pending,true);
 const receiptNode=workflow.nodes.find(n=>n.name==='Próximo anexo');const code=receiptNode.parameters.jsCode;
 const receipt=await new vm.Script('(async()=>{'+code+'})()').runInNewContext({$input:{all:()=>decision},$:()=>({item:{json:o}})});
 assert.equal(receipt[0].json.disposition,'pending');assert.equal(receipt[0].json.reason,'primary_deferred');
});
