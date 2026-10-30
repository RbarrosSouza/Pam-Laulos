export type Original={document_id:string;original_name:string;sha256:string|null;file_status:string;group_status:string}
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
export const groupLabels:Record<string,string>={sent:'Enviado ao grupo',submitted:'Envio em confirmação',uncertain:'Envio em conferência',reserved:'Envio em andamento',pending:'Aguardando envio ao grupo',failed:'Falha no envio ao grupo',held:'Aguardando captura do original',waived:'Envio dispensado',not_queued:'Envio ainda não agendado'}
