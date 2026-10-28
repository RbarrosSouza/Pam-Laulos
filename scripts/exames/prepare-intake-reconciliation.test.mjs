import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {buildWorkflows,CONFIG} from './operacional-build.mjs';
import {buildWhatsappWorkflow,WHATSAPP_CONFIG} from './whatsapp-intake-build.mjs';
import {prepareIntakeWorkflow,writeIntakeReconciliation} from './prepare-intake-reconciliation.mjs';

const credentials=Object.fromEntries(['gmail','drive','worker','chatwoot'].map(name=>[name,{id:'SYNTHETIC_'+name,name:'Synthetic existing '+name}]));
const config={...CONFIG,enabled:true,mailbox:'synthetic@example.invalid',driveFolderId:'synthetic-private-folder',serviceUrl:'https://synthetic.example.invalid/functions/v1/exam-document-service',intakeCutoff:'2026-10-01T00:00:00Z',accountId:41,inboxId:73};
async function fixtures(){
 const gmail=(await buildWorkflows({config,credentials})).intake;
 const whatsapp=await buildWhatsappWorkflow({config:{...WHATSAPP_CONFIG,...config,authorizedSenders:['+5511987654321'],allowedAttachmentOrigins:['https://files.example.invalid'],webhookPath:'synthetic_existing_webhook'},credentials});
 for(const [kind,workflow] of [['gmail',gmail],['whatsapp',whatsapp]]){
  Object.assign(workflow,{id:'synthetic-'+kind,name:'Existing synthetic '+kind,active:true,versionId:'synthetic-version',meta:{instanceId:'synthetic-instance'},settings:{...workflow.settings,timezone:'America/Sao_Paulo',executionTimeout:1200}});
  workflow.nodes.forEach((node,index)=>{node.id='existing-'+kind+'-'+index;node.position=[index*10,700];});
  workflow.nodes.push({id:'synthetic-extra',name:'Preserved customization',type:'n8n-nodes-base.code',typeVersion:2,position:[20,50],parameters:{jsCode:'return $input.all();'},notes:'Existing production customization'});
  workflow.connections['Preserved customization']={main:[[{node:'Configuração',type:'main',index:0}]]};
 }
 const webhook=whatsapp.nodes.find(node=>node.name==='Entrada WhatsApp da equipe');webhook.webhookId='existing-webhook-identity';webhook.parameters.options={responseHeaders:{entries:[{name:'X-Synthetic',value:'preserve'}]}};
 return {gmail,whatsapp};
}
const replaceConfig=(workflow,mutate)=>{
 const node=workflow.nodes.find(item=>item.name==='Configuração'),source=node.parameters.jsCode;
 const start=source.lastIndexOf('const cfg=')+'const cfg='.length,end=source.indexOf(';\nif(',start),config=JSON.parse(source.slice(start,end));
 mutate(config);node.parameters.jsCode=source.slice(0,start)+JSON.stringify(config,null,2)+source.slice(end);
};

test('preparation preserves current metadata, credentials, webhook identity, settings and unrelated nodes',async()=>{
 const inputs=await fixtures();
 for(const kind of ['gmail','whatsapp']){
  const baseline=inputs[kind],prepared=await prepareIntakeWorkflow([baseline],kind);
  assert.deepEqual(prepared.workflow,baseline);assert.equal(prepared.manifest.changedNodes.length,0);assert.equal(prepared.manifest.changedConnections.length,0);assert.equal(prepared.manifest.preservedExtraNodes[0],'Preserved customization');
 }
});

test('legacy exports may omit only unused shared extraction options and retain their exact original cfg literal',async()=>{
 const inputs=await fixtures(),optional=['enableVision','fallbackExtractorUrl','fallbackExtractorModel'];
 for(const kind of ['gmail','whatsapp']){
  const baseline=inputs[kind];replaceConfig(baseline,config=>{for(const key of optional)delete config[key];});
  const before=baseline.nodes.find(node=>node.name==='Configuração').parameters.jsCode;
  const start=before.lastIndexOf('const cfg=')+'const cfg='.length,end=before.indexOf(';\nif(',start),literal=before.slice(start,end);
  const prepared=await prepareIntakeWorkflow(baseline,kind),configuration=prepared.workflow.nodes.find(node=>node.name==='Configuração').parameters.jsCode;
  assert(configuration.includes('const cfg='+literal));assert.deepEqual(prepared.workflow.settings,baseline.settings);
  assert.deepEqual(prepared.manifest.omittedUnusedConfigurationFields,optional);
  for(const node of baseline.nodes)assert.deepEqual(prepared.workflow.nodes.find(item=>item.name===node.name).credentials,node.credentials);
 }
});

