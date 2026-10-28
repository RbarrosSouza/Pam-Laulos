import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildWorkflows,CONFIG} from './operacional-build.mjs';
import {buildWhatsappWorkflow,WHATSAPP_CONFIG} from './whatsapp-intake-build.mjs';
import {startChatwootSweep} from './whatsapp-intake-runtime.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const REFERENCE_REVISION='f0e6746c8ee19d9978005ffb070e794001c04715';
const UNUSED_EXTRACTION_FIELDS=['enableVision','fallbackExtractorUrl','fallbackExtractorModel'];
const clone=value=>JSON.parse(JSON.stringify(value));
const hash=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const same=(left,right)=>JSON.stringify(canonical(left))===JSON.stringify(canonical(right));
const fail=message=>{throw new Error(message);};
function configLiteral(source){
 const matches=[...source.matchAll(/\bconst cfg\s*=\s*(?=\{)/g)];
 if(matches.length!==1)fail('Configuration must contain exactly one literal JSON cfg object');
 const start=matches[0].index+matches[0][0].length;let depth=0,quoted=false,escaped=false;
 for(let index=start;index<source.length;index++){
  const character=source[index];
  if(quoted){if(escaped)escaped=false;else if(character==='\\')escaped=true;else if(character==='"')quoted=false;continue;}
  if(character==='"')quoted=true;else if(character==='{')depth++;else if(character==='}'&&--depth===0){
   const literal=source.slice(start,index+1);let config;try{config=JSON.parse(literal);}catch{fail('Configuration cfg must be JSON; JavaScript is never executed');}
   return {literal,start,end:index+1,config};
  }
 }
 fail('Configuration cfg JSON is incomplete');
}
function workflowObject(value){
 const workflow=Array.isArray(value)&&value.length===1?value[0]:value;
 if(!workflow||typeof workflow!=='object'||!Array.isArray(workflow.nodes)||!workflow.connections||!workflow.settings||!workflow.id||typeof workflow.name!=='string')fail('Supply a current export containing exactly one existing workflow');
 if(new Set(workflow.nodes.map(node=>node.name)).size!==workflow.nodes.length)fail('Duplicate workflow node names');
 return workflow;
}
function referenceTemplate(kind){
 try{return JSON.parse(execFileSync('git',['show',REFERENCE_REVISION+':n8n/exames/OPERACIONAL-0'+(kind==='gmail'?1:5)+'.json'],{cwd:ROOT,encoding:'utf8',maxBuffer:8*1024*1024}));}
 catch{fail('The pinned neutral reference commit is unavailable; restore it before preparing this update');}
}
function currentConfig(workflow,kind,clearManualSelection){
 const node=workflow.nodes.find(item=>item.name==='Configuração');
 if(!node?.parameters?.jsCode)fail('Configuration node is missing');
 const parsed=configLiteral(node.parameters.jsCode),schema=kind==='gmail'?CONFIG:WHATSAPP_CONFIG;
 const missing=Object.keys(schema).filter(key=>!Object.hasOwn(parsed.config,key)&&!UNUSED_EXTRACTION_FIELDS.includes(key));
 const unknown=Object.keys(parsed.config).filter(key=>!Object.hasOwn(schema,key));
 if(missing.length||unknown.length)fail('Configuration fields differ from the supported schema; missing: '+missing.join(',')+'; unknown: '+unknown.join(','));
 const selected=['manualMessageId','manualConversationId'].filter(key=>parsed.config[key]);
 if(selected.length&&!clearManualSelection)fail('Clear manual message/conversation selection in the existing workflow before exporting, or explicitly use --clear-manual-selection');
 for(const key of selected){
  if(typeof parsed.config[key]!=='string')fail('Manual selection fields must contain strings');
  parsed.literal=parsed.literal.replace(new RegExp('("'+key+'"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"'),'$1""');
 }
 parsed.config=JSON.parse(parsed.literal);parsed.clearedManualFields=selected;
 if(typeof parsed.config.intakeCutoff!=='string'||!Number.isFinite(Date.parse(parsed.config.intakeCutoff)))fail('An explicit valid intake cutoff is required');
 if(!parsed.config.driveFolderId||!parsed.config.serviceUrl||!parsed.config.worker)fail('Existing service, Drive and worker configuration is required');
 if(kind==='whatsapp'){
  if(!Array.isArray(parsed.config.authorizedSenders)||!parsed.config.authorizedSenders.length||!Array.isArray(parsed.config.allowedAttachmentOrigins))fail('Existing WhatsApp senders and attachment-origin configuration are required');
  startChatwootSweep(parsed.config);
  const webhook=workflow.nodes.find(item=>item.name==='Entrada WhatsApp da equipe');
  if(!webhook?.webhookId||webhook.parameters?.path!==parsed.config.webhookPath)fail('Existing webhook path/id must match cfg');
 }
 return parsed;
}
function credentialReferences(workflow,kind){
 const anchors={drive:['Drive - conferir pasta privada','oAuth2Api'],worker:['Reservar origem','httpHeaderAuth'],...(kind==='gmail'?{gmail:['Gmail - conferir conta OAuth','oAuth2Api']}:{chatwoot:['Chatwoot - conferir conversa de origem','chatwootApi']})};
 const references={};
 for(const [name,[nodeName,type]] of Object.entries(anchors)){
  const reference=workflow.nodes.find(node=>node.name===nodeName)?.credentials?.[type];
  if(!reference||Object.keys(reference).some(key=>!['id','name'].includes(key))||typeof reference.id!=='string'||!reference.id||typeof reference.name!=='string'||!reference.name||/^(SELECT_|CONFIGURE_)/.test(reference.id))fail('Existing credential id/name reference is missing or unsupported at '+nodeName);
  references[name]=clone(reference);
 }
 return references;
}
function normalizedParameters(parameters){
 const result=clone(parameters||{});
 if(typeof result.jsCode==='string'){
  const matches=[...result.jsCode.matchAll(/\bconst cfg\s*=\s*(?=\{)/g)];
  if(matches.length){const parsed=configLiteral(result.jsCode);result.jsCode=result.jsCode.slice(0,parsed.start)+'__CONFIGURATION__'+result.jsCode.slice(parsed.end);}
  result.jsCode=result.jsCode.replace(/const EXPECTED_MAILBOX="(?:[^"\\]|\\.)*"/g,'const EXPECTED_MAILBOX="__MAILBOX__"');
 }
 return result;
}
export async function prepareIntakeWorkflow(value,kind,{clearManualSelection=false}={}){
 if(!['gmail','whatsapp'].includes(kind))fail('Unknown intake workflow kind');
 if(typeof clearManualSelection!=='boolean')fail('clearManualSelection must be boolean');
 const baseline=workflowObject(value),parsed=currentConfig(baseline,kind,clearManualSelection),credentials=credentialReferences(baseline,kind);
 const reference=referenceTemplate(kind);
 const corrected=kind==='gmail'?(await buildWorkflows({config:parsed.config,credentials})).intake:await buildWhatsappWorkflow({config:parsed.config,credentials});
 const prepared=clone(baseline),changedNodes=[],changedConnections=[];
 const candidateFields=['parameters','onError','retryOnFail','maxTries','waitBetweenTries'];
 for(const updated of corrected.nodes){
  if(updated.name==='Entrada WhatsApp da equipe')continue;
  const previous=reference.nodes.find(node=>node.name===updated.name),existing=prepared.nodes.find(node=>node.name===updated.name);
  const fields=candidateFields.filter(field=>!same(field==='parameters'?normalizedParameters(previous?.[field]):previous?.[field],field==='parameters'?normalizedParameters(updated[field]):updated[field]));
  if(previous&&!fields.length)continue;
  if(!existing){
   if(previous)fail('Required existing node is missing: '+updated.name);
   if(prepared.nodes.some(node=>node.id===updated.id))fail('A new node ID collides with an existing node: '+updated.name);
   prepared.nodes.push(clone(updated));changedNodes.push({name:updated.name,change:'add',fields:['node'],after_sha256:hash(updated)});continue;
  }
  if(existing.type!==updated.type||existing.typeVersion!==updated.typeVersion)fail('Unsupported node type/version drift: '+updated.name);
  const before=clone(existing);
  for(const field of fields){
   const observed=field==='parameters'?normalizedParameters(existing[field]):existing[field];
   const old=field==='parameters'?normalizedParameters(previous?.[field]):previous?.[field];
   const next=field==='parameters'?normalizedParameters(updated[field]):updated[field];
   if(!same(observed,old)&&!same(observed,next))fail('Custom changes in a corrected node require review: '+updated.name+' ('+field+')');
   if(updated[field]===undefined)delete existing[field];else existing[field]=clone(updated[field]);
  }
  if(existing.name==='Configuração'){
   const outputLiteral=configLiteral(existing.parameters.jsCode);
   existing.parameters.jsCode=existing.parameters.jsCode.slice(0,outputLiteral.start)+parsed.literal+existing.parameters.jsCode.slice(outputLiteral.end);
  }
  if(!same(before,existing))changedNodes.push({name:updated.name,change:'update',fields,before_sha256:hash(before),after_sha256:hash(existing)});
 }
 for(const [from,connections] of Object.entries(corrected.connections)){
  const old=reference.connections[from];if(same(old,connections))continue;
  const observed=prepared.connections[from];
  if(observed!==undefined&&!same(observed,old)&&!same(observed,connections))fail('Custom connections require review at corrected node: '+from);
  if(!same(observed,connections)){prepared.connections[from]=clone(connections);changedConnections.push({from,before_sha256:observed?hash(observed):null,after_sha256:hash(connections)});}
 }
 const configuration=prepared.nodes.find(node=>node.name==='Configuração'),beforeConfiguration=clone(configuration),preparedLiteral=configLiteral(configuration.parameters.jsCode);
 configuration.parameters.jsCode=configuration.parameters.jsCode.slice(0,preparedLiteral.start)+parsed.literal+configuration.parameters.jsCode.slice(preparedLiteral.end);
 if(!same(configuration,beforeConfiguration)){
  const change=changedNodes.find(node=>node.name==='Configuração');
  if(change)change.after_sha256=hash(configuration);else changedNodes.push({name:'Configuração',change:'update',fields:['parameters'],before_sha256:hash(beforeConfiguration),after_sha256:hash(configuration)});
 }
 const names=new Set(prepared.nodes.map(node=>node.name));
 for(const [from,connections] of Object.entries(prepared.connections)){
  if(!names.has(from))fail('Connection source is missing: '+from);
  for(const branches of Object.values(connections))for(const branch of branches)for(const edge of branch)if(!names.has(edge.node))fail('Connection destination is missing: '+edge.node);
 }
 if(!same(configLiteral(prepared.nodes.find(node=>node.name==='Configuração').parameters.jsCode).config,parsed.config))fail('Prepared configuration does not exactly match the export');
 return {workflow:prepared,manifest:{kind,reference_revision:REFERENCE_REVISION,baseline_sha256:hash(baseline),prepared_sha256:hash(prepared),clearedManualSelectionFields:parsed.clearedManualFields,omittedUnusedConfigurationFields:UNUSED_EXTRACTION_FIELDS.filter(key=>!Object.hasOwn(parsed.config,key)),changedNodes,changedConnections,preservedExtraNodes:baseline.nodes.filter(node=>!corrected.nodes.some(item=>item.name===node.name)).map(node=>node.name)}};
}
async function resolvedLocation(target){
 let ancestor=path.resolve(target);const suffix=[];
 while(true){try{return path.join(await fs.realpath(ancestor),...suffix.reverse());}catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(ancestor);if(parent===ancestor)throw error;suffix.push(path.basename(ancestor));ancestor=parent;}}
}
async function requireExternal(target){
 const location=await resolvedLocation(target),relative=path.relative(await fs.realpath(ROOT),location);
 if(relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))fail('Exports and private output must remain outside the repository');
}
export async function writeIntakeReconciliation({gmailExport,whatsappExport,out,clearManualSelection=false}){
 if(!gmailExport||!whatsappExport||!out)fail('Use --gmail-export <file> --whatsapp-export <file> --out <private-directory>');
 for(const target of [gmailExport,whatsappExport,out])await requireExternal(target);
 const gmailRaw=await fs.readFile(gmailExport,'utf8'),whatsappRaw=await fs.readFile(whatsappExport,'utf8');
 const gmail=await prepareIntakeWorkflow(JSON.parse(gmailRaw),'gmail',{clearManualSelection}),whatsapp=await prepareIntakeWorkflow(JSON.parse(whatsappRaw),'whatsapp',{clearManualSelection});
 const manifest={preparedAt:new Date().toISOString(),publication:'not_applied',workflows:[{...gmail.manifest,export_sha256:hash(gmailRaw)},{...whatsapp.manifest,export_sha256:hash(whatsappRaw)}]};
 await fs.mkdir(out,{recursive:true,mode:0o700});
 const outputs=[['gmail.workflow.json',gmail.workflow],['whatsapp.workflow.json',whatsapp.workflow],['manifest.json',manifest]],written=[];
 for(const [name,value] of outputs){const target=path.join(out,name);await fs.writeFile(target,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});written.push(target);}
 return {files:written,publication:'not_applied',changedNodes:manifest.workflows.map(item=>({kind:item.kind,count:item.changedNodes.length}))};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const supplied=process.argv.slice(2),clearManualSelection=supplied.includes('--clear-manual-selection'),args=supplied.filter(value=>value!=='--clear-manual-selection'),flags=['--gmail-export','--whatsapp-export','--out'];
 if(supplied.filter(value=>value==='--clear-manual-selection').length>1)fail('Specify --clear-manual-selection at most once');
 if(args.length!==6||args.some((value,index)=>index%2===0&&!flags.includes(value))||new Set(args.filter((_,index)=>index%2===0)).size!==3)fail('Use --gmail-export <file> --whatsapp-export <file> --out <private-directory>');
 const values=Object.fromEntries(args.flatMap((value,index)=>index%2===0?[[value,args[index+1]]]:[]));
 console.log(JSON.stringify(await writeIntakeReconciliation({gmailExport:values['--gmail-export'],whatsappExport:values['--whatsapp-export'],out:values['--out'],clearManualSelection})));
}
