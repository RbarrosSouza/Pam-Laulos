import {intakeDocumentHref, intakeSnapshotStatus} from './IntakeReceiptsView'

export type ExamFailure = {row_kind?:'document'|'receipt';row_id?:string;position?:number|null;sender?:string|null;document_id:string|null; original_name:string|null; received_at:string|null; pet_name:string|null; client_name:string|null; exam_type:string|null; channel:'email'|'whatsapp'|'both'; issue_kind:'processing'|'group'; status:'failed'|'overdue'|'uncertain'; reason:string|null}
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
  return value.rows.every(row=>object(row)&&(row.row_kind==='receipt'?row.document_id===null&&!!intakeDocumentHref(row.row_id)&&(row.position===null||Number.isSafeInteger(row.position)&&Number(row.position)>=1&&Number(row.position)<=200)&&nullableText(row.sender):!!intakeDocumentHref(row.document_id))&&['email','whatsapp','both'].includes(String(row.channel))&&['processing','group'].includes(String(row.issue_kind))&&['failed','overdue','uncertain'].includes(String(row.status))&&['original_name','received_at','pet_name','client_name','exam_type','reason'].every(field=>nullableText(row[field]))&&(row.received_at===null||Number.isFinite(Date.parse(String(row.received_at)))))
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
const receiptReasons:Record<string,string>={sender_review_required:'Remetente precisa de conferência',invalid_pdf_signature:'Arquivo sem assinatura PDF válida',outlook_child_unconfirmed:'Processamento precisa de confirmação',outlook_attachment_or_reservation_failed:'Não foi possível obter ou registrar o arquivo',outlook_non_pdf_review:'Formato do arquivo precisa de conferência',outlook_attachment_metadata_invalid:'Dados do anexo precisam de conferência',outlook_attachment_format_review:'Formato do arquivo precisa de conferência',source_reservation_unproven:'Não foi possível registrar a origem do arquivo',original_storage_pending:'Arquivo ainda não foi salvo',intake_receipt_unproven:'Não foi possível confirmar o processamento do arquivo',target_attachment_not_found:'Não foi possível localizar o anexo na mensagem',source_retry_unconfirmed:'Nova tentativa precisa de confirmação',child_response_uncertain:'Processamento precisa de confirmação',pdf_url_missing_or_untrusted:'Não foi possível acessar o arquivo recebido',pdf_size_invalid_or_exceeds_limit:'Arquivo com tamanho inválido ou acima do limite',pdf_metadata_mismatch:'Formato do arquivo precisa de conferência',whatsapp_media_download_failed:'Falha ao baixar o arquivo recebido',unsupported_attachment_requires_review:'Formato do arquivo precisa de conferência'}
function issue(row:ExamFailure){
  if(row.row_kind==='receipt')return receiptReasons[row.reason||'']||(row.status==='failed'?'Não foi possível processar o arquivo':'Arquivo aguardando processamento')
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
  const titleId=compact?'home-exam-failures-title':'exam-failures-title'
  return <section aria-labelledby={titleId} className="exam-conference">
    <header className="exam-conference-header">
      <div>
        <h2 id={titleId}>Exames que precisam de atenção</h2>
        <p>Exames com processamento ou envio ao grupo em atraso, com falha ou sem confirmação.</p>
      </div>
      {compact?<a className="exam-conference-link" href="/recebimentos">Abrir lista</a>:onRefresh&&<button type="button" className="exam-conference-button" disabled={refreshing} onClick={onRefresh}>{refreshing?'Atualizando…':'Atualizar'}</button>}
    </header>
    {loading&&!data&&!error&&!paused?<p role="status" className="exam-conference-message">Consultando exames…</p>:unavailable?<div role="alert" className="exam-conference-notice">Não foi possível consultar os exames que precisam de atenção. Tente atualizar a página.</div>:data&&rows?<>
      {stale&&<p role="status" className="exam-conference-notice">Consulta antiga ou pausada: os dados abaixo são de {formatDate(data.as_of)}.</p>}
      {data.coverage_status!=='proven'&&<details className="exam-conference-coverage">
        <summary>{data.coverage_status==='not_configured'?'A conferência ainda não foi iniciada.':'Não foi possível confirmar a conferência de todos os recebimentos.'}</summary>
        <ul aria-label="Conferência por canal">{data.channels.map(channel=><li key={channel.provider}>{channelName(channel.provider)}: {channelActivity(channel)}</li>)}</ul>
      </details>}
      {data.coverage_status==='not_configured'?null:data.total===0?<p className="exam-conference-message">Nenhum exame identificado precisa de atenção nesta consulta.</p>:<>
        <ul className="exam-conference-list">
          {rows.map(row=><li key={row.row_id||row.document_id} className="exam-conference-row">
            <div className="exam-conference-identity">
              <p className="exam-conference-name">{row.pet_name||row.original_name||(row.row_kind==='receipt'&&row.position?`Arquivo sem nome · anexo ${row.position}`:'Arquivo sem nome')}{row.client_name?` · ${row.client_name}`:row.sender?` · ${row.sender}`:''}</p>
              {row.pet_name&&row.original_name&&<p className="exam-conference-file">{row.original_name}</p>}
              <p className="exam-conference-meta">{row.row_kind==='receipt'?'Arquivo recebido':row.exam_type||'Tipo a conferir'} · {row.channel==='both'?'E-mail e WhatsApp':row.channel==='whatsapp'?'WhatsApp':'E-mail'} · {formatDate(row.received_at)}</p>
            </div>
            <div className="exam-conference-issue">
              <span className="exam-conference-stage">{row.issue_kind==='group'?'Envio ao grupo':'Processamento'}</span>
              <p>{issue(row)}</p>
            </div>
            {row.document_id&&<a className="exam-conference-link exam-conference-open" href={intakeDocumentHref(row.document_id)!}>{['unreadable_file','review_file'].includes(row.reason||'')?'Abrir registro':'Abrir exame'}</a>}
          </li>)}
        </ul>
        {compact&&data.total>rows.length&&<a href="/recebimentos" className="exam-conference-link">Abrir lista de exames</a>}
      </>}
      {data.coverage_status!=='not_configured'&&!compact&&(onPrevious||onNext)&&(data.total>0||pageNumber>1)&&<nav aria-label="Páginas de exames" className="exam-conference-pagination">
        <button type="button" className="exam-conference-button" disabled={pageNumber===1||refreshing} onClick={onPrevious}>Anterior</button>
        <span>{rows.length?`Página ${pageNumber} · ${rows.length} nesta consulta`:'Nenhum exame nesta página'}</span>
        <button type="button" className="exam-conference-button" disabled={!data.has_more||refreshing} onClick={onNext}>Próxima</button>
      </nav>}
    </>:null}
  </section>
}