test('explicit manual-selection cleanup changes only the two selected fields and records their names',async()=>{
 const inputs=await fixtures();
 for(const kind of ['gmail','whatsapp']){
  const baseline=inputs[kind];replaceConfig(baseline,config=>{config.manualMessageId='synthetic-selected';if(kind==='whatsapp')config.manualConversationId='synthetic-conversation';});
  baseline.settings.executionTimeout=900;
  const before=baseline.nodes.find(node=>node.name==='Configuração').parameters.jsCode;
  await assert.rejects(prepareIntakeWorkflow(baseline,kind),/Clear manual/);
  const prepared=await prepareIntakeWorkflow(baseline,kind,{clearManualSelection:true}),after=prepared.workflow.nodes.find(node=>node.name==='Configuração').parameters.jsCode;
  assert.equal(after,before.replace('"manualMessageId": "synthetic-selected"','"manualMessageId": ""').replace('"manualConversationId": "synthetic-conversation"','"manualConversationId": ""'));
  assert.deepEqual(prepared.manifest.clearedManualSelectionFields,kind==='whatsapp'?['manualMessageId','manualConversationId']:['manualMessageId']);
  assert.deepEqual(prepared.workflow.settings,baseline.settings);assert.equal(prepared.workflow.active,true);assert.equal(prepared.workflow.id,baseline.id);
 }
});

test('an empty additional attachment-origin list preserves the validated Chatwoot origin restriction',async()=>{
 const {whatsapp}=await fixtures();replaceConfig(whatsapp,config=>{config.allowedAttachmentOrigins=[];});
 const prepared=await prepareIntakeWorkflow(whatsapp,'whatsapp');assert.deepEqual(prepared.workflow,whatsapp);
 replaceConfig(whatsapp,config=>{config.chatwootBaseUrl='https://127.0.0.1';});
 await assert.rejects(prepareIntakeWorkflow(whatsapp,'whatsapp'),/whatsapp_base_url_config_invalid/);
});

test('an older error policy is patched while all existing node identities and custom metadata survive',async()=>{
 const {gmail}=await fixtures();const target=gmail.nodes.find(node=>node.name==='Reservar origem');
 delete target.onError;gmail.connections['Reservar origem'].main.length=1;
 target.notes='Preserve this note';target.disabled=false;
 const prepared=await prepareIntakeWorkflow(gmail,'gmail'),updated=prepared.workflow.nodes.find(node=>node.name===target.name);
 assert.equal(updated.onError,'continueErrorOutput');assert.equal(updated.id,target.id);assert.deepEqual(updated.position,target.position);assert.equal(updated.notes,target.notes);assert.equal(updated.disabled,false);assert.deepEqual(updated.credentials,target.credentials);
 assert.deepEqual(prepared.workflow.settings,gmail.settings);assert.equal(prepared.workflow.active,true);assert.equal(prepared.manifest.changedNodes.length,1);assert.equal(prepared.manifest.changedConnections.length,1);
 assert.equal(prepared.workflow.connections['Reservar origem'].main[1][0].node,'Marcar falha da reserva');
});

