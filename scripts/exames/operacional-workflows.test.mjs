import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {buildWorkflows,CONFIG,writeWorkflows} from './operacional-build.mjs';
import * as a from './operacional-runtime.mjs';
const workflows=await buildWorkflows();
const docId='11111111-1111-4111-a111-111111111111', canonical='22222222-2222-4222-a222-222222222222';
const bytes=Buffer.from('%PDF-1.4\nSem paciente: bytes somente para teste local.\n%%EOF\n');
const digest=crypto.createHash('sha256').update(bytes).digest('hex');
const cfg={...CONFIG,enabled:true,intakeCutoff:'2026-10-16T00:00:00Z',notificationCutoff:'2026-10-16T00:00:00Z',windowStart:'2026-10-16T00:00:00Z',sweepEnd:'2026-10-17T00:00:00Z',worker:'synthetic-worker'};
const message={id:'synthetic-message',threadId:'synthetic-thread',internalDate:String(Date.parse('2026-10-16T10:00:00Z')),payload:{partId:'',mimeType:'multipart/mixed',headers:[{name:'From',value:'Laboratório <laboratorio@example.invalid>'},{name:'Subject',value:'PDF sem nomes reconhecidos'},{name:'Message-ID',value:'<synthetic@example.invalid>'}],body:{size:0},parts:[{partId:'1',mimeType:'application/pdf',filename:'sem-nomes.pdf',body:{attachmentId:'synthetic-part-A',size:bytes.length}},{partId:'2',mimeType:'application/pdf',filename:'segundo.pdf',body:{attachmentId:'synthetic-part-B',size:bytes.length}}]}};
const n=(w,name)=>w.nodes.find(n=>n.name===name);
const asyncCode=async(w,name,input,outputs={})=>{
 const look={Configuração:[{json:cfg}],'Janela de recebimento':[{json:cfg}],...outputs};
 const inputs=Array.isArray(input)?input:[input];
 const sandbox={Buffer,require:k=>{assert.equal(k,'crypto');return crypto;},$json:inputs[0]?.json,$input:{first:()=>inputs[0],all:()=>inputs},$execution:{id:'synthetic-execution'},$getWorkflowStaticData:()=>outputs.__staticData||{},$:name=>({first:()=>look[name]?.[0],item:look[name]?.at(-1),all:()=>look[name]||[]}),helpers:{getBinaryDataBuffer:async()=>inputs[0]?.binary?.data?.bytes??bytes,prepareBinaryData:async(v,name,mime)=>({bytes:Buffer.from(v),fileName:name,mimeType:mime})},Date,console:undefined};
 return new vm.Script('(async function(){'+n(w,name).parameters.jsCode+'}).call(this)').runInNewContext(sandbox);
};
const expression=(value,json,outputs={})=>new vm.Script('('+value.slice(3,-2).trim()+')').runInNewContext({$json:json,$:name=>({first:()=>outputs[name],item:outputs[name]}),encodeURIComponent,Math,Date,$response:outputs.$response});
const plain=x=>JSON.parse(JSON.stringify(x));
function staged(id=docId){return {document_id:id,drive_file_id:'stable-drive-id',claimed:true,upload_required:true,delivery_id:'33333333-3333-4333-a333-333333333333',lease_token:'44444444-4444-4444-a444-444444444444',document:{id,sha256:digest,size_bytes:bytes.length,file_status:'pending',drive_file_id:'stable-drive-id',drive_folder_id:cfg.driveFolderId,received_at:'2026-10-16T10:00:00Z',original_name:'original.pdf'}};}
function metadata(stage,size=0){return {statusCode:200,body:{id:stage.drive_file_id,mimeType:'application/pdf',trashed:false,ownedByMe:true,shared:false,parents:[stage.document.drive_folder_id],size:String(size),appProperties:{exam_document_id:stage.document_id,sha256:digest},name:'original.pdf'}};}

