import { useState } from 'react'

export type VersionReviewDecision='clinical_complement_confirmed'|'clinical_correction_confirmed'|'inconclusive'
type Original={document_id:string;original_name:string;sha256:string|null;file_status:string;group_status:string}
export type VersionReviewData={contract:'exam_intake_version_review_v1';document_id:string;hold:{state:'held'|'released';reason:string;previous_document_id:string|null;created_at:string;released_at:string|null}|null;current:Original;previous:Original|null;review_allowed:boolean;can_link_previous:boolean;blocking_reason:string|null;decision:{reason_code:string;reviewed_at:string}|null}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const sha=/^[a-f0-9]{64}$/
const codes:VersionReviewDecision[]=['clinical_complement_confirmed','clinical_correction_confirmed','inconclusive']
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const original=(v:unknown)=>object(v)&&typeof v.document_id==='string'&&uuid.test(v.document_id)&&typeof v.original_name==='string'&&(v.sha256===null||(typeof v.sha256==='string'&&sha.test(v.sha256)))&&typeof v.file_status==='string'&&typeof v.group_status==='string'
export function isVersionReviewData(v:unknown):v is VersionReviewData{
  if(!object(v)||v.contract!=='exam_intake_version_review_v1'||typeof v.document_id!=='string'||!uuid.test(v.document_id)||!original(v.current)||(v.previous!==null&&!original(v.previous))||typeof v.review_allowed!=='boolean'||typeof v.can_link_previous!=='boolean')return false
  if((v.current as Original).document_id!==v.document_id)return false
  if(v.hold!==null&&(!object(v.hold)||!['held','released'].includes(String(v.hold.state))||typeof v.hold.reason!=='string'||!(v.hold.previous_document_id===null||(typeof v.hold.previous_document_id==='string'&&uuid.test(v.hold.previous_document_id)))))return false
  if(object(v.hold)&&v.hold.previous_document_id!==null&&object(v.previous)&&v.hold.previous_document_id!==v.previous.document_id)return false
  return v.decision===null||(object(v.decision)&&typeof v.decision.reason_code==='string'&&typeof v.decision.reviewed_at==='string')
}
export function buildVersionReviewSubmission(data:VersionReviewData,role:string|null,decision:string,confirmed:boolean){
  if(!['admin','vet'].includes(role||'')||!data.review_allowed||data.hold?.state!=='held'||!['changed_content_review','historical_snapshot_unavailable'].includes(data.hold.reason)||!confirmed||!codes.includes(decision as VersionReviewDecision)||data.current.file_status!=='saved'||!data.current.sha256||!sha.test(data.current.sha256))return null
  if(decision!=='inconclusive'&&(!data.can_link_previous||!data.previous||data.previous.file_status!=='saved'||!data.previous.sha256||data.previous.sha256===data.current.sha256))return null
  return {p_document_id:data.document_id,p_expected_sha256:data.current.sha256,p_reason_code:decision as VersionReviewDecision}
}
export const hasVersionReviewNotice=(data:VersionReviewData)=>!!data.decision||data.hold?.state==='held'||['changed_content_review','historical_snapshot_unavailable'].includes(data.hold?.reason||'')
const reasonLabels:Record<string,string>={changed_content_review:'Recebemos outro PDF para esta requisição. Cada original tem seu próprio envio ao grupo.',historical_snapshot_unavailable:'A nova cópia tem envio próprio ao grupo. O original anterior não está disponível para comparação.',awaiting_snapshot:'A captura do novo original ainda está pendente.',missing_link:'O link do original está ausente.'}
const blockingLabels:Record<string,string>={previous_document_missing:'O documento anterior ainda não foi localizado.',previous_original_not_preserved:'O original anterior ainda não está preservado.',previous_patient_not_confirmed:'Confirme o paciente no documento anterior antes de ligar as versões.',current_patient_already_linked:'O novo documento já tem vínculo clínico e precisa de conferência antes de ligar as versões.',current_original_not_preserved:'Aguarde a preservação do original atual.',same_content:'Os dois registros apontam para o mesmo conteúdo.',current_previous_already_set:'O documento atual já possui uma versão anterior vinculada.',version_lineage_unresolved:'A relação entre as versões precisa de conferência adicional.',patient_conflict:'Há uma divergência entre os pacientes das duas versões.'}
const decisionLabels:Record<string,string>={clinical_complement_confirmed:'Complemento clínico confirmado',clinical_correction_confirmed:'Correção confirmada',inconclusive:'Relação clínica inconclusiva'}
const groupLabels:Record<string,string>={sent:'Enviado ao grupo',submitted:'Envio em confirmação',uncertain:'Envio em conferência',reserved:'Envio em andamento',pending:'Aguardando envio ao grupo',failed:'Falha no envio ao grupo',held:'Aguardando captura do original',waived:'Envio dispensado',not_queued:'Envio ainda não agendado'}
const input='rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--card))] px-3 py-2 text-sm'
function OriginalCard({title,value}:{title:string;value:Original|null}){
  return <article className="min-w-0 rounded-xl border bg-[hsl(var(--card))] p-3"><h3 className="text-sm font-semibold">{title}</h3>{value?<><p className="mt-2 break-words text-sm">{value.original_name}</p><p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{value.file_status==='saved'?'Original preservado':'Original ainda sem preservação comprovada'}</p><p className="mt-1 text-xs font-medium">{groupLabels[value.group_status]||'Situação do envio a conferir'}</p>{value.file_status==='saved'&&uuid.test(value.document_id)&&<a className="mt-3 inline-block text-sm font-medium underline underline-offset-4" href={`/novos-exames/${value.document_id}?panel=pdf`} target="_blank" rel="noopener noreferrer">Conferir PDF {title==='Original atual'?'atual':'anterior'}</a>}</>:<p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">Original anterior indisponível para comparação.</p>}</article>
}
export function DocumentVersionReviewView({data,role,saving=false,error=null,completion=null,onSubmit,onRetry}:{data:VersionReviewData;role:string|null;saving?:boolean;error?:string|null;completion?:string|null;onSubmit:(decision:VersionReviewDecision)=>void;onRetry?:()=>void}){
  const [decision,setDecision]=useState<VersionReviewDecision|''>('')
  const [confirmed,setConfirmed]=useState(false)
  const held=data.hold?.state==='held'
  const canReview=['admin','vet'].includes(role||'')&&data.review_allowed&&held&&['changed_content_review','historical_snapshot_unavailable'].includes(data.hold?.reason||'')
  const eligible=buildVersionReviewSubmission(data,role,decision,confirmed)!==null
  const versionNotice=['changed_content_review','historical_snapshot_unavailable'].includes(data.hold?.reason||'')||!!data.decision
  const bothSent=data.previous?.group_status==='sent'&&data.current.group_status==='sent'
  const reviewContent=<>
    {versionNotice&&<p className="text-sm">Se desejar, registre se o novo PDF é um complemento ou uma correção. Essa classificação não é necessária para enviar os dois originais ao grupo.</p>}
    {held&&data.decision&&<p className="text-sm font-medium">Última revisão: {decisionLabels[data.decision.reason_code]||'Registrada pela equipe'}.</p>}
    <p className="text-sm">Registrar a relação preserva os recibos e não repete o envio ao grupo.</p>
    {completion?<div role="status" className="rounded-xl border bg-white p-3 text-sm"><p>{completion}</p>{onRetry&&<button type="button" className={`${input} mt-3`} onClick={onRetry}>Atualizar conferência da versão</button>}</div>:canReview?<>
      {!data.can_link_previous&&<p role="status" className="text-sm text-amber-950">{blockingLabels[data.blocking_reason||'']||'Os requisitos para ligar clinicamente as versões ainda não estão completos. A relação clínica permanece pendente.'}</p>}
      <fieldset disabled={saving} className="space-y-3"><legend className="mb-2 text-sm font-semibold">Qual é a relação entre os resultados?</legend>{([
        ['clinical_complement_confirmed','Complemento clínico','O novo original acrescenta resultados ao exame anterior.'],
        ['clinical_correction_confirmed','Correção','O novo original corrige informações do exame anterior.'],
        ['inconclusive','Inconclusivo','Ainda não há evidência suficiente para ligar clinicamente as versões.'],
      ] as const).map(([code,title,description])=><label key={code} className={`flex items-start gap-2 text-sm ${code!=='inconclusive'&&!data.can_link_previous?'opacity-60':''}`}><input type="radio" name={`version-decision-${data.document_id}`} value={code} checked={decision===code} disabled={code!=='inconclusive'&&!data.can_link_previous} onChange={()=>{setDecision(code);setConfirmed(false)}} className="mt-1"/><span><strong className="block">{title}</strong>{description}</span></label>)}<label className="flex items-start gap-2 border-t border-amber-200 pt-3 text-sm"><input type="checkbox" checked={confirmed} disabled={!decision} onChange={e=>setConfirmed(e.target.checked)} className="mt-1"/><span>{decision==='inconclusive'?'Confirmo que a relação clínica entre as versões permanece inconclusiva.':'Comparei os originais e confirmei o paciente e a relação clínica escolhida.'}</span></label></fieldset>
      <p className="text-xs text-[hsl(var(--muted-foreground))]">Cada PDF diferente segue para o grupo independentemente desta revisão. Esta decisão registra a relação entre as versões; o cadastro clínico é feito separadamente.</p>
      {error&&<p role="alert" className="text-sm text-red-800">{error}</p>}
      <button type="button" className="min-h-11 rounded-lg bg-[hsl(var(--primary))] px-4 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={!eligible||saving} onClick={()=>{if(eligible&&decision)onSubmit(decision)}}>{saving?'Registrando revisão…':decision==='inconclusive'?'Registrar relação inconclusiva':'Registrar relação entre versões'}</button>
    </>:held?<p className="text-sm">{['admin','vet'].includes(role||'')?'Aguarde a preservação dos originais para concluir a revisão.':'A revisão clínica é realizada por uma veterinária ou pela administração.'}</p>:null}
  </>
  return <section aria-label="Atualização e envio dos originais" className={`my-5 space-y-4 rounded-2xl border p-4 text-[hsl(var(--foreground))] ${bothSent?'border-emerald-200 bg-emerald-50/60':'border-amber-200 bg-amber-50/60'}`}>
    <header><p className={`text-xs font-semibold uppercase tracking-wide ${bothSent?'text-emerald-900':'text-amber-900'}`}>{versionNotice?'Atualização recebida':'Original em conferência'}</p><h2 className="mt-1 text-lg font-semibold">{versionNotice?(bothSent?'Os dois originais foram enviados ao grupo':'Envio dos originais ao grupo'):held?'Captura do original pendente':'Conferência do original'}</h2><p className="mt-2 text-sm">{versionNotice?reasonLabels[data.hold?.reason||'']||'Cada PDF diferente tem envio próprio ao grupo.':reasonLabels[data.hold?.reason||'']||'Confira a preservação do original.'}</p></header>
    <div className="grid gap-3 sm:grid-cols-2"><OriginalCard title="Original anterior" value={data.previous}/><OriginalCard title="Original atual" value={data.current}/></div>
    {versionNotice?<details open={completion||error?true:undefined} className="border-t pt-3"><summary className="cursor-pointer text-sm font-medium">{data.decision?`${decisionLabels[data.decision.reason_code]||'Relação registrada'} · Ver classificação`:'Classificar como complemento ou correção (opcional)'}</summary><div className="mt-4 space-y-4">{reviewContent}</div></details>:reviewContent}
  </section>
}
