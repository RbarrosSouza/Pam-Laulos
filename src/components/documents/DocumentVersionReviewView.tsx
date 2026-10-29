type Original={document_id:string;original_name:string;sha256:string|null;file_status:string;group_status:string}
export type VersionReviewData={contract:'exam_intake_version_review_v1';document_id:string;hold:{state:'held'|'released';reason:string;previous_document_id:string|null;created_at:string;released_at:string|null}|null;current:Original;previous:Original|null;review_allowed:boolean;can_link_previous:boolean;blocking_reason:string|null;decision:{reason_code:string;reviewed_at:string}|null}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const sha=/^[a-f0-9]{64}$/
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const original=(v:unknown)=>object(v)&&typeof v.document_id==='string'&&uuid.test(v.document_id)&&typeof v.original_name==='string'&&(v.sha256===null||(typeof v.sha256==='string'&&sha.test(v.sha256)))&&typeof v.file_status==='string'&&typeof v.group_status==='string'
export function isVersionReviewData(v:unknown):v is VersionReviewData{
  if(!object(v)||v.contract!=='exam_intake_version_review_v1'||typeof v.document_id!=='string'||!uuid.test(v.document_id)||!original(v.current)||(v.previous!==null&&!original(v.previous))||typeof v.review_allowed!=='boolean'||typeof v.can_link_previous!=='boolean')return false
  if((v.current as Original).document_id!==v.document_id)return false
  if(v.hold!==null&&(!object(v.hold)||!['held','released'].includes(String(v.hold.state))||typeof v.hold.reason!=='string'||!(v.hold.previous_document_id===null||(typeof v.hold.previous_document_id==='string'&&uuid.test(v.hold.previous_document_id)))))return false
  if(object(v.hold)&&v.hold.previous_document_id!==null&&object(v.previous)&&v.hold.previous_document_id!==v.previous.document_id)return false
  return v.decision===null||(object(v.decision)&&typeof v.decision.reason_code==='string'&&typeof v.decision.reviewed_at==='string')
}
export const hasVersionReviewNotice=(data:VersionReviewData)=>!!data.decision||data.hold?.state==='held'||['changed_content_review','historical_snapshot_unavailable'].includes(data.hold?.reason||'')
const reasonLabels:Record<string,string>={changed_content_review:'Recebemos outro PDF para esta requisição. Cada original tem seu próprio envio ao grupo.',historical_snapshot_unavailable:'A nova cópia tem envio próprio ao grupo. O original anterior não está disponível.',awaiting_snapshot:'A captura do novo original ainda está pendente.',missing_link:'O link do original está ausente.'}
const groupLabels:Record<string,string>={sent:'Enviado ao grupo',submitted:'Envio em confirmação',uncertain:'Envio em conferência',reserved:'Envio em andamento',pending:'Aguardando envio ao grupo',failed:'Falha no envio ao grupo',held:'Aguardando captura do original',waived:'Envio dispensado',not_queued:'Envio ainda não agendado'}
function OriginalCard({title,value}:{title:string;value:Original|null}){
  return <article className="min-w-0 rounded-xl border bg-[hsl(var(--card))] p-3"><h3 className="text-sm font-semibold">{title}</h3>{value?<><p className="mt-2 break-words text-sm">{value.original_name}</p><p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{value.file_status==='saved'?'Original preservado':'Original ainda sem preservação comprovada'}</p><p className="mt-1 text-xs font-medium">{groupLabels[value.group_status]||'Situação do envio a conferir'}</p>{value.file_status==='saved'&&uuid.test(value.document_id)&&<a className="mt-3 inline-block text-sm font-medium underline underline-offset-4" href={`/novos-exames/${value.document_id}?panel=pdf`} target="_blank" rel="noopener noreferrer">Conferir PDF {title==='Original atual'?'atual':'anterior'}</a>}</>:<p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">Original anterior indisponível para comparação.</p>}</article>
}
export function DocumentVersionReviewView({data}:{data:VersionReviewData}){
  const held=data.hold?.state==='held'
  const versionNotice=['changed_content_review','historical_snapshot_unavailable'].includes(data.hold?.reason||'')||!!data.decision
  const bothSent=data.previous?.group_status==='sent'&&data.current.group_status==='sent'
  return <section aria-label="Atualização e envio dos originais" className={`my-5 space-y-4 rounded-2xl border p-4 text-[hsl(var(--foreground))] ${bothSent?'border-emerald-200 bg-emerald-50/60':'border-amber-200 bg-amber-50/60'}`}>
    <header><p className={`text-xs font-semibold uppercase tracking-wide ${bothSent?'text-emerald-900':'text-amber-900'}`}>{versionNotice?'Atualização recebida':'Original em conferência'}</p><h2 className="mt-1 text-lg font-semibold">{versionNotice?(bothSent?'Os dois originais foram enviados ao grupo':'Envio dos originais ao grupo'):held?'Captura do original pendente':'Conferência do original'}</h2><p className="mt-2 text-sm">{versionNotice?reasonLabels[data.hold?.reason||'']||'Cada PDF diferente tem envio próprio ao grupo.':reasonLabels[data.hold?.reason||'']||'Confira a preservação do original.'}</p></header>
    <div className="grid gap-3 sm:grid-cols-2"><OriginalCard title="Original anterior" value={data.previous}/><OriginalCard title="Original atual" value={data.current}/></div>

  </section>
}
