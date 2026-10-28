export const HOPELAB_NOTICE_V2_CONTRACT = 'hopelab_notice_v2_hold_v1';

export function validateHopelabNoticeV2Policy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)
    || Object.keys(policy).some(key => !['cutover','replayNoticeIds','accountId','backendContract'].includes(key))
    || typeof policy.cutover !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(policy.cutover)
    || !Number.isFinite(Date.parse(policy.cutover)) || typeof policy.accountId !== 'string'
    || !/^gmail:[^\s@]+@[^\s@]+$/.test(policy.accountId)
    || policy.backendContract !== 'hopelab_notice_v2_hold_v1'
    || !Array.isArray(policy.replayNoticeIds) || policy.replayNoticeIds.length > 20
    || policy.replayNoticeIds.some(value => typeof value !== 'string' || !/^[a-f\d]{8,64}$/i.test(value))
    || new Set(policy.replayNoticeIds).size !== policy.replayNoticeIds.length) {
    throw new Error('hopelab_notice_v2_policy_invalid');
  }
  return policy;
}

export function applyHopelabNoticeV2Policy(origin, policy) {
  validateHopelabNoticeV2Policy(policy);
  const source = origin?.source, metadata = source?.metadata, noticeId = origin?.message?.id;
  if (!source || source.channel !== 'email' || source.account_id !== policy.accountId || metadata?.provider !== 'hopelab_link'
    || typeof noticeId !== 'string' || !/^[a-f\d]{8,64}$/i.test(noticeId) || metadata.gmail_message_id !== noticeId
    || typeof source.received_at !== 'string' || !Number.isFinite(Date.parse(source.received_at))
    || String(Date.parse(source.received_at)) !== origin.message.internalDate) throw new Error('hopelab_notice_v2_origin_invalid');
  const selected = policy.replayNoticeIds.includes(noticeId);
  if (Date.parse(source.received_at) < Date.parse(policy.cutover) && !selected) return origin;
  const digest = metadata.link_sha256 ?? null;
  if ((digest !== null && (typeof digest !== 'string' || !/^[a-f\d]{64}$/.test(digest)))
    || source.attachment_id !== (digest ? 'hopelab-link:'+digest : 'hopelab-link:missing')
    || source.message_id !== (digest ? 'hopelab-result:'+digest : noticeId)) throw new Error('hopelab_notice_v2_link_binding_invalid');
  const result = JSON.parse(JSON.stringify(origin));
  result.source.message_id = noticeId;
  result.source.metadata.hopelab_notice_protocol = 'gmail_notice_link_v2';
  result.source.metadata.hopelab_notice_id = noticeId;
  result.source.metadata.hopelab_notice_cutover = policy.cutover;
  result.source.metadata.hopelab_notice_scope = selected ? 'explicit_replay' : 'prospective';
  return result;
}

export function verifyHopelabNoticeV2Reservation(origin, reservation) {
  if (origin?.source?.metadata?.hopelab_notice_protocol !== 'gmail_notice_link_v2') return;
  const source = origin.source, metadata = source.metadata, ack = reservation?.hopelab_notice_v2;
  if (!ack || ack.contract !== 'hopelab_notice_v2_hold_v1' || ack.group_hold_enforced !== true
    || typeof ack.source_id !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(ack.source_id)
    || ack.notice_id !== source.message_id || ack.notice_id !== metadata.gmail_message_id
    || ack.url_sha256 !== (metadata.link_sha256 ?? null)) throw new Error('hopelab_notice_v2_backend_contract_unproven');
}

export function classifyHopelabContentSnapshot(snapshot, lineageHistory, context) {
  const validHash = value => typeof value === 'string' && /^[a-f\d]{64}$/.test(value);
  if (!snapshot || !validHash(snapshot.sha256) || !Number.isSafeInteger(snapshot.sizeBytes) || snapshot.sizeBytes < 1
    || !Array.isArray(lineageHistory) || !context || typeof context.lineageHistoryComplete !== 'boolean'
    || typeof context.canonicalAlreadyExisted !== 'boolean' || typeof context.canonicalHasReviewHold !== 'boolean'
    || typeof context.canonicalDocumentId !== 'string'
    || lineageHistory.some(previous => !validHash(previous.sha256) || !Number.isSafeInteger(previous.sizeBytes) || previous.sizeBytes < 1)) {
    throw new Error('hopelab_snapshot_contract_invalid');
  }
  const exact = lineageHistory.some(previous => previous.sha256 === snapshot.sha256 && previous.sizeBytes === snapshot.sizeBytes);
  if (context.canonicalAlreadyExisted || exact) return {state:'known_content',groupAction:'preserve_existing',
    requiresReview:context.canonicalHasReviewHold,canonicalDocumentId:context.canonicalDocumentId,preservePriorDeliveries:true};
  if (!context.lineageHistoryComplete || lineageHistory.length) return {state:'pending_review',groupAction:'hold_new_document',
    requiresReview:true,canonicalDocumentId:context.canonicalDocumentId,preservePriorDeliveries:true};
  return {state:'new_original',groupAction:'existing_clinical_policy',requiresReview:false,
    canonicalDocumentId:context.canonicalDocumentId,preservePriorDeliveries:true};
}
