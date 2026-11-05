import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {examPresentation,findExamDelivery} from './notification-presentation.mjs';
import {validateExamExtraction} from './extraction-validation.mjs';
import {parseHopeLabFastCandidate,validateFastExamCandidate,inspectFastExtraction} from './fast-extraction.mjs';
import * as intakeRuntime from './operacional-runtime.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const KINDS=['intake','processing','group','nexus'];
const templates=await Promise.all(KINDS.map((_,i)=>fs.readFile(path.join(ROOT,'n8n/exames/OPERACIONAL-0'+(i+1)+'.json'),'utf8').then(JSON.parse)));
const clone=value=>JSON.parse(JSON.stringify(value));
function configLiteral(workflow){
 const source=workflow.nodes.find(n=>n.name==='Configuração').parameters.jsCode;
 const start=source.indexOf('const cfg=')+'const cfg='.length;
 const end=source.indexOf(';\nif(',start);
 if(start<10||end<start)throw new Error('Operational template configuration is missing');
 return source.slice(start,end);
}
export const CONFIG=Object.freeze(JSON.parse(configLiteral(templates[0])));
export const CREDENTIALS=Object.freeze({
 gmail:{id:'SELECT_GMAIL_OAUTH',name:'Select Gmail OAuth'},
 drive:{id:'SELECT_DRIVE_OAUTH',name:'Select Drive OAuth'},
 worker:{id:'SELECT_WORKER_HEADER',name:'Select exam worker header'},
 chatwoot:{id:'SELECT_CHATWOOT_CREDENTIAL',name:'Select Chatwoot credential'},
 extractor:{id:'SELECT_OPENAI_CREDENTIAL',name:'Select OpenAI credential'},
});
const inRoot=target=>{const relative=path.relative(ROOT,path.resolve(target));return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));};
function applyHopelabIntake(workflow){
 const node=name=>{const found=workflow.nodes.find(item=>item.name===name);if(!found)throw new Error('Missing intake node: '+name);return found;};
 const bundle=names=>'const EXPECTED_MAILBOX='+JSON.stringify(CONFIG.mailbox)+',MAX_BYTES=20971520,MAX_MIME_DEPTH=8;\n'+names.map(name=>intakeRuntime[name].toString()).join('\n')+'\n';
 const base=['fail','object','stableId','unwrap','validateWindow','header','senderAddress'];
 const upsert=(name,type,typeVersion,position,parameters,extra={})=>{
  const hex=crypto.createHash('sha256').update('pamvet-hopelab:'+name).digest('hex');
  const id=hex.slice(0,8)+'-'+hex.slice(8,12)+'-5'+hex.slice(13,16)+'-a'+hex.slice(17,20)+'-'+hex.slice(20,32);
  const existing=workflow.nodes.find(item=>item.name===name);
  if(existing)Object.assign(existing,{parameters,...extra});else workflow.nodes.push({id,name,type:'n8n-nodes-base.'+type,typeVersion,position,parameters,...extra});
 };
 const condition=expression=>{const parameters=clone(node('Precisa baixar').parameters);parameters.conditions.conditions[0].leftValue=expression;return parameters;};
 node('Decidir recebimento').parameters.jsCode=bundle(['fail','object','decideReservation'])+"return [{json:decideReservation($('Um anexo por vez').item.json,$json)}];";
 node('Adiar sweep quando upload pendente').parameters.jsCode="return [{json:{pending:$json.excluded===true?false:$json.document?.file_status!=='saved',excluded:$json.excluded===true,document_id:$json.document_id}}];";
 const connect=(from,outputs)=>{workflow.connections[from]={main:outputs.map(names=>names.map(name=>({node:name,type:'main',index:0})))};};
 node('Janela de recebimento').parameters.jsCode=bundle(['fail','validateWindow','listQuery'])+"const cfg=$json;const window={...cfg,windowStart:cfg.intakeCutoff,sweepEnd:new Date().toISOString()};return [{json:{...window,listQuery:listQuery(window)}}];";
 node('Enumerar anexos e ausência').parameters.jsCode=bundle([...base,'inspectMessage','inspectHopelabNotice'])+"const cfg=$('Janela de recebimento').first().json;const expectedId=$('Mensagem disponível').item.json.id;const notice=inspectHopelabNotice($json,expectedId,cfg);if(notice)return [{json:{hopelabNotice:notice}}];const result=inspectMessage($json,expectedId,cfg);return result.excluded?[{json:{messageExcluded:true}}]:result.origins.map(json=>({json:{...json,resetAttachments:true}}));";
 upsert('Aviso Hopelab autorizado','if',2.2,[1680,360],condition('={{ !!$json.hopelabNotice }}'));
 const bodyRequest=clone(node('Gmail - MIME sem bytes').parameters);
 bodyRequest.url="={{ 'https://gmail.googleapis.com/gmail/v1/users/me/messages/'+encodeURIComponent($json.hopelabNotice.id)+'?format=full&fields='+encodeURIComponent("+JSON.stringify(intakeRuntime.hopelabBodyFields())+") }}";
 upsert('Gmail - corpo do aviso Hopelab','httpRequest',4.2,[1920,360],bodyRequest,{retryOnFail:false,credentials:clone(node('Gmail - MIME sem bytes').credentials)});
 upsert('Extrair link Hopelab autorizado','code',2,[2160,360],{jsCode:"const crypto=require('crypto');\n"+bundle([...base,'canonicalHopelabUrl','parseHopelabNotice'])+"const notice=$('Aviso Hopelab autorizado').item.json.hopelabNotice;const origins=parseHopelabNotice($json,notice,$('Janela de recebimento').first().json);return origins.map(json=>({json:{...json,resetAttachments:true}}));"});
 upsert('Origem de link Hopelab','if',2.2,[2640,360],condition("={{ $json.source.metadata.provider === 'hopelab_link' }}"));
 upsert('Hopelab - baixar PDF reservado','httpRequest',4.2,[2880,360],{method:'GET',url:'={{ $json.attachment.downloadUrl }}',options:{timeout:30000,redirect:{redirect:{followRedirects:false}},response:{response:{responseFormat:'file',outputPropertyName:'data',fullResponse:true}}}},{retryOnFail:false,onError:'continueErrorOutput'});
 node('Validar bytes e SHA-256').parameters.jsCode="const crypto=require('crypto');\n"+bundle(['fail','object','unwrap','canonicalHopelabUrl','decodeOriginal','decodeHopelabOriginal'])+"const origin=$('Decidir recebimento').item.json;const cfg=$('Configuração').first().json;const decoded=origin.source.metadata.provider==='hopelab_link'?decodeHopelabOriginal(await this.helpers.getBinaryDataBuffer(0,'data'),$json,origin,cfg):decodeOriginal($json,origin,cfg);return [{json:decoded.json,binary:{data:await this.helpers.prepareBinaryData(decoded.bytes,decoded.json.source.original_name,'application/pdf')}}];";
 connect('Enumerar anexos e ausência',[['Aviso Hopelab autorizado']]);
 connect('Aviso Hopelab autorizado',[['Gmail - corpo do aviso Hopelab'],['PDF ou aviso disponível']]);
 connect('Gmail - corpo do aviso Hopelab',[['Extrair link Hopelab autorizado']]);
 connect('Extrair link Hopelab autorizado',[['PDF ou aviso disponível']]);
 connect('Precisa baixar',[['Origem de link Hopelab'],['Próximo anexo']]);
 connect('Origem de link Hopelab',[['Hopelab - baixar PDF reservado'],['Gmail - baixar PDF reservado']]);
 connect('Hopelab - baixar PDF reservado',[['Validar bytes e SHA-256'],['Registrar falha de origem']]);
}
function applyNotificationPresentation(workflow, kind){
 const node=name=>{const found=workflow.nodes.find(item=>item.name===name);if(!found)throw new Error('Missing notification node: '+name);return found;};
 if(kind==='processing'){
  node('Validar JSON e evidências').parameters.jsCode=validateExamExtraction.toString()+`\nconst context=$('Preparar classificação ou revisão').item.json;\nreturn [{json:{task:context.task,extraction:validateExamExtraction(context,$json)}}];\n`;
  node('Resultado para persistir').parameters.jsCode=examPresentation.toString()+`\nconst input=$input.first().json;\nconst task=input.task;const extraction=input.extraction;\nconst presentation=examPresentation({...task.document,extracted_data:extraction.fields});\nreturn [{json:{task,extraction,driveName:presentation.fileName}}];\n`;
  const request=node('Extrair dados estruturados').parameters;
  request.jsonBody=request.jsonBody.replace('pdfBase64}}]','pdfBase64} }]');
  const legacyDateInstruction='exam_date é a data explicitamente identificada no documento como realização do exame ou coleta. Nunca use data de recebimento do email, emissão ou assinatura como substituta; se a data de realização/coleta não estiver clara, retorne null.';
  const instruction='exam_date é a data do exame informada no documento. Priorize a data de realização ou coleta quando indicada; na ausência dela, use a Data do Laudo ou data de emissão ou assinatura do laudo. Nunca use data de recebimento do email, nascimento ou rodapé genérico. Retorne null apenas se não houver data documental identificável.';
  request.jsonBody=request.jsonBody.replace(legacyDateInstruction,instruction).replace(' Data do Laudo, emissão e assinatura não comprovam realização/coleta.','');
  if(!request.jsonBody.includes(instruction))request.jsonBody=request.jsonBody.replace('Ausências são null; não invente data.', 'Ausências são null; não invente data. '+instruction);
  const previousIdentityInstruction='Copie pet_name e client_name por inteiro, exatamente como impressos, incluindo todos os sobrenomes e nomes compostos; nunca reduza ao primeiro nome nem complete usando conhecimento externo. Acompanhante do Exame pode identificar o tutor quando aparece claramente no bloco de identificação do paciente. exam_type deve ser uma expressão literal presente no PDF (por exemplo RELATÓRIO RADIOGRÁFICO); não componha ou parafraseie modalidade e região. Cada valor não nulo precisa de evidência na própria página. Copie os trechos de evidência com seus rótulos e mantenha as quebras de linha existentes.';
  const identityInstruction='Copie pet_name e client_name por inteiro, exatamente como impressos, incluindo todos os sobrenomes e nomes compostos; nunca reduza ao primeiro nome nem complete usando conhecimento externo. Acompanhante do Exame ou Responsável pode identificar o tutor quando aparece no bloco de identificação do paciente. Tipos de exame devem ter títulos documentais comprovados. Exceção comercial: ERITROGRAMA, LEUCOGRAMA e PLAQUETOGRAMA, quando os três são seções atuais com resultados do mesmo paciente, formam Hemograma; cite os três títulos reais, sem inventar uma ocorrência literal de Hemograma. Se o arquivo também contém CREATININA e/ou UREIA, preserve os exames adicionais na composição Hemograma + Creatinina + Ureia, incluindo somente os títulos efetivamente presentes e evidência própria para cada um. Não normalize menções históricas, canceladas ou apenas solicitadas. Nos demais casos, mantenha o título literal, sem compor modalidade e região. Cada valor não nulo precisa de evidência na própria página. Copie os trechos de evidência com seus rótulos e mantenha as quebras de linha existentes.';
  request.jsonBody=request.jsonBody.replace(previousIdentityInstruction,identityInstruction);
  if(!request.jsonBody.includes(identityInstruction))request.jsonBody=request.jsonBody.replace(instruction,instruction+' '+identityInstruction);
  request.jsonBody=request.jsonBody.replace('report_number:null|string}', 'report_number:null|string,requesting_vet_name:null|string,requesting_vet_crmv:null|string}');
  const previousRequesterInstruction='requesting_vet_name é exclusivamente o nome completo explicitamente rotulado como Solicitante, Requisitante ou Solicitado por. Não use o nome do radiologista, laudante, signatário, laboratório ou responsável técnico. requesting_vet_crmv é o CRMV com UF desse mesmo solicitante, apenas quando identificado no mesmo bloco; um número sem UF é null. Na ausência desse solicitante explícito, ambos são null; isso não impede o envio do exame. Cite evidência própria para cada campo, incluindo o rótulo e, para o CRMV, também o nome do solicitante. Não complete nomes pelo cadastro nem pela assinatura do laudo.';
  const requesterInstruction='requesting_vet_name é o nome completo explicitamente rotulado como Solicitante, Requisitante ou Solicitado por. Também aceite Médico veterinário no cabeçalho de identificação quando o mesmo bloco contém Paciente, Responsável ou Tutor e Data coleta; leia a coluna correta entre Clínica veterinária e CRMV. A evidência desse caso deve incluir o cabeçalho e as linhas de identificação e coleta, sem incluir a assinatura. Não use o nome do radiologista, laudante, signatário, Liberado por, laboratório ou responsável técnico. requesting_vet_crmv é o CRMV com UF desse mesmo solicitante, apenas quando identificado no mesmo bloco; um número sem UF é null. Na ausência desse solicitante explícito, ambos são null; isso não impede o envio do exame. Cite evidência própria para cada campo, incluindo o rótulo e, para o CRMV, também o nome do solicitante. Não complete nomes pelo cadastro nem pela assinatura do laudo.';
  request.jsonBody=request.jsonBody.replace(previousRequesterInstruction,requesterInstruction);
  if(!request.jsonBody.includes(requesterInstruction))request.jsonBody=request.jsonBody.replace(identityInstruction,identityInstruction+' '+requesterInstruction);
  const headerInstruction='Determine single_patient pela identidade do paciente e do tutor ao longo das páginas. Vários exames, várias páginas ou profissionais diferentes em Liberado por não significam vários pacientes. Se o mesmo paciente e tutor se repetem, single_patient pode ser true; mantenha false quando houver identidades distintas ou dúvida real. Para tabelas de identificação, associe cada valor à sua coluna: na linha Responsável | Raça | Data coleta, a data é a última coluna de valores; inclua as duas linhas na evidência da data, sem tomar nascimento ou recebimento como coleta.';
  if(!request.jsonBody.includes(headerInstruction))request.jsonBody=request.jsonBody.replace(requesterInstruction,requesterInstruction+' '+headerInstruction);
 }
 if(kind==='group'){
  const prepare=node('Preparar PDF e correlação');
  prepare.parameters.jsCode=examPresentation.toString()+`\nconst crypto=require('crypto');\nconst bytes=await this.helpers.getBinaryDataBuffer(0,'data');\nconst cfg=$('Configuração').first().json;const task=$('Tarefa disponível').item.json;const doc=task.document;\nif(!bytes.length||bytes.length>cfg.maxBytes||!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))throw new Error('PDF vazio, inválido ou fora do limite.');\nif(crypto.createHash('sha256').update(bytes).digest('hex')!==doc.sha256||bytes.length!==Number(doc.size_bytes))throw new Error('PDF para grupo sem integridade comprovada.');\nconst presentation=examPresentation({...doc,notification_fields:task.notification_fields||doc.notification_fields},cfg.pamLaudosBaseUrl);\nconst correlation='[EXAM:'+doc.id+':DELIVERY:'+task.id+']';\nconst contentAttributes={pamvet_exam_document_id:doc.id,pamvet_exam_delivery_id:task.id,pamvet_exam_sha256:doc.sha256};\nconst binary=$input.first().binary;binary.data.fileName=presentation.fileName;binary.data.mimeType='application/pdf';\nreturn [{json:{task,correlation,contentAttributes,content:presentation.content,verified:true},binary}];\n`;
  const parameters=node('Chatwoot - enviar PDF único').parameters.bodyParameters.parameters;
  if(!parameters.some(parameter=>parameter.name==='content_attributes'))parameters.push({name:'content_attributes',value:'={{ JSON.stringify($json.contentAttributes) }}',parameterType:'formData'});
  node('Conferir entrega sem reenviar').parameters.jsCode=findExamDelivery.toString()+`\nconst task=$('Uma confirmação por vez').item.json;const list=[];for(const i of $input.all()){const body=i.json;list.push(...(body.payload||body.messages||[]));}\nconst found=findExamDelivery(list,task,$('Configuração').first().json);\nlet outcome={status:'uncertain',error:'Entrega não comprovada nas páginas consultadas; conferir no PamLaudos',external_status:'reconciliation_inconclusive'};\nif(found.length===1){const m=found[0];const sent=$('Configuração').first().json.providerConfirmationStatuses.includes(String(m.status));outcome={status:sent?'sent':m.status==='failed'?'uncertain':'submitted',external_id:String(m.id),external_status:String(m.status||'api_created'),correlation:'[EXAM:'+task.document.id+':DELIVERY:'+task.id+']'};}\nreturn [{json:{task,outcome}}];\n`;
 }
}
function applyIntakeAccounting(workflow){
 const node=name=>workflow.nodes.find(item=>item.name===name);
 const connect=(from,outputs)=>{workflow.connections[from]={main:outputs.map(names=>names.map(name=>({node:name,type:'main',index:0})))};};
 const add=(name,position,jsCode)=>{
  const existing=node(name);if(existing){existing.parameters={jsCode};return;}
  const hex=crypto.createHash('sha256').update('pamvet-intake-accounting:'+name).digest('hex');
  workflow.nodes.push({id:hex.slice(0,8)+'-'+hex.slice(8,12)+'-5'+hex.slice(13,16)+'-a'+hex.slice(17,20)+'-'+hex.slice(20,32),name,type:'n8n-nodes-base.code',typeVersion:2,position,parameters:{jsCode}});
 };
 add('Marcar falha da mensagem',[1680,-520],"return [{json:{intakeReceipt:true,kind:'message',message_id:$('Mensagem disponível').item.json.id,disposition:'failed',reason:'message_metadata_or_notice_unproven'}}];");
 add('Marcar mensagem excluída',[1680,-280],"return [{json:{intakeReceipt:true,kind:'message',message_id:$('Mensagem disponível').item.json.id,disposition:'excluded',reason:$json.reason||'outside_window_or_no_pdf_no_exam_hint'}}];");
 add('Marcar falha da reserva',[2400,-520],"return [{json:{intakeFailure:true}}];");
 for(const name of ['Gmail - MIME sem bytes','Enumerar anexos e ausência','Gmail - corpo do aviso Hopelab','Extrair link Hopelab autorizado']){
  node(name).onError='continueErrorOutput';workflow.connections[name].main[1]=[{node:'Marcar falha da mensagem',type:'main',index:0}];
 }
 for(const name of ['Reservar origem','Decidir recebimento']){
  node(name).onError='continueErrorOutput';workflow.connections[name].main[1]=[{node:'Marcar falha da reserva',type:'main',index:0}];
 }
 node('Enumerar anexos e ausência').parameters.jsCode=node('Enumerar anexos e ausência').parameters.jsCode.replace('messageExcluded:true}}]', 'messageExcluded:true,reason:result.reason}}]');
 node('Próximo anexo').parameters.jsCode='function fail(code){throw new Error(code);}\n'+intakeRuntime.object.toString()+'\n'+intakeRuntime.attachmentIntakeReceipt.toString()+"\nreturn $input.all().map(item=>({json:attachmentIntakeReceipt(item.json,$('Um anexo por vez').item.json)}));";
 node('Confirmar varredura concluída').parameters.jsCode='function fail(code){throw new Error(code);}\n'+intakeRuntime.object.toString()+'\n'+intakeRuntime.summarizeIntakeReceipts.toString()+"\nconst cfg=$('Configuração').first().json;const expected=cfg.manualMessageId?[cfg.manualMessageId]:$('IDs de mensagens').all().filter(item=>!item.json.emptySweep).map(item=>item.json.id);const summary=summarizeIntakeReceipts($input.all().map(item=>item.json),expected);const audit={checkedAt:new Date().toISOString(),executionId:String($execution.id),scanFinished:summary.scanFinished,counts:summary.counts};const state=$getWorkflowStaticData('global');state.lastIntakeAudit=audit;state.intakeAuditHistory=[...(Array.isArray(state.intakeAuditHistory)?state.intakeAuditHistory:[]).filter(item=>item.executionId!==audit.executionId),audit].slice(-20);return [{json:summary}];";
 connect('Marcar falha da mensagem',[['Uma mensagem por vez']]);connect('Marcar mensagem excluída',[['Uma mensagem por vez']]);connect('Marcar falha da reserva',[['Próximo anexo']]);
 connect('PDF ou aviso disponível',[['Um anexo por vez'],['Marcar mensagem excluída']]);
}
function applyPipelineLatency(workflow,kind){
 if(kind==='intake')return;
 const node=name=>{const found=workflow.nodes.find(item=>item.name===name);if(!found)throw new Error('Missing pipeline node: '+name);return found;};
 const connect=(from,outputs)=>{workflow.connections[from]={main:outputs.map(names=>names.map(name=>({node:name,type:'main',index:0})))};};
 const upsert=(name,type,version,parameters,position,extra={})=>{
  const existing=workflow.nodes.find(item=>item.name===name);
  if(existing){Object.assign(existing,{parameters,...extra});return existing;}
  const hash=crypto.createHash('sha256').update('pamvet-pipeline:'+kind+':'+name).digest('hex');
  const added={id:hash.slice(0,8)+'-'+hash.slice(8,12)+'-5'+hash.slice(13,16)+'-a'+hash.slice(17,20)+'-'+hash.slice(20,32),name,type:'n8n-nodes-base.'+type,typeVersion:version,position,parameters,...extra};
  workflow.nodes.push(added);return added;
 };
 const code=(name,source,position=[0,800])=>upsert(name,'code',2,{jsCode:source},position);
 const condition=(name,expression,position=[240,800])=>upsert(name,'if',2.2,{conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'strict',version:2},conditions:[{id:'pipeline-condition',leftValue:expression,rightValue:true,operator:{type:'boolean',operation:'equals'}}],combinator:'and'},options:{}},position);
 const service=(name,action,payload,position=[480,800])=>{
  const base=clone(node('Reservar tarefa'));
  // n8n's template tokenizer treats adjacent }} as the expression terminator,
  // even when they close nested JavaScript objects. Keep those tokens apart.
  return upsert(name,'httpRequest',4.2,{...base.parameters,jsonBody:'={{ ({action:'+JSON.stringify(action)+',payload:'+payload+' }) }}'},position,{credentials:base.credentials,retryOnFail:false});
 };
 const runtime=names=>names.map(name=>intakeRuntime[name].toString()).join('\n')+'\n';
 const trigger=(stage,mode=false)=>{
  const title='Acordar '+stage;
  upsert(title,'webhook',2,{httpMethod:'POST',path:'pamvet-exam-'+stage+'-wakeup',authentication:'headerAuth',responseMode:'onReceived',options:{}},mode?[-960,1040]:[-720,800],{webhookId:'pamvet-exam-'+stage+'-wakeup',credentials:{httpHeaderAuth:clone(node('Reservar tarefa').credentials.httpHeaderAuth)}});
  if(mode){code('Modo '+stage,"return [{json:{__pipelineStage:"+JSON.stringify(stage)+"}}];",[-480,1040]);connect(title,[['Modo '+stage]]);connect('Modo '+stage,[['Configuração']]);}
  else connect(title,[['Configuração']]);
 };
 const alternate=stage=>{
  trigger(stage,true);
  const oldName='Recuperar '+stage+' a cada minuto',newName='Recuperar '+stage+' a cada 5 minutos';
  const old=workflow.nodes.find(item=>item.name===oldName);if(old){old.name=newName;delete workflow.connections[oldName];}
  upsert(newName,'scheduleTrigger',1.2,{rule:{interval:[{field:'minutes',minutesInterval:5}]}},[-720,1040]);
  connect(newName,[['Modo '+stage]]);
 };
 const cfg=node('Configuração');
 const allowed=kind==='processing'?['processing','rename']:kind==='group'?['group','reconcile']:['nexus'];
 cfg.parameters.jsCode=cfg.parameters.jsCode.replace(/\ncfg\.pipelineStage=[\s\S]*?\nreturn \[\{json:cfg\}\];$/,'\nreturn [{json:cfg}];');
 cfg.parameters.jsCode=cfg.parameters.jsCode.replace('return [{json:cfg}];',`cfg.pipelineStage=$json.__pipelineStage||${JSON.stringify(kind)};\nif(!${JSON.stringify(allowed)}.includes(cfg.pipelineStage))throw new Error('pipeline_stage_invalid');\nreturn [{json:cfg}];`);
 workflow.settings.executionTimeout=600;
 const schedule=node('A cada 5 minutos');schedule.parameters.rule={interval:[{field:'minutes',minutesInterval:5}]};
 // Preserve the existing node identity/layout while its interval becomes recovery-only.
 trigger(kind);
 service('Reservar trabalhador exclusivo','worker_acquire',"{stage:$('Configuração').first().json.pipelineStage,worker:$('Configuração').first().json.worker,lease_seconds:660}",[-240,800]);
 condition('Trabalhador reservado','={{ $json.claimed === true }}',[0,800]);
 code('Iniciar rodada',runtime(['startPipelineDrain'])+"return [{json:startPipelineDrain($('Configuração').first().json.pipelineStage,$('Configuração').first().json.worker,$json)}];",[240,800]);
 condition('Orçamento disponível','={{ $json.count < 4 && Date.now() - $json.startedAt < 180000 }}',[720,800]);
 service('Liberar trabalhador exclusivo','worker_release',"{stage:$('Iniciar rodada').first().json.stage,lease_token:$('Iniciar rodada').first().json.workerToken}",[1680,1040]);
 service('Continuar fila após orçamento','worker_release',"{stage:$('Iniciar rodada').first().json.stage,lease_token:$('Iniciar rodada').first().json.workerToken,continue:$json.count>0}",[1920,1040]);
 connect('Configuração',[['Reservar trabalhador exclusivo']]);
 connect('Reservar trabalhador exclusivo',[['Trabalhador reservado']]);connect('Trabalhador reservado',[['Iniciar rodada'],[]]);
 connect('Orçamento disponível',[['Reservar tarefa'],['Continuar fila após orçamento']]);
 node('Reservar tarefa').parameters.jsonBody="={{ ({action:'reserve_tasks',payload:{destination:"+JSON.stringify(kind)+",worker:$('Configuração').first().json.worker,worker_lease_token:$json.workerToken,limit:1} }) }}";
 condition('Há tarefa reservada','={{ Array.isArray($json.tasks) && $json.tasks.length === 1 }}',[960,800]);
 connect('Reservar tarefa',[['Há tarefa reservada']]);connect('Há tarefa reservada',[['Tarefa disponível'],['Liberar trabalhador exclusivo']]);
 node('Tarefa disponível').parameters.jsCode="const state=$('Orçamento disponível').item.json;\nconst task=$json.tasks[0];\nif(!task||task.destination!=="+JSON.stringify(kind)+")throw new Error('pipeline_task_destination_invalid');\nconst cfg=$('Configuração').first().json;\nconst expected='chatwoot:'+cfg.accountId+':'+cfg.inboxId+':'+cfg.conversationId+':'+cfg.groupJid;\nreturn [{json:{...task,drain:state,destinationVerified:task.configured_destination===expected}}];";
 code('Preparar próxima tarefa',runtime(['pipelineDrainAvailable','advancePipelineDrain'])+"const task=$('Tarefa disponível').item.json;return [{json:advancePipelineDrain(task.drain,$json,task.id)}];",[1440,800]);
 connect('Preparar próxima tarefa',[['Orçamento disponível']]);
 if(kind==='processing'||kind==='nexus'){
  connect('Iniciar rodada',[['Reconciliar reservas vencidas']]);
  code('Restaurar rodada',"return [{json:$('Iniciar rodada').first().json}];",[480,800]);
  connect('Reconciliar reservas vencidas',[['Restaurar rodada']]);connect('Restaurar rodada',[['Orçamento disponível']]);
  const finish=kind==='processing'?'Concluir processamento':'Anexar e verificar no backend';
  const failure=kind==='processing'?'Registrar falha de processamento':'Registrar falha de anexação';
  connect(finish,[['Preparar próxima tarefa'],...(kind==='nexus'?[[failure]]:[])]);connect(failure,[['Preparar próxima tarefa']]);
 }
 if(kind==='processing'){
  code('Avaliar extração rápida',[validateExamExtraction,parseHopeLabFastCandidate,validateFastExamCandidate,inspectFastExtraction].map(fn=>fn.toString()).join('\n')+"\nconst context=$json;const mode=$('Configuração').first().json.fastExtractionMode||'shadow';return [{json:{...context,fast:inspectFastExtraction(context,{mode})}}];",[1440,560]);
  condition('Extração rápida validada','={{ $json.fast.accepted === true && $json.fast.route === "fast" && !!$json.fast.extraction }}',[1680,560]);
  code('Usar extração rápida',"if(!$json.fast?.accepted||!$json.fast.extraction)throw new Error('fast_extraction_unproven');return [{json:{task:$json.task,extraction:$json.fast.extraction}}];",[1920,560]);
  connect('Preparar classificação ou revisão',[['Avaliar extração rápida']]);connect('Avaliar extração rápida',[['Extração rápida validada']]);connect('Extração rápida validada',[['Usar extração rápida'],['Extrator disponível e texto válido']]);connect('Usar extração rápida',[['Resultado para persistir']]);
  // The backend persists desired_name in its own queue. A Drive rename can no
  // longer prevent the document/card transaction from committing.
  connect('Resultado para persistir',[['Persistir extração e revisão'],['Registrar falha de processamento']]);
  alternate('rename');
  condition('Rodada de renomeação','={{ $json.stage === "rename" }}',[480,1040]);
  connect('Orçamento disponível',[['Rodada de renomeação'],['Continuar fila após orçamento']]);
  connect('Rodada de renomeação',[['Reservar renomeação'],['Reservar tarefa']]);
  service('Reservar renomeação','reserve_rename',"{worker:$('Configuração').first().json.worker,worker_lease_token:$json.workerToken}",[720,1040]);
  condition('Há renomeação reservada','={{ Array.isArray($json.tasks) && $json.tasks.length === 1 }}',[960,1040]);
  code('Renomeação disponível',examPresentation.toString()+"\nconst task=$json.tasks[0];if(!task?.document||task.document.id!==task.document_id)throw new Error('rename_document_snapshot_missing');return [{json:{...task,desired_name:examPresentation(task.document).fileName,drain:$('Orçamento disponível').item.json}}];",[1200,1040]);
  connect('Reservar renomeação',[['Há renomeação reservada']]);connect('Há renomeação reservada',[['Renomeação disponível'],['Liberar trabalhador exclusivo']]);
  service('Autorizar renomeação atual','rename_prepare','{delivery_id:$json.id,lease_token:$json.lease_token,document_version:$json.document_version,name:$json.desired_name}',[1200,1280]);
  condition('Renomeação autorizada','={{ $json.dispatch_allowed === true }}',[1440,1120]);
  code('Restaurar renomeação autorizada',"if($json.dispatch_allowed!==true)throw new Error('rename_not_authorized');return [$('Renomeação disponível').item];",[1680,1120]);
  connect('Renomeação disponível',[['Autorizar renomeação atual']]);connect('Autorizar renomeação atual',[['Renomeação autorizada']]);connect('Renomeação autorizada',[['Restaurar renomeação autorizada'],['Liberar trabalhador exclusivo']]);connect('Restaurar renomeação autorizada',[['Drive - renomear o mesmo arquivo']]);
  const rename=node('Drive - renomear o mesmo arquivo');rename.parameters.url="={{ 'https://www.googleapis.com/drive/v3/files/'+encodeURIComponent($json.drive_file_id)+'?fields=id,name' }}";rename.parameters.jsonBody='={{ ({name:$json.desired_name}) }}';
  code('Conferir renomeação',"const task=$('Renomeação disponível').item.json;if($json.id!==task.drive_file_id||$json.name!==task.desired_name)throw new Error('drive_rename_unproven');return [{json:{task,outcome:{status:'completed',drive_file_id:$json.id,name:$json.name}}}];",[1440,1280]);
  code('Falha de renomeação',"return [{json:{task:$('Renomeação disponível').item.json,outcome:{status:'failed',error:'Renomeação pendente; identificação preservada'}}}];",[1440,1440]);
  node('Conferir renomeação').onError='continueErrorOutput';
  service('Persistir renomeação','rename_result','{delivery_id:$json.task.id,lease_token:$json.task.lease_token,outcome:$json.outcome}',[1680,1280]);
  code('Preparar próxima renomeação',runtime(['pipelineDrainAvailable','advancePipelineDrain'])+"const task=$('Renomeação disponível').item.json;const receipt=$json.applied===true&&$json.task?.status==='pending'?{...$json,task:{...$json.task,status:'completed'}}:$json;return [{json:advancePipelineDrain(task.drain,receipt,task.id)}];",[1920,1280]);
  connect('Drive - renomear o mesmo arquivo',[['Conferir renomeação'],['Falha de renomeação']]);connect('Conferir renomeação',[['Persistir renomeação'],['Falha de renomeação']]);connect('Falha de renomeação',[['Persistir renomeação']]);connect('Persistir renomeação',[['Preparar próxima renomeação']]);connect('Preparar próxima renomeação',[['Orçamento disponível']]);
 }
 if(kind==='group'){
  alternate('reconcile');
  connect('Iniciar rodada',[['Chatwoot - conferir conversa destino']]);
  node('Validar grupo e caixa').parameters.jsCode=node('Validar grupo e caixa').parameters.jsCode.replace('return [{json:cfg}];',"return [{json:$('Iniciar rodada').first().json}];");
  condition('Rodada de confirmação','={{ $json.stage === "reconcile" }}',[480,800]);
  connect('Validar grupo e caixa',[['Rodada de confirmação']]);connect('Rodada de confirmação',[['Reconciliar reservas e mensagens'],['Orçamento disponível']]);
  node('Reconciliar reservas e mensagens').parameters.jsonBody="={{ ({action:'group_reconcile',payload:{worker:$('Configuração').first().json.worker,worker_lease_token:$('Iniciar rodada').first().json.workerToken,limit:4} }) }}";
  node('Registrar confirmação observada').parameters.jsonBody="={{ ({action:'task_result',payload:{delivery_id:$json.task.id,lease_token:$json.task.lease_token,outcome:$json.outcome,reconciliation:true} }) }}";
  node('Mensagens aguardando confirmação').parameters.jsCode="const cfg=$('Configuração').first().json;const expected='chatwoot:'+cfg.accountId+':'+cfg.inboxId+':'+cfg.conversationId+':'+cfg.groupJid;const tasks=$json.tasks||[];for(const task of tasks){if((task.configured_destination||task.destination_key)!==expected)throw new Error('Conferir o destino original da mensagem antes de continuar');}const state=$('Iniciar rodada').first().json;return tasks.length?tasks.slice(0,4).map((task,index)=>({json:{...task,drain:{...state,count:index}}})):[{json:{empty:true}}];";
  condition('Orçamento da confirmação','={{ $json.drain.count < 4 && Date.now() - $json.drain.startedAt < 180000 }}',[480,1280]);
  code('Concluir rodada de confirmação',"const count=$('Mensagens aguardando confirmação').all().filter(item=>!item.json.empty).length;return [{json:{...$('Iniciar rodada').first().json,count}}];",[960,1440]);
  condition('Lote de confirmação completo','={{ $json.count >= 4 }}',[1200,1440]);
  connect('Uma confirmação por vez',[['Concluir rodada de confirmação'],['Mensagem anterior disponível']]);connect('Concluir rodada de confirmação',[['Lote de confirmação completo']]);connect('Lote de confirmação completo',[['Continuar fila após orçamento'],['Liberar trabalhador exclusivo']]);
  connect('Mensagem anterior disponível',[['Orçamento da confirmação'],['Uma confirmação por vez']]);
  code('Continuar confirmação após orçamento',"return [{json:$json.drain}];",[720,1440]);
  connect('Orçamento da confirmação',[['Chatwoot - consultar mensagens existentes'],['Continuar confirmação após orçamento']]);connect('Continuar confirmação após orçamento',[['Continuar fila após orçamento']]);
  node('Chatwoot - consultar mensagens existentes').parameters.options.timeout=10000;
  // Bytes are checked before asking for a fresh snapshot. The immutable file
  // identity is checked again when that snapshot is restored into the item.
  code('Conferir PDF para despacho',"const crypto=require('crypto');const task=$('Tarefa disponível').item.json;const bytes=await this.helpers.getBinaryDataBuffer(0,'data');const sha256=crypto.createHash('sha256').update(bytes).digest('hex');if(!bytes.length||bytes.length>$('Configuração').first().json.maxBytes||!bytes.subarray(0,1024).includes(Buffer.from('%PDF-'))||sha256!==task.document.sha256||bytes.length!==Number(task.document.size_bytes))throw new Error('group_pdf_integrity_invalid');return [{json:{task,verified:{documentId:task.document.id,sha256,sizeBytes:bytes.length}},binary:$input.first().binary}];",[1920,800]);
  node('Conferir PDF para despacho').onError='continueErrorOutput';
  service('Atualizar autorização de envio','group_prepare','{delivery_id:$json.task.id,lease_token:$json.task.lease_token}',[2160,800]);
  condition('Despacho pronto','={{ $json.dispatch_ready === true }}',[2400,800]);
  code('Restaurar PDF validado',runtime(['freshGroupTask'])+"const checked=$('Conferir PDF para despacho').item;const task=freshGroupTask(checked.json.task,$json,checked.json.verified,$('Configuração').first().json);return [{json:{task},binary:checked.binary}];",[2640,800]);
  node('Preparar PDF e correlação').parameters.jsCode=node('Preparar PDF e correlação').parameters.jsCode.replace("const task=$('Tarefa disponível').item.json;","const task=$json.task;").replace('content:presentation.content,verified:true','content:presentation.content,contentSha256:crypto.createHash(\'sha256\').update(presentation.content).digest(\'hex\'),verified:true');
  if(!node('Preparar PDF e correlação').parameters.jsCode.includes('const task=$json.task;')||node('Preparar PDF e correlação').parameters.jsCode.includes("$('Tarefa disponível')"))throw new Error('Group preparation must consume the freshly authorized task');
  service('Registrar início do envio','group_begin','{delivery_id:$json.task.id,lease_token:$json.task.lease_token,presentation_revision:$json.task.presentation_revision,content:$json.content}',[2880,800]);
  condition('POST autorizado','={{ $json.dispatch_allowed === true }}',[3120,800]);
  code('Restaurar conteúdo autorizado',"if($json.dispatch_allowed!==true)throw new Error('group_post_not_authorized');return [$('Preparar PDF e correlação').item];",[3360,800]);
  connect('Drive - baixar PDF para grupo',[['Conferir PDF para despacho'],['Falha confirmada antes do POST']]);
  connect('Conferir PDF para despacho',[['Atualizar autorização de envio'],['Falha confirmada antes do POST']]);
  connect('Atualizar autorização de envio',[['Despacho pronto']]);connect('Despacho pronto',[['Restaurar PDF validado'],['Liberar trabalhador exclusivo']]);connect('Restaurar PDF validado',[['Preparar PDF e correlação']]);
  connect('PDF íntegro para enviar',[['Registrar início do envio'],['Falha confirmada antes do POST']]);connect('Registrar início do envio',[['POST autorizado']]);connect('POST autorizado',[['Restaurar conteúdo autorizado'],['Liberar trabalhador exclusivo']]);connect('Restaurar conteúdo autorizado',[['Chatwoot - enviar PDF único']]);
  node('Classificar submissão sem reenvio').parameters.jsCode=runtime(['classifyGroupSubmission'])+"return [{json:classifyGroupSubmission($('Preparar PDF e correlação').item.json,$json)}];";
  connect('Persistir tentativa de grupo',[['Preparar próxima tarefa']]);connect('Falha confirmada antes do POST',[['Preparar próxima tarefa']]);
 }
}
// Also used by the private publication adapter: keeps existing node IDs,
// positions, prompts, credentials and environment-specific configuration.
export function upgradePipelineWorkflow(workflow,kind){
 if(!['processing','group','nexus'].includes(kind))throw new Error('Unsupported pipeline workflow');
 const upgraded=clone(workflow);applyPipelineLatency(upgraded,kind);return upgraded;
}
function validatePrivateSettings(settings){
 if(!settings||typeof settings!=='object'||Array.isArray(settings)||Object.keys(settings).some(k=>!['config','credentials'].includes(k)))throw new Error('Use only {config,credentials}; never put secret values in this file');
 const configuration=settings.config??{};
 if(!configuration||typeof configuration!=='object'||Array.isArray(configuration)||Object.keys(configuration).some(k=>!Object.hasOwn(CONFIG,k)&&k!=='fastExtractionMode'))throw new Error('Unknown operational configuration field');
 if(configuration.fastExtractionMode!==undefined&&!['off','shadow','active'].includes(configuration.fastExtractionMode))throw new Error('Invalid fast extraction mode');
 const credentials=settings.credentials??{};
 if(!credentials||typeof credentials!=='object'||Array.isArray(credentials)||Object.keys(credentials).some(k=>!Object.hasOwn(CREDENTIALS,k)))throw new Error('Unknown credential reference');
 for(const reference of Object.values(credentials))if(!reference||typeof reference!=='object'||Array.isArray(reference)||Object.keys(reference).some(k=>!['id','name'].includes(k))||typeof reference.id!=='string'||!reference.id||reference.id.length>200||typeof reference.name!=='string'||!reference.name||reference.name.length>200||/[\x00-\x1f\x7f]/.test(reference.id+reference.name))throw new Error('Credential references accept id/name only, never token/key/value');
 return {configuration,credentials};
}
export async function buildWorkflows(settings={}){
 const {configuration,credentials}=validatePrivateSettings(settings);
 const config={...clone(CONFIG),...configuration};
 const refs={...clone(CREDENTIALS),...clone(credentials)};
 if(typeof config.enabled!=='boolean'||typeof config.mailbox!=='string'||!config.mailbox.includes('@')||typeof config.dedicatedMailbox!=='boolean'||typeof config.includeSpamTrash!=='boolean')throw new Error('Invalid operational configuration types');
 const result={};
 for(let i=0;i<templates.length;i++){
  const workflow=clone(templates[i]);
  if(KINDS[i]==='intake'){applyHopelabIntake(workflow);applyIntakeAccounting(workflow);}
  applyNotificationPresentation(workflow,KINDS[i]);
  applyPipelineLatency(workflow,KINDS[i]);
  for(const node of workflow.nodes){
   if(node.name==='Configuração')node.parameters.jsCode=node.parameters.jsCode.replace(configLiteral(workflow),JSON.stringify(config,null,2));
   if(node.parameters.jsCode)node.parameters.jsCode=node.parameters.jsCode.replace('const EXPECTED_MAILBOX='+JSON.stringify(CONFIG.mailbox), 'const EXPECTED_MAILBOX='+JSON.stringify(config.mailbox));
   for(const type of Object.keys(node.credentials||{})){
    const ref=type==='oAuth2Api'?(node.name.startsWith('Gmail -')?refs.gmail:refs.drive):type==='httpHeaderAuth'?refs.worker:type==='chatwootApi'?refs.chatwoot:type==='openAiApi'?refs.extractor:null;
    if(!ref)throw new Error('Unsupported operational credential type');
    node.credentials[type]=clone(ref);
   }
  }
  result[KINDS[i]]=workflow;
 }
 return result;
}
export async function writeWorkflows(out=path.join(ROOT,'n8n/exames'),settings={}){
 if(Object.keys(settings).length&&inRoot(out))throw new Error('Bound workflows must be written outside the public repository');
 const workflows=await buildWorkflows(settings);await fs.mkdir(out,{recursive:true});
 const result=[];let i=0;
 for(const workflow of Object.values(workflows)){
  const target=path.join(out,'OPERACIONAL-0'+(++i)+'.json');const text=JSON.stringify(workflow,null,2)+'\n';
  await fs.writeFile(target,text,{mode:0o600});if(Object.keys(settings).length)await fs.chmod(target,0o600);
  result.push({path:target,nodes:workflow.nodes.length,sha256:crypto.createHash('sha256').update(text).digest('hex')});
 }
 return result;
}
function argument(name){const args=process.argv.slice(2),at=args.indexOf(name);return at>=0?args[at+1]:args.find(v=>v.startsWith(name+'='))?.slice(name.length+1);}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const configPath=argument('--config'),out=argument('--out');
 const invalid=process.argv.slice(2).filter((v,i,a)=>!v.startsWith('--config=')&&!v.startsWith('--out=')&&!['--config','--out'].includes(v)&&!['--config','--out'].includes(a[i-1]));
 if(invalid.length)throw new Error('Use --config <private-config.local> --out <private-directory>');
 if(configPath&&(!out||inRoot(configPath)))throw new Error('Use an external private config and an external --out directory');
 const settings=configPath?JSON.parse(await fs.readFile(path.resolve(configPath),'utf8')):{};
 console.log(JSON.stringify(await writeWorkflows(out?path.resolve(out):undefined,settings),null,2));
}
