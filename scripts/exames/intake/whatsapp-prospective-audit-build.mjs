import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {buildN8nAuditWorkflow,exportConfiguration} from './n8n-discovery-audit-build.mjs';
import {normalizeBrazilPhone} from '../whatsapp-intake-runtime.mjs';
import {whatsappProspectiveConversation,whatsappProspectivePolicyMaterial} from './whatsapp-prospective-policy.mjs';
import {whatsappProspectiveCollectorId} from './whatsapp-prospective-child-build.mjs';

const upstream=await fs.readFile(new URL('./n8n-discovery-audit-runtime.mjs',import.meta.url),'utf8');
const runtime=await fs.readFile(new URL('./whatsapp-prospective-audit-runtime.mjs',import.meta.url),'utf8');
const upstreamBundle=upstream.replace(/^import crypto from 'node:crypto';\s*/,'const crypto=require("crypto");\n').replace(/^export /gm,'');
const whatsappBundle='const crypto=require("crypto");\n'+normalizeBrazilPhone.toString()+'\n'+whatsappProspectivePolicyMaterial.toString()+'\n'+whatsappProspectiveConversation.toString()+'\n'
  +runtime.replace(/^import crypto from 'node:crypto';\s*/,'').replace(/^import \{whatsappProspectiveConversation,whatsappProspectivePolicyMaterial\} from '\.\/whatsapp-prospective-policy\.mjs';\s*/,'').replace(/^export /gm,'');
const clone=v=>JSON.parse(JSON.stringify(v));

// Produces only an inactive private candidate. Child ID must identify the
// separately reviewed WhatsApp child; no webhook or provider writes are added.
export function buildWhatsappProspectiveAudit(source,dataTableId,cutoff,childId,{canaryConversationId=null,canaryMessageId=null,manualOnly=false}={}) {
  if(typeof cutoff!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cutoff)
    ||!Number.isFinite(Date.parse(cutoff))||new Date(cutoff).toISOString()!==cutoff)throw new Error('Canonical activation cutoff required');
  if(typeof childId!=='string'||!/^[A-Za-z0-9_-]{8,80}$/.test(childId))throw new Error('Reviewed child workflow ID required');
  const canary=canaryConversationId!==null||canaryMessageId!==null;
  const numeric=x=>typeof x==='string'&&/^[1-9][0-9]*$/.test(x)&&Number.isSafeInteger(Number(x))&&Number(x)<Number.MAX_SAFE_INTEGER;
  if(canary&&(!numeric(canaryConversationId)||!numeric(canaryMessageId)))throw new Error('Canary requires exact conversation and message');
  const previous=exportConfiguration(source);
  if(!Array.isArray(previous.authorizedSenders)||!previous.authorizedSenders.length||typeof previous.allowBrazilLegacyMobileAlias!=='boolean')throw new Error('Verified WhatsApp authorization policy required');
  const workflow=buildN8nAuditWorkflow('chatwoot',source,dataTableId,{resumeFence:true});
  const node=name=>{const n=workflow.nodes.find(x=>x.name===name);if(!n)throw new Error('Missing audit node: '+name);return n;};
  for(const n of workflow.nodes.filter(x=>x.type==='n8n-nodes-base.code')){
    const code=n.parameters.jsCode;if(code.startsWith(upstreamBundle))n.parameters.jsCode=whatsappBundle+code.slice(upstreamBundle.length);
    else if(['Configuração de auditoria','Retomar estado auditável','Dirigir próxima operação','Aplicar resposta sem perder cursor'].includes(n.name))throw new Error('Audit runtime changed during build; retry review');
  }
  const cfgNode=node('Configuração de auditoria'),code=cfgNode.parameters.jsCode,at=code.lastIndexOf('const cfg='),end=code.indexOf(';validateAuditConfig',at);
  if(at<0||end<at)throw new Error('Audit configuration template changed');
  const old=JSON.parse(code.slice(at+'const cfg='.length,end));
  const cfg={...old,enabled:true,allowScheduled:!canary&&!manualOnly,provider:'chatwoot',intakeCutoff:cutoff,
    collectorId:whatsappProspectiveCollectorId(cutoff,canaryConversationId,canaryMessageId),
    continuous:true,prospective:true,bridgeEnabled:true,bridgeWorkflowId:childId,recheckPending:true,resumeFence:true,
    overlapSeconds:300,maxRepeatedFailures:3,notificationMode:'home_only',monitoring:false,
    authorizedSenders:clone(previous.authorizedSenders),allowBrazilLegacyMobileAlias:previous.allowBrazilLegacyMobileAlias,
    ...(canary?{canary:true,canaryConversationId,canaryMessageId}:{})};
  cfgNode.parameters.jsCode=code.slice(0,at)+'const cfg='+JSON.stringify(cfg,null,2)+code.slice(end);
  const schedule=workflow.nodes.find(n=>n.type.endsWith('.scheduleTrigger'));if(!schedule)throw new Error('Audit schedule missing');
  schedule.disabled=canary||manualOnly;
  // All state reads and CAS writes must address the same prospective collector.
  for(const n of workflow.nodes.filter(n=>n.type==='n8n-nodes-base.dataTable')){
    for(const condition of n.parameters?.filters?.conditions||[])
      if(condition.keyName==='collector_key') condition.keyValue=cfg.collectorId;
  }
  const condition=clone(node('Operação do ledger').parameters);condition.conditions.conditions[0].leftValue='={{ $json.target === "bridge" }}';
  const add=(name,type,version,parameters,position,extra={})=>workflow.nodes.push({id:crypto.randomUUID(),name,type:'n8n-nodes-base.'+type,typeVersion:version,parameters,position,...extra});
  add('Encaminhar mensagem autorizada','if',2.2,condition,[1940,160]);
  add('Processar WhatsApp prospectivo','executeWorkflow',1.2,{source:'database',workflowId:{__rl:true,value:childId,mode:'id'},mode:'once',options:{waitForSubWorkflow:true}},[2180,340],{onError:'continueRegularOutput',alwaysOutputData:true});
  add('Reconsultar origem após filho','code',2,{jsCode:whatsappBundle+"\nconst cfg=$('Configuração de auditoria').first().json;const context=$('Dirigir próxima operação').item.json;const issue=Array.isArray($json.issues)&&$json.issues.length===1?$json.issues[0]:null;let state;try{state=applyAuditResponse(context,{statusCode:200,body:{completed:!$json.error,issue}},cfg,Date.now());}catch(error){state=applyAuditFailure(context,error.message,Date.now());}return [{json:state}];"},[2420,340]);
  const connect=(from,branches)=>{workflow.connections[from]={main:branches.map(names=>names.map(name=>({node:name,type:'main',index:0})))};};
  connect('Operação do ledger',[['Ledger — evento durável'],['Encaminhar mensagem autorizada']]);
  connect('Encaminhar mensagem autorizada',[['Processar WhatsApp prospectivo'],['Provedor — somente leitura']]);
  connect('Processar WhatsApp prospectivo',[['Reconsultar origem após filho']]);
  connect('Reconsultar origem após filho',[['Preparar persistência privada']]);
  workflow.name='INTAKE AUDIT — WhatsApp prospectivo'+(canary?' CANÁRIO':'')+' (INATIVO)';workflow.active=false;
  return workflow;
}