test('four paused operational workflows: only current actions, valid graph, existing refs, manual + schedule, no journal/gates/secrets',async(t)=>{
 const actions=new Set(['reserve_source','stage_file','confirm_file','source_error','extraction','reserve_tasks','task_result','attach_nexus','reconcile']);
 for(const [kind,w]of Object.entries(workflows)){
  assert.equal(w.active,false);assert.deepEqual(w.pinData,{});assert.equal(w.settings.executionOrder,'v1');assert.equal(w.settings.saveDataSuccessExecution,'none');assert.equal(w.settings.saveDataErrorExecution,'none');assert.equal(w.settings.saveManualExecutions,false);assert.equal(w.settings.saveExecutionProgress,false);
  assert.equal(w.nodes.filter(n=>n.type.endsWith('manualTrigger')).length,1);assert.equal(w.nodes.filter(n=>n.type.endsWith('scheduleTrigger')).length,1);
  const names=new Set(w.nodes.map(n=>n.name));assert.equal(names.size,w.nodes.length);
  for(const [from,c]of Object.entries(w.connections)){assert(names.has(from));for(const out of c.main)for(const e of out)assert(names.has(e.node),e.node);}
  for(const node of w.nodes){
   if(node.type.endsWith('code'))new vm.Script('(async function(){'+node.parameters.jsCode+'})');
   if(node.type.endsWith('httpRequest')){assert.equal(node.retryOnFail,false);if(node.name==='Hopelab - baixar PDF reservado'){assert.equal(node.credentials,undefined);assert.equal(node.parameters.authentication,undefined);assert.equal(node.parameters.options.redirect.redirect.followRedirects,false);}else assert(node.credentials);if(node.parameters.url.includes('serviceUrl')){assert.equal(node.credentials.httpHeaderAuth.id,'SELECT_WORKER_HEADER');const m=node.parameters.jsonBody.match(/action:\s*["']([^"']+)/);assert(m&&actions.has(m[1]),node.name);}}
  }
  if(process.env.OPERACIONAL_PARSER_PACKAGE){
   const require=createRequire(process.env.OPERACIONAL_PARSER_PACKAGE);const {Tournament}=require('@n8n/tournament');const parser=new Tournament(e=>{throw e;});let count=0;
   function parse(v){if(typeof v==='string'&&v.startsWith('={{')){parser.getExpressionCode(v.slice(1));count++;}else if(Array.isArray(v))v.forEach(parse);else if(v&&typeof v==='object')Object.values(v).forEach(parse);}
   for(const node of w.nodes)parse(node.parameters);t.diagnostic(kind+': '+count+' expressions parsed by local Tournament');
  }
  const literal=JSON.stringify(w);assert(!/collection_|begin_staging|staging_result|fixture|clinical_pilot|runtimePhase|approvalId|structuredClone/i.test(literal));
  await assert.rejects(asyncCode(w,'Configuração',{json:{}}),/EXAMES_OPERACIONAL_PAUSADO/);
  const saved=JSON.parse(await fs.readFile(new URL('../../n8n/exames/OPERACIONAL-0'+({intake:1,processing:2,group:3,nexus:4}[kind])+'.json',import.meta.url),'utf8'));assert.deepEqual(saved,w);
 }
});

test('fixed-cutoff padded query, exact metadata window, real pageToken, incomplete/cyclic pagination refuses completion',()=>{
 const q=a.listQuery(cfg);assert(q.startsWith('{has:attachment (from:hopelab@exames.vet.br subject:"Exame finalizado")} after:'+String(Date.parse(cfg.intakeCutoff)/1000-60)));
 const url=expression(n(workflows.intake,'Gmail - IDs paginados').parameters.url,{}, {'Configuração':{json:cfg},'Janela de recebimento':{json:{...cfg,listQuery:q}}});assert.equal(new URL(url).searchParams.get('q'),q);assert.equal(new URL(url).searchParams.get('includeSpamTrash'),'false');
 const next=expression(n(workflows.intake,'Gmail - IDs paginados').parameters.options.pagination.pagination.nextURL,{}, {'Configuração':{json:cfg},'Janela de recebimento':{json:{...cfg,listQuery:q}},$response:{body:{nextPageToken:'opaque token/plus+'}}});assert.equal(new URL(next).searchParams.get('pageToken'),'opaque token/plus+');
 assert.deepEqual(a.listIds([{messages:[{id:'a'}],nextPageToken:'opaque'},{messages:[{id:'b'},{id:'a'}]}]),[{id:'a'},{id:'b'}]);
 assert.throws(()=>a.listIds([{messages:[{id:'a'}],nextPageToken:'opaque'}]),/incomplete/);assert.throws(()=>a.listIds([{nextPageToken:'same'},{nextPageToken:'same'}]),/cycle/);
 assert.equal(a.inspectMessage({...message,internalDate:String(Date.parse(cfg.sweepEnd))},message.id,cfg).excluded,true);
});

test('all PDF parts reserved separately, unknown sender/name does not suppress bytes, missing/oversize remain pending',async()=>{
 const result=a.inspectMessage(message,message.id,cfg);assert.equal(result.origins.length,2);assert.notEqual(result.origins[0].source.attachment_id,result.origins[1].source.attachment_id);
 const outputs={'Mensagem disponível':[{json:{id:message.id}}]};const emitted=await asyncCode(workflows.intake,'Enumerar anexos e ausência',{json:message},outputs);assert.equal(emitted.length,2);assert(emitted.every(i=>i.json.resetAttachments===true));
 const origin=result.origins[0];assert.equal(origin.needsReview,true);assert.equal(origin.source.metadata.unknown_sender,true);assert.equal(origin.source.metadata.sender_address,'laboratorio@example.invalid');assert.equal(origin.source.metadata.sender_allowlisted,false);assert.equal(origin.source.metadata.exam_candidate,false);const reservation={document_id:docId,document:{id:docId,file_status:'pending',identification_status:'review'}};
 const decision=await asyncCode(workflows.intake,'Decidir recebimento',{json:reservation},{'Um anexo por vez':[{json:origin}]});assert.equal(decision[0].json.skip,false);
 const decoded=await asyncCode(workflows.intake,'Validar bytes e SHA-256',{json:{data:bytes.toString('base64url'),size:bytes.length}},{'Decidir recebimento':decision});assert.equal(decoded[0].json.sha256,digest);assert.equal(decoded[0].json.folderId,cfg.driveFolderId);
 const oversized=structuredClone(message);oversized.payload.parts[0].body.size=cfg.maxBytes+1;assert.equal(a.decideReservation(a.inspectMessage(oversized,message.id,cfg).origins[0],reservation).skip,true);
 const inline=structuredClone(message);delete inline.payload.parts[0].body.attachmentId;assert.equal(a.decideReservation(a.inspectMessage(inline,message.id,cfg).origins[0],reservation).skip,true);
 const bad=bytes.toString('base64url')+'!';assert.throws(()=>a.decodeOriginal({data:bad,size:bytes.length},decision[0].json,cfg),/base64url/);
});

test('Gmail without subject or filename still reserves and validates each PDF for reading', async()=>{
 const unnamed=structuredClone(message); unnamed.payload.headers=unnamed.payload.headers.filter(h=>h.name!=='Subject');
 for(const part of unnamed.payload.parts) part.filename='';
 const result=a.inspectMessage(unnamed,unnamed.id,cfg); assert.equal(result.origins.length,2);
 for(const origin of result.origins){
  assert.equal(origin.attachment.name,'original.pdf'); assert.equal(origin.source.metadata.exam_candidate,false);
  const reservation={document_id:docId,document:{id:docId,file_status:'pending',identification_status:'review'}};
  const decision=a.decideReservation(origin,reservation); assert.equal(decision.skip,false);
  const decoded=a.decodeOriginal({data:bytes.toString('base64url'),size:bytes.length},decision,cfg);
  assert.equal(decoded.json.sha256,digest);
 }
});

test('saved source skips download; forwarded hash dedupe uses canonical document/folder/Drive ID and never creates a new file',async()=>{
 const origin=a.inspectMessage(message,message.id,cfg).origins[0];assert(a.decideReservation(origin,{document_id:docId,document:{id:docId,file_status:'saved'}}).skip);
 const decoded={...origin,documentId:docId,sha256:digest,sizeBytes:bytes.length,folderId:'new-request-folder'};
 const stage=staged(canonical);stage.claimed=false;stage.upload_required=false;stage.document.file_status='saved';stage.document.drive_folder_id='canonical-older-folder';a.validateStage(stage,decoded);
 assert.equal(expression(n(workflows.intake,'Upload reservado').parameters.conditions.conditions[0].leftValue,stage),false);
 const result=await asyncCode(workflows.intake,'Adiar sweep quando upload pendente',{json:stage});assert.equal(result[0].json.pending,false);
 const bad={...stage,document:{...stage.document,sha256:'0'.repeat(64)}};assert.throws(()=>a.validateStage(bad,decoded),/receipt/);
});

test('deleted origin and a repeated fingerprint stop without upload or a pending receipt',async()=>{
 const origin=a.inspectMessage(message,message.id,cfg).origins[0];
 const existing=a.decideReservation(origin,{document_id:docId,document:{id:docId,identification_status:'not_exam',deletion_state:'deleted'}});
 assert.equal(existing.skip,true);assert.equal(a.attachmentIntakeReceipt(existing,origin).reason,'user_deleted');
 const result=await asyncCode(workflows.intake,'Adiar sweep quando upload pendente',{json:{document_id:canonical,excluded:true,claimed:false,upload_required:false}});
 assert.equal(result[0].json.pending,false);assert.equal(result[0].json.excluded,true);
 assert.equal(a.attachmentIntakeReceipt(result[0].json,origin).disposition,'excluded');
});

test('lost upload ACK resumes same ID through metadata/readback, never PATCHes existing bytes or overwrites a conflict',async()=>{
 const stage=staged(),decoded={sha256:digest,sizeBytes:bytes.length};
 const outputs={'Reservar ID e upload Drive':[{json:stage}],'Validar bytes e SHA-256':[{json:decoded}]};
 const exists=await asyncCode(workflows.intake,'Validar estado do objeto',{json:metadata(stage,bytes.length)},outputs);assert.equal(exists[0].json.hasBytes,true);assert.equal(expression(n(workflows.intake,'Metadados ausentes').parameters.conditions.conditions[0].leftValue,exists[0].json),false);assert.equal(expression(n(workflows.intake,'Objeto já tem bytes').parameters.conditions.conditions[0].leftValue,exists[0].json),true);
 assert.equal(workflows.intake.connections['Objeto já tem bytes'].main[0][0].node,'Drive - conferir bytes salvos');
 const receipt={document_id:stage.document_id,document:{...stage.document,file_status:'saved'}};const verified=await asyncCode(workflows.intake,'Validar confirmação salva',{json:receipt},outputs);assert.equal(verified[0].json.status,'saved');
 assert.throws(()=>a.inspectDriveObject(metadata(stage,1),stage,decoded),/conflict/);const wrong=metadata(stage);wrong.body.parents=['another-folder'];assert.throws(()=>a.inspectDriveObject(wrong,stage,decoded),/parent/);assert.throws(()=>a.verifySaved({...receipt,document:{...receipt.document,drive_file_id:'other'}},stage,decoded),/confirmation/);
});

test('failure after reserving one attachment persists source_error, returns to attachment loop, next scan retains cutoff',()=>{
 const w=workflows.intake;for(const name of ['Gmail - baixar PDF reservado','Drive - criar metadados com ID fixo','Drive - gravar bytes no ID fixo']){assert.equal(n(w,name).onError,'continueErrorOutput');assert.equal(w.connections[name].main[1][0].node,'Registrar falha de origem');}
 assert.equal(w.connections['Registrar falha de origem'].main[0][0].node,'Manter janela para recuperação');assert.equal(w.connections['Manter janela para recuperação'].main[0][0].node,'Próximo anexo');assert.equal(w.connections['Próximo anexo'].main[0][0].node,'Um anexo por vez');assert.equal(w.connections['Confirmar armazenamento'].main[1][0].node,'Manter janela para recuperação');
 assert(n(w,'Janela de recebimento').parameters.jsCode.includes('windowStart:cfg.intakeCutoff'));assert(!n(w,'Janela de recebimento').parameters.jsCode.includes('staticData'));
});

test('processing reuses page/value evidence validator; empty text/model failure stays review, source context cannot be replaced',async()=>{
 const w=workflows.processing,task={id:'processing-task',lease_token:'lease',document:{id:docId}};
 const empty=await asyncCode(w,'Preparar classificação ou revisão',{json:{text:['   '],numpages:1}},{'Tarefa disponível':[{json:task}]});assert.equal(empty[0].json.canExtract,false);assert.equal(empty[0].json.extraction.classification,'review');
 const context={task,pages:['Tutor: Maria. Pet: Nina.'],totalPages:1,extraction:{classification:'review',single_patient:false,fields:{},evidence:[]}};
 const malicious={classification:'exam',single_patient:true,task:{document:{id:canonical}},fields:{client_name:'Joana',pet_name:'Nina'},evidence:[{field:'client_name',page:1,excerpt:'Tutor: Maria.'},{field:'pet_name',page:1,excerpt:'Pet: Nina.'}]};
 const out=await asyncCode(w,'Validar JSON e evidências',{json:{choices:[{message:{content:JSON.stringify(malicious)}}]}},{'Preparar classificação ou revisão':[{json:context}]});assert.equal(out[0].json.task.document.id,docId);assert.equal(out[0].json.extraction.classification,'review');
 assert.equal(n(w,'Extrair dados estruturados').parameters.nodeCredentialType,'openAiApi');assert.equal(n(w,'Extrair dados estruturados').credentials.openAiApi.id,'SELECT_OPENAI_CREDENTIAL');
});

test('group uses only verified original destination, one multipart POST, timeout stays uncertain and reconciliation cannot resend',async()=>{
 const w=workflows.group;const task={id:'task',document:{id:docId,received_at:cfg.intakeCutoff},lease_token:'token',external_id:'91'};
 const context={task,correlation:'[EXAM:'+docId+':DELIVERY:task]'};
 for(const r of [{error:'timeout'},{statusCode:503,body:{}}]){const result=await asyncCode(w,'Classificar submissão sem reenvio',{json:r},{'Preparar PDF e correlação':[{json:context}]});assert.equal(result[0].json.outcome.status,'uncertain');}
 const submitted=await asyncCode(w,'Classificar submissão sem reenvio',{json:{statusCode:200,body:{id:91,status:'sent'}}},{'Preparar PDF e correlação':[{json:context}]});assert.equal(submitted[0].json.outcome.status,'submitted');
 const sent=await asyncCode(w,'Conferir entrega sem reenviar',{json:{payload:[{id:91,status:'delivered',private:false,message_type:'outgoing'}]}},{'Uma confirmação por vez':[{json:task}]});assert.equal(sent[0].json.outcome.status,'sent');
 const empty=await asyncCode(w,'Conferir entrega sem reenviar',{json:{payload:[]}},{'Uma confirmação por vez':[{json:task}]});assert.equal(empty[0].json.outcome.status,'uncertain');
 const posts=w.nodes.filter(x=>x.name.startsWith('Chatwoot -')&&x.parameters.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].retryOnFail,false);assert.equal(posts[0].parameters.bodyParameters.parameters.filter(p=>p.name==='attachments[]').length,1);
 assert.equal(w.connections['Registrar confirmação observada'].main[0][0].node,'Uma confirmação por vez');assert(!n(w,'Preparar PDF e correlação').parameters.jsCode.includes('\\\\n'));
});

test('worker lease recovery and real backend contracts remain available; no dependency on another workflow ID',()=>{
 for(const w of Object.values(workflows)){assert(w.nodes.some(x=>x.parameters.jsonBody?.includes('"reconcile"')));assert(!w.nodes.some(x=>x.type.endsWith('executeWorkflow')));}
 const nexus=workflows.nexus;const payload=expression(n(nexus,'Anexar e verificar no backend').parameters.jsonBody,{id:'delivery',lease_token:'lease'});assert.deepEqual(plain(payload),{action:'attach_nexus',payload:{delivery_id:'delivery',lease_token:'lease'}});
 assert(n(workflows.processing,'Persistir extração e revisão').parameters.jsonBody.includes('delivery_id'));assert(n(workflows.processing,'Persistir extração e revisão').parameters.jsonBody.includes('extraction:'));
});

test('nested attachment loop resets only on a fresh message and clears the flag on every return',async()=>{
 const w=workflows.intake;const reset=n(w,'Um anexo por vez').parameters.options.reset;
 assert.equal(expression(reset,{resetAttachments:true}),true);
 const origin=a.inspectMessage(message,message.id,cfg).origins[0];
 const returned=await asyncCode(w,'Próximo anexo',{json:{resetAttachments:true,document_id:docId,status:'saved'}},{'Um anexo por vez':[{json:origin}]});assert.equal(expression(reset,returned[0].json),false);
 for(const [name,c]of Object.entries(w.connections))for(const output of c.main)for(const edge of output)if(edge.node==='Um anexo por vez')assert(['PDF ou aviso disponível','Próximo anexo'].includes(name),name);
});

test('metadata and reservation failures continue their own loops and leave the scan incomplete',async()=>{
 const workflow=workflows.intake;
 for(const name of ['Gmail - MIME sem bytes','Enumerar anexos e ausência','Gmail - corpo do aviso Hopelab','Extrair link Hopelab autorizado']){
  assert.equal(n(workflow,name).onError,'continueErrorOutput');assert.equal(workflow.connections[name].main[1][0].node,'Marcar falha da mensagem');
 }
 for(const name of ['Reservar origem','Decidir recebimento']){
  assert.equal(n(workflow,name).onError,'continueErrorOutput');assert.equal(workflow.connections[name].main[1][0].node,'Marcar falha da reserva');
 }
 assert.equal(workflow.connections['Marcar falha da mensagem'].main[0][0].node,'Uma mensagem por vez');
 assert.equal(workflow.connections['Marcar falha da reserva'].main[0][0].node,'Próximo anexo');
 const failedMessage=await asyncCode(workflow,'Marcar falha da mensagem',{json:{error:'transport failure'}},{'Mensagem disponível':[{json:{id:'broken-message'}}]});
 const origin=a.inspectMessage(message,message.id,cfg).origins[0];
 const failedReservation=await asyncCode(workflow,'Marcar falha da reserva',{json:{error:'reservation failure'}});
 const failedAttachment=await asyncCode(workflow,'Próximo anexo',failedReservation,{'Um anexo por vez':[{json:origin}]});
 const second={...origin,source:{...origin.source,attachment_id:'second-part'}};
 const savedAttachment=await asyncCode(workflow,'Próximo anexo',{json:{status:'saved',document_id:docId}},{'Um anexo por vez':[{json:second}]});
 const result=await asyncCode(workflow,'Confirmar varredura concluída',[...failedMessage,...failedAttachment,...savedAttachment],{'IDs de mensagens':[{json:{id:'broken-message'}},{json:{id:message.id}}]});
 assert.equal(result[0].json.scanFinished,false);assert.equal(result[0].json.counts.messages_failed,1);assert.equal(result[0].json.counts.failed,1);assert.equal(result[0].json.counts.saved,1);assert.equal(result[0].json.counts.attachments,2);
 assert.equal(result[0].json.issues[1].reason,'source_reservation_unproven');assert.equal(result[0].json.checkpointAdvanced,false);
});

test('four nameless/same-named PDF parts retain four receipts; pending originals prevent a successful scan',async()=>{
 const four=structuredClone(message);four.payload.parts=Array.from({length:4},(_,index)=>({partId:String(index+1),mimeType:'application/pdf',filename:index<2?'':'original.pdf',body:{attachmentId:'part-'+index,size:bytes.length}}));
 const origins=a.inspectMessage(four,four.id,cfg).origins;assert.equal(origins.length,4);assert.equal(new Set(origins.map(origin=>origin.source.attachment_id)).size,4);
 const receipts=origins.map((origin,index)=>a.attachmentIntakeReceipt(index===3?{pending:true}:{status:'saved'},origin));
 const incomplete=a.summarizeIntakeReceipts(receipts,[four.id]);assert.equal(incomplete.scanFinished,false);assert.equal(incomplete.counts.attachments,4);assert.equal(incomplete.counts.saved,3);assert.equal(incomplete.counts.pending,1);assert.equal(incomplete.issues[0].reason,'original_storage_pending');
 const complete=a.summarizeIntakeReceipts(origins.map(origin=>a.attachmentIntakeReceipt({pending:false},origin)),[four.id]);assert.equal(complete.scanFinished,true);assert.equal(complete.counts.already_saved,4);
 const missing=a.summarizeIntakeReceipts(origins.slice(0,3).map(origin=>a.attachmentIntakeReceipt({status:'saved'},origin)),[four.id]);assert.equal(missing.scanFinished,false);assert.equal(missing.counts.attachments_missing,1);assert.equal(missing.issues[0].reason,'attachment_receipt_count_mismatch');
 assert.equal(a.summarizeIntakeReceipts(receipts,[four.id,'never-returned']).counts.messages_failed,1);
 assert.equal(a.summarizeIntakeReceipts([...receipts,receipts[0]],[four.id]).counts.unproven,1);
 assert.equal(a.summarizeIntakeReceipts([{emptySweep:true}],[]).scanFinished,true);
});

test('scan audit persists only bounded counts and timestamps without clinical payloads or provider IDs',async()=>{
 const state={intakeAuditHistory:Array.from({length:25},(_,index)=>({executionId:'previous-'+index,checkedAt:'2026-10-16T00:00:00Z',counts:{messages:0},scanFinished:true}))};
 const origin=a.inspectMessage(message,message.id,cfg).origins[0];
 const receipt=a.attachmentIntakeReceipt({status:'saved',document_id:docId},origin);
 const result=await asyncCode(workflows.intake,'Confirmar varredura concluída',[{json:receipt}],{'IDs de mensagens':[{json:{id:message.id}}],__staticData:state});
 assert.equal(result[0].json.scanFinished,false);assert.equal(state.intakeAuditHistory.length,20);assert.equal(state.lastIntakeAudit.executionId,'synthetic-execution');assert.equal(state.lastIntakeAudit.counts.attachments_missing,1);
 assert.deepEqual(Object.keys(state.lastIntakeAudit).sort(),['checkedAt','counts','executionId','scanFinished']);
 assert(!JSON.stringify(state).includes(message.id));assert(!JSON.stringify(state).includes(docId));assert(!JSON.stringify(state).includes('laboratorio@example.invalid'));
 for(const workflow of Object.values(workflows))assert.equal(workflow.settings.saveDataErrorExecution,'none');
});

test('the same intake supports a selected manual message, and refuses that selection in scheduled mode',()=>{
 const source=n(workflows.intake,'Configuração').parameters.jsCode.replace('"enabled": false','"enabled": true').replace('"intakeCutoff": ""','"intakeCutoff": "2026-10-16T00:00:00Z"').replace('"manualMessageId": ""','"manualMessageId": "abcdef1234567890"');
 const run=mode=>new vm.Script('(function(){'+source+'})()').runInNewContext({$execution:{id:'run',mode},Date});
 assert.throws(()=>run('production'),/só pode ser usada manualmente/);assert.throws(()=>run('unknown'),/só pode ser usada manualmente/);assert.throws(()=>run('manual'),/só pode ser usada manualmente/);assert.equal(run('test')[0].json.manualMessageId,'abcdef1234567890');
 assert.equal(workflows.intake.connections['Mensagem manual selecionada'].main[0][0].node,'Preparar mensagem selecionada');assert.equal(workflows.intake.connections['Mensagem manual selecionada'].main[1][0].node,'Gmail - IDs paginados');
});

test('external configuration binds references without modifying neutral templates and refuses public output or secret properties',async()=>{
 const settings={config:{mailbox:'alternate@example.invalid',driveFolderId:'external-private-folder',serviceUrl:'https://synthetic-project.example.invalid/functions/v1/exam-document-service'},credentials:{gmail:{id:'SYNTHETIC_GMAIL_REFERENCE',name:'Synthetic existing OAuth'}}};
 const bound=await buildWorkflows(settings);const code=n(bound.intake,'Configuração').parameters.jsCode;
 assert(code.includes('alternate@example.invalid'));assert(code.includes('external-private-folder'));assert.equal(n(bound.intake,'Gmail - conferir conta OAuth').credentials.oAuth2Api.id,'SYNTHETIC_GMAIL_REFERENCE');
 assert(n(bound.intake,'Validar identidade da caixa').parameters.jsCode.includes('EXPECTED_MAILBOX="alternate@example.invalid"'));
 assert.equal(CONFIG.mailbox,'exames@example.invalid');assert(n(workflows.intake,'Configuração').parameters.jsCode.includes('SELECT_PRIVATE_DRIVE_FOLDER'));
 await assert.rejects(writeWorkflows(new URL('../../n8n/exames/',import.meta.url).pathname,settings),/outside the public repository/);
 await assert.rejects(buildWorkflows({credentials:{gmail:{id:'reference',name:'name',value:'must-never-be-accepted'}}}),/never token/);
 await assert.rejects(buildWorkflows({config:{apiKey:'must-never-be-accepted'}}),/Unknown operational/);
});

test('subject candidacy does not come from sender or body; unknown sender PDFs are still preserved',()=>{
 assert.equal(CONFIG.dedicatedMailbox,false);
 const financial=structuredClone(message);financial.snippet='Resultado de exame apenas no corpo';financial.payload.headers.find(h=>h.name==='From').value='Exames Resultado <laboratorio@example.invalid>';financial.payload.headers.find(h=>h.name==='Subject').value='Boleto e nota fiscal';
 const fromKnown=a.inspectMessage(financial,financial.id,{...cfg,allowedSenders:['laboratorio@example.invalid']}).origins[0];assert.equal(fromKnown.source.metadata.exam_candidate,false);financial.payload.headers.find(h=>h.name==='Subject').value='Resultado financeiro';assert.equal(a.inspectMessage(financial,financial.id,cfg).origins[0].source.metadata.exam_candidate,false);assert.equal(fromKnown.source.metadata.sender_allowlisted,true);
 const decision=a.decideReservation(fromKnown,{document_id:docId,document:{id:docId,file_status:'pending'}});assert.equal(decision.skip,false);
 const exam=structuredClone(message);exam.payload.headers.find(h=>h.name==='Subject').value='Resultado do exame veterinário';const origin=a.inspectMessage(exam,exam.id,cfg).origins[0];assert.equal(origin.source.metadata.exam_candidate,true);assert.equal(origin.source.metadata.unknown_sender,true);assert.equal(a.decideReservation(origin,{document_id:docId,document:{id:docId,file_status:'pending'}}).skip,false);
});

test('a forwarded generic subject accepts a specific clinical filename without changing sender trust or patient identity',async()=>{
 const forwarded=structuredClone(message);forwarded.payload.headers.find(header=>header.name==='Subject').value='ENC:';
 forwarded.payload.parts=[{...forwarded.payload.parts[0],filename:'Hemograma - Paciente A - Tutor A.pdf'}];
 const previousSubjectOnlyCandidate=cfg.examSubjectHints.some(hint=>'ENC:'.toLowerCase().includes(hint.toLowerCase()));assert.equal(previousSubjectOnlyCandidate,false);
 const origin=a.inspectMessage(forwarded,forwarded.id,cfg).origins[0];
 assert.equal(origin.source.metadata.exam_candidate,true);assert.equal(origin.source.metadata.exam_candidate_basis,'attachment_filename');assert.equal(origin.needsReview,false);
 assert.equal(origin.source.metadata.unknown_sender,true);assert.equal(origin.source.metadata.sender_allowlisted,false);assert.equal(origin.source.original_name,'Hemograma - Paciente A - Tutor A.pdf');
 assert.equal(origin.source.pet_name,undefined);assert.equal(origin.source.client_name,undefined);
 const emitted=await asyncCode(workflows.intake,'Enumerar anexos e ausência',{json:forwarded},{'Mensagem disponível':[{json:{id:forwarded.id}}]});assert.equal(emitted[0].json.source.metadata.exam_candidate,true);
});

test('filename candidacy is restricted to its own clinical attachment in mixed forwarded emails',()=>{
 const forwarded=structuredClone(message);forwarded.payload.headers.find(header=>header.name==='Subject').value='ENC:';
 const names=['Hemograma - Paciente A - Responsável A.pdf','boleto.pdf','original.pdf','Ultrassom - paciente.PDF'];
 forwarded.payload.parts=names.map((filename,index)=>({...forwarded.payload.parts[0],partId:String(index+1),filename,body:{attachmentId:'part-'+index,size:bytes.length}}));
 const origins=a.inspectMessage(forwarded,forwarded.id,cfg).origins;
 assert.deepEqual(origins.map(origin=>origin.source.metadata.exam_candidate),[true,false,false,true]);
 assert.deepEqual(origins.map(origin=>origin.needsReview),[false,true,true,false]);
 assert.equal(new Set(origins.map(origin=>origin.source.attachment_id)).size,4);assert(origins.every(origin=>origin.source.metadata.unknown_sender===true));
 const unconfigured=a.inspectMessage(forwarded,forwarded.id,{...cfg,examSubjectHints:['exame','laudo']}).origins;assert(unconfigured.every(origin=>origin.source.metadata.exam_candidate===false));
});

test('generic, financial, opaque and disguised filename hints remain pending with a generic subject',()=>{
 const forwarded=structuredClone(message);forwarded.payload.headers.find(header=>header.name==='Subject').value='ENC:';
 for(const filename of ['arquivo.pdf','original.pdf','contrato.pdf','exame.pdf','laudo.pdf','Nota fiscal hemograma.pdf','Hemograma boleto.pdf','hemograma.pdf.exe','hemogramatico.pdf','Laudo financeiro.pdf']){
  forwarded.payload.parts=[{...forwarded.payload.parts[0],filename}];const origin=a.inspectMessage(forwarded,forwarded.id,cfg).origins[0];
  assert.equal(origin.source.metadata.exam_candidate,false,filename);assert.equal(origin.needsReview,true,filename);assert.equal(origin.pendingReason,'pdf_sem_indicio_exame',filename);
 }
});


test('processing prompt preserves table roles, a single patient across signers and supported commercial panels',()=>{
 const body=expression(n(workflows.processing,'Extrair dados estruturados').parameters.jsonBody,{text:'texto fictício'}, {'Configuração':{json:{extractorModel:'synthetic-model'}}});
 const prompt=body.messages[0].content;
 assert(prompt.includes('Médico veterinário no cabeçalho de identificação'));
 assert(prompt.includes('sem incluir a assinatura'));
 assert(prompt.includes('um número sem UF é null'));
 assert(prompt.includes('Vários exames, várias páginas ou profissionais diferentes em Liberado por não significam vários pacientes'));
 assert(prompt.includes('Responsável | Raça | Data coleta'));
 assert(prompt.includes('ERITROGRAMA, LEUCOGRAMA e PLAQUETOGRAMA'));
 assert(prompt.includes('Hemograma + Creatinina + Ureia'));
 assert(prompt.includes('sem inventar uma ocorrência literal de Hemograma'));
 assert.equal((prompt.match(/Determine single_patient pela identidade/g)||[]).length,1);
 assert.equal((prompt.match(/requesting_vet_name é o nome completo/g)||[]).length,1);
 assert(!prompt.includes('requesting_vet_name é exclusivamente'));
 assert(!prompt.includes('exam_type deve ser uma expressão literal'));
 assert.equal(body.messages[1].content,'texto fictício');
});
