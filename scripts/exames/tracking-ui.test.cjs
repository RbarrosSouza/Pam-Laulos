// Run from any working directory: node scripts/exames/tracking-ui.test.cjs
// These regressions execute the real TypeScript component/hook bodies, compiled
// with the existing TypeScript dependency. Lightweight React state, router,
// animation and backend doubles let us inspect actions without a DOM or network.
// They cover behavior contracts; browser accessibility/layout and live RLS are
// validated separately. No generated files or external /tmp fixtures are read.

const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const repo = path.resolve(__dirname, '../..');
const ts = require('typescript');
const jsx = require('react/jsx-runtime');
let stateOverrides = {}, stateIndex = 0, mutations = [], notices = [];
const stubMutation = () => ({isPending:false,mutateAsync:async(value)=>{mutations.push(value)}});
function load(filePath, extra={}) {
 const source = ts.transpileModule(fs.readFileSync(path.join(repo, filePath), 'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 const icons = new Proxy({}, {get:(_,key)=>String(key)});
 const mocks = {
  'react':{useState:(initial)=>[Object.hasOwn(stateOverrides,stateIndex)?stateOverrides[stateIndex++]:((stateIndex++),initial),()=>{}]},
  'react/jsx-runtime':jsx,'lucide-react':icons,'react-router-dom':{Link:'Link'},
  'sonner':{toast:{error:(msg)=>notices.push(msg),success:(msg)=>notices.push(msg)}},
  'framer-motion':{motion:new Proxy({}, {get:(_,key)=>'motion.'+String(key)}),AnimatePresence:'AnimatePresence'},
  '@/lib/utils':{cn:(...v)=>v.filter(Boolean).join(' '),formatDate:(v)=>v,formatHours:(v)=>v},
  '@/lib/group-time':{elapsedHoursForDisplay:()=>0},'@/lib/animations':{},
  '@/hooks/useExamCardMutations':{useUpdateItem:stubMutation,useDeleteItem:stubMutation,useDeleteCard:stubMutation,useAddItem:stubMutation},
  '@/hooks/useExamCards':{useExamCardLogs:()=>({data:[]}),useMarkAllContacted:stubMutation},
  '@/hooks/useVets':{useVets:()=>({data:[]})},
  '@/types/exam-card':model,
  './StatusBadge':{StatusBadge:'StatusBadge'},'./ExamItemRow':{ExamItemRow:'ExamItemRow'},
  './ContactModal':{ContactModal:'ContactModal'},'./EditCardModal':{EditCardModal:'EditCardModal'},
  './ConfirmDialog':{ConfirmDialog:'ConfirmDialog'},'./MergeCardModal':{MergeCardModal:'MergeCardModal'},...extra
 };
 const module={exports:{}};
 new Function('require','module','exports',source)((id)=>{if(id in mocks)return mocks[id];throw new Error('Unmocked '+id)},module,module.exports);
 return module.exports;
}
let model={}; model=load('src/types/exam-card.ts');
const {ExamItemRow}=load('src/components/tracking/ExamItemRow.tsx');
const {TrackingDetail}=load('src/components/tracking/TrackingDetail.tsx');
const d1='10000000-0000-4000-8000-000000000001', d2='20000000-0000-4000-8000-000000000002';
const item=(id, extra={})=>({id,exam_type:id,lab_name:null,result_received:true,contacted:false,...extra});
const legacy=item('legacy'), managed=item('managed',{document_ids:[d1,d2]});
const card=(items)=>({id:'card',pet_name:'Nina',client_name:'Tutor',origin:'manual',status:'exame_pronto',vet_name:'Vet',items,items_ready:items.length,items_total:items.length});
function render(fn,props,override={}) {stateIndex=0;stateOverrides=override;mutations=[];notices=[];return fn(props)}
function nodes(tree) {const all=[];function walk(value){if(Array.isArray(value))return value.forEach(walk);if(!value||typeof value!=='object')return;all.push(value);walk(value.props?.children)}walk(tree);return all}
function words(value) {if(Array.isArray(value))return value.map(words).join('');if(value&&typeof value==='object')return words(value.props?.children);return value===false||value==null?'':String(value)}
let count=0; function check(name,run){run();count++;console.log('ok '+count+' - '+name)}
(async()=>{
 check('legacy optional/empty document ids remain editable',()=>{assert.equal(model.isManagedExamItem(legacy),false);assert.equal(model.isManagedExamItem({...legacy,document_ids:[]}),false)});
 check('managed detail hides legacy edit/delete/contact buttons',()=>{const tree=nodes(render(ExamItemRow,{item:managed,cardId:'card',onContactClick:()=>{}}));assert.equal(tree.filter(n=>['Editar exame','Remover exame'].includes(n.props?.title)||n.props?.['aria-label']==='Registrar contato').length,0)});
 check('all source documents link from compact Kanban item',()=>{const tree=nodes(render(ExamItemRow,{item:managed,compact:true,onContactClick:()=>{}}));assert.deepEqual(tree.filter(n=>n.type==='Link').map(n=>n.props.to),['/novos-exames/'+d1,'/novos-exames/'+d2]);for(const link of tree.filter(n=>n.type==='Link')){for(const event of ['onPointerDown','onClick','onKeyDown']){let stopped=false;link.props[event]({stopPropagation:()=>stopped=true});assert.equal(stopped,true)}}});
 check('managed arrival cancels preopened edit/delete legacy UI',()=>{for(const overrides of [{0:true},{3:true}]){const tree=nodes(render(ExamItemRow,{item:managed,cardId:'card'},overrides));assert.equal(tree.some(n=>n.type==='input'||words(n)==='Sim'),false)}});
 check('legacy detail keeps edit/delete/contact actions',()=>{const tree=nodes(render(ExamItemRow,{item:legacy,cardId:'card',onContactClick:()=>{}}));assert.equal(tree.filter(n=>['Editar exame','Remover exame'].includes(n.props?.title)||n.props?.['aria-label']==='Registrar contato').length,3)});
 check('managed-only card routes contact and archive without legacy conclude',()=>{const tree=nodes(render(TrackingDetail,{card:card([managed]),onClose:()=>{}},{2:true}));assert.equal(tree.find(n=>n.type==='Link').props.to,'/novos-exames');assert.equal(tree.some(n=>n.type==='button'&&words(n).startsWith('Concluir contato')),false);const dialog=tree.find(n=>n.type==='ConfirmDialog');assert.equal(dialog.props.title,'Arquivar card');assert.equal(dialog.props.loadingLabel,'Arquivando…');assert.match(dialog.props.description,/preservados/)});
 check('single document contact routes straight to its detail',()=>{const tree=nodes(render(TrackingDetail,{card:card([item('managed',{document_ids:[d1]})]),onClose:()=>{}}));assert.equal(tree.find(n=>n.type==='Link').props.to,'/novos-exames/'+d1)});
 check('mixed card contact form includes only ready uncontacted legacy items',()=>{const tree=nodes(render(TrackingDetail,{card:card([managed,legacy,item('waiting',{result_received:false}),item('done',{contacted:true})]),onClose:()=>{}},{3:true}));const boxes=tree.filter(n=>n.type==='input'&&n.props.type==='checkbox');assert.equal(boxes.length,1);assert.equal(boxes[0].props.checked,false);assert.equal(tree.find(n=>n.type==='button'&&words(n).startsWith('Confirmar ')).props.disabled,true);assert.equal(words(tree[0]).includes('Contato concluído'),false)});
 let tree=nodes(render(TrackingDetail,{card:card([managed,legacy,item('another')]),onClose:()=>{}},{3:true,6:['managed',d1,'legacy']}));
 await tree.find(n=>n.type==='button'&&words(n).startsWith('Confirmar ')).props.onClick();
 check('mixed selection cannot submit managed/stale document ids',()=>{assert.deepEqual(mutations,[{cardId:'card',itemIds:['legacy'],contactedBy:'Vet'}]);assert.equal(notices.some(n=>n==='Contato concluído'),false)});
 tree=nodes(render(TrackingDetail,{card:card([managed,legacy]),onClose:()=>{}},{3:true}));
 await tree.find(n=>n.type==='button'&&words(n).startsWith('Confirmar ')).props.onClick();
 check('mixed card empty selection never mutates',()=>assert.equal(mutations.length,0));
 tree=nodes(render(TrackingDetail,{card:card([legacy,item('another'),item('waiting',{result_received:false})]),onClose:()=>{}},{3:true}));
 await tree.find(n=>n.type==='button'&&words(n)==='Confirmar').props.onClick();
 check('legacy-only card preserves conclude-all-ready behavior',()=>{assert.deepEqual(mutations[0].itemIds,['legacy','another']);assert.equal(tree.some(n=>n.type==='input'&&n.props.type==='checkbox'),false)});
 check('preopened contact modal closes when item becomes managed',()=>{const tree=nodes(render(TrackingDetail,{card:card([{...legacy,document_ids:[d1]}]),onClose:()=>{}},{0:legacy}));assert.equal(tree.some(n=>n.type==='ContactModal'),false)});
 let status='no_grupo', logs=[], updates=[], invalidated=[];
 const supabase={from:(table)=>table==='exam_item'?{update:()=>({in:async(_,ids)=>{updates.push(ids);return {error:null}}})}:table==='exam_card'?{select:()=>({eq:()=>({single:async()=>({data:{status},error:null})})})}:{insert:async(log)=>{logs.push(log);return {error:null}}}};
 const {useMarkAllContacted}=load('src/hooks/useExamCards.ts',{'@/lib/supabase':{supabase},'@tanstack/react-query':{useQuery:()=>{},useQueryClient:()=>({invalidateQueries:(entry)=>invalidated.push(entry.queryKey)}),useMutation:(config)=>config}});
 const mutation=useMarkAllContacted();await mutation.mutationFn({cardId:'card',itemIds:['legacy'],contactedBy:'Vet'});
 check('partial contact log keeps actual card state',()=>{assert.equal(logs[0].new_status,'no_grupo');assert.match(logs[0].change_reason,/outros itens seguem pendentes/)});
 status='contato_realizado';await mutation.mutationFn({cardId:'card',itemIds:['legacy','another'],contactedBy:'Vet'});
 check('fully completed legacy card keeps contact conclusion log',()=>{assert.equal(logs[1].new_status,'contato_realizado');assert.equal(logs[1].change_reason,'Contato concluído por Vet')});
 mutation.onSuccess();check('legacy mutation refreshes list, detail, stats and logs',()=>assert.deepEqual(invalidated,[['exam-cards'],['exam-card'],['exam-card-stats'],['exam-card-logs']]));
 const before=updates.length;await assert.rejects(mutation.mutationFn({cardId:'card',itemIds:[],contactedBy:'Vet'}),/Nenhum exame/);check('empty mutation rejects before updating storage',()=>assert.equal(updates.length,before));
 console.log(count+' tracking regression checks passed');
})().catch(error=>{console.error(error);process.exitCode=1});
