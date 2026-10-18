import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {examPresentation, findExamDelivery} from './notification-presentation.mjs';
import {buildWorkflows} from './operacional-build.mjs';

const id='11111111-1111-4111-a111-111111111111';
const fields={pet_name:'Luna',client_name:'Ana Souza',exam_type:'Hemograma',exam_date:'2026-10-14'};
const doc={id,sha256:'a'.repeat(64),received_at:'2026-10-16T18:29:00Z',extracted_data:fields};
const base='https://pam-laulos.vercel.app';
const workflows=await buildWorkflows();
const node=(kind,name)=>workflows[kind].nodes.find(n=>n.name===name);

test('extractor prompt requests complete printed names, a literal exam type and documentary date fallback',()=>{
 const prompt=node('processing','Extrair dados estruturados').parameters.jsonBody;
 assert(prompt.includes('incluindo todos os sobrenomes e nomes compostos'));
 assert(prompt.includes('Acompanhante do Exame'));assert(prompt.includes('expressão literal presente no PDF'));
 assert(prompt.includes('Priorize a data de realização ou coleta'));
 assert(prompt.includes('na ausência dela, use a Data do Laudo'));
 assert(!prompt.includes('não comprovam realização/coleta'));
 assert(prompt.includes('Nunca use data de recebimento do email, nascimento ou rodapé genérico'));
});

test('filename starts with pet then tutor, exam, documented date; received time appears only at end of caption',()=>{
 const result=examPresentation(doc,base);
 assert(result.ready);assert.equal(result.fileName,'Luna - Ana Souza - Hemograma - 14-10-2026.pdf');
 assert(result.content.indexOf('*Tutor:*')<result.content.indexOf('*Pet:*'));
 assert(result.content.includes('*Data do exame:* 14/10/2026'));
 assert(result.content.endsWith('_Recebido em 16/10/2026 às 15:29_'));
 assert(!result.content.includes('[EXAM:'));assert(!result.content.includes(id));
 assert.equal(result.shortUrl,base+'/e/ERERERERQRGhEREREREREQ');
 assert(!result.content.includes('\\n'));
});

test('missing or impossible exam date is never replaced by email receipt date',()=>{
 for(const date of [null,'','2026-02-30','2026-99-99','16/10/2026']){
  const result=examPresentation({...doc,extracted_data:{...fields,exam_date:date}},base);
  assert.equal(result.ready,false);assert.deepEqual(result.missingFields,['exam_date']);
  assert.equal(result.fileName,'Luna - Ana Souza - Hemograma.pdf');assert(!result.fileName.includes('16-10-2026'));
  assert(!result.content.includes('*Data do exame:*'));
 }
});

test('missing fields remain diagnostic, partial confirmation and server notification fields take precedence',()=>{
 for(const key of ['pet_name','client_name','exam_type'])assert(!examPresentation({...doc,extracted_data:{...fields,[key]:'—'}},base).ready);
 const merged=examPresentation({...doc,confirmed_data:{client_name:'Ana Lima'}},base);
 assert.equal(merged.fileName,'Luna - Ana Lima - Hemograma - 14-10-2026.pdf');
 for(const value of [null,'']){
  const cleared=examPresentation({...doc,confirmed_data:{exam_date:value}},base);
  assert.equal(cleared.ready,false);assert(cleared.missingFields.includes('exam_date'));
 }
 const server=examPresentation({...doc,notification_fields:{...fields,pet_name:'Mel'}},base);
 assert(server.fileName.startsWith('Mel - '));
 assert(examPresentation({...doc,confirmed_data:{tutor_name:'Ana Lima'}},base).fileName.includes('Ana Lima'));
 assert.equal(examPresentation({...doc,confirmed_data:{tutor_name:null}},base).ready,false);
 assert(examPresentation({...doc,confirmed_data:{client_name:'Ana Lima',tutor_name:'Outra'}},base).fileName.includes('Ana Lima'));
});

