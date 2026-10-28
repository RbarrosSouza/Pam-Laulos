import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {createElement,Fragment} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {intakePreviewFixture} from '../../../dev/intake-preview.fixture.mjs';

const require=createRequire(import.meta.url);
function load(path,mocks={}){
 const source=readFileSync(new URL(`../../../${path}`,import.meta.url),'utf8');
 const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}};new Function('require','module','exports',compiled)(name=>{
  if(Object.hasOwn(mocks,name))return mocks[name];
  if(name==='react'||name==='react/jsx-runtime')return require(name);
  throw new Error(`Unmocked dependency ${name}`);
 },module,module.exports);return module.exports;
}
const intake=load('src/components/intake/IntakeReceiptsView.tsx');
const {HomeIntakeIssuesView,homeIntakeRows}=load('src/components/dashboard/HomeIntakeIssuesView.tsx',{'@/components/intake/IntakeReceiptsView':intake});
const render=props=>renderToStaticMarkup(createElement(HomeIntakeIssuesView,props));

test('loading and failed queries never report zero, including a failed refresh with cached data',()=>{
 const loading=render({loading:true});assert.match(loading,/Consultando falhas/);assert(!loading.includes('Nenhuma ocorrência'));
 for(const props of [{error:true},{error:true,data:intakePreviewFixture('empty')}]){
  const html=render(props);assert.match(html,/role="alert"/);assert.match(html,/indisponível/);assert.match(html,/falta de resposta não significa/);assert(!html.includes('Nenhuma ocorrência'));assert(!html.includes('<dd'));
 }
 const empty=render({data:intakePreviewFixture('empty')});assert.match(empty,/Nenhuma ocorrência ou original pendente/);assert.match(empty,/Zero registros não comprova todo o histórico/);
});
test('failed originals, pending review and unresolved incidents stay distinct and lists are limited',()=>{
 const panel=intakePreviewFixture('pending');
 panel.incidents.push({id:'revisao',state:'acknowledged',code:'linked_result_content_requires_review',last_seen_at:'2026-10-20T12:00:00Z'});
 panel.incident_total=2;
 panel.unresolved_origins.push({id:'invalid-link',document_id:'javascript:alert(1)',disposition:'pending'},{id:'fourth',disposition:'failed'},{id:'inventory',disposition:'discovered'});panel.unresolved_origin_total=5;
 const rows=homeIntakeRows(panel);assert.equal(rows.origins.length,3);assert.equal(rows.origins[0].disposition,'failed');assert(!rows.origins.some(row=>row.disposition==='discovered'));
 const html=render({data:panel});assert.match(html,/Falha no processamento do original/);assert.match(html,/Pendente de resolução ou revisão/);assert.match(html,/Versão aguardando revisão clínica/);assert(!html.includes('Erro na revisão'));assert.match(html,/Ver todos os 5 originais/);assert(!html.includes('javascript:'));assert(!html.includes('avisos-pendentes'));
});
test('a completed recent window leaves older pending incidents visible and links validate document IDs',()=>{
 const panel=intakePreviewFixture('pending');panel.incidents[0].last_seen_at='2026-10-18T12:00:00Z';panel.incidents[0].document_id='11111111-1111-4111-8111-111111111111';
 assert.equal(panel.collectors[0].latest_sweep.scanFinished,true);
 const html=render({data:panel});assert.match(html,/Original aguardando resolução além do prazo/);assert.match(html,/18\/10\/2026/);assert.match(html,/href="\/novos-exames\/11111111-1111-4111-8111-111111111111"/);assert.match(html,/pendências anteriores continuam até sua resolução/);
});
test('the actual Dashboard inserts the new section before its existing queues and retains their order',()=>{
 let realtime=0,writeCount=0;
 const icon=()=>createElement('span');
 const query={data:{count:0,documents:[]},isLoading:false,isFetching:false,refetch:async()=>{}};
 const {CockpitDashboard}=load('src/components/dashboard/CockpitDashboard.tsx',{
  'react-router-dom':{Link:({to,children,...rest})=>createElement('a',{href:to,...rest},children),useNavigate:()=>()=>{}},
  'lucide-react':{RefreshCw:icon,Search:icon,Check:icon},'@phosphor-icons/react/dist/csr/WhatsappLogo':{WhatsappLogo:icon},
  sonner:{toast:{success:()=>{}}},'@/hooks/useExamDocuments':{useExamDocuments:()=>query,useDocumentAction:()=>({mutateAsync:async()=>{writeCount++}})},
  '@/hooks/useExamCards':{useExamCards:()=>({...query,data:[]})},'@/lib/document-status':{documentLabel:()=>'',documentIsOverdue:()=>false},'@/lib/fireworks':{triggerFireworksAt:()=>{}},'./cockpit.css':{},
 });
 const examView=load('src/components/intake/ExamFailuresView.tsx',{'./IntakeReceiptsView':intake});
 const {HomeIntakeIssues}=load('src/components/dashboard/HomeIntakeIssues.tsx',{'@/hooks/useExamIntakeFailures':{useExamIntakeFailures:()=>({data:{contract:'exam_intake_exam_failures_v1',as_of:new Date().toISOString(),attention_cutoff:'2026-10-28T12:00:00Z',coverage_status:'unproven',channels:[{provider:'gmail',activity:'recent',last_checked:new Date().toISOString()},{provider:'outlook',activity:'not_configured',last_checked:null},{provider:'chatwoot',activity:'not_configured',last_checked:null}],total:0,has_more:false,next_cursor:null,rows:[],unclassified_receipts_total:0,unclassified_documents_total:0},isPending:false,isError:false,isFetching:false,refetch:async()=>{}})},'@/components/intake/ExamFailuresView':examView});
 const {Dashboard}=load('src/pages/Dashboard.tsx',{'framer-motion':{AnimatePresence:Fragment},'@/components/dashboard/CockpitDashboard':{CockpitDashboard},'@/components/dashboard/HomeIntakeIssues':{HomeIntakeIssues},'@/components/tracking/TrackingDetail':{TrackingDetail:()=>null},'@/hooks/useRealtimeExams':{useRealtimeExams:()=>{realtime++}}});
 const html=renderToStaticMarkup(createElement(Dashboard));
 const order=['Início','Exames que precisam de atenção','Filtros de pendências','Falta contato','Falta cadastro','Falta grupo','Aguardando lab','Falta entrar em contato'].map(text=>html.indexOf(text));
 for(let i=0;i<order.length;i++){assert(order[i]>=0);if(i)assert(order[i]>order[i-1]);}
 assert.equal(realtime,1);assert.equal(writeCount,0);
});
test('the shared read-only query is authenticated per user, reuses a 30s cache and rejects incomplete contracts',async()=>{
 let options,auth={session:{user:{id:'synthetic-user-a'}},membership:{role:'admin'}},response={data:intakePreviewFixture('empty'),error:null};const calls=[];
 const {useIntakePanel}=load('src/hooks/useIntakePanel.ts',{'react':{useState:init=>[typeof init==='function'?init():init,()=>{}],useEffect:()=>{}},'@tanstack/react-query':{useQuery:value=>(options=value)},'@/lib/supabase':{supabase:{rpc:async(...args)=>(calls.push(args),response)}},'@/contexts/exam-auth':{useExamAuth:()=>auth},'@/components/intake/IntakeReceiptsView':intake});
 useIntakePanel();assert.deepEqual(options.queryKey,['intake-panel-v2','synthetic-user-a']);assert.equal(options.refetchInterval,30000);assert.equal(options.staleTime,30000);assert.equal(options.enabled,true);await options.queryFn();assert.deepEqual(calls,[['get_exam_intake_panel',{p_limit:100}]]);
 auth={session:{user:{id:'synthetic-user-b'}},membership:{role:'vet'}};useIntakePanel();assert.deepEqual(options.queryKey,['intake-panel-v2','synthetic-user-b']);
 response={data:{},error:null};await assert.rejects(options.queryFn,/não comprovou/);response={data:null,error:new Error('unavailable')};await assert.rejects(options.queryFn,/unavailable/);
 auth={session:null,membership:null};useIntakePanel();assert.equal(options.enabled,false);
});
test('old or paused snapshots retain only explicitly dated counts and offer refresh instead of current proof',()=>{
 const panel=intakePreviewFixture('empty'),then=Date.parse(panel.as_of);
 const current=render({data:panel,now:then});assert(!current.includes('Consulta antiga'));
 const old=render({data:panel,now:then+120001,onRefresh:()=>{}});assert.match(old,/Consulta antiga/);assert.match(old,/contagens abaixo pertencem a essa consulta/);assert.match(old,/Atualizar conferência/);
 const paused=render({data:panel,now:then+1000,paused:true,onRefresh:()=>{}});assert.match(paused,/Atualização pausada/);assert.match(paused,/estado atual dos recebimentos não foi confirmado/);
 const noData=render({loading:true,paused:true,onRefresh:()=>{}});assert.match(noData,/Consulta dos recebimentos pausada/);assert(!noData.includes('Consultando falhas'));assert(!noData.includes('<dd'));
});
test('shared query exposes paused state and ages cached snapshots on a clock without any new RPC',()=>{
 let options,effect,tick;const state=[];
 const fakeWindow={setInterval:(fn,ms)=>(assert.equal(ms,30000),tick=fn,1),clearInterval:()=>{},addEventListener:()=>{},removeEventListener:()=>{}};
 const oldWindow=globalThis.window;globalThis.window=fakeWindow;
 try{
  const {useIntakePanel}=load('src/hooks/useIntakePanel.ts',{'react':{useState:init=>[init(),value=>state.push(value)],useEffect:fn=>effect=fn},'@tanstack/react-query':{useQuery:value=>(options=value,{fetchStatus:'paused',data:intakePreviewFixture('empty')})},'@/lib/supabase':{supabase:{rpc:()=>{throw new Error('clock must not fetch')}}},'@/contexts/exam-auth':{useExamAuth:()=>({session:{user:{id:'synthetic-user'}},membership:true})},'@/components/intake/IntakeReceiptsView':intake});
  const result=useIntakePanel();assert.equal(result.snapshotPaused,true);assert.equal(typeof result.now,'number');const cleanup=effect();tick();assert.equal(state.length,1);cleanup();assert.equal(options.refetchInterval,30000);
 }finally{globalThis.window=oldWindow;}
});
