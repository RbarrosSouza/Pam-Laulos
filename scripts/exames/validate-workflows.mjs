import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(import.meta.url);
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const workflows=Array.from({length:6},(_,i)=>JSON.parse(fs.readFileSync(path.join(root,'n8n/exames',`EXAMES-${String(i+1).padStart(2,'0')}.json`),'utf8')));
let checks=0;
const test=async(name,fn)=>{await fn();checks++;console.log(`✓ ${name}`);};
const get=(i,name)=>workflows[i-1].nodes.find(n=>n.name===name);
async function run(i,name,input,refs={},extra={}){
 const node=get(i,name);assert(node,`Node ${name} missing`);
 const items=Array.isArray(input)?input:[{json:input}];
 const inputApi={all:()=>items,first:()=>items[0],item:items[0]};
 const $=(n)=>{const value=refs[n];assert(value,`Missing mock ${n}`);const item=value.json?value:{json:value};return {first:()=>item,item,all:()=>[item]};};
 const fn=new AsyncFunction('$input','$','$json','$getWorkflowStaticData','require','Buffer',node.parameters.jsCode);
 return fn.call(extra.context||{},inputApi,$,items[0]?.json,()=>extra.state||{},require,Buffer);
}
function reachable(w,start,end){
 const visited=new Set();const visit=n=>{if(n===end)return true;if(visited.has(n))return false;visited.add(n);return (w.connections[n]?.main||[]).flat().some(e=>visit(e.node));};return visit(start);
}
const cfg={enabled:true,serviceUrl:'https://example.supabase.co/functions/v1/exam-document-service',maxBytes:20*1024*1024,driveFolders:{'2026-10':'folder'},worker:'test',allowedSenders:['lab@example.test'],examSubjectHints:['exame'],extractorUrl:'https://model.example.test',extractorModel:'test',maxPages:100,maxTextChars:80000};
const doc={id:'11111111-1111-4111-8111-111111111111',size_bytes:34,sha256:'x',drive_file_id:'drive-fixed',extracted_data:{pet_name:'Luna',client_name:'Ana'},confirmed_data:{},received_at:'2026-10-10T03:00:00Z'};
const task={id:'22222222-2222-4222-8222-222222222222',lease_token:'lease-test',document:doc};

