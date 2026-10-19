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

const bloodSections = [
 'ERITROGRAMA\nHemácias 7,1 milhões/mm³\nHemoglobina 15,0 g/dL',
 'LEUCOGRAMA\nLeucócitos 10.500 /mm³\nSegmentados 70 %',
 'PLAQUETOGRAMA\nPlaquetas 320.000 /mm³',
];
function bloodData(type = 'Hemograma') {
 const data = copy(); data.fields.exam_type = type;
 data.evidence = data.evidence.filter(ev => ev.field !== 'exam_type');
 return data;
}
const bloodPages = sections => [pages[0].replace('RELATÓRIO RADIOGRÁFICO\nRegião: pelve e joelhos', sections.join('\n'))];

test('three current blood count sections normalize to Hemograma with three real page excerpts',()=>{
 const data=bloodData(); data.fields.exam_date='2026-10-16';
 data.evidence.push({field:'exam_date',page:1,excerpt:'Data do Laudo: 16/10/2026'});
 const report=bloodPages(bloodSections); assert.equal(report[0].includes('Hemograma'),false);
 const out=run(data,report);
 assert.equal(out.fields.exam_type,'Hemograma');assert.equal(out.classification,'exam');
 assert.equal(out.fields.pet_name,'LILI');assert.equal(out.fields.client_name,'Clara Beatriz Lopes Oliveira');
 assert.equal(out.fields.exam_date,'2026-10-16');assert.equal(out.extractor_version,'document-evidence-v6');
 assert.deepEqual(out.evidence.filter(ev=>ev.field==='exam_type'),bloodSections.map(section=>({field:'exam_type',page:1,excerpt:section.split('\n')[0]})));
 assert(out.evidence.every(ev=>report[ev.page-1].includes(ev.excerpt)));
});

test('headings may continue over pages, use ordinal prefixes or carry table column labels',()=>{
 const report=[
   ...bloodPages(['1. Eritrograma  Resultado  Valores de referência\nHemácias 7,1 milhões/mm³']),
   'II - Leucograma: Resultado | Valor de referência\nLeucócitos 10.500 /mm³',
   '3) PLAQUETOGRAMA — Valores de referência\nPlaquetas 320.000 /mm³',
 ];
 const out=run(bloodData('Eritrograma, Leucograma e Plaquetograma'),report);
 assert.equal(out.fields.exam_type,'Hemograma');
 assert.deepEqual(out.evidence.filter(ev=>ev.field==='exam_type').map(ev=>ev.page),[1,2,3]);
 assert(out.evidence.every(ev=>report[ev.page-1].includes(ev.excerpt)));
});

test('a missing, null or section-only type can be filled from the complete current report',()=>{
 for(const type of [undefined,null,'Leucograma','ERITROGRAMA / LEUCOGRAMA / PLAQUETOGRAMA','Hemograma completo']) {
  const data=bloodData(type);if(type===undefined) delete data.fields.exam_type;
  const out=run(data,bloodPages(bloodSections));assert.equal(out.fields.exam_type,'Hemograma');
  assert.equal(out.evidence.filter(ev=>ev.field==='exam_type').length,3);
 }
});

test('one or two blood count sections never establish the complete commercial exam',()=>{
 for(const sections of [bloodSections.slice(0,1),bloodSections.slice(1,2),bloodSections.slice(2),bloodSections.slice(0,2),bloodSections.slice(1),[bloodSections[0],bloodSections[2]]]) {
  const out=run(bloodData(),bloodPages(sections));
  assert.equal(out.fields.exam_type,null);assert.equal(out.classification,'review');
  assert.equal(out.fields.pet_name,'LILI');assert.equal(out.fields.client_name,'Clara Beatriz Lopes Oliveira');
  assert.equal(out.evidence.some(ev=>ev.field==='exam_type'),false);
 }
});

test('mentions, an order list, substring words and paraphrased evidence cannot stand in for section headings',()=>{
 for(const text of [
  'Recomenda-se eritrograma, leucograma e plaquetograma no retorno.',
  'Exames solicitados: Eritrograma\nExames solicitados: Leucograma\nExames solicitados: Plaquetograma',
  'Não foram realizados eritrograma, leucograma ou plaquetograma.',
  'ERITROGRAMALEUCOGRAMA\nPLAQUETOGRAMA',
  'Eritrograma Resultado esperado amanhã\nLeucograma Resultado esperado amanhã\nPlaquetograma Resultado esperado amanhã',
 ]) {
  const data=bloodData();data.evidence.push({field:'exam_type',page:1,excerpt:'Hemograma'});
  const out=run(data,bloodPages([text]));assert.equal(out.fields.exam_type,null);
 }
});

