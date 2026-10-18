import test from 'node:test';
import assert from 'node:assert/strict';
import {validateExamExtraction} from './extraction-validation.mjs';

const pages=['Nome: LILI\nAcompanhante do Exame: Clara Beatriz Lopes\nOliveira\nEspécie: CANINA\nData do Laudo: 16/10/2026\nRELATÓRIO RADIOGRÁFICO\nRegião: pelve e joelhos', ...Array(5).fill('Imagem radiográfica.'), 'Enviado para a CLÍNICA\nMODELO.'];
const source={classification:'exam',single_patient:true,fields:{pet_name:'LILI',client_name:'Clara Beatriz Lopes Oliveira',exam_type:'RELATÓRIO RADIOGRÁFICO',exam_date:null,lab_name:'CLÍNICA MODELO',species:'canina'},evidence:[
  {field:'pet_name',page:1,excerpt:'Nome: LILI'},
  {field:'client_name',page:1,excerpt:'Acompanhante do Exame: Clara Beatriz Lopes Oliveira'},
  {field:'exam_type',page:1,excerpt:'RELATÓRIO RADIOGRÁFICO'},
  {field:'lab_name',page:7,excerpt:'CLÍNICA MODELO'},
  {field:'species',page:1,excerpt:'Espécie: CANINA'},
]};
const run=(data=source,sourcePages=pages)=>validateExamExtraction({pages:sourcePages,totalPages:sourcePages.length},{choices:[{message:{content:JSON.stringify(data)}}]});
const copy=()=>structuredClone(source);

test('seven-page report retains full wrapped tutor name and exact original evidence',()=>{
  const out=run();assert.equal(out.classification,'exam');assert.deepEqual(out.fields,source.fields);
  assert.equal(out.fields.client_name,'Clara Beatriz Lopes Oliveira');
  assert.equal(out.fields.exam_date,null);
  assert.equal(out.evidence.find(e=>e.field==='client_name').excerpt,'Acompanhante do Exame: Clara Beatriz Lopes\nOliveira');
  assert(out.evidence.every(e=>pages[e.page-1].includes(e.excerpt)));
});

test('one paraphrased exam type or unsupported optional field never erases valid identity',()=>{
  for(const field of ['exam_type','species']){
    const data=copy();data.fields[field]=field==='exam_type'?'radiografia de pelve e joelhos':'felina';
    const out=run(data);assert.equal(out.classification,field==='exam_type'?'review':'exam');assert.equal(out.fields[field],null);
    assert.equal(out.fields.client_name,source.fields.client_name);assert.equal(out.fields.pet_name,'LILI');
    assert.equal(out.evidence.some(e=>e.field===field),false);assert.match(out.review_reason,new RegExp(field));
  }
});

test('extra invalid evidence and unsupported fields cannot poison independently supported fields',()=>{
  const data=copy();data.evidence.push({field:'species',page:99,excerpt:'inexistente'},null,{field:'hidden_id',page:1,excerpt:'Nome'});
  data.fields.hidden_id='not-a-database-id';data.review_reason={not:'text'};
  const out=run(data);assert.deepEqual(out.fields,source.fields);assert.equal(out.review_reason,null);
  assert.equal(Object.hasOwn(out.fields,'hidden_id'),false);assert.equal(out.evidence.length,5);
});

test('evidence tolerates spaces, NBSP and canonical Unicode but never joins words',()=>{
  const data=copy();data.evidence.find(e=>e.field==='client_name').excerpt='Acompanhante do Exame:  Clara\u00a0Beatriz Lopes Oliveira';
  const unicodePages=[pages[0].normalize('NFD'),...pages.slice(1)];
  const out=run(data,unicodePages);assert.equal(out.fields.client_name,source.fields.client_name);assert(out.evidence.every(e=>unicodePages[e.page-1].includes(e.excerpt)));
  data.fields.client_name='ClaraBeatriz Lopes Oliveira';data.evidence.find(e=>e.field==='client_name').excerpt='Acompanhante do Exame: ClaraBeatriz Lopes Oliveira';
  assert.equal(run(data).fields.client_name,null);
});

test('a quote cannot span pages, change punctuation, or cite another field without literal support',()=>{
  for(const ev of [{page:2,excerpt:'Nome: LILI'},{page:1,excerpt:'Nome: LILI\nImagem radiográfica.'},{page:1,excerpt:'Nome; LILI'}]){
    const data=copy();Object.assign(data.evidence[0],ev);const out=run(data);
    assert.equal(out.fields.pet_name,null);assert.equal(out.fields.client_name,source.fields.client_name);assert.equal(out.classification,'review');
  }
});

