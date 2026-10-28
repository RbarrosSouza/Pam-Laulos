import test from 'node:test';import assert from 'node:assert/strict';
import {buildWorkflows} from '../operacional-build.mjs';import {buildOutlookChild} from './outlook-child-build.mjs';
const names=['Composio - descobrir ferramentas','Validar descoberta e sessão','Composio - listar conexões','Validar conta e preparar leitura','Outlook - listar metadados do anexo','Confirmar parte exata antes de baixar','Outlook - obter bytes do anexo exato'];
function diagnostic(){return {nodes:[...names.map((name,i)=>({id:String(i),name,type:i%2?'n8n-nodes-base.code':'@n8n/n8n-nodes-langchain.mcpClient',typeVersion:2,parameters:{jsCode:name==='Validar descoberta e sessão'?"const data={results:[]},id='s';return [{json:{session_id:id, list_input:{}}}];":name==='Validar conta e preparar leitura'?"const candidates=[{id:'a'}];const session='s';return [{json:{execute_input:{tools:[{tool_slug:'OUTLOOK_LIST_OUTLOOK_ATTACHMENTS',account:candidates[0].id,arguments:{}}]}}}];":name==='Confirmar parte exata antes de baixar'?"const cfg={folderId:'a'};return [{json:{mail_folder_id:cfg.folderId}}];":''},credentials:{syntheticCredential:{id:'fixture',name:'fixture'}}})),{name:'Conferir PDF e hash sem exibir conteúdo',parameters:{jsCode:"function parseMcp(v){return v;}function isObject(v){return !!v&&typeof v==='object';}\nconst crypto=require('crypto');"}}]};}
const make=async()=>buildOutlookChild({gmail:(await buildWorkflows()).intake,diagnostic:diagnostic()});
test('child retains source upload/readback/confirm graph and private execution settings',async()=>{
 const w=await make();assert.equal(w.active,false);assert.equal(w.settings.saveDataSuccessExecution,'none');assert.equal(w.settings.saveDataErrorExecution,'none');
 const names=new Set(w.nodes.map(x=>x.name));for(const [from,outputs] of Object.entries(w.connections))for(const branch of outputs.main)for(const edge of branch)assert(names.has(from)&&names.has(edge.node));
 assert.equal(w.nodes.find(n=>n.name==='Receber anexo Outlook').parameters.inputSource,'passthrough');
 assert.equal(w.connections['Conferir integridade do original'].main[0][0].node,'Confirmar armazenamento');
 assert.equal(w.connections['Validar conteúdo Outlook'].main[1][0].node,'Erro antes da reserva');
 assert.equal(w.connections['Reservar origem'].main[1][0].node,'Erro antes da reserva');
});
test('content validation rejects different identity, retains provider mismatch and computes digest from bytes',async()=>{
 const w=await make(),code=w.nodes.find(n=>n.name==='Validar conteúdo Outlook').parameters.jsCode;
 const bytes=Buffer.from('%PDF-1.4\nsynthetic content\n%%EOF\n'), job={receipt_id:'receipt',source:{original_name:'',metadata:{}}};
 const data={results:[{tool_slug:'OUTLOOK_GET_USER_MESSAGES_ATTACHMENTS',response:{successful:true,data:{id:'part','@odata.type':'#microsoft.graph.fileAttachment',size:1876,contentBytes:bytes.toString('base64')}}}]};
 const refs={'Configuração e trava manual':{cfg:{attachmentId:'part'}},'Confirmar parte exata antes de baixar':{expected_size:1876},'Configuração':{maxBytes:20971520,driveFolderId:'fixture-folder'},'Receber anexo Outlook':{job}};
 const dollar=name=>({first:()=>({json:refs[name]})});const input={first:()=>({json:data})};
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor, run=new AsyncFunction('$','$input','require','Buffer',code);
 const context={helpers:{prepareBinaryData:async b=>({bytes:b.length})}};const items=await run.call(context,dollar,input,(await import('node:module')).createRequire(import.meta.url),Buffer);
 assert.equal(items[0].json.source.metadata.provider_size_differs,true);assert.equal(items[0].json.source.metadata.provider_size,1876);assert.equal(items[0].json.sizeBytes,bytes.length);assert.match(items[0].json.sha256,/^[a-f0-9]{64}$/);
 data.results[0].response.data.id='different';await assert.rejects(run.call(context,dollar,input,(await import('node:module')).createRequire(import.meta.url),Buffer),/IDENTITY_OR_METADATA/);
});
