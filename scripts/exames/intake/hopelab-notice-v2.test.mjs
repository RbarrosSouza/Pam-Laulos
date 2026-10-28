import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validateHopelabNoticeV2Policy,applyHopelabNoticeV2Policy,verifyHopelabNoticeV2Reservation,classifyHopelabContentSnapshot} from './hopelab-notice-v2-runtime.mjs';
import {buildHopelabNoticeV2Candidate,writeHopelabNoticeV2Candidate} from './hopelab-notice-v2-build.mjs';

const {CONFIG,buildWorkflows}=await import('../operacional-build.mjs');
const {inspectHopelabNotice,parseHopelabNotice,decideReservation,decodeHopelabOriginal}=await import('../operacional-runtime.mjs');
const cfg={...CONFIG,intakeCutoff:'2026-10-16T00:00:00Z',windowStart:'2026-10-27T00:00:00Z',sweepEnd:'2026-10-28T00:00:00Z',allowedSenders:[],driveFolderId:'synthetic-folder'};
const policy={cutover:'2026-10-27T18:00:00Z',replayNoticeIds:[],accountId:'gmail:'+cfg.mailbox,backendContract:'hopelab_notice_v2_hold_v1'};
const url='https://hopelab.exames.vet.br/laudos/download/37/1234/'+'a'.repeat(32)+'/'+'b'.repeat(32);
const documentId='11111111-1111-4111-a111-111111111111',sourceId='22222222-2222-4222-a222-222222222222';
function makeNotice(messageId,receivedAt){
  const text=Buffer.from('Sua requisição foi atualizada com novos resultados. '+url);
  const meta={id:messageId,internalDate:String(Date.parse(receivedAt)),payload:{partId:'',mimeType:'multipart/alternative',headers:[{name:'From',value:'Hopelab <hopelab@exames.vet.br>'},{name:'Subject',value:'Exame finalizado (FICTICIO)'},{name:'Message-ID',value:'<'+messageId+'@example.invalid>'}],parts:[{partId:'0',mimeType:'text/plain',body:{size:text.length}}]}};
  const body=structuredClone(meta);body.payload.parts[0].body.data=text.toString('base64url');
  return {meta,body,notice:inspectHopelabNotice(meta,messageId,cfg),origin:parseHopelabNotice(body,inspectHopelabNotice(meta,messageId,cfg),cfg)[0]};
}
const acknowledgment=origin=>({document_id:documentId,document:{id:documentId,file_status:'pending'},hopelab_notice_v2:{contract:policy.backendContract,source_id:sourceId,notice_id:origin.source.message_id,url_sha256:origin.source.metadata.link_sha256,group_hold_enforced:true}});

test('historical notices retain legacy identity; only prospective or explicitly selected notice IDs change',()=>{
  const old=makeNotice('1111222233334444','2026-10-27T16:48:32Z').origin;
  const untouched=applyHopelabNoticeV2Policy(old,policy);assert.equal(untouched,old);assert.deepEqual(untouched,old);
  const selected=applyHopelabNoticeV2Policy(old,{...policy,replayNoticeIds:[old.message.id]});
  assert.equal(selected.source.message_id,old.message.id);assert.equal(selected.source.metadata.hopelab_notice_scope,'explicit_replay');
  assert.equal(old.source.metadata.hopelab_notice_protocol,undefined);
  const first=applyHopelabNoticeV2Policy(makeNotice('1111222233335555','2026-10-27T18:00:00Z').origin,policy);
  const second=applyHopelabNoticeV2Policy(makeNotice('1111222233336666','2026-10-27T18:02:00Z').origin,policy);
  assert.notEqual(first.source.message_id,second.source.message_id);assert.equal(first.source.attachment_id,second.source.attachment_id);
  assert.equal(first.source.metadata.link_sha256,second.source.metadata.link_sha256);
  assert.equal(second.source.metadata.hopelab_notice_protocol,'gmail_notice_link_v2');
  assert.equal(second.source.metadata.hopelab_notice_scope,'prospective');assert(!JSON.stringify(second.source).includes(url));
});

