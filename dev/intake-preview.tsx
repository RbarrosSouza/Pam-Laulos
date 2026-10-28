import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/dm-sans/400.css'
import '@fontsource/dm-sans/500.css'
import '@fontsource/dm-sans/600.css'
import '../src/index.css'
import { IntakeReceiptsView, isIntakePanel } from '../src/components/intake/IntakeReceiptsView'
import {HomeIntakeIssuesView} from '../src/components/dashboard/HomeIntakeIssuesView'
import { intakePreviewFixture } from './intake-preview.fixture.mjs'

if(!import.meta.env.DEV)throw new Error('Synthetic preview is available in DEV only')
function Preview(){
  const [scenario,setScenario]=useState('pending')
  const [page,setPage]=useState('home')
  const fixture=intakePreviewFixture(scenario)
  if(!isIntakePanel(fixture))throw new Error('Preview fixture does not match panel contract')
  return <><nav aria-label="Cenário de demonstração" className="flex flex-wrap items-center gap-2 border-b bg-white px-4 py-3 text-sm"><strong className="mr-2">Prévia local · dados fictícios</strong>{[['home','Início'],['receipts','Conferência']].map(([id,label])=><button key={id} className={`rounded border px-3 py-1 ${page===id?'bg-lime-100':''}`} onClick={()=>setPage(id)}>{label}</button>)}<span className="mx-1">·</span>{[['pending','Com pendências'],['none','Sem coleta'],['empty','Filas vazias'],['error','Consulta indisponível']].map(([id,label])=><button key={id} className={`rounded border px-3 py-1 ${scenario===id?'bg-lime-100':''}`} onClick={()=>setScenario(id)}>{label}</button>)}<span>Nenhuma API é consultada.</span></nav>{page==='home'?<main className="mx-auto max-w-6xl space-y-6 p-4 md:p-8"><h1 className="text-xl font-bold">Início</h1><HomeIntakeIssuesView data={fixture} error={scenario==='error'} onRefresh={()=>setScenario('pending')}/><p className="text-sm text-[hsl(var(--muted-foreground))]">Prévia do componente de recebimentos. As filas clínicas existentes continuam abaixo na tela inicial.</p></main>:scenario==='error'?<main className="mx-auto max-w-6xl p-8"><p role="alert">Conferência indisponível. Não foi possível comprovar os recebimentos nesta consulta.</p></main>:<IntakeReceiptsView data={fixture} onRefresh={()=>setScenario(s=>s)}/>}</>
}
createRoot(document.getElementById('root')!).render(<Preview/> )
