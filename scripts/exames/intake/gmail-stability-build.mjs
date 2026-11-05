import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {buildN8nAuditWorkflow,exportConfiguration} from './n8n-discovery-audit-build.mjs';
const ROOT=fileURLToPath(new URL('../../../',import.meta.url));
const canonical=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const digest=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const clone=value=>structuredClone(value);
const node=(w,name)=>{const n=w?.nodes?.find(n=>n.name===name);if(!n)throw new Error('gmail_stability_baseline_missing:'+name);return n;};

function configLiteral(code) {
 const at=code.lastIndexOf('const cfg=')+10;if(at<10||code[at]!=='{')throw new Error('gmail_stability_config_literal_required');
 let depth=0,quoted=false,escaped=false;
 for(let i=at;i<code.length;i++){
  const c=code[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
  if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0)return JSON.parse(code.slice(at,i+1));
 }
 throw new Error('gmail_stability_config_literal_invalid');
}

export function gmailStabilityLanes(primarySource,handoff) {
 if(!canonical(handoff))throw new Error('gmail_stability_canonical_handoff_required');
 const originalCutoff=exportConfiguration(primarySource).intakeCutoff;
 if(!canonical(originalCutoff)||Date.parse(handoff)<=Date.parse(originalCutoff)+300000)throw new Error('gmail_stability_history_interval_required');
 const freshCutoff=new Date(Date.parse(handoff)-300000).toISOString();
 return {
  history:{cutoff:originalCutoff,historicalThrough:handoff,collectorId:'gmail_history_'+digest([originalCutoff,handoff]).slice(0,16),scheduleMinutes:15},
  fresh:{cutoff:freshCutoff,collectorId:'gmail_prospective_'+digest(freshCutoff).slice(0,16),scheduleMinutes:5},
 };
}

// Rebind the latest published child, rather than rebuild an old OP01 template:
// that preserves reserved-Drive recovery, current source guards, stage errors and backoff.
export function buildGmailStabilityChild(primarySource,publishedChild,handoff,lane) {
 const spec=gmailStabilityLanes(primarySource,handoff)[lane];if(!spec)throw new Error('gmail_stability_lane_invalid');
 const baselineCfg=configLiteral(node(publishedChild,'Configuração').parameters.jsCode),primaryCfg=exportConfiguration(primarySource);
 if(baselineCfg.enabled!==true||primaryCfg.enabled!==true||baselineCfg.includeSpamTrash!==true||baselineCfg.mailbox!==primaryCfg.mailbox||baselineCfg.serviceUrl!==primaryCfg.serviceUrl||baselineCfg.driveFolderId!==primaryCfg.driveFolderId)throw new Error('gmail_stability_child_source_mismatch');
 if(publishedChild.nodes.some(n=>/\.(scheduleTrigger|manualTrigger|webhook)$/.test(n.type))||publishedChild.nodes.filter(n=>n.type.endsWith('.executeWorkflowTrigger')).length!==1)throw new Error('gmail_stability_child_not_subworkflow_only');
 node(publishedChild,'Original reservado recuperável');
 if(!node(publishedChild,'Decidir recebimento').parameters.jsCode.includes('intake_retry')||!node(publishedChild,'Registrar falha de origem').parameters.jsonBody.includes('Gmail/Drive ['))throw new Error('gmail_stability_current_recovery_required');
 const original=node(publishedChild,'Configuração').parameters.jsCode;
 const oldCollector='gmail_prospective_'+digest(baselineCfg.intakeCutoff).slice(0,16);
 const oldGuard='request.collector_id!=='+JSON.stringify(oldCollector),cutoffGuard='request.cutoff!=='+JSON.stringify(baselineCfg.intakeCutoff);
 if(original.split(oldGuard).length!==2||original.split(cutoffGuard).length!==2||!original.includes('cfg.manualMessageId=request.message_id;cfg.bridgeTargets=request.targets'))throw new Error('gmail_stability_child_identity_guard_drift');
 const configCode=original.replace(oldGuard,'request.collector_id!=='+JSON.stringify(spec.collectorId)).replace(cutoffGuard,'request.cutoff!=='+JSON.stringify(spec.cutoff));
 const oldLiteral='"intakeCutoff": '+JSON.stringify(baselineCfg.intakeCutoff);
 if(configCode.split(oldLiteral).length!==2)throw new Error('gmail_stability_child_cutoff_literal_drift');
 const nodes=clone(publishedChild.nodes);node({nodes},'Configuração').parameters.jsCode=configCode.replace(oldLiteral,'"intakeCutoff": '+JSON.stringify(spec.cutoff));
 return {name:lane==='fresh'?'OP01 — Gmail atual — preservar uma mensagem':'OP01 — Reconciliação histórica — preservar uma mensagem',active:false,
  nodes,connections:clone(publishedChild.connections),pinData:{},settings:{...clone(publishedChild.settings||{}),executionTimeout:180,
    saveDataSuccessExecution:'none',saveDataErrorExecution:'none',saveManualExecutions:false,saveExecutionProgress:false}};
}

export function readGmailCollectorConfig(publishedCollector) {
 return configLiteral(node(publishedCollector,'Configuração de auditoria').parameters.jsCode);
}

