// These functions are bundled into n8n Code nodes; keep their dependencies explicit.
export function canRecoverReservedDrive(origin) {
  const d=origin?.reservation?.document;
  return origin?.skip!==true && !!d && d.id===origin.documentId && /^[a-f0-9]{64}$/.test(d.sha256 || '')
    && Number.isSafeInteger(Number(d.size_bytes)) && Number(d.size_bytes)>0 && Number(d.size_bytes)<=20971520
    && typeof d.drive_file_id==='string' && /^[A-Za-z0-9_-]{1,200}$/.test(d.drive_file_id)
    && typeof d.drive_folder_id==='string' && /^[A-Za-z0-9_-]{1,200}$/.test(d.drive_folder_id);
}
export function inspectReservedDrive(response,origin) {
  if(!canRecoverReservedDrive(origin))throw new Error('drive_recovery_identity_unproven');
  if(!response || ![200,404].includes(response.statusCode))throw new Error('drive_recovery_lookup_failed');
  if(response.statusCode===404)return {...origin,restoreReservedOriginal:false};
  const f=response.body,d=origin.reservation.document;
  if(!f || f.id!==d.drive_file_id || f.mimeType!=='application/pdf' || f.trashed!==false || f.ownedByMe!==true || f.shared!==false
    || !Array.isArray(f.parents) || f.parents.length!==1 || f.parents[0]!==d.drive_folder_id
    || f.appProperties?.exam_document_id!==d.id || f.appProperties?.sha256!==d.sha256)throw new Error('drive_recovery_binding_conflict');
  const size=Number(f.size);
  if(!Number.isSafeInteger(size)||size<0||size>0&&size!==Number(d.size_bytes)
    || f.sha256Checksum!==undefined&&size>0&&f.sha256Checksum!==d.sha256)throw new Error('drive_recovery_content_conflict');
  return {...origin,restoreReservedOriginal:size>0};
}
export function decodeReservedDriveOriginal(bytes,origin,config) {
  if(!canRecoverReservedDrive(origin))throw new Error('drive_recovery_identity_unproven');
  const d=origin.reservation.document,max=config.maxBytes??20971520;
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>max||bytes.length!==Number(d.size_bytes)
    || !bytes.subarray(0,1024).includes(Buffer.from('%PDF-')) || crypto.createHash('sha256').update(bytes).digest('hex')!==d.sha256)
    throw new Error('drive_recovery_content_conflict');
  return {bytes,json:{...origin,sha256:d.sha256,sizeBytes:bytes.length,folderId:d.drive_folder_id,recoveredReservedOriginal:true}};
}
export const INTAKE_FAILURE_CODES=Object.freeze(['gmail_download_failed','hopelab_download_failed','inline_download_failed','inline_identity_failed','invalid_pdf_signature','original_validation_failed','drive_id_failed','drive_stage_failed','drive_lookup_failed','drive_binding_conflict','drive_create_failed','drive_upload_failed','drive_readback_failed','drive_integrity_conflict','drive_confirmation_failed','drive_recovery_lookup_failed','drive_recovery_binding_conflict','drive_recovery_content_conflict']);
export function classifyGmailDriveFailure(value,stage) {
  const allowed=['gmail_download_failed','hopelab_download_failed','inline_download_failed','inline_identity_failed','invalid_pdf_signature','original_validation_failed','drive_id_failed','drive_stage_failed','drive_lookup_failed','drive_binding_conflict','drive_create_failed','drive_upload_failed','drive_readback_failed','drive_integrity_conflict','drive_confirmation_failed','drive_recovery_lookup_failed','drive_recovery_binding_conflict','drive_recovery_content_conflict'];
  const text=typeof value?.error==='string'?value.error:typeof value?.error?.message==='string'?value.error.message:'';
  const exact=text.replace(/\s+\[line \d+\]$/,'');
  if(['gmail_pdf_signature_missing','hopelab_pdf_signature_missing'].includes(exact))return 'invalid_pdf_signature';
  if(allowed.includes(exact))return exact;
  return allowed.includes(stage)?stage:'original_validation_failed';
}
