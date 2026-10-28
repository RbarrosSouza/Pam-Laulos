type Json = Record<string, unknown>;
type Rpc = (name: string, args: Json) => Promise<unknown>;
type Helpers = { uuid: (value: unknown) => string; hash: (bytes: ArrayBuffer) => Promise<string> };
export const intakeActions = new Set(['intake_begin','intake_resume','intake_event','intake_finish','intake_health','intake_status','intake_lookup_source','intake_list_pending_sources','intake_resolve_receipt_saved','intake_alert_reserve','intake_alert_begin','intake_alert_result','reserve_intake_source','stage_intake_file']);
export async function runIntakeAction(action: string, payload: Json, rpc: Rpc, helpers: Helpers) {
  const object = (value: unknown): Json => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('INTAKE_OBJECT_REQUIRED'), { status: 400 });
    return value as Json;
  };
  const id = helpers.uuid;
  switch (action) {
    case 'intake_begin': return rpc('begin_exam_intake_sweep', {p_collector_id: String(payload.collector_id || ''),p_scope_key: String(payload.scope_key || ''),p_scope_manifest: object(payload.scope_manifest),p_received_from: payload.received_from,p_received_through: payload.received_through,p_request_id: id(payload.request_id),p_mode: String(payload.mode || 'audit'),p_ttl_seconds: Number(payload.ttl_seconds ?? 900)});
    case 'intake_resume': {
      const ttl=payload.ttl_seconds ?? 900;
      if(typeof payload.collector_id!=='string'||!/^([A-Za-z0-9_.:-]){1,96}$/.test(payload.collector_id)
        ||typeof payload.scope_key!=='string'||!/^[a-f0-9]{64}$/.test(payload.scope_key)
        ||!Number.isSafeInteger(ttl)||Number(ttl)<60||Number(ttl)>3600
        ||Object.keys(payload).some(key=>!['collector_id','scope_key','request_id','sweep_id','run_token','resume_request_id','ttl_seconds'].includes(key)))
        throw Object.assign(new Error('INTAKE_RESUME_IDENTITY_INVALID'),{status:400});
      return rpc('resume_exam_intake_sweep',{p_collector_id:payload.collector_id,p_scope_key:payload.scope_key,
        p_request_id:id(payload.request_id),p_sweep_id:id(payload.sweep_id),p_run_token:id(payload.run_token),
        p_resume_request_id:id(payload.resume_request_id),p_ttl_seconds:ttl});
    }
    case 'intake_event': return rpc('record_exam_intake_event',{p_sweep_id:id(payload.sweep_id),p_run_token:id(payload.run_token),p_event:object(payload.event)});
    case 'intake_finish': return rpc('finish_exam_intake_sweep',{p_sweep_id:id(payload.sweep_id),p_run_token:id(payload.run_token)});
    case 'intake_health': return rpc('check_exam_intake_health',{});
    case 'intake_status': return rpc('get_exam_intake_worker_status',{});
    case 'intake_list_pending_sources': {
      const limit=payload.limit ?? 50;
      if(typeof payload.collector_id!=='string'||!/^([A-Za-z0-9_.:-]){1,96}$/.test(payload.collector_id)
        ||!Number.isSafeInteger(limit)||Number(limit)<1||Number(limit)>100
        ||Object.keys(payload).some(key=>!['collector_id','after_receipt_id','limit'].includes(key)))
        throw Object.assign(new Error('INTAKE_PENDING_PAGE_INVALID'),{status:400});
      return rpc('list_exam_intake_pending_sources',{p_collector_id:payload.collector_id,
        p_after_receipt_id:payload.after_receipt_id == null ? null : id(payload.after_receipt_id),p_limit:limit});
    }
    case 'intake_resolve_receipt_saved': {
      if(Object.keys(payload).some(key=>!['receipt_id','source_id','document_id'].includes(key)))
        throw Object.assign(new Error('INTAKE_RECEIPT_RESOLUTION_INVALID'),{status:400});
      return rpc('resolve_exam_intake_receipt_saved',{p_receipt_id:id(payload.receipt_id),p_source_id:id(payload.source_id),p_document_id:id(payload.document_id)});
    }
    case 'intake_lookup_source': {
      const identities=payload.identities;
      const validText=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=2048&&!/[\x00-\x1f\x7f]/.test(value);
      if(!validText(payload.collector_id)||!Array.isArray(identities)||identities.length<1||identities.length>100
        ||identities.some(value=>!value||typeof value!=='object'||Array.isArray(value)
          ||Object.keys(value).some(key=>!['account_id','message_id','attachment_id','partition_key'].includes(key))
          ||!['account_id','message_id','attachment_id'].every(key=>validText(value[key]))
          ||value.partition_key!==undefined&&!validText(value.partition_key))) throw Object.assign(new Error('INTAKE_LOOKUP_IDENTITIES_INVALID'),{status:400});
      return rpc('lookup_exam_intake_sources',{p_collector_id:payload.collector_id,p_identities:identities});
    }
    case 'intake_alert_reserve': return rpc('reserve_exam_intake_alert',{p_worker:String(payload.worker || '')});
    case 'intake_alert_begin': {
      if(typeof payload.content !== 'string' || !payload.content.trim() || payload.content.length > 12000 || payload.content.includes('\u0000')) throw Object.assign(new Error('INTAKE_ALERT_CONTENT_INVALID'), { status: 400 });
      const hash=await helpers.hash(new TextEncoder().encode(payload.content).buffer as ArrayBuffer);
      return rpc('begin_exam_intake_alert',{p_alert_id:id(payload.alert_id),p_lease_token:id(payload.lease_token),p_destination_key:String(payload.destination_key || ''),p_content_sha256:hash});
    }
    case 'intake_alert_result': return rpc('record_exam_intake_alert_result',{p_alert_id:id(payload.alert_id),p_lease_token:id(payload.lease_token),p_outcome:object(payload.outcome)});
    case 'reserve_intake_source': return rpc('reserve_exam_intake_source',{p_source:object(payload.source)});
    case 'stage_intake_file': {
      const file={...object(payload.file)};delete file.staging_bucket;delete file.staging_path;
      return rpc('stage_exam_intake_file',{p_document_id:id(payload.document_id),p_file:file,p_worker:String(payload.worker || 'ingestion')});
    }
    default: throw Object.assign(new Error('INTAKE_ACTION_UNKNOWN'), { status: 400 });
  }
}
