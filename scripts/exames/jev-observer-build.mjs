import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validateExamExtraction} from './extraction-validation.mjs';
import {parseHopeLabFastCandidate,validateFastExamCandidate,inspectFastExtraction,createJevRoutingRequest,parseJevRoutingResponse} from './fast-extraction.mjs';

// Official endpoint verified 2026-11-05:
// https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request
// https://openrouter.ai/docs/guides/community/jev
export const JEV_DECISIONS_URL='https://openrouter.ai/api/alpha/decisions';
export function prepareJevObservation(pdfText) {
 const pages=Array.isArray(pdfText?.text)?pdfText.text:typeof pdfText?.text==='string'?[pdfText.text]:[];
 const counts=[pdfText?.numpages,pdfText?.numPages].filter(value=>value!==undefined);
 const totalPages=counts[0];
 if(!counts.length||counts.some(value=>!Number.isInteger(value)||value<1||value!==totalPages)||!pages.length||pages.some(page=>typeof page!=='string')||totalPages>4||totalPages!==pages.length||pages.reduce((n,page)=>n+page.length,0)>80000)
  return {request:null,reason:'unsupported_text_or_pages'};
 const context={pages,totalPages,isVision:false,canExtract:pages.some(page=>page.trim())};
 const local=inspectFastExtraction(context,{mode:'shadow'});
 return {request:createJevRoutingRequest(context,local),reason:local.shadow?.eligible?'local_parser_conclusive':'no_eligible_text'};
}
export function classifyJevObservation(response,startedAt,now=Date.now()) {
 const duration_ms=Number.isFinite(now-startedAt)?Math.max(0,Math.min(180000,Math.floor(now-startedAt))):0;
 const status=Number.isInteger(response?.statusCode)&&response.statusCode>=100&&response.statusCode<=599?response.statusCode:0;
 if(status<200||status>=300)return {status:status?'failed':'uncertain',error_code:status?'http_'+status:'transport_unknown',duration_ms};
 const parsed=parseJevRoutingResponse(response.body);
 if(!parsed.ok)return {status:'failed',error_code:'invalid_response',duration_ms};
 return {status:'completed',route:parsed.route,confidence:parsed.confidence,cost_usd:parsed.costUsd,model:parsed.model,duration_ms};
}
export function buildJevObserver(settings={}) {
 if(Object.keys(settings).some(key=>!['config','credentials'].includes(key)))throw new Error('Unknown observer settings');
 const config={enabled:false,serviceUrl:'https://PROJECT_REF.supabase.co/functions/v1/exam-document-service',worker:'n8n-jev-observer',...settings.config};
 if(Object.keys(config).some(key=>!['enabled','serviceUrl','worker'].includes(key))||typeof config.enabled!=='boolean'||typeof config.serviceUrl!=='string'||!/^https:\/\/[^/]+\/functions\/v1\/exam-document-service$/.test(config.serviceUrl)||!/^[A-Za-z0-9_.:-]{1,120}$/.test(config.worker))throw new Error('Invalid observer configuration');
 const serviceUrl=new URL(config.serviceUrl);if(serviceUrl.username||serviceUrl.password||serviceUrl.search||serviceUrl.hash)throw new Error('Invalid observer service URL');
 const refs={worker:{id:'SELECT_WORKER_HEADER',name:'Select existing exam worker header'},openrouter:{type:'openRouterApi',id:'SELECT_EXISTING_OPENROUTER',name:'Select existing OpenRouter credential'},...settings.credentials};
 if(Object.keys(refs).some(key=>!['worker','openrouter'].includes(key)))throw new Error('Unknown observer credential');
 for(const [key,ref]of Object.entries(refs)){
  if(!ref||typeof ref.id!=='string'||!ref.id||ref.id.length>200||typeof ref.name!=='string'||!ref.name||ref.name.length>200||/[\x00-\x1f\x7f]/.test(ref.id+ref.name)||Object.keys(ref).some(field=>!['id','name',...(key==='openrouter'?['type']:[])].includes(field)))throw new Error('Credential references only; never keys');
 }
 if(!['openRouterApi','openAiApi','httpHeaderAuth'].includes(refs.openrouter.type))throw new Error('Unsupported existing OpenRouter credential type');
 const workflow={name:'OBSERVAÇÃO — JEV (independente dos exames)',active:false,nodes:[],connections:{},pinData:{},settings:{executionOrder:'v1',executionTimeout:120,timezone:'America/Sao_Paulo',saveDataSuccessExecution:'none',saveDataErrorExecution:'none',saveManualExecutions:false,saveExecutionProgress:false}};
 const add=(name,type,version,parameters,x,y=0,extra={})=>{const hash=crypto.createHash('sha256').update('jev-observer:'+name).digest('hex');const node={id:hash.slice(0,8)+'-'+hash.slice(8,12)+'-4'+hash.slice(13,16)+'-8'+hash.slice(17,20)+'-'+hash.slice(20,32),name,type:'n8n-nodes-base.'+type,typeVersion:version,position:[x,y],parameters,...extra};workflow.nodes.push(node);return node;};
 const link=(name,...branches)=>workflow.connections[name]={main:branches.map(names=>names.map(node=>({node,type:'main',index:0})))};
 const code=(name,jsCode,x,y)=>add(name,'code',2,{jsCode},x,y);
 const iff=(name,leftValue,x,y)=>add(name,'if',2.2,{conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'strict',version:2},conditions:[{id:'check',leftValue,rightValue:true,operator:{type:'boolean',operation:'equals'}}],combinator:'and'},options:{}},x,y);
 const http=(name,action,payload,x,y,extra={})=>add(name,'httpRequest',4.2,{method:'POST',url:"={{ $('Configuração').first().json.serviceUrl }}",authentication:'genericCredentialType',genericAuthType:'httpHeaderAuth',sendBody:true,specifyBody:'json',jsonBody:'={{ ({action:'+JSON.stringify(action)+',payload:'+payload+' }) }}',options:{timeout:10000,redirect:{redirect:{followRedirects:false}},response:{response:{responseFormat:'json'}}}},x,y,{credentials:{httpHeaderAuth:{id:refs.worker.id,name:refs.worker.name}},retryOnFail:false,...extra});
 add('Executar manualmente','manualTrigger',1,{},-480,0);
 add('A cada 5 minutos','scheduleTrigger',1.2,{rule:{interval:[{field:'minutes',minutesInterval:5}]}},-480,160);
 code('Configuração','const cfg='+JSON.stringify(config,null,2)+";\nif(!cfg.enabled)return [];cfg.worker+=':'+$execution.id;return [{json:cfg}];",-240);
 http('Reservar observação ociosa','jev_observe_reserve',"{worker:$('Configuração').first().json.worker}",0);
 iff('Observação disponível','={{ !!$json.task }}',240);
 code('Observação reservada',"return [{json:$json.task}];",480);
 const file=http('Ler original preservado','file','{document_id:$json.document.id}',720,0,{onError:'continueErrorOutput'});file.parameters.options.timeout=30000;file.parameters.options.response={response:{responseFormat:'file',outputPropertyName:'data'}};
 code('Conferir original',"const crypto=require('crypto');const task=$('Observação reservada').item.json;const bytes=await this.helpers.getBinaryDataBuffer(0,'data');if(!bytes.length||bytes.length>2097152||bytes.length!==Number(task.document.size_bytes)||!bytes.subarray(0,1024).includes(Buffer.from('%PDF-'))||crypto.createHash('sha256').update(bytes).digest('hex')!==task.document.sha256)throw new Error('observer_original_invalid');return $input.all();",960).onError='continueErrorOutput';
 add('Extrair texto limitado','extractFromFile',1,{operation:'pdf',binaryPropertyName:'data',options:{joinPages:false,keepSource:'json',maxPages:5}},1200,0,{onError:'continueErrorOutput'});
 const bundle=[validateExamExtraction,parseHopeLabFastCandidate,validateFastExamCandidate,inspectFastExtraction,createJevRoutingRequest,prepareJevObservation].map(fn=>fn.toString()).join('\n');
 code('Preparar pergunta em sombra',bundle+"\nreturn [{json:prepareJevObservation($json)}];",1440);
 iff('Pergunta necessária','={{ !!$json.request }}',1680);
 http('Marcar início e ceder ao principal','jev_observe_begin',"{observation_id:$('Observação reservada').item.json.id,lease_token:$('Observação reservada').item.json.lease_token}",1920);
 iff('Observação autorizada','={{ $json.allowed === true }}',2160);
 code('Pedido autorizado',"return [{json:{request:$('Preparar pergunta em sombra').item.json.request,startedAt:Date.now()}}];",2400);
 const credentialType=refs.openrouter.type;
 add('OpenRouter - decisão JEV','httpRequest',4.2,{method:'POST',url:JEV_DECISIONS_URL,
  authentication:credentialType==='httpHeaderAuth'?'genericCredentialType':'predefinedCredentialType',
  ...(credentialType==='httpHeaderAuth'?{genericAuthType:credentialType}:{nodeCredentialType:credentialType}),
  sendBody:true,specifyBody:'json',jsonBody:'={{ $json.request }}',options:{timeout:2000,redirect:{redirect:{followRedirects:false}},response:{response:{responseFormat:'json',fullResponse:true,neverError:true}}}},2640,0,
  {credentials:{[credentialType]:{id:refs.openrouter.id,name:refs.openrouter.name}},retryOnFail:false,onError:'continueRegularOutput'});
 code('Normalizar observação',parseJevRoutingResponse.toString()+'\n'+classifyJevObservation.toString()+"\nreturn [{json:classifyJevObservation($json,$('Pedido autorizado').item.json.startedAt)}];",2880);
 code('Texto fora do piloto',"return [{json:{status:'skipped',error_code:$json.reason||'unsupported_text',duration_ms:0}}];",1920,240);
 code('Falha de leitura sem repetir',"return [{json:{status:'failed',error_code:'original_read_or_text_failed',duration_ms:0}}];",1440,400);
 http('Registrar somente observação','jev_observe_result',"{observation_id:$('Observação reservada').item.json.id,lease_token:$('Observação reservada').item.json.lease_token,outcome:$json}",3120);
 link('Executar manualmente',['Configuração']);link('A cada 5 minutos',['Configuração']);link('Configuração',['Reservar observação ociosa']);link('Reservar observação ociosa',['Observação disponível']);link('Observação disponível',['Observação reservada'],[]);
 link('Observação reservada',['Ler original preservado']);link('Ler original preservado',['Conferir original'],['Falha de leitura sem repetir']);link('Conferir original',['Extrair texto limitado'],['Falha de leitura sem repetir']);link('Extrair texto limitado',['Preparar pergunta em sombra'],['Falha de leitura sem repetir']);link('Preparar pergunta em sombra',['Pergunta necessária']);link('Pergunta necessária',['Marcar início e ceder ao principal'],['Texto fora do piloto']);link('Marcar início e ceder ao principal',['Observação autorizada']);link('Observação autorizada',['Pedido autorizado'],[]);link('Pedido autorizado',['OpenRouter - decisão JEV']);link('OpenRouter - decisão JEV',['Normalizar observação']);link('Normalizar observação',['Registrar somente observação']);link('Texto fora do piloto',['Registrar somente observação']);link('Falha de leitura sem repetir',['Registrar somente observação']);
 return workflow;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const target=new URL('../../n8n/exames/OBSERVACAO-JEV.json',import.meta.url);
 await fs.writeFile(target,JSON.stringify(buildJevObserver(),null,2)+'\n');
 console.log('Prepared inactive observer template');
}