await test('six inactive exports, safe defaults, no secrets/clinical pinData',async()=>{
 assert.equal(workflows.length,6);
 for(const w of workflows){
  assert.equal(w.active,false);assert.deepEqual(w.pinData,{});assert.equal(w.settings.saveDataSuccessExecution,'none');assert.equal(w.settings.saveDataErrorExecution,'none');
  assert(w.nodes.find(n=>n.name==='Configuração').parameters.jsCode.includes('enabled: false'));
  const json=JSON.stringify(w);assert(!/eyJ[A-Za-z0-9_-]{25}|sk-[A-Za-z0-9]{20}|SUPABASE_SERVICE_ROLE_KEY/.test(json));
  for(const n of w.nodes)assert(!n.credentials,'No credential ids/values belong in exports');
 }
});
await test('all node names, connection targets and expression references resolve',async()=>{
 for(const w of workflows){const names=new Set(w.nodes.map(n=>n.name));assert.equal(names.size,w.nodes.length);
  for(const [source,channels] of Object.entries(w.connections)){assert(names.has(source));for(const edge of channels.main.flat())assert(names.has(edge.node),edge.node);}
  for(const n of w.nodes){for(const match of JSON.stringify(n.parameters).matchAll(/\$\('([^']+)'\)/g))assert(names.has(match[1]),`${w.name}: ${match[1]}`);if(n.type==='n8n-nodes-base.code')new AsyncFunction(n.parameters.jsCode);const visit=v=>{if(typeof v==='string'&&v.startsWith('={{')&&v.endsWith('}}'))new Function('return ('+v.slice(3,-2)+');');else if(v&&typeof v==='object')Object.values(v).forEach(visit);};visit(n.parameters);}
 }
});
await test('disabled configuration blocks effects before HTTP in every workflow',async()=>{
 for(let i=1;i<=6;i++)await assert.rejects(()=>run(i,'Configuração',{}),/pausado/);
});
await test('Graph messages and attachments exhaust nextLink with immutable IDs',async()=>{
 for(const name of ['Graph - mensagens paginadas','Graph - todos os anexos']){
  const p=get(1,name).parameters;
  assert.equal(p.options.pagination.pagination.paginationMode,'responseContainsNextURL');
  assert.equal(p.options.pagination.pagination.limitPagesFetched,false);
  assert(p.options.pagination.pagination.completeExpression.includes("!$response.body['@odata.nextLink']"));
  assert(p.headerParameters.parameters.some(x=>x.value==='IdType="ImmutableId"'));
 }
 const list=await run(1,'Mensagens elegíveis',[{json:{value:[{id:'m1',from:{emailAddress:{address:'lab@example.test'}}},{id:'m1',from:{emailAddress:{address:'lab@example.test'}}}]}},{json:{value:[{id:'m2',subject:'Exame recebido',from:{emailAddress:{address:'new@example.test'}}},{id:'m3',subject:'pessoal',from:{emailAddress:{address:'other@example.test'}}}]}}],{'Configuração':cfg});
 assert.deepEqual(list.map(i=>i.json.id),['m1','m2']);assert.equal(list[1].json.unknownSender,true);
});
await test('all three PDFs become separate origins; signatures filtered; unsupported remains review',async()=>{
 const r=await run(1,'Enumerar anexos e ausência',{value:[{id:'a',name:'A.pdf',contentType:'application/pdf'},{id:'b',name:'B.PDF',contentType:'application/octet-stream'},{id:'c',name:'C.pdf',contentType:'application/pdf'},{id:'logo',name:'logo.png',contentType:'image/png'},{id:'zip',name:'exam.zip',contentType:'application/zip'}]}, {'Mensagem disponível':{id:'m1'}});
 assert.equal(r.length,4);assert.deepEqual(r.slice(0,3).map(i=>i.json.attachment.id),['a','b','c']);assert(r[3].json.missing);
 const none=await run(1,'Enumerar anexos e ausência',{value:[]},{'Mensagem disponível':{id:'m2'}});assert.equal(none[0].json.attachment.id,'missing-pdf');assert(none[0].json.missing);
});
await test('Drive effect uses ID reserved in backend, single original, and readback before confirm',async()=>{
 const w=workflows[0];assert(reachable(w,'Reservar ID e upload Drive','Drive - criar metadados com ID fixo'));assert(reachable(w,'Drive - gravar bytes no ID fixo','Drive - conferir bytes salvos'));assert(reachable(w,'Drive - conferir bytes salvos','Confirmar armazenamento'));
 assert(get(1,'Drive - criar metadados com ID fixo').parameters.jsonBody.includes('id:$json.drive_file_id'));
 const upload=get(1,'Drive - gravar bytes no ID fixo');assert.equal(upload.parameters.contentType,'binaryData');assert.equal(upload.parameters.inputDataFieldName,'data');assert.equal(upload.parameters.method,'PATCH');
 const mismatch=await assert.rejects(()=>run(1,'Conferir integridade do original',{},{'Configuração':cfg,'Validar bytes e SHA-256':{sha256:'wrong',sizeBytes:10},'Reservar ID e upload Drive':{}},{context:{helpers:{getBinaryDataBuffer:async()=>Buffer.from('%PDF-1.7\nsynthetic\n%%EOF')}}}),/integridade/);void mismatch;
});
await test('OCR absence/limits produce review, never invented date or successful extraction',async()=>{
 const refs={'Configuração':{...cfg,extractorUrl:'',extractorModel:''},'Tarefa disponível':task};
 const result=await run(2,'Preparar classificação ou revisão',{text:[]},refs);assert.equal(result[0].json.canExtract,false);assert.equal(result[0].json.extraction.classification,'review');assert.deepEqual(result[0].json.extraction.fields,{});
 const over=await run(2,'Preparar classificação ou revisão',{text:['a'.repeat(20)]},{...refs,'Configuração':{...cfg,maxTextChars:5}});assert.equal(over[0].json.canExtract,false);
});
await test('structured extraction checks actual supporting text and real dates',async()=>{
 const context={task,text:'[Página 1]\nPet: Luna Tutor: Ana Data: 10/10/2026',totalPages:1,extraction:{classification:'review',single_patient:false,fields:{},evidence:[],extractor_version:'manual'}};
 const good={classification:'exam',single_patient:true,fields:{pet_name:'Luna',client_name:'Ana',exam_date:'2026-10-10'},evidence:[{field:'pet_name',page:1,excerpt:'Pet: Luna'},{field:'client_name',page:1,excerpt:'Tutor: Ana'},{field:'exam_date',page:1,excerpt:'10/10/2026'}]};
 const result=await run(2,'Validar JSON e evidências',{choices:[{message:{content:JSON.stringify(good)}}]},{'Preparar classificação ou revisão':context});assert.equal(result[0].json.extraction.classification,'exam');
 for(const bad of [{...good,fields:{...good.fields,exam_date:'2026-02-30'}},{...good,evidence:[{field:'pet_name',page:1,excerpt:'Invented patient'}]},{...good,single_patient:false}]){
  const result=await run(2,'Validar JSON e evidências',{choices:[{message:{content:JSON.stringify(bad)}}]},{'Preparar classificação ou revisão':context});assert.equal(result[0].json.extraction.classification,'review');
 }
});
await test('Chatwoot emits one actual PDF multipart and one destination POST without retry',async()=>{
 const send=get(3,'Chatwoot - enviar PDF único');assert.equal(send.parameters.method,'POST');assert.equal(send.retryOnFail,false);assert.equal(send.onError,'continueRegularOutput');
 const fields=send.parameters.bodyParameters.parameters;assert.equal(fields.filter(f=>f.parameterType==='formBinaryData').length,1);assert.equal(fields.find(f=>f.parameterType==='formBinaryData').name,'attachments[]');assert.equal(fields.find(f=>f.parameterType==='formBinaryData').inputDataFieldName,'data');assert(!send.parameters.headerParameters?.parameters.some(x=>/content-type/i.test(x.name)));
 assert(reachable(workflows[2],'Validar grupo e caixa','Chatwoot - enviar PDF único'));
 for(const w of workflows)for(const [name,c] of Object.entries(w.connections))assert(c.main.every(edges=>edges.length<=1),`${name} fans out effects`);
});
await test('Chatwoot 2xx means submitted; timeout/5xx/429 never causes blind resend',async()=>{
 const refs={'Preparar PDF e correlação':{task,correlation:'[EXAM:test:DELIVERY:test]'}};
 const good=await run(3,'Classificar submissão sem reenvio',{statusCode:200,body:{id:42,status:'sent'}},refs);assert.equal(good[0].json.outcome.status,'submitted');assert.equal(good[0].json.outcome.external_id,'42');
 for(const response of [{error:'Timeout'},{statusCode:500},{statusCode:429},{statusCode:200,body:{}}]){const r=await run(3,'Classificar submissão sem reenvio',response,refs);assert.equal(r[0].json.outcome.status,'uncertain');}
 const rejected=await run(3,'Classificar submissão sem reenvio',{statusCode:401},refs);assert.equal(rejected[0].json.outcome.status,'failed');
});
await test('reconciliation never posts Chatwoot, and sent alone does not prove provider delivery',async()=>{
 const w=workflows[4];assert(!w.nodes.some(n=>n.type==='n8n-nodes-base.httpRequest'&&n.parameters.method==='POST'&&String(n.parameters.url).includes('/messages')));
 assert.equal(get(5,'Chatwoot - consultar mensagens').parameters.options.pagination.pagination.paginationMode,'updateAParameterInEachRequest');
 const correlation=`[EXAM:${doc.id}:DELIVERY:${task.id}]`;
 const refs={'Uma mensagem por vez':task,'Configuração':{...cfg,providerConfirmationStatuses:['delivered','read']}};
 for(const [status,expected] of [['sent','submitted'],['delivered','sent'],['read','sent']]){const result=await run(5,'Reconciliar status e correlação',{payload:[{id:42,status,content:correlation}]},refs);assert.equal(result[0].json.outcome.status,expected);}
 const missing=await run(5,'Reconciliar status e correlação',{payload:[]},refs);assert.equal(missing[0].json.outcome.status,'uncertain');
});
await test('Drive reconciliation reaches group even with zero Drive tasks',async()=>{
 const r=await run(5,'Pendências Drive',{drive_tasks:[]});assert.equal(r.length,1);assert(r[0].json.empty);
 assert(reachable(workflows[4],'Uma reserva Drive por vez','Pendências de grupo'));
 assert(reachable(workflows[4],'Ler original temporário','Confirmar original temporário'));
});
await test('ingestion failure persists in backend and preserves the recovery watermark',async()=>{
 const w=workflows[0];assert(reachable(w,'Registrar falha de origem','Manter janela para recuperação'));
 assert(get(1,'Registrar falha de origem').parameters.jsonBody.includes('source_error'));
 const state={watermark:'2026-10-01T00:00:00Z',failedSweeps:{'run-1':true}};
 const r=await run(1,'Confirmar varredura concluída',{}, {'Configuração':{...cfg,sweepEnd:'2026-10-10T00:00:00Z',sweepId:'run-1'}},{state});
 assert.equal(r[0].json.watermarkAdvanced,false);assert.equal(state.watermark,'2026-10-01T00:00:00Z');
 const after=await run(1,'Confirmar varredura concluída',{}, {'Configuração':{...cfg,sweepEnd:'2026-10-10T00:00:00Z',sweepId:'run-2'}},{state});assert(after[0].json.watermarkAdvanced);
});
await test('group worker rejects backend destination mismatch before POST',async()=>{
 const c={...cfg,accountId:4,inboxId:7,conversationId:99,groupJid:'group@g.us'};
 const dest='chatwoot:4:7:99:group@g.us';
 const ok=await run(3,'Tarefa disponível',{tasks:[{...task,configured_destination:dest}]},{'Configuração':c});assert.equal(ok.length,1);assert(ok[0].json.destinationVerified);
 const wrong=await run(3,'Tarefa disponível',{tasks:[{...task,configured_destination:'wrong'}]},{'Configuração':c});assert.equal(wrong[0].json.destinationVerified,false);assert(reachable(workflows[2],'Destino da tarefa confere','Falha confirmada antes do POST'));assert(reachable(workflows[2],'PDF íntegro para enviar','Falha confirmada antes do POST'));assert(get(3,'Falha confirmada antes do POST').parameters.jsonBody.includes("status:'failed'"));
});
await test('canonical duplicates skip upload; pending leases preserve sweep and canonical folder/name',async()=>{
 const state={};const refs={'Configuração':{...cfg,sweepId:'sweep'},'Reservar ID e upload Drive':{document_id:'canonical',claimed:false,upload_required:false,document:{...doc,file_status:'saved'}}};
 await run(1,'Adiar sweep quando upload pendente',{},refs,{state});assert(!state.failedSweeps?.sweep);
 refs['Reservar ID e upload Drive']={document_id:'canonical',claimed:false,upload_required:true,document:{...doc,file_status:'pending'}};
 await run(1,'Adiar sweep quando upload pendente',{},refs,{state});assert(state.failedSweeps.sweep);
 for(const [i,name] of [[1,'Drive - criar metadados com ID fixo'],[5,'Drive - criar temporário ID fixo'],[6,'Drive - metadados WhatsApp com ID fixo']])assert(get(i,name).parameters.jsonBody.includes('$json.document.drive_folder_id||'));
 const origin={message:{id:'m'},attachment:{id:'a'}};
 const skip=await run(1,'Decidir recebimento',{document_id:'canonical',document:{file_status:'saved'}},{'Um anexo por vez':origin});assert(skip[0].json.skip);
 const m=await run(1,'Validar estado do objeto',{statusCode:404,body:{}},{'Reservar ID e upload Drive':{document_id:doc.id,document:{...doc,original_name:'canonical.pdf'}}});assert(m[0].json.driveName.endsWith('canonical.pdf'));
});
await test('Outlook OAuth identity is checked before all source/file effects',async()=>{
 const refs={'Configuração':{...cfg,mailbox:'clinical@example.test'}};
 assert.equal((await run(1,'Validar identidade da caixa',{mail:'clinical@example.test',id:'account'},refs)).length,1);
 await assert.rejects(()=>run(1,'Validar identidade da caixa',{mail:'other@example.test',id:'other'},refs),/Credencial Outlook/);
 assert(reachable(workflows[0],'Validar identidade da caixa','Reservar origem'));
});
await test('Nexus task calls backend verification only, with the lease',async()=>{
 const n=get(4,'Anexar e verificar no backend');assert(n.parameters.jsonBody.includes('attach_nexus'));assert(n.parameters.jsonBody.includes('lease_token:$json.lease_token'));
});
await test('WhatsApp excludes outgoing, private, destination, untrusted sender and self-loop',async()=>{
 const config={...cfg,accountId:4,inboxId:7,destinationConversationId:99,allowedConversationIds:[12],allowedSenderIds:[25],allowedDownloadOrigins:['https://chat.example.test']};
 const incoming={id:5,event:'message_created',message_type:'incoming',private:false,account:{id:4},inbox:{id:7},conversation:{id:12},sender:{id:25},created_at:1791590400,attachments:[{id:10,file_type:'file',file_name:'exam.pdf',data_url:'https://chat.example.test/exam.pdf'},{id:11,file_type:'file',file_name:'exam2.pdf',data_url:'https://chat.example.test/exam2.pdf'}]};
 const refs=body=>({'Configuração':config,'Webhook Chatwoot autenticado':{body}});
 const r=await run(6,'Validar evento e todos os PDFs',{},refs(incoming));assert.equal(r.length,2);assert.match(r[0].json.receivedAt,/^2026-/);
 for(const b of [{...incoming,message_type:'outgoing'},{...incoming,private:true},{...incoming,conversation:{id:99}},{...incoming,conversation:{id:30},sender:{id:40}},{...incoming,content:'[EXAM:source]'}])assert.deepEqual(await run(6,'Validar evento e todos os PDFs',{},refs(b)),[]);
 await assert.rejects(()=>run(6,'Validar evento e todos os PDFs',{},refs({...incoming,attachments:[{id:1,file_type:'file',file_name:'exam.pdf',data_url:'https://attacker.example.test/exam.pdf'}]})),/Host/);
 assert.equal(get(6,'Webhook Chatwoot autenticado').parameters.authentication,'headerAuth');
});
console.log(`\n${checks} contract/graph/binário/guard checks passed. Not live n8n import or delivery proof.`);