test('a new notice requires a verified backend contract before any PDF download; replays remain idempotent',()=>{
  const origin=applyHopelabNoticeV2Policy(makeNotice('1111222233335555','2026-10-27T18:01:00Z').origin,policy);
  for(const response of [{},{...acknowledgment(origin),hopelab_notice_v2:null},
    {...acknowledgment(origin),hopelab_notice_v2:{...acknowledgment(origin).hopelab_notice_v2,group_hold_enforced:false}},
    {...acknowledgment(origin),hopelab_notice_v2:{...acknowledgment(origin).hopelab_notice_v2,notice_id:'ffffffffffffffff'}},
    {...acknowledgment(origin),hopelab_notice_v2:{...acknowledgment(origin).hopelab_notice_v2,url_sha256:'f'.repeat(64)}}])assert.throws(()=>verifyHopelabNoticeV2Reservation(origin,response),/backend_contract_unproven/);
  const receipt=acknowledgment(origin);assert.doesNotThrow(()=>verifyHopelabNoticeV2Reservation(origin,receipt));
  assert.equal(decideReservation(origin,receipt).skip,false);
  assert.equal(decideReservation(origin,{...receipt,document:{id:documentId,file_status:'saved'}}).skip,true);
  const bytes=Buffer.from('%PDF-1.4\nNew synthetic supplemental results\n%%EOF');
  const decoded=decodeHopelabOriginal(bytes,{statusCode:200,headers:{'content-type':'application/pdf'}},decideReservation(origin,receipt),cfg);
  assert.equal(decoded.json.source.message_id,origin.message.id);assert.equal(decoded.json.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));
});

test('bad policies and conflicting metadata fail instead of widening the replay scope',()=>{
  for(const changed of [{...policy,cutover:''},{...policy,replayNoticeIds:Array(21).fill('1111222233334444')},{...policy,replayNoticeIds:['https://secret.invalid']},{...policy,unexpected:true}])assert.throws(()=>validateHopelabNoticeV2Policy(changed),/policy_invalid/);
  const origin=makeNotice('1111222233335555','2026-10-27T18:01:00Z').origin;
  const wrong=structuredClone(origin);wrong.source.metadata.gmail_message_id='ffffffffffffffff';assert.throws(()=>applyHopelabNoticeV2Policy(wrong,policy),/origin_invalid/);
  const changed=structuredClone(origin);changed.source.attachment_id='hopelab-link:'+'0'.repeat(64);assert.throws(()=>applyHopelabNoticeV2Policy(changed,policy),/link_binding_invalid/);
});

test('changed bytes in a known URL lineage require review; exact and already known documents preserve previous deliveries and holds',()=>{
  const snapshot={sha256:'b'.repeat(64),sizeBytes:300};
  const context={lineageHistoryComplete:true,canonicalAlreadyExisted:false,canonicalHasReviewHold:false,canonicalDocumentId:documentId};
  const history=[{sha256:'a'.repeat(64),sizeBytes:200}];
  assert.equal(classifyHopelabContentSnapshot(snapshot,history,context).state,'pending_review');
  assert.equal(classifyHopelabContentSnapshot(snapshot,[],{...context,lineageHistoryComplete:false}).state,'pending_review');
  assert.equal(classifyHopelabContentSnapshot(snapshot,[],context).state,'new_original');
  const same=classifyHopelabContentSnapshot(snapshot,[snapshot],{...context,canonicalHasReviewHold:true});assert.equal(same.groupAction,'preserve_existing');assert.equal(same.requiresReview,true);
  const known=classifyHopelabContentSnapshot(snapshot,history,{...context,canonicalAlreadyExisted:true});assert.equal(known.state,'known_content');assert.equal(known.groupAction,'preserve_existing');
  for(const result of [same,known,classifyHopelabContentSnapshot(snapshot,history,context)])assert.equal(result.preservePriorDeliveries,true);
});

