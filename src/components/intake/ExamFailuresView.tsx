import {intakeDocumentHref, intakeSnapshotStatus} from './IntakeReceiptsView'

export type ExamFailure = {document_id:string; original_name:string|null; received_at:string|null; pet_name:string|null; client_name:string|null; exam_type:string|null; channel:'email'|'whatsapp'|'both'; issue_kind:'processing'|'group'; status:'failed'|'overdue'|'uncertain'; reason:string|null}
export type ExamFailuresCursor = {age_from:string; document_id:string}
export type ExamChannelActivity={provider:'gmail'|'outlook'|'chatwoot';activity:'not_configured'|'not_started'|'stale'|'test_only'|'recent';last_checked:string|null}
export type ExamFailures = {contract:'exam_intake_exam_failures_v1'; as_of:string; attention_cutoff:string|null; coverage_status:'not_configured'|'unproven'|'proven';channels:ExamChannelActivity[];total:number; has_more:boolean; next_cursor:ExamFailuresCursor|null; rows:ExamFailure[]; unclassified_receipts_total:number; unclassified_documents_total:number}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const count=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0
const nullableText=(value:unknown)=>value===null||typeof value==='string'
export function isExamFailures(value:unknown):value is ExamFailures {
  if(!object(value)||value.contract!=='exam_intake_exam_failures_v1'||typeof value.as_of!=='string'||!Number.isFinite(Date.parse(value.as_of))||!(value.attention_cutoff===null||typeof value.attention_cutoff==='string'&&Number.isFinite(Date.parse(value.attention_cutoff)))||!['not_configured','unproven','proven'].includes(String(value.coverage_status))||(value.attention_cutoff===null)!==(value.coverage_status==='not_configured')||!count(value.total)||!count(value.unclassified_receipts_total)||!count(value.unclassified_documents_total)||typeof value.has_more!=='boolean'||!Array.isArray(value.rows)||value.rows.length>value.total)return false
  if(!Array.isArray(value.channels)||value.channels.length!==3||new Set(value.channels.map(channel=>object(channel)?channel.provider:null)).size!==3||!value.channels.every(channel=>object(channel)&&['gmail','outlook','chatwoot'].includes(String(channel.provider))&&['not_configured','not_started','stale','test_only','recent'].includes(String(channel.activity))&&(channel.last_checked===null||typeof channel.last_checked==='string'&&Number.isFinite(Date.parse(channel.last_checked)))))return false
  if(value.has_more?(!object(value.next_cursor)||typeof value.next_cursor.age_from!=='string'||!Number.isFinite(Date.parse(value.next_cursor.age_from))||!intakeDocumentHref(value.next_cursor.document_id)||value.rows.length===0):value.next_cursor!==null)return false
  return value.rows.every(row=>object(row)&&!!intakeDocumentHref(row.document_id)&&['email','whatsapp','both'].includes(String(row.channel))&&['processing','group'].includes(String(row.issue_kind))&&['failed','overdue','uncertain'].includes(String(row.status))&&['original_name','received_at','pet_name','client_name','exam_type','reason'].every(field=>nullableText(row[field]))&&(row.received_at===null||Number.isFinite(Date.parse(String(row.received_at)))))
}
const formatDate=(value:string|null)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'}):'Data não disponível'
const channelName=(value:ExamChannelActivity['provider'])=>value==='gmail'?'Gmail':value==='outlook'?'Outlook':'WhatsApp'
function channelActivity(channel:ExamChannelActivity){
  if(channel.activity==='not_configured')return 'conferência não configurada'
  if(channel.activity==='not_started')return 'aguardando primeira conferência'
  if(channel.activity==='stale')return 'sem atualização recente; verificar coletor'
  if(channel.activity==='test_only')return 'somente teste, sem cobertura geral'
  return channel.last_checked?`atividade em ${formatDate(channel.last_checked)}; cobertura não confirmada`:'atividade recente; cobertura não confirmada'
}
function issue(row:ExamFailure){
  if(row.reason==='unreadable_file')return 'Não foi possível ler o exame ou arquivo'
  if(row.reason==='review_file')return 'Conferir conteúdo do arquivo'
  if(row.issue_kind==='processing')return row.status==='failed'?'Falha ao processar':'Processamento atrasado'
  return row.status==='uncertain'?'Uma tentativa de envio ao grupo precisa de confirmação':row.status==='failed'?'Falha no envio ao grupo':'Envio ao grupo atrasado'
}
type Props={data?:ExamFailures; loading?:boolean; error?:boolean; paused?:boolean; refreshing?:boolean; onRefresh?:()=>void; now?:number; compact?:boolean; pageNumber?:number; onPrevious?:()=>void; onNext?:()=>void}
export function ExamFailuresView({data,loading=false,error=false,paused=false,refreshing=false,onRefresh,now=Date.now(),compact=false,pageNumber=1,onPrevious,onNext}:Props){
  const unavailable=error||paused&&!data||!loading&&!data
  const stale=!!data&&intakeSnapshotStatus(data.as_of,now,paused)!=='current'
  const rows=compact?data?.rows.slice(0,3):data?.rows
  return <section aria-labelledby={compact?'home-exam-failures-title':'exam-failures-title'} className="rounded-2xl border bg-[hsl(var(--card))] p-4 sm:p-5">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h2 id={compact?'home-exam-failures-title':'exam-failures-title'} className="text-lg font-semibold">Exames que precisam de atenção</h2><p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">Exames com processamento ou envio ao grupo em atraso, com falha ou sem confirmação.</p></div>{compact?<a className="text-sm underline" href="/recebimentos">Abrir lista</a>:onRefresh&&<button type="button" className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50" disabled={refreshing} onClick={onRefresh}>{refreshing?'Atualizando…':'Atualizar'}</button>}</header>
    {loading&&!data&&!error&&!paused?<p role="status" className="mt-4 text-sm">Consultando exames…</p>:unavailable?<div role="alert" className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-950">Não foi possível consultar os exames que precisam de atenção. Tente atualizar a página.</div>:data&&rows?<>
      {stale&&<p role="status" className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-950">Consulta antiga ou pausada: os dados abaixo são de {formatDate(data.as_of)}.</p>}
      {data.coverage_status!=='proven'&&<div role="status" className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-950"><p>{data.coverage_status==='not_configured'?'A conferência ainda não foi iniciada.':'Não foi possível confirmar a conferência de todos os recebimentos.'}</p><p className="mt-1 text-xs">{data.channels.map(channel=>`${channelName(channel.provider)}: ${channelActivity(channel)}`).join(' · ')}</p></div>}
      {data.coverage_status==='not_configured'?null:data.total===0?<p className="mt-4 text-sm">Nenhum exame identificado precisa de atenção nesta consulta.</p>:<><ul className="mt-3 divide-y">{rows.map(row=><li key={row.document_id} className="flex flex-wrap items-start justify-between gap-3 py-3"><div className="min-w-0"><p className="text-sm font-semibold">{row.pet_name||row.original_name||'Arquivo sem nome'}{row.client_name?` · ${row.client_name}`:''}</p><p className="mt-1 text-sm">{issue(row)}</p><p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{row.exam_type||'Tipo a conferir'} · {row.channel==='both'?'E-mail e WhatsApp':row.channel==='whatsapp'?'WhatsApp':'E-mail'} · {formatDate(row.received_at)}</p></div><a className="text-sm font-medium underline" href={intakeDocumentHref(row.document_id)!}>{['unreadable_file','review_file'].includes(row.reason||'')?'Abrir registro':'Abrir exame'}</a></li>)}</ul>{compact&&data.total>rows.length&&<a href="/recebimentos" className="mt-3 inline-block text-sm underline">Abrir lista de exames</a>}</>}{data.coverage_status!=='not_configured'&&!compact&&(onPrevious||onNext)&&(data.total>0||pageNumber>1)&&<nav aria-label="Páginas de exames" className="mt-4 flex items-center gap-4 border-t pt-3 text-sm"><button type="button" className="underline disabled:opacity-40" disabled={pageNumber===1||refreshing} onClick={onPrevious}>Anterior</button><span>{rows.length?`Página ${pageNumber} · ${rows.length} nesta consulta`:'Nenhum exame nesta página'}</span><button type="button" className="underline disabled:opacity-40" disabled={!data.has_more||refreshing} onClick={onNext}>Próxima</button></nav>}
    </>:null}
  </section>
}