export function buildGmailStabilityParent(primarySource,publishedCollector,dataTableId,handoff,lane,childWorkflowId) {
 const spec=gmailStabilityLanes(primarySource,handoff)[lane];if(!spec)throw new Error('gmail_stability_lane_invalid');
 const previous=readGmailCollectorConfig(publishedCollector),primary=exportConfiguration(primarySource);
 if(previous.provider!=='gmail'||previous.dataTableId!==dataTableId||previous.mailbox!==primary.mailbox||previous.serviceUrl!==primary.serviceUrl)throw new Error('gmail_stability_collector_source_mismatch');
 if(!/^[A-Za-z0-9_-]{8,80}$/.test(childWorkflowId||''))throw new Error('gmail_stability_created_child_id_required');
 const workflow=buildN8nAuditWorkflow('gmail',primarySource,dataTableId,{scheduledCandidate:true,resumeFence:true,
  prospectiveCutoff:spec.cutoff,bridgeWorkflowId:childWorkflowId,captureAttachmentDetails:true,historicalThrough:spec.historicalThrough??null,
  executionTimeoutSeconds:300,recheckAfterEnumeration:true,recheckPageSize:1,stabilityBudget:true,scheduleMinutes:spec.scheduleMinutes});
 for(const [name,type,old]of [['Conferir conta autorizada','oAuth2Api','Conferir conta autorizada'],['Ledger — evento durável','httpHeaderAuth','Ledger — evento durável']]){
  if(JSON.stringify(node(workflow,name).credentials?.[type])!==JSON.stringify(node(publishedCollector,old).credentials?.[type]))throw new Error('gmail_stability_collector_credential_drift');
 }
 workflow.name=lane==='fresh'?'OP01 — Gmail atual — coleta limitada a cada 5 minutos':'OP01 — Reconciliação histórica — blocos a cada 15 minutos';
 workflow.settings={...clone(publishedCollector.settings||{}),...workflow.settings,executionTimeout:300};
 return workflow;
}

export async function writeGmailStabilityCandidates({primarySource,publishedChild,publishedCollector,dataTableId,handoff,childWorkflowIds={},out}) {
 if(!out)throw new Error('gmail_stability_private_output_required');
 let resolved=path.resolve(out),ancestor=resolved;const suffix=[];
 while(true){try{resolved=path.join(await fs.realpath(ancestor),...suffix.reverse());break;}catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(ancestor);if(parent===ancestor)throw error;suffix.push(path.basename(ancestor));ancestor=parent;}}
 const relative=path.relative(await fs.realpath(ROOT),resolved);
 if(relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))throw new Error('gmail_stability_output_must_be_outside_repository');
 const lanes=gmailStabilityLanes(primarySource,handoff);await fs.mkdir(resolved,{recursive:true,mode:0o700});
 const artifacts=[];
 for(const lane of ['history','fresh']){
  const child=buildGmailStabilityChild(primarySource,publishedChild,handoff,lane);
  const candidates=[['child',child]];
  if(childWorkflowIds[lane])candidates.push(['parent',buildGmailStabilityParent(primarySource,publishedCollector,dataTableId,handoff,lane,childWorkflowIds[lane])]);
  for(const [kind,workflow] of candidates){const filename=path.join(resolved,'gmail-'+lane+'-'+kind+'.private.json'),text=JSON.stringify(workflow,null,2)+'\n';await fs.writeFile(filename,text,{mode:0o600});await fs.chmod(filename,0o600);artifacts.push({lane,kind,path:filename,sha256:digest(text),nodes:workflow.nodes.length,active:false});}
 }
 const manifest={version:1,handoff,lanes,artifacts,publication:'not_applied',bootstrap:{requiredBeforeActivation:true,rows:Object.values(lanes).map(spec=>({collector_key:spec.collectorId,revision:0,state_json:'null'})),proof:'Read back exactly one row per new collector before enabling schedules; native revision CAS prevents initial overlap only after this bootstrap.'},oldWorkflows:'Preserve states and receipts; pause only old OP01 and old Gmail collector schedules after new parents are published and read back.',
  pending:childWorkflowIds.history&&childWorkflowIds.fresh?'Review candidate exports before publication.':'Create/read back the two inactive children, then rerun with their actual workflow IDs to build parents.'};
 await fs.writeFile(path.join(resolved,'gmail-stability-manifest.private.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
 return manifest;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),get=name=>{const at=args.indexOf(name);return at<0?undefined:args[at+1];};
 const [primarySource,publishedChild,publishedCollector]=await Promise.all(['--primary-export','--child-export','--collector-export'].map(async name=>{const filename=get(name);if(!filename)throw new Error('gmail_stability_missing_argument:'+name);return JSON.parse(await fs.readFile(filename,'utf8'));}));
 const result=await writeGmailStabilityCandidates({primarySource,publishedChild,publishedCollector,dataTableId:get('--data-table-id'),handoff:get('--handoff'),
  childWorkflowIds:{history:get('--history-child-id'),fresh:get('--fresh-child-id')},out:get('--out')});
 console.log(JSON.stringify(result,null,2));
}