test('private candidate changes only two Code bodies and preserves configuration, connections, credentials and metadata',async()=>{
  const baseline=(await buildWorkflows({config:{driveFolderId:'synthetic-folder',intakeCutoff:'2026-10-16T00:00:00Z'},credentials:{worker:{id:'SYNTHETIC_WORKER',name:'Synthetic worker'}}})).intake;
  baseline.id='synthetic-existing-gmail';baseline.active=true;baseline.versionId='synthetic-version';
  const supplied={cutover:policy.cutover,replayNoticeIds:[],backendContract:policy.backendContract};
  const {workflow,manifest}=buildHopelabNoticeV2Candidate(baseline,supplied,{now:new Date(policy.cutover)});
  assert.equal(manifest.changes.length,2);assert.deepEqual(workflow.settings,baseline.settings);assert.deepEqual(workflow.connections,baseline.connections);
  for(const original of baseline.nodes){const updated=workflow.nodes.find(node=>node.name===original.name);assert.equal(updated.id,original.id);assert.deepEqual(updated.credentials,original.credentials);assert.deepEqual(updated.position,original.position);}
  assert.deepEqual(workflow.nodes.find(node=>node.name==='Configuração'),baseline.nodes.find(node=>node.name==='Configuração'));
  const code=workflow.nodes.find(node=>node.name==='Extrair link Hopelab autorizado').parameters.jsCode;
  const notice=makeNotice('1111222233335555','2026-10-27T18:01:00Z');
  const lookup={'Aviso Hopelab autorizado':{json:{hopelabNotice:notice.notice}},'Janela de recebimento':{json:cfg}};
  const result=new vm.Script('(function(){'+code+'})()').runInNewContext({require:name=>{assert.equal(name,'crypto');return crypto;},Buffer,Date,$json:notice.body,$:name=>({item:lookup[name],first:()=>lookup[name]})});
  assert.equal(result[0].json.source.message_id,notice.meta.id);assert.equal(result[0].json.resetAttachments,true);
  const decideCode=workflow.nodes.find(node=>node.name==='Decidir recebimento').parameters.jsCode;
  const run=reservation=>new vm.Script('(function(){'+decideCode+'})()').runInNewContext({$json:reservation,$:()=>({item:result[0]})});
  assert.throws(()=>run({document_id:documentId,document:{id:documentId,file_status:'pending'}}),/backend_contract_unproven/);
  assert.equal(run(acknowledgment(result[0].json))[0].json.skip,false);
  assert.throws(()=>buildHopelabNoticeV2Candidate(baseline,{...supplied,cutover:'2026-10-16T00:00:00Z'},{now:new Date(policy.cutover)}),/must_be_prospective/);
  const custom=structuredClone(baseline);custom.nodes.find(node=>node.name==='Decidir recebimento').parameters.jsCode+='\nreturn [];';assert.throws(()=>buildHopelabNoticeV2Candidate(custom,supplied,{now:new Date(policy.cutover)}),/source_drift/);
});

test('optional private Gmail export can be patched in memory without writing to the owning repository',{skip:!process.env.EXAM_PRIVATE_GMAIL_EXPORT},async()=>{
  const file=process.env.EXAM_PRIVATE_GMAIL_EXPORT;
  const baseline=JSON.parse(await fs.readFile(file,'utf8'));
  const {workflow,manifest}=buildHopelabNoticeV2Candidate(baseline,{cutover:policy.cutover,replayNoticeIds:[],backendContract:policy.backendContract},{now:new Date(policy.cutover)});
  assert.equal(workflow.nodes.length,baseline.nodes.length);assert.equal(manifest.changes.length,2);assert.deepEqual(workflow.settings,baseline.settings);
  assert.equal(manifest.publication,'not_applied');
});

test('portable repository boundary rejects private inputs inside the checkout before reading their contents',async()=>{
  const inside=fileURLToPath(import.meta.url);
  await assert.rejects(writeHopelabNoticeV2Candidate({baselineFile:inside,policyFile:inside,out:inside+'.forbidden'}),/private_files_only/);
});
