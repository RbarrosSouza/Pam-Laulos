import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const require=createRequire(import.meta.url);
function load(path,mocks={}) {
 const source=readFileSync(new URL(`../../../${path}`,import.meta.url),'utf8');
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}}; new Function('require','module','exports',js)(name=>Object.hasOwn(mocks,name)?mocks[name]:name==='react'||name==='react/jsx-runtime'?require(name):(()=>{throw new Error(`Unmocked ${name}`)})(),module,module.exports);return module.exports;
}
const intake=load('src/components/intake/IntakeReceiptsView.tsx');
const view=load('src/components/intake/ExamFailuresView.tsx',{'./IntakeReceiptsView':intake});
const now=Date.parse('2026-10-28T15:00:00Z');
const row={document_id:'11111111-1111-4111-8111-111111111111',original_name:'sem nome.pdf',received_at:'2026-10-28T14:00:00Z',pet_name:'Paciente fictício',client_name:'Tutor fictício',exam_type:'Bioquímico',channel:'email',issue_kind:'group',status:'uncertain',reason:'group_delivery_uncertain'};
const channels=[{provider:'gmail',activity:'recent',last_checked:'2026-10-28T14:55:00Z'},{provider:'outlook',activity:'not_configured',last_checked:null},{provider:'chatwoot',activity:'stale',last_checked:'2026-10-28T13:00:00Z'}];
const fixture=(overrides={})=>({contract:'exam_intake_exam_failures_v1',as_of:new Date(now).toISOString(),attention_cutoff:'2026-10-28T12:00:00Z',coverage_status:'unproven',channels,total:1,has_more:false,next_cursor:null,rows:[row],unclassified_receipts_total:9876,unclassified_documents_total:0,...overrides});
const render=props=>renderToStaticMarkup(createElement(view.ExamFailuresView,{now,...props}));

test('shows identified exam, group uncertainty and a safe detail link, not unclassified receipt counts',()=>{
 const html=render({data:fixture()});assert.match(html,/Paciente fictício · Tutor fictício/);assert.match(html,/Bioquímico · E-mail/);assert.match(html,/Uma tentativa de envio ao grupo precisa de confirmação/);assert(!html.includes('Falha no envio'));assert(!html.includes('9876'));assert.match(html,/Não foi possível confirmar a conferência/);assert.match(html,/Gmail: atividade em/);assert.match(html,/Outlook: conferência não configurada/);assert.match(html,/WhatsApp: sem atualização recente; verificar coletor/);assert(!html.includes('/recebimentos/auditoria'));assert.match(html,/href="\/novos-exames\/11111111-1111-4111-8111-111111111111"/);
 const failed=render({data:fixture({rows:[{...row,issue_kind:'processing',status:'failed',reason:'processing_failed'}]})});assert.match(failed,/Falha ao processar/);
});
test('query failures and paused snapshots never report an empty current queue',()=>{
 for(const props of [{error:true},{error:true,data:fixture({total:0,rows:[]})},{loading:true,paused:true}]) {const html=render(props);assert.match(html,/Não foi possível consultar/);assert(!html.includes('Nenhum exame identificado'));}
 const old=render({data:fixture({as_of:'2026-10-28T14:00:00Z'})});assert.match(old,/Consulta antiga ou pausada/);
 const empty=render({data:fixture({total:0,rows:[],unclassified_receipts_total:0})});assert.match(empty,/Nenhum exame identificado/);assert.match(empty,/Não foi possível confirmar/);
 const unconfigured=render({data:fixture({attention_cutoff:null,coverage_status:'not_configured',total:0,rows:[]})});assert.match(unconfigured,/ainda não foi iniciada/);assert(!unconfigured.includes('Nenhum exame identificado'));
});
test('pagination retains a way back when the result set changes and never hides more rows',()=>{
 const html=render({data:fixture({total:21,has_more:true,next_cursor:{age_from:'2026-10-28T14:00:00Z',document_id:row.document_id}}),pageNumber:1,onNext:()=>{},onPrevious:()=>{}});assert.match(html,/Página 1 · 1 nesta consulta/);assert.match(html,/Próxima/);
 const last=render({data:fixture({total:0,rows:[]}),pageNumber:2,onNext:()=>{},onPrevious:()=>{}});assert.match(last,/Nenhum exame nesta página/);assert.match(last,/Anterior/);
 const compact=render({data:fixture({total:4}),compact:true});assert.match(compact,/Abrir lista de exames/);assert(!compact.includes('recebimentos/auditoria'));
});
test('RPC contract rejects malformed data and links',()=>{
 assert(view.isExamFailures(fixture()));assert(!view.isExamFailures(fixture({channels:[]})));assert(!view.isExamFailures(fixture({rows:[{...row,document_id:'javascript:alert(1)'}]})));assert(!view.isExamFailures(fixture({rows:[{...row,status:'sent'}]})));assert(!view.isExamFailures({...fixture(),contract:'unknown'}));assert(!view.isExamFailures(fixture({has_more:true,next_cursor:null})));assert(!view.isExamFailures(fixture({next_cursor:undefined})));assert(!view.isExamFailures(fixture({has_more:true,next_cursor:{age_from:'invalid',document_id:row.document_id}})));
});
test('proven coverage removes the warning and whatsapp sources are clearly identified',()=>{
 const html=render({data:fixture({coverage_status:'proven',rows:[{...row,channel:'whatsapp'}],unclassified_receipts_total:0,unclassified_documents_total:9999})});assert.match(html,/Bioquímico · WhatsApp/);assert(!html.includes('Não foi possível confirmar'));assert(!html.includes('9999'));
 assert.match(render({data:fixture({rows:[{...row,channel:'both'}]})}),/E-mail e WhatsApp/);
});
test('query is membership gated, keyed by user and page, and rejects malformed responses',async()=>{
 let options,auth={session:{user:{id:'u1'}},membership:{}},response={data:fixture(),error:null};const calls=[];
 const {useExamIntakeFailures}=load('src/hooks/useExamIntakeFailures.ts',{'@tanstack/react-query':{useQuery:o=>(options=o)},'@/lib/supabase':{supabase:{rpc:async(...args)=>(calls.push(args),response)}},'@/contexts/exam-auth':{useExamAuth:()=>auth},'@/components/intake/ExamFailuresView':view});
 useExamIntakeFailures({age_from:'2026-10-28T14:00:00Z',document_id:row.document_id});assert.deepEqual(options.queryKey,['exam-intake-exam-failures-v1','u1','2026-10-28T14:00:00Z',row.document_id,0]);assert.equal(options.enabled,true);assert.equal(options.refetchInterval,30000);await options.queryFn();assert.deepEqual(calls,[['get_exam_intake_exam_failures',{p_limit:20,p_offset:0,p_after_age_from:'2026-10-28T14:00:00Z',p_after_document_id:row.document_id}]]);
 response={data:{},error:null};await assert.rejects(options.queryFn,/incompleta/);response={data:null,error:new Error('unavailable')};await assert.rejects(options.queryFn,/unavailable/);auth={session:null,membership:null};useExamIntakeFailures();assert.equal(options.enabled,false);
});

