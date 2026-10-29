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
  const [blocked,setBlocked]=useState(false),[notice,setNotice]=useState<string|null>(null)
  const data=versionReviewPreviewFixture(blocked)
  if(new URLSearchParams(window.location.search).get('sent')==='both')data.current.group_status='sent'
  if(!isVersionReviewData(data))throw new Error('Invalid preview contract')
  return <div className="mx-auto max-w-xl p-4"><nav className="space-y-3 text-sm"><p className="font-semibold">Prévia local · somente dados fictícios · nenhuma API</p><button className="rounded border bg-white px-3 py-2" onClick={()=>setBlocked(v=>!v)}>{blocked?'Mostrar dois originais preservados':'Mostrar original antigo indisponível'}</button></nav>{notice&&<p role="status">{notice}</p>}<div onClickCapture={e=>{if((e.target as HTMLElement).closest('a')){e.preventDefault();setNotice('PDF fictício: nenhum original real é consultado nesta prévia.')}}}><DocumentVersionReviewView data={data}/></div></div>
}
createRoot(document.getElementById('root')!).render(<Preview/> )