test('a cancelled, missing or pending section is not counted even when the model crops its qualifier',()=>{
 for(const unavailable of ['não realizado','não foi realizado','não há resultados','não foi possível realizar','Não solicitado','SEM RESULTADOS','sem material','cancelado','pendente']) {
  for(const section of ['PLAQUETOGRAMA: '+unavailable,'PLAQUETOGRAMA\n'+unavailable]) {
   const data=bloodData();data.evidence.push(...['ERITROGRAMA','LEUCOGRAMA','PLAQUETOGRAMA'].map(excerpt=>({field:'exam_type',page:1,excerpt})));
   assert.equal(run(data,bloodPages([...bloodSections.slice(0,2),section])).fields.exam_type,null);
  }
 }
});

test('historical, reference and non-performed blocks cannot supply missing sections',()=>{
 for(const label of ['Histórico','Histórico clínico','Resultados anteriores','Resultados do exame anterior','Exames anteriores','Referência histórica','Bibliografia','Exemplo','Não realizado','Não foi realizado','Exames não realizados']) {
  const report=bloodPages([bloodSections[0],label+':',...bloodSections.slice(1)]);
  assert.equal(run(bloodData(),report).fields.exam_type,null,label);
 }
 const report=[...bloodPages([bloodSections[0],'Resultados anteriores:',bloodSections[1]]),bloodSections[2]];
 assert.equal(run(bloodData(),report).fields.exam_type,null);
});

test('an explicit current results block may follow historical results without citing the old headings',()=>{
 const report=bloodPages(['Histórico:',...bloodSections,'Resultados atuais:',...bloodSections.map(section=>section.toLocaleLowerCase('pt-BR'))]);
 const out=run(bloodData(),report);assert.equal(out.fields.exam_type,'Hemograma');
 assert.deepEqual(out.evidence.filter(ev=>ev.field==='exam_type').map(ev=>ev.excerpt),['eritrograma','leucograma','plaquetograma']);
});

test('a different explicit panel or a combined exam retains its own evidenced type',()=>{
 for(const type of ['RELATÓRIO RADIOGRÁFICO','Hemograma + Bioquímica','Eritrograma e PCR','Leucograma e Urinálise']) {
  const data=bloodData(type);data.evidence.push({field:'exam_type',page:1,excerpt:type});
  const out=run(data,bloodPages([type,...bloodSections]));
  assert.equal(out.fields.exam_type,type);assert.deepEqual(out.evidence.filter(ev=>ev.field==='exam_type'),[{field:'exam_type',page:1,excerpt:type}]);
 }
});

test('normalizing the exam type never upgrades uncertainty, combines patients or overrides not-exam',()=>{
 const uncertain=bloodData();uncertain.classification='review';uncertain.review_reason='Conferir identificação';
 const reviewed=run(uncertain,bloodPages(bloodSections));assert.equal(reviewed.fields.exam_type,'Hemograma');assert.equal(reviewed.classification,'review');
 for(const classification of ['exam','review','not_exam']) {
  const data=bloodData();data.classification=classification;data.single_patient=false;
  const out=run(data,bloodPages(bloodSections));assert.equal(out.fields.exam_type,null);assert.notEqual(out.classification,'exam');
 }
 const notExam=bloodData();notExam.classification='not_exam';
 assert.equal(run(notExam,bloodPages(bloodSections)).classification,'not_exam');
 assert.equal(run(notExam,bloodPages(bloodSections)).fields.exam_type,null);
});

// Same row structure as the n8n native parser, with fictitious identities.
const identificationHeader = [
 'Clínica veterinária Médico veterinário CRMV',
 'CLÍNICA MODELO Ana Beatriz Souza 12345',
 'Paciente Idade Sexo',
 'LILI 10a Fêmea',
 'Responsável Raça Data coleta',
 'Clara Beatriz Lopes Oliveira Canino / MALTÊS 16/10/2026',
].join('\n');
const requesterData = header => {
 const data=copy();data.fields.requesting_vet_name='Ana Beatriz Souza';
 data.evidence.push({field:'requesting_vet_name',page:1,excerpt:header});return data;
};

