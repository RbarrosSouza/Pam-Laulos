import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import crypto from 'node:crypto';
import {buildN8nAuditWorkflow} from './n8n-discovery-audit-build.mjs';import {buildOutlookParent} from './outlook-parent-build.mjs';
const old={serviceUrl:'https://fixture.invalid/functions/v1/exam-document-service',mailbox:'fixture@example.invalid',intakeCutoff:'2026-10-28T00:00:00.000Z',accountId:1,inboxId:2,chatwootBaseUrl:'https://fixture.invalid'};
const source={nodes:[{name:'Configuração',parameters:{jsCode:'const cfg='+JSON.stringify(old)+';\nif(false){}'}},{name:'Reservar origem',credentials:{httpHeaderAuth:{id:'worker',name:'worker'}}},{name:'Gmail - IDs paginados',credentials:{oAuth2Api:{id:'gmail',name:'gmail'}}}]};
function diagnostic(){let names=['Composio - descobrir ferramentas','Validar descoberta e sessão','Composio - listar conexões','Validar conta e preparar leitura','Outlook - obter bytes do anexo exato'];return{nodes:[...names.map((name,i)=>({name,type:i%2?'n8n-nodes-base.code':'@n8n/n8n-nodes-langchain.mcpClient',typeVersion:2,parameters:{jsonInput:'',jsCode:name==='Validar descoberta e sessão'?"const data={results:[]},id='s';return [{json:{session_id:id, list_input:{}}}];":name==='Validar conta e preparar leitura'?"const expected=$('Configuração e trava manual').first().json.cfg.mailbox;const session='s',candidates=[{id:'a'}];return [{json:{session_id:session,account:candidates[0].id,execute_input:{}}}];":""},credentials:{fixture:{id:'fixture',name:'fixture'}}})),{name:'Conferir PDF e hash sem exibir conteúdo',parameters:{jsCode:"function parseMcp(v){return v;}\nconst crypto=require('crypto');"}}]};}
const config={mailbox:'fixture@example.invalid',intakeCutoff:'2026-10-28T00:00:00.000Z',activationId:'11111111-1111-4111-8111-111111111111',childWorkflowId:'fixtureChild12345'};
test('parent is inactive, has safe credential references and a closed graph',async()=>{
 const audit=buildN8nAuditWorkflow('gmail',source,'fixtureDataTable',{scheduledCandidate:true});const w=await buildOutlookParent({audit,diagnostic:diagnostic(),config});
 assert.equal(w.active,false);assert.equal(w.settings.saveDataSuccessExecution,'none');assert.equal(w.settings.saveDataErrorExecution,'none');
 const names=new Set(w.nodes.map(n=>n.name));for(const [from,c] of Object.entries(w.connections))for(const b of c.main||[])for(const edge of b)assert(names.has(from)&&names.has(edge.node));
 for(const node of w.nodes.filter(n=>n.type==='n8n-nodes-base.code'))new vm.Script('(async function(){'+node.parameters.jsCode+'})');
 assert.equal(w.nodes.find(n=>n.name==='Provedor — somente leitura').onError,'continueErrorOutput');
 assert.equal(w.nodes.find(n=>n.name==='Preservar original Outlook').parameters.workflowId,config.childWorkflowId);
});
test('unconfigured child placeholder fails before scanning',async()=>{
 const audit=buildN8nAuditWorkflow('gmail',source,'fixtureDataTable',{scheduledCandidate:true});const w=await buildOutlookParent({audit,diagnostic:diagnostic(),config:{...config,childWorkflowId:'SET_CHILD_WORKFLOW_ID'}});
 const code=w.nodes.find(n=>n.name==='Configuração de auditoria').parameters.jsCode;assert.throws(()=>new vm.Script('(function(){'+code+'})()').runInNewContext({require:n=>crypto}),/OUTLOOK_COLLECTOR_CONFIG_INVALID/);
});
