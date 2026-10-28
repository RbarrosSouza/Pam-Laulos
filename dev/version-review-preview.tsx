import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import '@fontsource/dm-sans/400.css'
import '@fontsource/dm-sans/500.css'
import '@fontsource/dm-sans/600.css'
import '../src/index.css'
import {DocumentVersionReviewView,isVersionReviewData} from '../src/components/documents/DocumentVersionReviewView'
import {versionReviewPreviewFixture} from './version-review-preview.fixture.mjs'
if(!import.meta.env.DEV)throw new Error('Synthetic preview is DEV only')
function Preview(){
  const [role,setRole]=useState('vet'),[blocked,setBlocked]=useState(false),[completion,setCompletion]=useState<string|null>(null)
  const data=versionReviewPreviewFixture(blocked)
  if(!isVersionReviewData(data))throw new Error('Invalid preview contract')
  return <div className="mx-auto max-w-xl p-4"><nav className="space-y-3 text-sm"><p className="font-semibold">Prévia local · somente dados fictícios · nenhuma API</p><div className="flex flex-wrap gap-2">{[['vet','Veterinária'],['admin','Administração'],['staff','Sem permissão clínica']].map(([id,label])=><button className="rounded border bg-white px-3 py-2" key={id} onClick={()=>{setRole(id);setCompletion(null)}}>{label}</button>)}<button className="rounded border bg-white px-3 py-2" onClick={()=>{setBlocked(v=>!v);setCompletion(null)}}>{blocked?'Mostrar dois originais preservados':'Mostrar original antigo indisponível'}</button></div></nav><div onClickCapture={e=>{if((e.target as HTMLElement).closest('a')){e.preventDefault();setCompletion('PDF fictício: nenhum original real é consultado nesta prévia.')}}}><DocumentVersionReviewView key={`${role}:${blocked}:${completion}`} data={data} role={role} completion={completion} onSubmit={decision=>setCompletion(`Demonstração: ${decision==='inconclusive'?'a versão continuaria retida':'a decisão seria registrada'}. Nenhuma alteração real foi executada.`)} onRetry={()=>setCompletion(null)}/></div></div>
}
createRoot(document.getElementById('root')!).render(<Preview/> )