test('the native single-space identification table proves the full named veterinarian and collection date',()=>{
 const data=requesterData(identificationHeader);data.fields.exam_date='2026-10-16';
 data.fields.requesting_vet_crmv='12345';
 data.evidence.push({field:'exam_date',page:1,excerpt:identificationHeader.split('\n').slice(4).join('\n')});
 data.evidence.push({field:'requesting_vet_crmv',page:1,excerpt:identificationHeader});
 const report=[pages[0]+'\n'+identificationHeader+'\nLiberado por: Outro Profissional CRMV SP-54321'];
 const out=run(data,report);
 assert.equal(out.fields.requesting_vet_name,'Ana Beatriz Souza');
 assert.equal(out.fields.requesting_vet_crmv,null,'an unqualified numeric registration is still not assigned a state');
 assert.equal(out.fields.exam_date,'2026-10-16');assert.equal(out.classification,'exam');
 assert(out.evidence.every(ev=>report[ev.page-1].includes(ev.excerpt)));
});

test('physical column gaps also work without borrowing a clinic name or only part of the veterinarian name',()=>{
 const header=identificationHeader.replace('Clínica veterinária Médico veterinário CRMV','Clínica veterinária   Médico veterinário   CRMV')
  .replace('CLÍNICA MODELO Ana Beatriz Souza 12345','CLÍNICA MODELO   Ana Beatriz Souza   SP-12345')
  .replace('Paciente Idade Sexo','Paciente   Idade   Sexo').replace('LILI 10a Fêmea','LILI   10a   Fêmea')
  .replace('Responsável Raça Data coleta','Responsável   Raça   Data coleta')
  .replace('Clara Beatriz Lopes Oliveira Canino / MALTÊS 16/10/2026','Clara Beatriz Lopes Oliveira   Canino / MALTÊS   16/10/2026');
 const data=requesterData(header.replace(/\s+/gu,' '));data.fields.requesting_vet_crmv='SP-12345';
 data.evidence.push({field:'requesting_vet_crmv',page:1,excerpt:header});
 const report=[pages[0]+'\n'+header];const out=run(data,report);
 assert.equal(out.fields.requesting_vet_name,'Ana Beatriz Souza');assert.equal(out.fields.requesting_vet_crmv,'SP-12345');
 for(const name of ['Beatriz Souza','CLÍNICA MODELO Ana Beatriz Souza']) {
  data.fields.requesting_vet_name=name;assert.equal(run(data,report).fields.requesting_vet_name,null);
 }
});

test('generic veterinarian evidence must include the same validated pet and guardian, not another patient header',()=>{
 for(const header of [
  identificationHeader.replace('LILI 10a','LUNA 10a'),
  identificationHeader.replace('Clara Beatriz Lopes Oliveira Canino','HELENA Canino'),
  identificationHeader.replace('LILI 10a','LUNA 10a').replace('Clara Beatriz Lopes Oliveira Canino','HELENA Canino'),
 ]) {
  const out=run(requesterData(header),[pages[0]+'\n'+header]);
  assert.equal(out.fields.requesting_vet_name,null);assert.equal(out.fields.pet_name,'LILI');
  assert.equal(out.fields.client_name,'Clara Beatriz Lopes Oliveira');
 }
 for(const missing of ['pet_name','client_name']) {
  const data=requesterData(identificationHeader);data.fields[missing]=null;
  assert.equal(run(data,[pages[0]+'\n'+identificationHeader]).fields.requesting_vet_name,null);
 }
});

test('a generic title alone, a signer quote or missing collection context never identifies the requester',()=>{
 for(const quote of [
  'Médico veterinário: Ana Beatriz Souza',
  identificationHeader+'\nLiberado por: Ana Beatriz Souza',
  identificationHeader+'\nAssinatura: Ana Beatriz Souza',
  identificationHeader+'\nResponsável técnico: Ana Beatriz Souza',
  identificationHeader+'\nRT: Ana Beatriz Souza',
  identificationHeader.replace('Data coleta','Data nascimento'),
  identificationHeader.replace('Paciente Idade Sexo\nLILI 10a Fêmea\n',''),
 ]) {
  const out=run(requesterData(quote),[pages[0]+'\n'+quote]);assert.equal(out.fields.requesting_vet_name,null,quote);
 }
});

test('a directly labelled medical veterinarian is accepted only with the same inline identification context',()=>{
 const quote='Paciente: LILI\nTutor: Clara Beatriz Lopes Oliveira\nData de coleta: 16/10/2026\nMédica Veterinária: Dra. Ana Beatriz Souza';
 assert.equal(run(requesterData(quote),[pages[0]+'\n'+quote]).fields.requesting_vet_name,'Ana Beatriz Souza');
 const foreign=quote.replace('Paciente: LILI','Paciente: LUNA');
 assert.equal(run(requesterData(foreign),[pages[0]+'\n'+foreign]).fields.requesting_vet_name,null);
});