test('the pinned older WhatsApp export gains the scheduled path while preserving literal cfg and current credentials',async()=>{
 const {whatsapp:current}=await fixtures();
 const baseline=JSON.parse(execFileSync('git',['show','f0e6746c8ee19d9978005ffb070e794001c04715:n8n/exames/OPERACIONAL-05.json'],{cwd:new URL('../../',import.meta.url),encoding:'utf8',maxBuffer:8*1024*1024}));
 Object.assign(baseline,{id:'existing-whatsapp',name:current.name,active:true,settings:current.settings,meta:current.meta});
 const currentConfig=current.nodes.find(node=>node.name==='Configuração').parameters.jsCode;
 const start=currentConfig.lastIndexOf('const cfg=')+'const cfg='.length,end=currentConfig.indexOf(';\nif(',start),literal=currentConfig.slice(start,end);
 const configuration=baseline.nodes.find(node=>node.name==='Configuração');const oldStart=configuration.parameters.jsCode.lastIndexOf('const cfg=')+'const cfg='.length,oldEnd=configuration.parameters.jsCode.indexOf(';\nif(',oldStart);
 configuration.parameters.jsCode=configuration.parameters.jsCode.slice(0,oldStart)+literal+configuration.parameters.jsCode.slice(oldEnd);
 baseline.nodes.forEach((node,index)=>{node.id='existing-before-'+index;const updated=current.nodes.find(item=>item.name===node.name);if(updated?.credentials)node.credentials=structuredClone(updated.credentials);});
 const webhook=baseline.nodes.find(node=>node.name==='Entrada WhatsApp da equipe');webhook.webhookId='preserve-webhook-id';webhook.parameters.path='synthetic_existing_webhook';
 const prepared=await prepareIntakeWorkflow(baseline,'whatsapp');
 assert(prepared.workflow.nodes.some(node=>node.name==='Conferir WhatsApp a cada 5 minutos'));
 for(const node of baseline.nodes){const output=prepared.workflow.nodes.find(item=>item.name===node.name);assert.equal(output.id,node.id);assert.deepEqual(output.credentials,node.credentials);}
 assert.equal(prepared.workflow.nodes.find(node=>node.name===webhook.name).webhookId,webhook.webhookId);
 assert(prepared.workflow.nodes.find(node=>node.name==='Configuração').parameters.jsCode.includes('const cfg='+literal));
 assert(prepared.manifest.changedNodes.some(node=>node.change==='add'));assert(prepared.manifest.changedConnections.length>0);
});

test('preparation refuses missing config, credentials, manual selections, webhook mismatch and code/edge drift',async()=>{
 const mutations=[
  [workflow=>replaceConfig(workflow,config=>{delete config.worker;}),'gmail',/missing: worker/],
  [workflow=>replaceConfig(workflow,config=>{config.apiKey='synthetic-must-not-appear';}),'gmail',/unknown: apiKey/],
  [workflow=>replaceConfig(workflow,config=>{config.manualMessageId='synthetic-selected-message';}),'gmail',/Clear manual/],
  [workflow=>{delete workflow.nodes.find(node=>node.name==='Reservar origem').credentials;},'gmail',/credential/],
  [workflow=>{workflow.nodes.find(node=>node.name==='Entrada WhatsApp da equipe').parameters.path='different-webhook';},'whatsapp',/webhook path/],
  [workflow=>{workflow.nodes.find(node=>node.name==='Próximo anexo').parameters.jsCode+='\nthrow new Error("custom code");';},'gmail',/Custom changes/],
  [workflow=>{workflow.connections['Reservar origem'].main[1].push({node:'Preserved customization',type:'main',index:0});},'gmail',/Custom connections/],
 ];
 for(const [mutate,kind,error] of mutations){const inputs=await fixtures();mutate(inputs[kind]);await assert.rejects(prepareIntakeWorkflow(inputs[kind],kind),error);}
});

test('private output contains baseline hashes and is written with mode0600 without applying anything',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'synthetic-intake-preparation-'));
 try{
  const inputs=await fixtures(),gmailExport=path.join(directory,'gmail.json'),whatsappExport=path.join(directory,'whatsapp.json'),out=path.join(directory,'review');
  await fs.writeFile(gmailExport,JSON.stringify(inputs.gmail));await fs.writeFile(whatsappExport,JSON.stringify([inputs.whatsapp]));
  const result=await writeIntakeReconciliation({gmailExport,whatsappExport,out});assert.equal(result.publication,'not_applied');assert.equal(result.files.length,3);
  for(const target of result.files)assert.equal((await fs.stat(target)).mode&0o777,0o600);
  const manifest=JSON.parse(await fs.readFile(path.join(out,'manifest.json'),'utf8'));assert.equal(manifest.publication,'not_applied');assert(manifest.workflows.every(item=>/^[a-f0-9]{64}$/.test(item.export_sha256)&&/^[a-f0-9]{64}$/.test(item.baseline_sha256)));
  await assert.rejects(writeIntakeReconciliation({gmailExport,whatsappExport,out}),/EEXIST/);
  await assert.rejects(writeIntakeReconciliation({gmailExport,whatsappExport,out:new URL('../../n8n/exames/private-output',import.meta.url).pathname}),/outside the repository/);
  const link=path.join(directory,'repo-link');await fs.symlink(new URL('../../',import.meta.url).pathname,link);
  await assert.rejects(writeIntakeReconciliation({gmailExport,whatsappExport,out:path.join(link,'private-output')}),/outside the repository/);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