test('a genuine single-word printed tutor remains valid and is never expanded',()=>{
  const data=copy();data.fields.client_name='Clara';data.evidence.find(e=>e.field==='client_name').excerpt='Acompanhante do Exame: Clara';
  const out=run(data,[pages[0].replace('Clara Beatriz Lopes\nOliveira','Clara'),...pages.slice(1)]);
  assert.equal(out.fields.client_name,'Clara');assert.equal(out.classification,'exam');
});

test('headings on a new line and separate columns do not look like missing surnames',()=>{
  for(const text of ['Tutor: Ana Maria\nRELATÓRIO RADIOGRÁFICO','Nome: Lili\nDESCRIÇÃO\nTutor: Ana Maria','Nome: Lili    Labrador\nTutor: Ana Maria']){
    const pet=text.includes('Lili');
    const data={classification:'review',single_patient:true,fields:{client_name:'Ana Maria',...(pet?{pet_name:'Lili'}:{})},evidence:[{field:'client_name',page:1,excerpt:'Tutor: Ana Maria'},...(pet?[{field:'pet_name',page:1,excerpt:'Nome: Lili'}]:[])]};
    const out=run(data,[text]);assert.deepEqual(out.fields,data.fields);
  }
});

test('uncertain single-patient identity remains review while partial fields remain visible',()=>{
  const data=copy();data.single_patient=false;delete data.fields.client_name;data.evidence=data.evidence.filter(e=>e.field!=='client_name');
  const out=run(data);assert.equal(out.classification,'review');assert.equal(out.single_patient,false);
  assert.equal(out.fields.pet_name,'LILI');assert.equal(out.fields.exam_type,'RELATÓRIO RADIOGRÁFICO');
});

test('report, issue and signature dates are accepted as documentary exam dates',()=>{
  for(const label of ['Data do Laudo','Data de emissão','Data da assinatura','Assinatura','Laudo emitido em','Laudo\nrealizado em']){
    const data=copy();data.fields.exam_date='2026-10-16';data.evidence.push({field:'exam_date',page:1,excerpt:label+': 16/10/2026'});
    const sourcePages=[pages[0].replace('Data do Laudo',label),...pages.slice(1)];
    const out=run(data,sourcePages);assert.equal(out.fields.exam_date,'2026-10-16');
    assert.equal(out.fields.client_name,source.fields.client_name);assert.equal(out.classification,'exam');
    assert(out.evidence.every(e=>sourcePages[e.page-1].includes(e.excerpt)));
  }
});

test('receipt, birth, generic and negated dates stay excluded',()=>{
  for(const label of ['Recebido em','Data de recebimento','Nascimento','Data de nascimento','Exame não realizado em','Versão','Atualizado em']){
    const data=copy();data.fields.exam_date='2026-10-16';data.evidence.push({field:'exam_date',page:1,excerpt:label+': 16/10/2026'});
    const out=run(data,[pages[0].replace('Data do Laudo',label),...pages.slice(1)]);
    assert.equal(out.fields.exam_date,null);assert.equal(out.fields.client_name,source.fields.client_name);
  }
});

test('the date evidence must have its own valid label even if the quote is cropped',()=>{
  const data=copy();data.fields.exam_date='2026-10-16';
  const text='Coleta: 14/10/2026. Data do Laudo: 16/10/2026. Recebido em: 17/10/2026.';
  data.evidence.push({field:'exam_date',page:1,excerpt:text});
  const sourcePages=[pages[0]+'\n'+text,...pages.slice(1)];
  assert.equal(run(data,sourcePages).fields.exam_date,'2026-10-16');
  data.fields.exam_date='2026-10-14';assert.equal(run(data,sourcePages).fields.exam_date,'2026-10-14');
  data.fields.exam_date='2026-10-17';data.evidence.at(-1).excerpt='17/10/2026';
  assert.equal(run(data,sourcePages).fields.exam_date,null);
});

test('explicit clinical labels support valid calendar dates and reject impossible or unevidenced ones',()=>{
  for(const label of ['Realizado em','Data de realização','Coleta','Data do exame']){
    const data=copy();data.fields.exam_date='2026-10-14';data.evidence.push({field:'exam_date',page:1,excerpt:label+': 14/10/2026'});
    const sourcePages=[pages[0]+'\n'+label+': 14/10/2026',...pages.slice(1)];
    assert.equal(run(data,sourcePages).fields.exam_date,'2026-10-14');
    for(const date of ['2026-02-30','2026-10-15','14/10/2026']){data.fields.exam_date=date;assert.equal(run(data,sourcePages).fields.exam_date,null);}
  }
});