test('unreadable file is shown honestly with a safe link and no invented name',()=>{
 const html=render({data:fixture({rows:[{...row,pet_name:null,client_name:null,exam_type:null,original_name:null,issue_kind:'processing',status:'failed',reason:'unreadable_file'}]})});
 assert.match(html,/Arquivo sem nome/);assert.match(html,/Não foi possível ler o exame ou arquivo/);assert.match(html,/Abrir registro/);assert.match(html,/href="\/novos-exames\/11111111-1111-4111-8111-111111111111"/);
});

test('review of an unconfirmed file does not imply a group delivery',()=>{
 const html=render({data:fixture({rows:[{...row,exam_type:null,issue_kind:'processing',status:'overdue',reason:'review_file'}]})});assert.match(html,/Conferir conteúdo do arquivo/);assert.match(html,/Abrir registro/);assert(!html.includes('Envio ao grupo atrasado'));
});
test('pending source with no document displays one real attachment without pretending it has a document',()=>{
 const pending={...row,row_kind:'receipt',row_id:'22222222-2222-4222-8222-222222222222',document_id:null,position:4,sender:'lab@example.invalid',original_name:null,pet_name:null,client_name:null,exam_type:null,issue_kind:'processing',status:'failed',reason:'source_reservation_unproven'};
 const f=fixture({rows:[pending]});assert(view.isExamFailures(f));const html=render({data:f});assert.match(html,/Arquivo sem nome · anexo 4/);assert.match(html,/lab@example.invalid/);assert.match(html,/Não foi possível registrar a origem do arquivo/);assert(!html.includes('/novos-exames/'));assert(!view.isExamFailures(fixture({rows:[{...pending,position:0}]})));assert(!view.isExamFailures(fixture({rows:[{...pending,row_id:'javascript:alert(1)'}]})));
});

test('a real attachment without metadata shows an honest fallback',()=>{
 const item={...row,row_kind:'receipt',row_id:'22222222-2222-4222-8222-222222222222',document_id:null,position:null,sender:null,original_name:null,pet_name:null,client_name:null,exam_type:null,issue_kind:'processing',status:'overdue',reason:'source_reservation_unproven'};
 assert(view.isExamFailures(fixture({rows:[item]})));const html=render({data:fixture({rows:[item]})});assert.match(html,/Arquivo sem nome/);assert(!html.includes('anexo null'));
});