test('collection date maps only the terminal date of the explicit guardian/race/collection header',()=>{
 const make=(header,excerpt=header)=>run({classification:'review',single_patient:true,fields:{exam_date:'2026-10-16'},evidence:[{field:'exam_date',page:1,excerpt}]},[header]);
 assert.equal(make(identificationHeader).fields.exam_date,'2026-10-16');
 for(const header of [
  identificationHeader.replace('Data coleta','Data nascimento'),
  identificationHeader.replace('Data coleta','Data recebimento'),
  identificationHeader.replace('16/10/2026','31/02/2026'),
  identificationHeader.replace('Clara Beatriz Lopes Oliveira Canino / MALTÊS 16/10/2026','Clara Beatriz Lopes Oliveira 16/10/2026 Canino / MALTÊS'),
  identificationHeader.replace('Clara Beatriz Lopes Oliveira Canino / MALTÊS 16/10/2026','Clara Beatriz Lopes Oliveira 15/10/2026 Canino / MALTÊS 16/10/2026'),
 ]) assert.equal(make(header).fields.exam_date,null);
 assert.equal(make(identificationHeader,'16/10/2026').fields.exam_date,null,'cropping the table header cannot prove its date column');
});

test('a requested-only block never establishes performed haematology sections',()=>{
 for(const marker of ['Exames solicitados','Solicitação de exames','Exames a realizar']) {
  const report=bloodPages([marker+':',...bloodSections]);
  const data=bloodData(null);data.classification='review';
  assert.equal(run(data,report).fields.exam_type,null,marker);
 }
});

test('the complete count preserves evidenced Creatinina and Ureia components in canonical order',()=>{
 const extras=['CREATININA Resultado Referência\n0,8 mg/dL','URÉIA Resultado Referência\n45,2 mg/dL'];
 for(const [extra,expected] of [[[],'Hemograma'],[[extras[0]],'Hemograma + Creatinina'],[[extras[1]],'Hemograma + Ureia'],[extras,'Hemograma + Creatinina + Ureia']]) {
  const report=[...bloodPages(bloodSections),extra.join('\n') || 'Imagem.'];
  const out=run(bloodData('Eritrograma'),report);
  assert.equal(out.fields.exam_type,expected);assert.equal(out.evidence.filter(ev=>ev.field==='exam_type').length,3+extra.length);
  assert(out.evidence.every(ev=>report[ev.page-1].includes(ev.excerpt)));
 }
 const historical=run(bloodData(),[...bloodPages(bloodSections),'Resultados anteriores:\n'+extras.join('\n')]);
 assert.equal(historical.fields.exam_type,'Hemograma');
 const unrelated=run(bloodData(),[...bloodPages(bloodSections),'GLICOSE Resultado Referência\n100 mg/dL']);
 assert.equal(unrelated.fields.exam_type,null,'an unknown current panel is kept for review rather than erased');
});


test('a short literal veterinarian header expands to adjacent original identity rows',()=>{
 const short=identificationHeader.split('\n').slice(0,2).join('\n');
 const report=[pages[0]+'\n'+identificationHeader+'\nLiberado por: Pedro Lima'];
 const out=run(requesterData(short),report);
 assert.equal(out.fields.requesting_vet_name,'Ana Beatriz Souza');
 assert.equal(out.evidence.find(ev=>ev.field==='requesting_vet_name').excerpt,identificationHeader);
 assert(report[0].includes(out.evidence.find(ev=>ev.field==='requesting_vet_name').excerpt));
 assert.equal(out.extractor_version,'document-evidence-v6');
});

test('short header expansion cannot borrow another patient, guardian, page or missing context',()=>{
 const short=identificationHeader.split('\n').slice(0,2).join('\n');
 for(const report of [
  [pages[0]+'\n'+identificationHeader.replace('LILI 10a','LUNA 10a')],
  [pages[0]+'\n'+identificationHeader.replace('Clara Beatriz Lopes Oliveira Canino','HELENA Canino')],
  [pages[0]+'\n'+short,identificationHeader.split('\n').slice(2).join('\n')],
  [pages[0]+'\n'+identificationHeader.replace('Data coleta','Data nascimento')],
  [pages[0]+'\n'+short+'\nAssinatura: Ana Beatriz Souza\n'+identificationHeader.split('\n').slice(2).join('\n')],
 ]) assert.equal(run(requesterData(short),report).fields.requesting_vet_name,null);
 const data=requesterData('Ana Beatriz Souza');
 assert.equal(run(data,[pages[0]+'\n'+identificationHeader]).fields.requesting_vet_name,null);
});