test('malformed envelopes fail safely and explicit non-exam decisions are preserved',()=>{
  for(const content of ['not JSON','null',JSON.stringify({...source,single_patient:'true'}),JSON.stringify({...source,fields:[]})]){
    const out=validateExamExtraction({pages,totalPages:pages.length},{choices:[{message:{content}}]});
    assert.equal(out.classification,'review');assert.deepEqual(out.fields,{});assert.deepEqual(out.evidence,[]);
  }
  const out=run({classification:'not_exam',single_patient:false,fields:{},evidence:[],review_reason:'Documento financeiro'});
  assert.equal(out.classification,'not_exam');assert.equal(out.review_reason,'Documento financeiro');
});

test('clinical date labels can wrap lines and numeric day/month need not be zero-padded',()=>{
  for(const date of ['1/2/2026','01/2/2026','1/02/2026','01/02/2026']){
    const text='Data de realização:\n'+date;
    const data=copy();data.fields.exam_date='2026-02-01';data.evidence.push({field:'exam_date',page:1,excerpt:text.replace('\n',' ')});
    assert.equal(run(data,[pages[0]+'\n'+text,...pages.slice(1)]).fields.exam_date,'2026-02-01');
  }
});

test('only the explicitly labelled requester is collected, preserving the full printed name',()=>{
 const data=copy();data.fields.requesting_vet_name='Ana Beatriz Souza';
 data.fields.requesting_vet_crmv='SP-12345';
 const quote='Médica Veterinária Solicitante: Dra. Ana Beatriz Souza\nCRMV: SP-12345';
 data.evidence.push(...['requesting_vet_name','requesting_vet_crmv'].map(field=>({field,page:1,excerpt:quote})));
 const out=run(data,[pages[0]+'\n'+quote+'\nLaudante: Dr. Pedro Lima CRMV SP-54321',...pages.slice(1)]);
 assert.equal(out.fields.requesting_vet_name,'Ana Beatriz Souza');assert.equal(out.fields.requesting_vet_crmv,'SP-12345');
 assert.equal(out.classification,'exam');
});

test('report signer, technical director, copied signature or an unqualified CRMV never becomes requester',()=>{
 for(const label of ['Laudante','Radiologista','Responsável técnico','Assinado por','Médico Veterinário','Tutor']){
  const data=copy();data.fields.requesting_vet_name='Ana Beatriz Souza';
  const quote=label+': Ana Beatriz Souza';data.evidence.push({field:'requesting_vet_name',page:1,excerpt:quote});
  const out=run(data,[pages[0]+'\n'+quote,...pages.slice(1)]);
  assert.equal(out.fields.requesting_vet_name,null);assert.equal(out.classification,'exam');assert.equal(out.fields.pet_name,'LILI');
 }
 const data=copy();data.fields.requesting_vet_name='Ana Beatriz Souza';data.fields.requesting_vet_crmv='12345';
 const quote='Solicitante: Ana Beatriz Souza CRMV: 12345';
 data.evidence.push(...['requesting_vet_name','requesting_vet_crmv'].map(field=>({field,page:1,excerpt:quote})));
 assert.equal(run(data,[pages[0]+'\n'+quote,...pages.slice(1)]).fields.requesting_vet_crmv,null);
});

test('a requester label for another person does not validate the signer later in the quote',()=>{
 const data=copy();data.fields.requesting_vet_name='Pedro Lima';
 const quote='Solicitante: Ana Souza\nRadiologista: Pedro Lima';
 data.evidence.push({field:'requesting_vet_name',page:1,excerpt:quote});
 assert.equal(run(data,[pages[0]+'\n'+quote,...pages.slice(1)]).fields.requesting_vet_name,null);
});

test('another professional registration in a wider quote is not assigned to the requester',()=>{
 const data=copy();data.fields.requesting_vet_name='Ana Beatriz Souza';data.fields.requesting_vet_crmv='SP-54321';
 const quote='Solicitante: Ana Beatriz Souza CRMV SP-12345\nResponsável técnico: Pedro Lima CRMV SP-54321';
 data.evidence.push(...['requesting_vet_name','requesting_vet_crmv'].map(field=>({field,page:1,excerpt:quote})));
 const out=run(data,[pages[0]+'\n'+quote,...pages.slice(1)]);
 assert.equal(out.fields.requesting_vet_name,'Ana Beatriz Souza');assert.equal(out.fields.requesting_vet_crmv,null);
});
