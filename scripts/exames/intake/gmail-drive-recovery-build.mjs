import crypto from 'node:crypto';
import vm from 'node:vm';
import {canRecoverReservedDrive,inspectReservedDrive,decodeReservedDriveOriginal,classifyGmailDriveFailure,INTAKE_FAILURE_CODES} from './gmail-drive-recovery-runtime.mjs';
const clone=value=>structuredClone(value);
const sha=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export function buildGmailDriveRecoveryCandidate(baseline) {
  if(!baseline||!Array.isArray(baseline.nodes)||!baseline.connections||new Set(baseline.nodes.map(n=>n.name)).size!==baseline.nodes.length)throw new Error('gmail_recovery_existing_export_required');
  if(baseline.nodes.some(n=>n.name==='Original reservado recuperável'))throw new Error('gmail_recovery_already_applied');
  const workflow=clone(baseline),nodes=workflow.nodes,connections=workflow.connections;
  const node=name=>{const n=nodes.find(n=>n.name===name);if(!n)throw new Error('gmail_recovery_source_drift:'+name);return n;};
  const edge=name=>({node:name,type:'main',index:0});
  const connect=(from,outputs)=>connections[from]={main:outputs.map(names=>names.map(edge))};
  const add=(name,type,parameters,extra={})=>{const n={id:crypto.randomUUID(),name,type:'n8n-nodes-base.'+type,typeVersion:type==='code'?2:type==='if'?2.2:4.2,position:[3100,-240],parameters,...extra};nodes.push(n);return n;};
  const condition=expr=>({conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'strict',version:2},conditions:[{id:crypto.randomUUID(),leftValue:expr,rightValue:'',operator:{type:'boolean',operation:'true',singleValue:true}}],combinator:'and'},options:{}});
  const code=(name,jsCode)=>add(name,'code',{jsCode},{onError:'continueErrorOutput'});
  const decision=node('Decidir recebimento');
  if(!decision.parameters.jsCode.includes('skip: origin.missing ||'))throw new Error('gmail_recovery_reservation_contract_drift');
  decision.parameters.jsCode=decision.parameters.jsCode.replace('skip: origin.missing ||','pending: reservation.intake_retry?.deferred === true ? true : undefined, skip: reservation.intake_retry?.deferred === true || origin.missing ||');
  const next=node('Próximo anexo'); if(next.parameters.jsCode.includes("'original_storage_pending'"))next.parameters.jsCode=next.parameters.jsCode.replace("'original_storage_pending'","(result.reservation?.intake_retry?.deferred===true?'primary_deferred':'original_storage_pending')");
  const deferred=node('Precisa baixar');
  const target=connections[deferred.name]?.main?.[0];if(target?.length!==1)throw new Error('gmail_recovery_download_branch_drift');
  const originalTarget=target[0].node;
  const recoveryY=Math.max(...baseline.nodes.map(n=>Number(n.position?.[1])||0))+500;
  const recoveryX=Number(deferred.position?.[0])||2640;
  add('Original reservado recuperável','if',condition('={{ ('+canRecoverReservedDrive.toString()+')($json) }}'));
  const lookup=clone(node('Drive - consultar ID reservado'));lookup.id=crypto.randomUUID();lookup.name='Drive - consultar original reservado antes da origem';lookup.position=[3100,-400];
  lookup.parameters.url="={{ 'https://www.googleapis.com/drive/v3/files/'+encodeURIComponent($('Decidir recebimento').item.json.reservation.document.drive_file_id)+'?fields=id,size,name,mimeType,parents,trashed,ownedByMe,shared,appProperties,sha256Checksum' }}";lookup.onError='continueErrorOutput';nodes.push(lookup);
  code('Conferir original reservado',canRecoverReservedDrive.toString()+'\n'+inspectReservedDrive.toString()+"\nreturn [{json:inspectReservedDrive($json,$('Decidir recebimento').item.json)}];");
  add('Original reservado contém bytes','if',condition('={{ $json.restoreReservedOriginal === true }}'));
  const download=clone(node('Drive - conferir bytes salvos'));download.id=crypto.randomUUID();download.name='Drive - recuperar bytes reservados';download.position=[3600,-400];download.onError='continueErrorOutput';
  download.parameters.url="={{ 'https://www.googleapis.com/drive/v3/files/'+encodeURIComponent($('Decidir recebimento').item.json.reservation.document.drive_file_id)+'?alt=media' }}";nodes.push(download);
  code('Marcar original reservado recuperado',"return [{json:{restoreReservedOriginal:true},binary:$input.first().binary}];");
  const validation=node('Validar bytes e SHA-256');
  if(validation.parameters.jsCode.split('const decoded=').length!==2)throw new Error('gmail_recovery_decode_contract_drift');
  validation.parameters.jsCode=canRecoverReservedDrive.toString()+'\n'+decodeReservedDriveOriginal.toString()+'\n'+validation.parameters.jsCode.replace('const decoded=',"const decoded=$json.restoreReservedOriginal===true?decodeReservedDriveOriginal(await this.helpers.getBinaryDataBuffer(0,'data'),origin,cfg):");
  connect(deferred.name,[['Original reservado recuperável'],connections[deferred.name].main[1].map(e=>e.node)]);
  connect('Original reservado recuperável',[[lookup.name],[originalTarget]]);
  connect(lookup.name,[['Conferir original reservado'],['Registrar falha de origem']]);
  connect('Conferir original reservado',[['Original reservado contém bytes'],['Registrar falha de origem']]);
  connect('Original reservado contém bytes',[[download.name],[originalTarget]]);
  connect(download.name,[['Marcar original reservado recuperado'],['Registrar falha de origem']]);
  connect('Marcar original reservado recuperado',[[validation.name],['Registrar falha de origem']]);
  const stages={'Gmail - baixar PDF reservado':'gmail_download_failed','Hopelab - baixar PDF reservado':'hopelab_download_failed','Gmail - obter bytes inline exatos':'inline_download_failed','Selecionar bytes pela parte exata':'inline_identity_failed','Validar bytes e SHA-256':'original_validation_failed','Drive - gerar ID de arquivo':'drive_id_failed','Reservar ID e upload Drive':'drive_stage_failed','Drive - consultar ID reservado':'drive_lookup_failed','Validar estado do objeto':'drive_binding_conflict','Drive - criar metadados com ID fixo':'drive_create_failed','Drive - gravar bytes no ID fixo':'drive_upload_failed','Drive - conferir bytes salvos':'drive_readback_failed','Conferir integridade do original':'drive_integrity_conflict','Confirmar armazenamento':'drive_confirmation_failed','Validar confirmação salva':'drive_confirmation_failed',[lookup.name]:'drive_recovery_lookup_failed','Conferir original reservado':'drive_recovery_binding_conflict',[download.name]:'drive_readback_failed','Marcar original reservado recuperado':'drive_recovery_content_conflict'};
  const identifyName='Identificar falha exata de origem';let identify=nodes.find(n=>n.name===identifyName);
  const identifyCode=classifyGmailDriveFailure.toString()+"\nconst origin=$('Decidir recebimento').item.json;if(!origin.documentId||!origin.source?.attachment_id||!origin.message?.id)throw new Error('FAILURE_ORIGIN_UNPROVEN');const originFailureCode=classifyGmailDriveFailure($json,$json.originFailureStage);return [{json:{originFailureCode,originFailureAttachmentId:origin.source.attachment_id,originFailureMessageId:origin.message.id}}];";
  if(identify)identify.parameters.jsCode=identifyCode;else identify=code(identifyName,identifyCode);
  for(const [from,stage] of Object.entries(stages)){
    const links=connections[from]?.main?.[1];if(!links?.length)continue;
    if(links.length!==1||!['Registrar falha de origem',identifyName,'Manter janela para recuperação'].includes(links[0].node))throw new Error('gmail_recovery_failure_path_drift:'+from);
    const marker='Identificar etapa '+from;
    code(marker,"return [{json:{...$json,originFailureStage:"+JSON.stringify(stage)+"}}];");
    connect(marker,[[identifyName]]);connections[from].main[1]=[edge(marker)];
  }
  connect(identifyName,[['Registrar falha de origem']]);
  node('Registrar falha de origem').parameters.jsonBody="={{ (()=>{const code="+JSON.stringify(INTAKE_FAILURE_CODES)+".includes($json.originFailureCode)?$json.originFailureCode:'original_validation_failed';return {action:'source_error',payload:{document_id:$('Decidir recebimento').item.json.documentId,error:'Gmail/Drive ['+code+']',review_reason:code==='invalid_pdf_signature'?'Arquivo sem assinatura PDF; conferir o original':'Falha na etapa '+code+'; preservar o original e retomar com segurança'}};})() }}";
  if(nodes.some(n=>n.name==='Preservar falha exata para recibo')){
    node('Preservar falha exata para recibo').parameters.jsCode="const failure=$('Identificar falha exata de origem').item.json,origin=$('Um anexo por vez').item.json;const proven=failure.originFailureAttachmentId===origin.source?.attachment_id&&failure.originFailureMessageId===origin.message?.id;return [{json:{pending:true,recovery:'next_scan_same_source',failureReason:proven?failure.originFailureCode:null}}];";
  }
  const recoveryNames=['Original reservado recuperável',lookup.name,'Conferir original reservado','Original reservado contém bytes',download.name,'Marcar original reservado recuperado'];
  for(const [i,name] of recoveryNames.entries())node(name).position=[recoveryX+i*260,recoveryY];
  node(identifyName).position=[recoveryX+3*260,recoveryY+350];
  const markers=nodes.filter(n=>n.name.startsWith('Identificar etapa '));
  markers.forEach((n,i)=>{const from=node(n.name.slice('Identificar etapa '.length));n.position=[Number(from.position?.[0])||recoveryX,recoveryY+700+i*140];});
  for(const n of nodes)if(n.type.endsWith('.code'))new vm.Script('(async function(){\n'+n.parameters.jsCode+'\n})');
  const changed=nodes.filter(n=>!baseline.nodes.some(old=>old.name===n.name&&JSON.stringify(old)===JSON.stringify(n))).map(n=>n.name);
  return {workflow,manifest:{baseline_sha256:sha(baseline),candidate_sha256:sha(workflow),changedNodes:changed,credentialsPreserved:true,settingsPreserved:true,publication:'not_applied'}};
}
