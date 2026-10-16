import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';

const workflow=JSON.parse(await fs.readFile(new URL('../../n8n/exames/OPERACIONAL-02.json',import.meta.url),'utf8'));
const code=workflow.nodes.find(node=>node.name==='Validar JSON e evidências').parameters.jsCode;
const task={id:'processing-task',document:{id:'11111111-1111-4111-a111-111111111111'}};
const pages=['Pet: Luna. Tutor: Ana. Hemograma. Realizado em 14/10/2026.'];
const context={task,pages,totalPages:1,extraction:{classification:'review',single_patient:false,fields:{},evidence:[]}};
const complete={classification:'exam',single_patient:true,
  fields:{pet_name:'Luna',client_name:'Ana',exam_type:'Hemograma',exam_date:'2026-10-14'},
  evidence:[{field:'pet_name',page:1,excerpt:'Pet: Luna.'},{field:'client_name',page:1,excerpt:'Tutor: Ana.'},
    {field:'exam_type',page:1,excerpt:'Hemograma.'},{field:'exam_date',page:1,excerpt:'Realizado em 14/10/2026.'}]};

async function validate(data){
  const result=await new vm.Script('(async function(){'+code+'})()').runInNewContext({
    $json:{choices:[{message:{content:JSON.stringify(data)}}]},
    $:name=>{assert.equal(name,'Preparar classificação ou revisão');return {item:{json:context}};},
  });
  return JSON.parse(JSON.stringify(result[0].json));
}

test('an exam without tutor retains independently evidenced pet, type and date for review',async()=>{
  const data=structuredClone(complete);delete data.fields.client_name;
  data.evidence=data.evidence.filter(e=>e.field!=='client_name');
  const result=await validate(data);
  assert.deepEqual(result.task,task);assert.equal(result.extraction.classification,'review');
  assert.deepEqual(result.extraction.fields,data.fields);assert.deepEqual(result.extraction.evidence,data.evidence);
  assert.match(result.extraction.review_reason,/Identificação incompleta/);
});

test('missing pet or uncertain single patient preserves valid metadata without becoming link-ready',async()=>{
  for(const change of ['pet','single_patient']){
    const data=structuredClone(complete);
    if(change==='pet'){delete data.fields.pet_name;data.evidence=data.evidence.filter(e=>e.field!=='pet_name');}
    else data.single_patient=false;
    data.review_reason='Identidade requer conferência';
    const {extraction}=await validate(data);
    assert.equal(extraction.classification,'review');assert.equal(extraction.single_patient,data.single_patient);
    assert.deepEqual(extraction.fields,data.fields);assert.deepEqual(extraction.evidence,data.evidence);
    assert.match(extraction.review_reason,/Identidade requer conferência/);assert.match(extraction.review_reason,/Identificação incompleta/);
  }
});

test('invalid or unevidenced values and dates still discard extraction instead of trusting partial identity',async()=>{
  for(const mutation of [
    data=>{data.fields.pet_name='Mel';},
    data=>{data.fields.exam_type='Ultrassom';},
    data=>{data.fields.exam_date='2026-10-15';},
    data=>{data.fields.exam_date='2026-02-30';},
    data=>{data.evidence=data.evidence.filter(e=>e.field!=='exam_date');},
    data=>{data.evidence.find(e=>e.field==='exam_type').page=2;},
    data=>{data.evidence.find(e=>e.field==='exam_type').excerpt='Hemograma não consta no PDF';},
    data=>{data.review_reason={unsafe:'object'};},
  ]){
    const data=structuredClone(complete);delete data.fields.client_name;
    data.evidence=data.evidence.filter(e=>e.field!=='client_name');mutation(data);
    const {extraction}=await validate(data);
    assert.equal(extraction.classification,'review');assert.deepEqual(extraction.fields,{});assert.deepEqual(extraction.evidence,[]);
    assert.match(extraction.review_reason,/Resposta do extrator inválida/);
  }
});

test('fully evidenced exam and explicit not-exam classification retain their original semantics',async()=>{
  const accepted=(await validate(complete)).extraction;
  assert.equal(accepted.classification,'exam');assert.deepEqual(accepted.fields,complete.fields);assert.equal(accepted.review_reason,null);
  const rejected={classification:'not_exam',single_patient:false,fields:{},evidence:[],review_reason:'Boleto'};
  const out=(await validate(rejected)).extraction;
  assert.equal(out.classification,'not_exam');assert.equal(out.review_reason,'Boleto');assert.deepEqual(out.fields,{});
});
