import crypto from 'node:crypto';

// Constructs an inactive single-message child from a current private OP05 export.
// Never writes an export, contacts a provider or activates a workflow.
export function whatsappProspectiveCollectorId(cutoff,canaryConversationId=null,canaryMessageId=null) {
  const canary=canaryConversationId!==null||canaryMessageId!==null;
  const numeric=x=>typeof x==='string'&&/^[1-9][0-9]*$/.test(x)&&Number.isSafeInteger(Number(x))&&Number(x)<Number.MAX_SAFE_INTEGER;
  if(canary&&(!numeric(canaryConversationId)||!numeric(canaryMessageId)))throw new Error('Canary requires exact conversation and message');
  const material=canary?cutoff+':'+canaryConversationId+':'+canaryMessageId:cutoff;
  return (canary?'chatwoot_canary_':'chatwoot_prospective_')+crypto.createHash('sha256').update(material).digest('hex').slice(0,16);
}
export function buildProspectiveWhatsappChild(source, cutoff, collectorId,{canaryConversationId=null,canaryMessageId=null}={}) {
  if(typeof cutoff!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cutoff)
    ||!Number.isFinite(Date.parse(cutoff))||new Date(cutoff).toISOString()!==cutoff) throw new Error('Canonical activation cutoff required');
  const canary=canaryConversationId!==null||canaryMessageId!==null;
  const expected=whatsappProspectiveCollectorId(cutoff,canaryConversationId,canaryMessageId);
  if(collectorId!==expected)throw new Error('Collector and cutoff must match');
  if(!source||!Array.isArray(source.nodes)||!source.connections)throw new Error('Current OP05 export required');
  const nodes=structuredClone(source.nodes),connections=structuredClone(source.connections);
  const node=name=>{const n=nodes.find(x=>x.name===name);if(!n)throw new Error('Missing current OP05 node: '+name);return n;};
  const canonical=node('Conferir remetente e todos os PDFs').parameters?.jsCode||'';
  if(!canonical.includes('canonicalChatwootEvent(')||!canonical.includes('inspectChatwootMessage(')
    ||!canonical.includes('whatsapp_canonical_group_or_broadcast')||!canonical.includes('sender_not_authorized'))throw new Error('Current canonical reread and sender guards required');
  for(const name of ['Chatwoot - conferir conversa de origem','Chatwoot - reler mensagem de origem'])
    if(!node(name).credentials?.chatwootApi)throw new Error('Authenticated Chatwoot reread required');
  const original=node('Configuração').parameters?.jsCode||'',mark='const cfg=',at=original.lastIndexOf(mark),end=original.indexOf(';\nif(',at);
  if(at<0||end<at||!original.includes('function configValues(')||!original.includes('function safeProviderId('))throw new Error('Current OP05 configuration contract changed');
  let cfg;try{cfg=JSON.parse(original.slice(at+mark.length,end));}catch{throw new Error('Current OP05 configuration is invalid');}
  if(!cfg||!Array.isArray(cfg.authorizedSenders)||!cfg.authorizedSenders.length||!cfg.accountId||!cfg.inboxId)throw new Error('Current WhatsApp authorization configuration required');
  const childCfg={...cfg,enabled:true,intakeCutoff:cutoff,manualConversationId:'',manualMessageId:''};
  delete childCfg.webhookPath;
  const code=`${original.slice(0,at)}const cfg=${JSON.stringify(childCfg,null,2)};
const input=$input.all();if(input.length!==1||!object(input[0]?.json?.payload))throw new Error('BRIDGE_INPUT_REQUIRED');
const bridge=input[0].json.payload, allowed=['collector_id','account_id','cutoff','conversation_id','message_id','attachment_ids'];
if(Object.keys(bridge).some(key=>!allowed.includes(key))||bridge.collector_id!==${JSON.stringify(collectorId)}||bridge.cutoff!==${JSON.stringify(cutoff)}
 ||typeof bridge.conversation_id!=='string'||typeof bridge.message_id!=='string'||!/^[0-9]+$/.test(bridge.conversation_id)||!/^[0-9]+$/.test(bridge.message_id)
 ||!Array.isArray(bridge.attachment_ids)||!bridge.attachment_ids.length||bridge.attachment_ids.length>200||new Set(bridge.attachment_ids).size!==bridge.attachment_ids.length
 ||bridge.attachment_ids.some(x=>typeof x!=='string'||!/^chatwoot-attachment:[1-9]\\d*$/.test(x))
 ${canary?`||bridge.conversation_id!==${JSON.stringify(canaryConversationId)}||bridge.message_id!==${JSON.stringify(canaryMessageId)}`:''})throw new Error('BRIDGE_INPUT_IDENTITY_INVALID');
const verified=configValues(cfg),conversationId=safeProviderId(bridge.conversation_id,'BRIDGE_CONVERSATION_INVALID'),messageId=safeProviderId(bridge.message_id,'BRIDGE_MESSAGE_INVALID');
if(bridge.account_id!=='chatwoot:'+verified.accountId+':inbox:'+verified.inboxId)throw new Error('BRIDGE_INPUT_ACCOUNT_INVALID');
if(!cfg.serviceUrl.startsWith('https://')||!cfg.serviceUrl.endsWith('/functions/v1/exam-document-service'))throw new Error('BRIDGE_SERVICE_INVALID');
const request={accountId:verified.accountId,inboxId:verified.inboxId,conversationId,messageId,beforeMessageId:String(Number(messageId)+1),attachmentIds:bridge.attachment_ids};
return [{json:{...cfg,excluded:false,polling:false,request,worker:cfg.worker+':prospective:'+$execution.id}}];`;
  node('Configuração').parameters.jsCode=code;
  // A generic/missing MIME can still be a PDF; bytes are verified before storage.
  const inspect=node('Conferir remetente e todos os PDFs');
  const generic="  if (typeof mime === 'string' && mime.split(';')[0].trim().toLowerCase() === 'application/pdf') return true;";
  if(!inspect.parameters.jsCode.includes(generic))throw new Error('PDF candidate contract changed');
  inspect.parameters.jsCode=inspect.parameters.jsCode.replace(generic,generic+"\n  if (mime == null || typeof mime === 'string' && mime.split(';')[0].trim().toLowerCase() === 'application/octet-stream') return true;");
  const marker='const result=inspectChatwootMessage(canonical,cfg);';
  if(!inspect.parameters.jsCode.includes(marker))throw new Error('Canonical inspection contract changed');
  inspect.parameters.jsCode=inspect.parameters.jsCode.replace(marker,"const selected=new Set(cfg.request.attachmentIds);canonical.attachments=canonical.attachments.filter(a=>object(a)&&selected.has('chatwoot-attachment:'+String(a.id)));if(canonical.attachments.length!==selected.size)throw new Error('whatsapp_selected_attachment_missing');"+marker);
  connections['Configuração']={main:[[{node:'Drive - conferir pasta privada',type:'main',index:0}]]};
  connections['Validar pasta privada']={main:[[{node:'Chatwoot - conferir conversa de origem',type:'main',index:0}]]};
  // Retain only reachable processing nodes; remove webhook, manual/schedule,
  // global reconciliation and whole-inbox sweep so no other source can run.
  const reachable=new Set(), queue=['Configuração'];
  while(queue.length){const current=queue.shift();if(reachable.has(current))continue;reachable.add(current);
    for(const branch of connections[current]?.main||[])for(const edge of branch||[])queue.push(edge.node);}
  const forbidden=nodes.filter(n=>/\.(?:webhook|manualTrigger|scheduleTrigger)$/.test(n.type)).map(n=>n.name);
  if(forbidden.some(name=>reachable.has(name))||reachable.has('Conferência agendada')||reachable.has('Chatwoot - listar conversas da caixa'))throw new Error('Child must not retain an independent sweep');
  const filtered=nodes.filter(n=>reachable.has(n.name));
  for(const name of Object.keys(connections))if(!reachable.has(name))delete connections[name];
  for(const [name,c] of Object.entries(connections))for(const branch of c.main||[])for(const edge of branch||[])if(!reachable.has(edge.node))throw new Error('Child graph is incomplete: '+name);
  const trigger={id:crypto.randomUUID(),name:'Receber mensagem prospectiva WhatsApp',type:'n8n-nodes-base.executeWorkflowTrigger',typeVersion:1.1,
    position:[-1500,0],parameters:{inputSource:'passthrough'}};filtered.push(trigger);
  connections[trigger.name]={main:[[{node:'Configuração',type:'main',index:0}]]};
  return {name:'WHATSAPP — processar uma mensagem prospectiva (INATIVO)',active:false,nodes:filtered,connections,
    settings:{...structuredClone(source.settings||{}),saveDataSuccessExecution:'none',saveDataErrorExecution:'none',saveManualExecutions:false,saveExecutionProgress:false},pinData:{}};
}
