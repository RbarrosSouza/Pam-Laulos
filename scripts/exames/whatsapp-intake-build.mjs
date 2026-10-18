import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {buildWorkflows, CONFIG, CREDENTIALS} from './operacional-build.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const RUNTIME=await fs.readFile(new URL('./whatsapp-intake-runtime.mjs',import.meta.url),'utf8');
const bundle=()=>RUNTIME.replace(/^import crypto from 'node:crypto';\s*/,'const crypto=require("crypto");\n').replace(/^export /gm,'');
export const WHATSAPP_CONFIG=Object.freeze({...CONFIG, enabled:false, authorizedSenders:[], allowedAttachmentOrigins:[], allowBrazilLegacyMobileAlias:false,
 webhookPath:'CONFIGURE_PRIVATE_WHATSAPP_PATH',manualConversationId:'',manualMessageId:''});
const clone=value=>JSON.parse(JSON.stringify(value));
const inRoot=target=>{const r=path.relative(ROOT,path.resolve(target));return r===''||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));};
function validateSettings(settings){
 if(!settings||typeof settings!=='object'||Array.isArray(settings)||Object.keys(settings).some(k=>!['config','credentials'].includes(k)))throw new Error('Use {config,credentials} only');
 const config=settings.config||{},credentials=settings.credentials||{};
 if(Object.keys(config).some(k=>!Object.hasOwn(WHATSAPP_CONFIG,k)))throw new Error('Unknown WhatsApp configuration field');
 if(Object.keys(credentials).some(k=>!Object.hasOwn(CREDENTIALS,k)))throw new Error('Unknown credential reference');
 for(const ref of Object.values(credentials))if(!ref||Object.keys(ref).some(k=>!['id','name'].includes(k))||typeof ref.id!=='string'||!ref.id||typeof ref.name!=='string'||!ref.name||/[\x00-\x1f\x7f]/.test(ref.id+ref.name))throw new Error('Credential id/name references only; never secret values');
 if(config.authorizedSenders!==undefined&&(!Array.isArray(config.authorizedSenders)||config.authorizedSenders.some(n=>typeof n!=='string')))throw new Error('Invalid sender configuration');
 return {config,credentials};
}
export async function buildWhatsappWorkflow(settings={}){
 const {config:partial,credentials}=validateSettings(settings);
 const cfg={...clone(WHATSAPP_CONFIG),...clone(partial)};
 if(typeof cfg.enabled!=='boolean'||typeof cfg.webhookPath!=='string'||!/^[A-Za-z0-9_-]{12,160}$/.test(cfg.webhookPath))throw new Error('Invalid WhatsApp configuration');
 const inherited=Object.fromEntries(Object.entries(cfg).filter(([k])=>Object.hasOwn(CONFIG,k)));
 // Gmail selection is unrelated to this source. Only the shared Drive/backend nodes are inherited.
 inherited.manualMessageId='';
 const base=(await buildWorkflows({config:inherited,credentials})).intake;
 const keep=['Leia antes de configurar','Um anexo por vez','Reservar origem','Decidir recebimento','Precisa baixar','Validar bytes e SHA-256',
 'Original baixado e validado','Drive - gerar ID de arquivo','Reservar ID e upload Drive','Upload reservado','Adiar sweep quando upload pendente',
 'Drive - consultar ID reservado','Validar estado do objeto','Metadados ausentes','Drive - criar metadados com ID fixo','Restaurar contexto Drive',
 'Objeto já tem bytes','Drive - gravar bytes no ID fixo','Drive - conferir bytes salvos','Conferir integridade do original','Confirmar armazenamento',
 'Validar confirmação salva','Próximo anexo','Registrar falha de origem','Manter janela para recuperação','Drive - conferir pasta privada','Validar pasta privada'];
 const w={name:'OPERACIONAL 05 — WhatsApp pessoal para exames',active:false,nodes:base.nodes.filter(n=>keep.includes(n.name)),connections:{},settings:{...base.settings},pinData:{}};
 const refs={...clone(CREDENTIALS),...clone(credentials)};
 const node=name=>{const n=w.nodes.find(x=>x.name===name);if(!n)throw new Error('Missing shared node: '+name);return n;};
 const connect=(from,outputs)=>w.connections[from]={main:outputs.map(names=>names.map(n=>({node:n,type:'main',index:0})))};
 const add=(name,type,version,x,y,parameters,extra={})=>{
  const id=crypto.createHash('sha256').update('pamvet-whatsapp-v1:'+name).digest('hex');
  const n={id:id.slice(0,8)+'-'+id.slice(8,12)+'-5'+id.slice(13,16)+'-a'+id.slice(17,20)+'-'+id.slice(20,32),name,type:'n8n-nodes-base.'+type,typeVersion:version,position:[x,y],parameters,...extra};w.nodes.push(n);return n;
 };
 const condition=expression=>{const p=clone(node('Precisa baixar').parameters);p.conditions.conditions[0].leftValue=expression;return p;};
 const api=(url)=>({method:'GET',url,authentication:'predefinedCredentialType',nodeCredentialType:'chatwootApi',options:{timeout:30000,redirect:{redirect:{followRedirects:false}},response:{response:{responseFormat:'json'}}}});
 const note=node('Leia antes de configurar');
 note.parameters.content='WHATSAPP DA EQUIPE → MESMA FILA DE EXAMES. Somente mensagem individual recebida dos números explicitamente autorizados. O webhook é apenas um aviso: conversa/mensagem/remetente/anexos são relidos pela API autenticada do Chatwoot antes de reservar ou baixar. Origem reservada antes dos bytes; dedupe por arquivo no backend. Mesmo fluxo Drive → identificação → grupo → Nexus. Não habilitar até conferir caixa, número, pasta e teste. Nenhuma chave em Code. Logs de dados desabilitados.';
 const webhook=add('Entrada WhatsApp da equipe','webhook',2.1,-1320,0,{httpMethod:'POST',path:cfg.webhookPath,responseMode:'onReceived',options:{}},{webhookId:crypto.createHash('sha256').update(cfg.webhookPath).digest('hex').slice(0,32)});
 add('Testar mensagem selecionada','manualTrigger',1,-1320,260,{});
 const configCode=bundle()+`\nconst cfg=${JSON.stringify(cfg,null,2)};\nif(!cfg.enabled)throw new Error('EXAMES_WHATSAPP_PAUSADO');\nif(!cfg.serviceUrl.startsWith('https://')||!cfg.serviceUrl.endsWith('/functions/v1/exam-document-service'))throw new Error('Serviço de exames inválido');\nlet payload=$input.first().json.body;\nif(!payload){\n if(!['test','manual'].includes($execution.mode)||!cfg.manualMessageId||!cfg.manualConversationId)throw new Error('Selecione uma mensagem real para o teste manual');\n payload={event:'message_created',id:cfg.manualMessageId,message_type:'incoming',private:false,account:{id:cfg.accountId},inbox:{id:cfg.inboxId},conversation:{id:cfg.manualConversationId,inbox_id:cfg.inboxId}};\n}\nconst inspected=inspectChatwootWebhook(payload,cfg);\nreturn [{json:{...cfg,...inspected,worker:cfg.worker+':whatsapp:'+$execution.id}}];\n`;
 add('Configuração','code',2,-1080,0,{jsCode:configCode});
 add('Evento para conferir','if',2.2,-840,0,condition('={{ !$json.excluded }}'));
 add('Chatwoot - conferir conversa de origem','httpRequest',4.2,-120,0,api("={{ $('Configuração').first().json.chatwootBaseUrl+'/api/v1/accounts/'+$('Configuração').first().json.accountId+'/conversations/'+$('Configuração').first().json.request.conversationId }}"),{credentials:{chatwootApi:refs.chatwoot},retryOnFail:true,maxTries:3,waitBetweenTries:1000});
 add('Chatwoot - reler mensagem de origem','httpRequest',4.2,120,0,api("={{ $('Configuração').first().json.chatwootBaseUrl+'/api/v1/accounts/'+$('Configuração').first().json.accountId+'/conversations/'+$('Configuração').first().json.request.conversationId+'/messages?before='+$('Configuração').first().json.request.beforeMessageId }}"),{credentials:{chatwootApi:refs.chatwoot},retryOnFail:true,maxTries:3,waitBetweenTries:1000});
 add('Conferir remetente e todos os PDFs','code',2,360,0,{jsCode:bundle()+"\nconst cfg=$('Configuração').first().json;const canonical=canonicalChatwootEvent(cfg.request,$('Chatwoot - conferir conversa de origem').first().json,$json,cfg);const result=inspectChatwootMessage(canonical,cfg);return result.excluded?[{json:{messageExcluded:true,reason:result.reason}}]:result.origins.map(json=>({json:{...json,resetAttachments:true}}));"});
 add('PDF autorizado disponível','if',2.2,600,0,condition('={{ !$json.messageExcluded }}'));
 // Each hop is checked before following a provider storage redirect. No credential is sent to media URLs.
 add('Chatwoot - baixar PDF reservado','code',2,1560,0,{jsCode:bundle()+`\nconst origin=$json,cfg=$('Configuração').first().json;\nconst verifiedConfig=configValues(cfg);\n// The same origin/receipt/URL binding checked after download must hold before the first GET.\nif(!object(origin)||typeof origin.documentId!=='string'||!UUID.test(origin.documentId)||origin.skip||origin.missing\n ||origin.reservation?.document_id!==origin.documentId||(origin.reservation.document&&origin.reservation.document.id!==origin.documentId)\n ||origin.source?.channel!=='whatsapp'||origin.source?.metadata?.provider!=='chatwoot'\n ||origin.source.account_id!=='chatwoot:'+verifiedConfig.accountId+':inbox:'+verifiedConfig.inboxId\n ||origin.source.message_id!==origin.source.metadata.chatwoot_message_id\n ||!object(origin.attachment)||origin.source.attachment_id!==origin.attachment.id\n ||origin.attachment.id!=='chatwoot-attachment:'+origin.source.metadata.chatwoot_attachment_id)throw new Error('whatsapp_original_not_reserved');\nlet url=attachmentUrl(origin.attachment.downloadUrl,verifiedConfig.origins);\nif(!url||origin.source.metadata.attachment_url_sha256!==crypto.createHash('sha256').update(url).digest('hex'))throw new Error('whatsapp_original_url_mismatch');\nconst allowed=verifiedConfig.origins;const visited=new Set();let response,bytes;\nfor(let hop=0;hop<4;hop++){\n if(!attachmentUrl(url,allowed)||visited.has(url))throw new Error('whatsapp_media_redirect_not_allowed');visited.add(url);\n response=await this.helpers.httpRequest({method:'GET',url,returnFullResponse:true,encoding:'arraybuffer',disableFollowRedirect:true,ignoreHttpStatusErrors:true,timeout:30000});\n if(response.statusCode===200){bytes=Buffer.from(response.body);break;}\n if(![301,302,303,307,308].includes(response.statusCode))throw new Error('whatsapp_media_download_failed');\n const location=response.headers?.location||response.headers?.Location;if(typeof location!=='string')throw new Error('whatsapp_media_redirect_missing');\n url=resolveChatwootRedirect(location,url,allowed);\n}\nif(!bytes)throw new Error('whatsapp_media_redirect_limit');\nconst decoded=decodeChatwootOriginal(bytes,response,origin,cfg);\nreturn [{json:decoded.json,binary:{data:await this.helpers.prepareBinaryData(decoded.bytes,decoded.json.source.original_name,'application/pdf')}}];\n`},{onError:'continueErrorOutput',retryOnFail:false});
 // Existing downstream node names and expressions are retained to preserve the proven Drive contract.
 node('Validar bytes e SHA-256').parameters.jsCode="const item=$input.first();if(!item.json.sha256||!item.binary?.data)throw new Error('whatsapp_bytes_unverified');return [item];";
 node('Decidir recebimento').parameters.jsCode=node('Decidir recebimento').parameters.jsCode.replaceAll('gmail_source_','whatsapp_source_');
 node('Registrar falha de origem').parameters.jsonBody=node('Registrar falha de origem').parameters.jsonBody.replace('Não foi possível preservar o original Gmail/Drive','Não foi possível preservar o original WhatsApp/Drive');
 node('Manter janela para recuperação').parameters.jsCode="return [{json:{pending:true,recovery:'forward_or_replay_same_source',document_id:$('Decidir recebimento').item.json.documentId}}];";
 add('Recebimento encerrado','code',2,840,-260,{jsCode:"return [{json:{accepted:true,processed:true}}];"});
 // Keep shared task branches, remove Gmail-only and scan-only exits.
 const keptNames=new Set(w.nodes.map(n=>n.name));
 for(const [name,c] of Object.entries(base.connections))if(keptNames.has(name)){
  const filtered={...c,main:c.main.map(branch=>branch.filter(edge=>keptNames.has(edge.node)))};
  w.connections[name]=filtered;
 }
 connect(webhook.name,[['Configuração']]);connect('Testar mensagem selecionada',[['Configuração']]);
 connect('Configuração',[['Evento para conferir']]);connect('Evento para conferir',[['Drive - conferir pasta privada'],['Recebimento encerrado']]);
 connect('Drive - conferir pasta privada',[['Validar pasta privada']]);connect('Validar pasta privada',[['Chatwoot - conferir conversa de origem']]);
 connect('Chatwoot - conferir conversa de origem',[['Chatwoot - reler mensagem de origem']]);connect('Chatwoot - reler mensagem de origem',[['Conferir remetente e todos os PDFs']]);
 connect('Conferir remetente e todos os PDFs',[['PDF autorizado disponível']]);connect('PDF autorizado disponível',[['Um anexo por vez'],['Recebimento encerrado']]);
 connect('Um anexo por vez',[['Recebimento encerrado'],['Reservar origem']]);
 connect('Precisa baixar',[['Chatwoot - baixar PDF reservado'],['Próximo anexo']]);
 connect('Chatwoot - baixar PDF reservado',[['Validar bytes e SHA-256'],['Registrar falha de origem']]);
 for(const n of w.nodes){
  if(n.name==='Drive - conferir pasta privada'){
   n.position=[-600,0];n.retryOnFail=true;n.maxTries=3;n.waitBetweenTries=1000;
   n.parameters.options.response.response.neverError=false;
  }else if(n.name==='Validar pasta privada')n.position=[-360,0];
  if(n.type==='n8n-nodes-base.httpRequest'&&n.parameters.url?.includes('serviceUrl'))n.retryOnFail=false;
 }
 return w;
}
export async function writeWhatsappWorkflow(out,settings={}){
 if(Object.keys(settings).length&&inRoot(out))throw new Error('Bound configuration/output must stay outside the public repository');
 const w=await buildWhatsappWorkflow(settings);await fs.mkdir(path.dirname(out),{recursive:true});const contents=JSON.stringify(w,null,2)+'\n';
 await fs.writeFile(out,contents,{mode:0o600});if(Object.keys(settings).length)await fs.chmod(out,0o600);
 return {path:out,nodes:w.nodes.length,sha256:crypto.createHash('sha256').update(contents).digest('hex')};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);const get=k=>{const i=args.indexOf(k);return i<0?null:args[i+1];};
 const configPath=get('--config'),out=get('--out')||path.join(ROOT,'n8n/exames/OPERACIONAL-05.json');
 if(configPath&&inRoot(configPath))throw new Error('Private config must stay outside the public repository');
 const settings=configPath?JSON.parse(await fs.readFile(configPath,'utf8')):{};
 console.log(JSON.stringify(await writeWhatsappWorkflow(out,settings)));
}
