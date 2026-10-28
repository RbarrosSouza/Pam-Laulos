import crypto from 'node:crypto';
import { exportConfiguration } from './n8n-discovery-audit-build.mjs';

// Build from a verified current private OP01 export; never mutate or activate it.
// The caller must have already persisted the message and its per-origin outcomes.
export function buildProspectiveGmailChild(source, cutoff, collectorId) {
  if (typeof cutoff!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cutoff)
    || !Number.isFinite(Date.parse(cutoff)) || new Date(cutoff).toISOString()!==cutoff) throw new Error('Canonical activation cutoff required');
  const expectedCollector='gmail_prospective_'+crypto.createHash('sha256').update(cutoff).digest('hex').slice(0,16);
  if(collectorId!==expectedCollector) throw new Error('Collector and cutoff must match');
  const cfg=exportConfiguration(source), nodes=structuredClone(source.nodes), connections=structuredClone(source.connections);
  const node=name=>{const result=nodes.find(n=>n.name===name);if(!result)throw new Error('Missing current OP01 node: '+name);return result;};
  if(!node('Extrair link Hopelab autorizado').parameters.jsCode.includes('applyHopelabNoticeV2Policy')
    || !node('Decidir recebimento').parameters.jsCode.includes('verifyHopelabNoticeV2Reservation')) throw new Error('Current Hopelab snapshot guard required');
  const original=node('Configuração').parameters.jsCode,start=original.indexOf('const cfg=')+'const cfg='.length,end=original.indexOf(';\nif(',start);
  const legacy="if(cfg.manualMessageId&&$execution.mode!=='test')throw new Error('Seleção de mensagem só pode ser usada manualmente');";
  if(start<10||end<start||!original.includes(legacy))throw new Error('Current OP01 configuration contract changed');
  const childCfg={...cfg,enabled:true,intakeCutoff:cutoff,includeSpamTrash:true,manualMessageId:''};
  const literal='const cfg='+JSON.stringify(childCfg,null,2);
  const rest=original.slice(end).replace(legacy,'');
  const guard=`const input=$input.all();if(input.length!==1||!input[0]?.json?.payload)throw new Error('BRIDGE_INPUT_REQUIRED');
const request=input[0].json.payload;
if(request.collector_id!==${JSON.stringify(collectorId)}||request.account_id!==${JSON.stringify('gmail:'+cfg.mailbox)}||request.cutoff!==${JSON.stringify(cutoff)}||typeof request.message_id!=='string'||!/^[a-f0-9]{8,64}$/i.test(request.message_id))throw new Error('BRIDGE_INPUT_IDENTITY_INVALID');\n`;
  const targetGuard=`if(!Array.isArray(request.targets)||request.targets.length<1||request.targets.length>200||request.targets.some(t=>!t||typeof t!=='object'||Array.isArray(t)||
  (t.kind==='gmail_part'?Object.keys(t).some(k=>!['kind','part_id'].includes(k))||typeof t.part_id!=='string'||t.part_id.length>2048||/[\\x00-\\x1f\\x7f]/.test(t.part_id):
    t.kind==='hopelab_link'?Object.keys(t).some(k=>!['kind','attachment_id'].includes(k))||typeof t.attachment_id!=='string'||!/^hopelab-link:[a-f0-9]{64}$/.test(t.attachment_id):true))||
  new Set(request.targets.map(t=>JSON.stringify(t))).size!==request.targets.length)throw new Error('BRIDGE_TARGETS_INVALID');\n`;
  node('Configuração').parameters.jsCode=guard+targetGuard+literal+';cfg.manualMessageId=request.message_id;cfg.bridgeTargets=request.targets'+rest;
  // Treat a nameless generic binary as a candidate, never as clinical evidence.
  // Keep the established HopeLab notice route for mixed notice/link messages.
  const enumerate=node('Enumerar anexos e ausência');
  const swap=(owner,before,after)=>{const code=owner.parameters.jsCode;if(code.split(before).length!==2)throw new Error('Current OP01 source drift: '+owner.name);owner.parameters.jsCode=code.replace(before,after);};
  swap(enumerate,"const pdf = part.mimeType.toLowerCase() === 'application/pdf' || /\\.pdf$/i.test(part.filename || '');",
    "const pdf = part.mimeType.toLowerCase() === 'application/pdf' || /\\.pdf$/i.test(part.filename || '') || (part.mimeType.toLowerCase()==='application/octet-stream' && !(part.filename||'') && sender!=='hopelab@exames.vet.br' && Number.isSafeInteger(part.body?.size) && part.body.size>0);");
  swap(enumerate,'const inline = !part.attachmentId;', 'const inline = !part.attachmentId; const inlineMissing = inline && part.size<=0;');
  swap(enumerate,"const reason = inline ? 'bytes_inline_nao_suportados'", "const reason = inlineMissing ? 'bytes_inline_nao_suportados'");
  swap(enumerate,'missing_attachment: inline, unsupported_attachment: inline || part.size >', 'missing_attachment: inlineMissing, unsupported_attachment: inlineMissing || part.size >');
  swap(enumerate,'missing: inline || part.size >', 'missing: inlineMissing || part.size >');
  const validation=node('Validar bytes e SHA-256');
  swap(validation,'!source.attachment?.gmailAttachmentId', '(!source.attachment?.gmailAttachmentId && source.attachment?.partId===undefined)');
  // Do not persist arbitrary provider error text or invent a clinical diagnosis.
  // Preserve the one known signature failure explicitly for this origin.
  node('Registrar falha de origem').parameters.jsonBody=`={{ (()=>{const signature=$json.originFailureCode==='invalid_pdf_signature';return {action:'source_error',payload:{document_id:$('Decidir recebimento').item.json.documentId,error:signature?'Arquivo sem assinatura PDF comprovada':'Não foi possível preservar o original Gmail/Drive',review_reason:signature?'Arquivo sem assinatura PDF; conferir o original':'Conferir o anexo original e a pendência de armazenamento'}};})() }}`;
  const template=node('Gmail - MIME sem bytes'), inlineHttp=structuredClone(template);
  inlineHttp.id=crypto.randomUUID();inlineHttp.name='Gmail - obter bytes inline exatos';inlineHttp.position=[0,0];inlineHttp.onError='continueErrorOutput';
  const fields=depth=>{const one=n=>'partId,mimeType,filename,body(attachmentId,size,data)'+(n?',parts('+one(n-1)+')':',parts(partId)');return 'id,payload('+one(depth)+')';};
  inlineHttp.parameters.url="={{ 'https://gmail.googleapis.com/gmail/v1/users/me/messages/'+encodeURIComponent($('Decidir recebimento').item.json.message.id)+'?format=full&fields='+encodeURIComponent("+JSON.stringify(fields(8))+") }}";
  const inlineIf={id:crypto.randomUUID(),name:'Anexo inline prospectivo',type:'n8n-nodes-base.if',typeVersion:2.2,position:[0,0],parameters:{conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'strict',version:2},
    conditions:[{id:crypto.randomUUID(),leftValue:'={{ !$json.attachment.gmailAttachmentId }}',rightValue:'',operator:{type:'boolean',operation:'true',singleValue:true}}],combinator:'and'},options:{}}};
  const inlineCode={id:crypto.randomUUID(),name:'Selecionar bytes pela parte exata',type:'n8n-nodes-base.code',typeVersion:2,position:[0,0],onError:'continueErrorOutput',parameters:{jsCode:`
const origin=$('Decidir recebimento').item.json,body=$json;
if(!origin?.message?.id||body.id!==origin.message.id||!body.payload||origin.attachment.gmailAttachmentId)throw new Error('INLINE_MESSAGE_IDENTITY_UNPROVEN');
const found=[];let count=0;function visit(part,depth){if(!part||typeof part!=='object'||depth>8||++count>1000||typeof part.partId!=='string'||(part.parts!==undefined&&!Array.isArray(part.parts)))throw new Error('INLINE_MIME_INCOMPLETE');if(part.partId===origin.attachment.partId)found.push(part);for(const child of part.parts||[])visit(child,depth+1);}visit(body.payload,0);
if(found.length!==1||found[0].body?.attachmentId||found[0].body?.size!==origin.attachment.size||typeof found[0].body?.data!=='string'||!found[0].body.data)throw new Error('INLINE_BYTES_UNPROVEN');
return [{json:{data:found[0].body.data,size:found[0].body.size}}];`}};
  nodes.push(inlineIf,inlineHttp,inlineCode);
  connections['Origem de link Hopelab'].main[1]=[{node:inlineIf.name,type:'main',index:0}];
  connections[inlineIf.name]={main:[[{node:inlineHttp.name,type:'main',index:0}],[{node:'Gmail - baixar PDF reservado',type:'main',index:0}]]};
  connections[inlineHttp.name]={main:[[{node:inlineCode.name,type:'main',index:0}],[{node:'Registrar falha de origem',type:'main',index:0}]]};
  connections[inlineCode.name]={main:[[{node:'Validar bytes e SHA-256',type:'main',index:0}],[{node:'Registrar falha de origem',type:'main',index:0}]]};
  const selectCode={id:crypto.randomUUID(),name:'Selecionar somente origens pendentes',type:'n8n-nodes-base.code',typeVersion:2,position:[0,0],onError:'continueErrorOutput',parameters:{jsCode:`
const targets=$('Configuração').first().json.bridgeTargets,items=$input.all();
if(!Array.isArray(targets)||!targets.length)throw new Error('BRIDGE_TARGETS_REQUIRED');
const selected=items.filter(item=>{const source=item.json?.source,meta=source?.metadata;if(!source||!meta)return false;
  return targets.some(t=>t.kind==='gmail_part'&&meta.provider==='gmail'&&meta.gmail_part_id===t.part_id
    ||t.kind==='hopelab_link'&&meta.provider==='hopelab_link'&&source.attachment_id===t.attachment_id);});
if(!selected.length)return [{json:{messageExcluded:true,reason:'target_attachment_not_found'}}];
return selected.map(item=>({json:{...item.json,messageAttachmentCount:selected.length}}));`}};
  const selectedIf={id:crypto.randomUUID(),name:'Origem pendente encontrada',type:'n8n-nodes-base.if',typeVersion:2.2,position:[0,0],parameters:{conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'strict',version:2},
    conditions:[{id:crypto.randomUUID(),leftValue:'={{ !$json.messageExcluded }}',rightValue:'',operator:{type:'boolean',operation:'true',singleValue:true}}],combinator:'and'},options:{}}};
  nodes.push(selectCode,selectedIf);
  connections['PDF ou aviso disponível'].main[0]=[{node:selectCode.name,type:'main',index:0}];
  connections[selectCode.name]={main:[[{node:selectedIf.name,type:'main',index:0}],[{node:'Marcar falha da mensagem',type:'main',index:0}]]};
  connections[selectedIf.name]={main:[[{node:'Um anexo por vez',type:'main',index:0}],[{node:'Marcar mensagem excluída',type:'main',index:0}]]};
  node('Marcar mensagem excluída').parameters.jsCode="const reason=$json.reason||'outside_window_or_no_pdf_no_exam_hint';return [{json:{intakeReceipt:true,kind:'message',message_id:$('Mensagem disponível').item.json.id,disposition:reason==='target_attachment_not_found'?'failed':'excluded',reason}}];";
  // Preserve only the known signature failure across source_error's HTTP node.
  // Pair it with this exact origin; arbitrary provider errors remain generic.
  const identifyFailure={id:crypto.randomUUID(),name:'Identificar falha exata de origem',type:'n8n-nodes-base.code',typeVersion:2,position:[0,0],parameters:{jsCode:`
const origin=$('Um anexo por vez').item.json,source=origin?.source;
if(!source||typeof source.attachment_id!=='string'||typeof origin.message?.id!=='string')throw new Error('FAILURE_ORIGIN_UNPROVEN');
const error=typeof $json.error==='string'?$json.error:typeof $json.error?.message==='string'?$json.error.message:'';
const signature=/^gmail_pdf_signature_missing(?:\\s+\\[line \\d+\\])?$/.test(error);
return [{json:{...$json,originFailureCode:signature?'invalid_pdf_signature':null,originFailureAttachmentId:source.attachment_id,originFailureMessageId:origin.message.id}}];`}};
  const preserveFailure={id:crypto.randomUUID(),name:'Preservar falha exata para recibo',type:'n8n-nodes-base.code',typeVersion:2,position:[0,0],parameters:{jsCode:`
const failure=$('Identificar falha exata de origem').item.json,origin=$('Um anexo por vez').item.json;
const proven=failure?.originFailureAttachmentId===origin?.source?.attachment_id&&failure?.originFailureMessageId===origin?.message?.id;
return [{json:{pending:true,recovery:'next_scan_same_source',failureReason:proven&&failure.originFailureCode==='invalid_pdf_signature'?'invalid_pdf_signature':null}}];`}};
  for(const [name,connection] of Object.entries(connections))if(name!=='Registrar falha de origem')for(const outputs of connection.main||[])for(const edge of outputs||[])if(edge.node==='Registrar falha de origem')edge.node=identifyFailure.name;
  nodes.push(identifyFailure,preserveFailure);
  connections[identifyFailure.name]={main:[[{node:'Registrar falha de origem',type:'main',index:0}]]};
  connections['Registrar falha de origem']={main:[[{node:preserveFailure.name,type:'main',index:0}],[{node:preserveFailure.name,type:'main',index:0}]]};
  connections[preserveFailure.name]={main:[[{node:'Próximo anexo',type:'main',index:0}]]};
  swap(node('Próximo anexo'),"reason = origin.missing === true ? origin.pendingReason || 'original_metadata_pending' : 'original_storage_pending';",
    "reason = origin.missing === true ? origin.pendingReason || 'original_metadata_pending' : result.failureReason === 'invalid_pdf_signature' ? 'invalid_pdf_signature' : 'original_storage_pending';");
  // Trigger only from the parent; no schedule, webhook, manual path, or global reconcile.
  const remove=new Set(nodes.filter(n=>n.type.endsWith('.scheduleTrigger')||n.type.endsWith('.manualTrigger')||n.name==='Reconciliar reservas vencidas').map(n=>n.name));
  const filtered=nodes.filter(n=>!remove.has(n.name));for(const name of remove)delete connections[name];
  const trigger={id:crypto.randomUUID(),name:'Receber mensagem prospectiva',type:'n8n-nodes-base.executeWorkflowTrigger',typeVersion:1.1,
    position:[-900,0],parameters:{inputSource:'passthrough'}};filtered.push(trigger);
  connections[trigger.name]={main:[[{node:'Configuração',type:'main',index:0}]]};
  connections['Configuração']={main:[[{node:'Gmail - conferir conta OAuth',type:'main',index:0}]]};
  return {name:'GMAIL — processar uma mensagem prospectiva (INATIVO)',active:false,nodes:filtered,connections,
    settings:{...structuredClone(source.settings||{}),saveDataSuccessExecution:'none',saveDataErrorExecution:'none',saveManualExecutions:false,saveExecutionProgress:false},pinData:{}};
}
