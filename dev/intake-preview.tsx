import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/dm-sans/400.css'
import '@fontsource/dm-sans/500.css'
import '@fontsource/dm-sans/600.css'
import '../src/index.css'
import { IntakeReceiptsView, isIntakePanel } from '../src/components/intake/IntakeReceiptsView'
import { intakePreviewFixture } from './intake-preview.fixture.mjs'

if(!import.meta.env.DEV)throw new Error('Synthetic preview is available in DEV only')
function Preview(){
  const [scenario,setScenario]=useState('pending')
  const fixture=intakePreviewFixture(scenario)
  if(!isIntakePanel(fixture))throw new Error('Preview fixture does not match panel contract')
  return <><nav aria-label="Cenário de demonstração" className="flex flex-wrap items-center gap-2 border-b bg-white px-4 py-3 text-sm"><strong className="mr-2">Prévia local · dados fictícios</strong>{[['pending','Com pendências'],['none','Sem coleta'],['empty','Filas vazias']].map(([id,label])=><button key={id} className={`rounded border px-3 py-1 ${scenario===id?'bg-lime-100':''}`} onClick={()=>setScenario(id)}>{label}</button>)}<span>Nenhuma API é consultada.</span></nav><IntakeReceiptsView data={fixture} onRefresh={()=>setScenario(s=>s)}/></>
}
createRoot(document.getElementById('root')!).render(<Preview/> )
