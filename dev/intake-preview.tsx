import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/dm-sans/400.css'
import '@fontsource/dm-sans/500.css'
import '@fontsource/dm-sans/600.css'
import '../src/index.css'
import '../src/components/intake/exam-conference.css'
import { ExamFailuresView, type ExamFailures } from '../src/components/intake/ExamFailuresView'

if(!import.meta.env.DEV)throw new Error('Synthetic preview is available in DEV only')
function Preview(){
  const [scenario,setScenario]=useState('pending')
  const now=Date.now()
  const rows:ExamFailures['rows']=[
    {document_id:'11111111-1111-4111-8111-111111111111',original_name:'exame.pdf',received_at:new Date(now-3600000).toISOString(),pet_name:'Paciente fictício',client_name:'Tutor fictício',exam_type:'Hemograma',channel:'email',issue_kind:'processing',status:'failed',reason:'processing_failed'},
    {document_id:'22222222-2222-4222-8222-222222222222',original_name:'documento.pdf',received_at:new Date(now-7200000).toISOString(),pet_name:'Outro paciente fictício',client_name:'Outro tutor fictício',exam_type:'Bioquímico',channel:'whatsapp',issue_kind:'group',status:'uncertain',reason:'group_delivery_uncertain'},
  ]
  const data:ExamFailures={contract:'exam_intake_exam_failures_v1',as_of:new Date(now).toISOString(),attention_cutoff:new Date(now-86400000).toISOString(),coverage_status:'unproven',channels:[{provider:'gmail',activity:'recent',last_checked:new Date(now-120000).toISOString()},{provider:'outlook',activity:'not_configured',last_checked:null},{provider:'chatwoot',activity:'not_started',last_checked:null}],total:scenario==='pending'?rows.length:0,has_more:false,next_cursor:null,unclassified_documents_total:0,rows:scenario==='pending'?rows:[],unclassified_receipts_total:scenario==='pending'?5:0}
  return <><nav aria-label="Cenário de demonstração" className="flex flex-wrap items-center gap-2 border-b bg-white px-4 py-3 text-sm"><strong className="mr-2">Prévia local · dados fictícios</strong><span className="mx-1">·</span>{[['pending','Exames com problema'],['empty','Sem exames identificados'],['error','Consulta indisponível']].map(([id,label])=><button key={id} className={`rounded border px-3 py-1 ${scenario===id?'bg-lime-100':''}`} onClick={()=>setScenario(id)}>{label}</button>)}<span>Nenhuma API é consultada.</span></nav><main className="exam-conference-page"><header><h1>Conferência dos exames</h1></header><ExamFailuresView data={data} now={now} error={scenario==='error'} onRefresh={()=>setScenario('pending')} onNext={()=>{}} onPrevious={()=>{}}/></main></>
}
createRoot(document.getElementById('root')!).render(<Preview/> )
