import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {examPresentation,findExamDelivery} from './notification-presentation.mjs';
import {validateExamExtraction} from './extraction-validation.mjs';
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
function validatePrivateSettings(settings){
 if(!settings||typeof settings!=='object'||Array.isArray(settings)||Object.keys(settings).some(k=>!['config','credentials'].includes(k)))throw new Error('Use only {config,credentials}; never put secret values in this file');
 const configuration=settings.config??{};
 if(!configuration||typeof configuration!=='object'||Array.isArray(configuration)||Object.keys(configuration).some(k=>!Object.hasOwn(CONFIG,k)))throw new Error('Unknown operational configuration field');
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
  if(KINDS[i]==='intake')applyHopelabIntake(workflow);
  applyNotificationPresentation(workflow,KINDS[i]);
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
