import { useState } from 'react'
import { ArrowUpRight, Check, ChevronDown, Files, FileText } from 'lucide-react'

import { groupLabels, type Original, type VersionReviewData } from '@/lib/document-version-review'

export function DocumentVersionReviewView({data,onOpenOriginal,onExpandedChange}:{data:VersionReviewData;onOpenOriginal?:(original:Original,originals:Original[])=>void;onExpandedChange?:(open:boolean)=>void}){
  const [expanded,setExpanded]=useState(false)
  const bothSent=data.previous?.group_status==='sent'&&data.current.group_status==='sent'
  const originals=[data.current,...(data.previous?[data.previous]:[])]
  return <section aria-label="Atualização e envio dos originais" className={`originals${expanded?' open':''}`}>
    <button type="button" className="originals-toggle" aria-expanded={expanded} onClick={()=>{setExpanded(!expanded);onExpandedChange?.(!expanded)}}>
      <span className="originals-heading"><Files size={18}/><strong>{data.previous?'2 PDFs':'PDF atualizado'}</strong></span>
      <span className={`originals-status${bothSent?'':' pending'}`}>{bothSent?<><Check size={14}/>Enviados ao grupo</>:data.previous?'Conferir envios':data.hold?.state==='held'?'Captura pendente':'Anterior indisponível'}</span><ChevronDown size={15} className="originals-chevron"/>
    </button>
    <div className="originals-reveal" inert={!expanded} aria-hidden={!expanded}><div className="originals-clip"><div className="originals-list">
      {[{title:'Atual',value:data.current},{title:'Anterior',value:data.previous}].map(({title,value})=><article className="original-row" key={title}>
        <FileText size={19} aria-hidden="true"/><div><strong>{title}</strong><small>{value?.original_name||'Original anterior indisponível'}</small><small className={value?.group_status==='sent'?'sent':'pending'}>{value?groupLabels[value.group_status]||'Situação do envio a conferir':'Sem cópia disponível para consulta'}{value&&value.file_status!=='saved'?' · PDF ainda indisponível':''}</small></div>
        {value?.file_status==='saved'&&(onOpenOriginal?<button type="button" onClick={()=>onOpenOriginal(value,originals)} aria-label={`Abrir PDF ${title.toLowerCase()}`}>Abrir<ArrowUpRight size={15}/></button>:<a href={`/novos-exames/${value.document_id}?panel=pdf`} target="_blank" rel="noopener noreferrer">Conferir PDF {title.toLowerCase()}</a>)}
      </article>)}
    </div></div></div>
  </section>
}