test('partial and unidentified exams keep only available fields and are ready to present without invented placeholders',()=>{
 for(const [available,expected] of [[{pet_name:'Luna'},'Luna.pdf'],[{client_name:'Ana Souza'},'Ana Souza.pdf'],[{exam_type:'Hemograma'},'Hemograma.pdf'],[{},'Exame.pdf']]){
  const result=examPresentation({...doc,extracted_data:available},base);
  assert.equal(result.fileName,expected);
  assert(result.content.includes('Informações incompletas'));
  assert(!result.content.includes(': —'));assert(!result.content.includes('não identificado'));
  for(const [key,label] of [['client_name','Tutor'],['pet_name','Pet'],['exam_type','Exame']])assert.equal(result.content.includes('*'+label+':*'),Boolean(available[key]));
 }
});

test('file values and WhatsApp formatting cannot be broken by linebreaks or reserved punctuation',()=>{
 const result=examPresentation({...doc,extracted_data:{...fields,pet_name:'Lu\nna/<x>',client_name:'*Ana*\n_Equipe_'}},base);
 assert(!/[\\/:*?"<>|\x00-\x1f]/.test(result.fileName));
 assert(result.content.includes('*Tutor:* Ana Equipe\n*Pet:* Lu na/<x>'));
});

test('full pet and tutor names over 60 characters remain complete in filename and caption',()=>{
 const pet='Princesa Luna da Casa Verde dos Jardins de São Sebastião do Vale';
 const tutor='Ana Beatriz de Albuquerque Vasconcelos Oliveira dos Santos Ferreira';
 assert(pet.length>60);assert(tutor.length>60);
 const result=examPresentation({...doc,extracted_data:{...fields,pet_name:pet,client_name:tutor}},base);
 assert.equal(result.fileName,pet+' - '+tutor+' - Hemograma - 14-10-2026.pdf');
 assert(result.content.includes('*Tutor:* '+tutor));assert(result.content.includes('*Pet:* '+pet));
});

test('internal attributes recover lost POST response, ignore unrelated messages, keep legacy marker compatibility',()=>{
 const task={id:'delivery-one',document:doc};
 const current={id:18,private:false,message_type:'outgoing',content:'mensagem limpa',content_attributes:{pamvet_exam_document_id:id,pamvet_exam_delivery_id:task.id,pamvet_exam_sha256:doc.sha256}};
 const wrong={id:19,content_attributes:{pamvet_exam_document_id:id,pamvet_exam_delivery_id:'other'}};
 assert.deepEqual(findExamDelivery([current,wrong],task),[current]);
 const legacy={id:7,private:false,message_type:1,attachments:[{file_type:'file'}],content:'[EXAM:'+id+':DELIVERY:'+task.id+']'};
 assert.deepEqual(findExamDelivery([legacy],task),[legacy]);
 assert.deepEqual(findExamDelivery([current,legacy],{...task,external_id:'18'}),[current]);
 assert.deepEqual(findExamDelivery([current,current],task),[current]);
 assert.deepEqual(findExamDelivery([{...legacy,message_type:'incoming'},{...legacy,id:8,private:true},{...legacy,id:9,attachments:[]}],task),[]);
 assert.deepEqual(findExamDelivery([{...current,inbox_id:9}],task,{inboxId:2}),[]);
 assert.deepEqual(findExamDelivery([{...current,conversation_id:99}],task,{conversationId:23}),[]);
});

test('generated processing and group nodes agree on filename and put correlation only in private message attributes',async()=>{
 const bytes=Buffer.from('%PDF-1.4\nSynthetic\n%%EOF');
 const task={id:'delivery-one',document:{...doc,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),size_bytes:bytes.length}};
 const binary={data:{fileName:'old.pdf'}};
 const config={maxBytes:20000,pamLaudosBaseUrl:base,providerConfirmationStatuses:['delivered','read']};
 const outputs={'Tarefa disponível':{json:task},'Configuração':{json:config},'Uma confirmação por vez':{json:task}};
 const run=async(kind,name,input)=>new vm.Script('(async function(){'+node(kind,name).parameters.jsCode+'}).call(this)').runInNewContext({Buffer,require:key=>{assert.equal(key,'crypto');return crypto;},$json:input.json,$input:{first:()=>input,all:()=>[input]},$:name=>({item:outputs[name],first:()=>outputs[name]}),helpers:{getBinaryDataBuffer:async()=>bytes}});
 const process=await run('processing','Resultado para persistir',{json:{task,extraction:{fields}},binary});
 const group=await run('group','Preparar PDF e correlação',{json:{},binary});
 assert.equal(process[0].json.driveName,group[0].binary.data.fileName);
 assert(!group[0].json.content.includes(task.id));assert(!group[0].json.content.includes(id));
 assert.equal(group[0].json.contentAttributes.pamvet_exam_delivery_id,task.id);
 const params=node('group','Chatwoot - enviar PDF único').parameters.bodyParameters.parameters;
 assert.equal(params.find(p=>p.name==='content_attributes').value,'={{ JSON.stringify($json.contentAttributes) }}');
 assert(!params.some(p=>['source_id','echo_id'].includes(p.name)));
 const message={id:31,status:'delivered',private:false,message_type:'outgoing',content_attributes:group[0].json.contentAttributes};
 const ack=await run('group','Conferir entrega sem reenviar',{json:{payload:[message]}});
 assert.equal(ack[0].json.outcome.status,'sent');assert.equal(ack[0].json.outcome.external_id,'31');
 const ambiguous=await run('group','Conferir entrega sem reenviar',{json:{payload:[message,{...message,id:32}]}});
 assert.equal(ambiguous[0].json.outcome.status,'uncertain');
 for(const available of [{...fields,exam_date:null},{pet_name:'Luna'},{}]){
  task.document.extracted_data=available;
  const partial=await run('group','Preparar PDF e correlação',{json:{},binary});
  assert.equal(partial[0].json.verified,true);
  assert(partial[0].json.content.includes('Informações incompletas'));
  assert.equal(partial[0].binary.data.fileName,examPresentation(task.document,base).fileName);
 }
});

test('initial group caption names only the resolved responsible veterinarian, preserving partial delivery',()=>{
 const assigned=examPresentation({...doc,responsible_vet_id:'vet-one',responsible_vet_name:'*Dra. Ana* Souza',responsible_vet_source:'sale'},base);
 assert(assigned.content.includes('🩺 *Responsável:* Dra. Ana Souza'));assert(!assigned.content.includes('Aguardando responsável'));
 for(const extra of [{assigned_to:'auth-actor'},{extracted_data:{...fields,requesting_vet_name:'Ana Souza'}},{responsible_vet_id:'vet-one',responsible_vet_name:'Ana Souza',responsible_vet_source:'conflict'}]){
  const out=examPresentation({...doc,...extra},base);assert(out.content.includes('Aguardando responsável'));assert(!out.content.includes('*Responsável:*'));
 }
 const partial=examPresentation({...doc,extracted_data:{pet_name:'Luna'},responsible_vet_id:'vet-one',responsible_vet_name:'Ana Souza',responsible_vet_source:'pdf'},base);
 assert.equal(partial.fileName,'Luna.pdf');assert(partial.content.includes('*Responsável:* Ana Souza'));
});

test('generated extraction schema requests explicit requester role and state-qualified registration',()=>{
 const prompt=node('processing','Extrair dados estruturados').parameters.jsonBody;
 assert(prompt.includes('requesting_vet_name:null|string'));assert(prompt.includes('requesting_vet_crmv:null|string'));
 assert(prompt.includes('Não use o nome do radiologista'));assert(prompt.includes('um número sem UF é null'));
 assert(prompt.includes('isso não impede o envio do exame'));
});
