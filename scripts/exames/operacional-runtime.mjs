import crypto from 'node:crypto';

// Gmail MIME/bytes adapter reused from EXAMES-10. Pure functions: no network or credentials.
const EXPECTED_MAILBOX = 'exames@example.invalid';
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_MIME_DEPTH = 8;
function fail(code) { throw new Error(code); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function stableId(value, code, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.length) || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) fail(code);
  return value;
}
function unwrap(value) {
  if (object(value) && Object.hasOwn(value, 'statusCode')) {
    if (value.statusCode !== 200 || !object(value.body)) fail('gmail_http_response_unproven');
    return value.body;
  }
  if (!object(value)) fail('gmail_response_invalid');
  return value;
}
function verifyProfile(response, mailbox = EXPECTED_MAILBOX) {
  const profile = unwrap(response);
  if (mailbox !== EXPECTED_MAILBOX || profile.emailAddress !== mailbox) fail('gmail_account_mismatch');
  return { mailbox, accountId: 'gmail:' + mailbox, provider: 'gmail' };
}
function validateWindow(config) {
  if (config.mailbox !== EXPECTED_MAILBOX) fail('gmail_account_mismatch');
  for (const value of [config.windowStart, config.sweepEnd, config.intakeCutoff])
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) fail('gmail_window_invalid');
  const from = Date.parse(config.windowStart), through = Date.parse(config.sweepEnd), cutoff = Date.parse(config.intakeCutoff);
  if (!Number.isFinite(from) || !Number.isFinite(through) || !Number.isFinite(cutoff) || from < cutoff || through <= from) fail('gmail_window_invalid');
  return { from, through, cutoff };
}
function listQuery(config) {
  const { from, through } = validateWindow(config);
  // Widen the coarse seconds search, then enforce exact epoch-ms bounds on internalDate.
  return 'has:attachment after:' + (Math.floor(from / 1000) - 60) + ' before:' + (Math.ceil(through / 1000) + 60);
}
function metadataFields(maxDepth = MAX_MIME_DEPTH) {
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 12) fail('gmail_mime_depth_config_invalid');
  const own = 'partId,mimeType,filename,headers(name,value),body(attachmentId,size)';
  // The deepest parts marker detects projection truncation. No body.data at any level.
  let part = own + ',parts(partId)';
  for (let n = 0; n < maxDepth; n++) part = own + ',parts(' + part + ')';
  return 'id,threadId,internalDate,payload(' + part + ')';
}
function listIds(pages, maxPages = 100) {
  if (!Array.isArray(pages) || !pages.length || pages.length > maxPages) fail('gmail_pagination_limit');
  const ids = [], seenIds = new Set(), seenTokens = new Set();
  for (let index = 0; index < pages.length; index++) {
    const page = unwrap(pages[index]);
    if (page.messages !== undefined && !Array.isArray(page.messages)) fail('gmail_messages_invalid');
    for (const entry of page.messages || []) {
      if (!object(entry)) fail('gmail_message_reference_invalid');
      const id = stableId(entry.id, 'gmail_message_id_invalid');
      if (!seenIds.has(id)) { seenIds.add(id); ids.push({id}); }
    }
    if (page.nextPageToken !== undefined && page.nextPageToken !== '') {
      const token = stableId(page.nextPageToken, 'gmail_page_token_invalid');
      if (seenTokens.has(token)) fail('gmail_pagination_cycle');
      seenTokens.add(token);
      if (index === pages.length - 1) fail('gmail_pagination_incomplete');
    } else if (index !== pages.length - 1) fail('gmail_pagination_unexpected_extra_page');
  }
  return ids;
}
function header(headers, name) {
  if (headers !== undefined && !Array.isArray(headers)) fail('gmail_headers_invalid');
  const matches = (headers || []).filter(value => object(value) && String(value.name).toLowerCase() === name.toLowerCase());
  if (matches.length > 1) fail('gmail_ambiguous_header');
  if (!matches.length) return '';
  if (typeof matches[0].value !== 'string' || matches[0].value.length > 8192 || /[\r\n\x00]/.test(matches[0].value)) fail('gmail_header_invalid');
  return matches[0].value;
}
function senderAddress(from) {
  // A forwarded envelope remains its own sender; do not trust quoted body headers.
  const value = from.trim(), angle = value.match(/<([^<>\s]+@[^<>\s]+)>\s*$/);
  const email = angle ? angle[1] : value;
  return /^[^@\s<>;,]+@[^@\s<>;,]+$/.test(email) ? email.toLowerCase() : '';
}
function inspectMessage(response, expectedId, config) {
  const message = unwrap(response), bounds = validateWindow(config);
  if (config.mailbox !== EXPECTED_MAILBOX) fail('gmail_account_mismatch');
  if (message.id !== stableId(expectedId, 'gmail_expected_id_invalid')) fail('gmail_message_identity_mismatch');
  if (typeof message.internalDate !== 'string' || !/^\d{1,16}$/.test(message.internalDate)) fail('gmail_internal_date_invalid');
  const received = Number(message.internalDate);
  if (!Number.isSafeInteger(received) || received <= 0) fail('gmail_internal_date_invalid');
  if (received < bounds.from || received >= bounds.through || received < bounds.cutoff) return {excluded: true, reason: 'outside_received_window', origins: []};
  if (!object(message.payload)) fail('gmail_mime_payload_missing');
  const sender = senderAddress(header(message.payload.headers, 'From'));
  const subject = header(message.payload.headers, 'Subject');
  const internetMessageId = header(message.payload.headers, 'Message-ID');
  const trusted = Array.isArray(config.allowedSenders) && config.allowedSenders.includes(sender);
  const hint = Array.isArray(config.examSubjectHints) && config.examSubjectHints.some(value => subject.toLowerCase().includes(value.toLowerCase()));
  const needsReview = !trusted && !hint;
  const parts = [], partIds = new Set();
  function visit(part, depth) {
    if (!object(part) || depth > (config.maxMimeDepth ?? MAX_MIME_DEPTH)) fail('gmail_mime_projection_or_depth_incomplete');
    const partId = stableId(part.partId, 'gmail_part_id_invalid', true);
    if (partIds.has(partId)) fail('gmail_duplicate_part_id');
    partIds.add(partId);
    if (part.body !== undefined && !object(part.body)) fail('gmail_part_body_invalid');
    if (part.body && Object.hasOwn(part.body, 'data')) fail('gmail_bytes_received_before_reservation');
    if (typeof part.mimeType !== 'string') fail('gmail_mime_projection_or_depth_incomplete');
    if (part.parts !== undefined && !Array.isArray(part.parts)) fail('gmail_mime_parts_invalid');
    const pdf = part.mimeType.toLowerCase() === 'application/pdf' || /\.pdf$/i.test(part.filename || '');
    if (pdf) {
      const attachmentId = part.body?.attachmentId;
      if (attachmentId !== undefined) stableId(attachmentId, 'gmail_attachment_id_invalid');
      const size = part.body?.size;
      if (!Number.isSafeInteger(size) || size < 0) fail('gmail_attachment_size_invalid');
      parts.push({partId, attachmentId: attachmentId || null, size, name: part.filename || 'original.pdf', mimeType: part.mimeType});
    }
    for (const child of part.parts || []) visit(child, depth + 1);
  }
  visit(message.payload, 0);
  const receivedAt = new Date(received).toISOString();
  const normalizedMessage = {id: message.id, internalDate: message.internalDate, receivedDateTime: receivedAt,
    sender, subject, internetMessageId, unknownSender: !trusted};
  const create = part => {
    const inline = !part.attachmentId;
    const key = 'gmail-part:' + JSON.stringify([part.partId, part.attachmentId]);
    const reason = inline ? 'bytes_inline_nao_suportados' : part.size > (config.maxBytes ?? MAX_BYTES) ? 'pdf_exceeds_limit' : needsReview ? 'pdf_sem_indicio_exame' : null;
    const source = {channel: 'email', account_id: 'gmail:' + config.mailbox, message_id: message.id,
      attachment_id: key, original_name: part.name, mime_type: part.mimeType, received_at: receivedAt,
      metadata: {provider: 'gmail', mailbox: config.mailbox, gmail_message_id: message.id, exam_candidate: hint, gmail_part_id: part.partId,
        gmail_attachment_id: part.attachmentId, internet_message_id: internetMessageId, unknown_sender: !trusted && config.dedicatedMailbox !== true, sender_address: sender, sender_allowlisted: trusted,
        missing_attachment: inline, unsupported_attachment: inline || part.size > (config.maxBytes ?? MAX_BYTES),
        pending_reason: reason, review_reason: needsReview ? 'PDF sem indício clínico: conferência humana antes dos bytes' : null, subject}};
    return {message: normalizedMessage, attachment: {id: key, partId: part.partId, gmailAttachmentId: part.attachmentId,
      name: part.name, contentType: part.mimeType, size: part.size}, source,
      missing: inline || part.size > (config.maxBytes ?? MAX_BYTES), needsReview, pendingReason: reason};
  };
  if (parts.length) return {excluded: false, origins: parts.map(create)};
  if (needsReview) return {excluded: true, reason: 'no_pdf_or_exam_hint', origins: []};
  const source = {channel: 'email', account_id: 'gmail:' + config.mailbox, message_id: message.id, attachment_id: 'missing-pdf',
    original_name: 'PDF ausente', mime_type: null, received_at: receivedAt,
    metadata: {provider: 'gmail', mailbox: config.mailbox, gmail_message_id: message.id, exam_candidate: hint, internet_message_id: internetMessageId,
      unknown_sender: !trusted && config.dedicatedMailbox !== true, sender_address: sender, sender_allowlisted: trusted, missing_attachment: true, pending_reason: 'notice_without_pdf', subject}};
  return {excluded: false, origins: [{message: normalizedMessage, attachment: {id: 'missing-pdf', name: 'PDF ausente', contentType: null},
    source, missing: true, pendingReason: 'notice_without_pdf'}]};
}
function decideReservation(origin, response) {
  const reservation = response;
  if (!object(reservation) || typeof reservation.document_id !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(reservation.document_id)) fail('gmail_source_reservation_unproven');
  if (reservation.document && reservation.document.id !== reservation.document_id) fail('gmail_source_reservation_identity_mismatch');
  return {...origin, reservation, documentId: reservation.document_id,
    skip: origin.missing || reservation.document?.file_status === 'saved' || reservation.document?.identification_status === 'not_exam'};
}
function decodeOriginal(response, source, config) {
  const body = unwrap(response), maxBytes = config.maxBytes ?? MAX_BYTES;
  if (!source?.documentId || source.skip || !source.attachment?.gmailAttachmentId) fail('gmail_original_not_reserved');
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) fail('gmail_max_bytes_invalid');
  if (typeof body.data !== 'string' || !body.data.length || body.data.length > Math.ceil(maxBytes / 3) * 4 + 2 || !/^[A-Za-z0-9_-]+={0,2}$/.test(body.data)) fail('gmail_base64url_invalid_or_oversize');
  const raw = body.data.replace(/=+$/, '');
  if (raw.length % 4 === 1 || (body.data.includes('=') && body.data.length % 4 !== 0)) fail('gmail_base64url_invalid_or_oversize');
  const bytes = Buffer.from(raw, 'base64url');
  if (!bytes.length || bytes.length > maxBytes || bytes.toString('base64url') !== raw) fail('gmail_base64url_invalid_or_oversize');
  if (!Number.isSafeInteger(body.size) || body.size !== bytes.length || source.attachment.size !== bytes.length) fail('gmail_attachment_size_mismatch');
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) fail('gmail_pdf_signature_missing');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const folderId = config.driveFolderId;
  if (typeof folderId !== 'string' || !folderId.length) fail('gmail_destination_folder_missing');
  return {bytes, json: {...source, sha256, sizeBytes: bytes.length, folderId}};
}

function validateFolder(response, folderId) {
  const f=unwrap(response);
  if(f.id!==folderId||f.mimeType!=='application/vnd.google-apps.folder'||f.trashed!==false||f.ownedByMe!==true||f.shared!==false||f.capabilities?.canAddChildren!==true)fail('drive_private_owned_folder_unproven');
  return f;
}
function validateStage(stage, decoded) {
  if(!object(stage)||!object(stage.document)||stage.document_id!==stage.document.id||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(stage.document_id)||stage.document.sha256!==decoded.sha256||Number(stage.document.size_bytes)!==decoded.sizeBytes||stage.drive_file_id!==stage.document.drive_file_id||!stage.drive_file_id)fail('drive_stage_receipt_unproven');
  if(stage.claimed===true&&(!stage.lease_token||!stage.delivery_id))fail('drive_stage_lease_missing');
  if(stage.document.file_status==='saved'&&stage.upload_required!==false)fail('drive_saved_receipt_unproven');
  return stage;
}
function inspectDriveObject(response, stage, decoded) {
  validateStage(stage,decoded);
  if(!object(response)||![200,404].includes(response.statusCode))fail('drive_lookup_unproven');
  const f=response.body;
  if(response.statusCode===200){
    if(!object(f)||f.id!==stage.drive_file_id||f.mimeType!=='application/pdf'||f.trashed!==false||f.ownedByMe!==true||f.shared!==false||!Array.isArray(f.parents)||f.parents.length!==1||f.parents[0]!==stage.document.drive_folder_id)fail('drive_object_identity_or_parent_unproven');
    if(f.appProperties?.exam_document_id!==stage.document_id||f.appProperties?.sha256!==decoded.sha256)fail('drive_object_binding_unproven');
    if(Number(f.size)>0&&Number(f.size)!==decoded.sizeBytes)fail('drive_existing_bytes_conflict');
  }
  return {...stage,exists:response.statusCode===200,hasBytes:response.statusCode===200&&Number(f.size)>0,driveName:f?.name||('Recebido - '+stage.document.received_at.slice(0,10)+' - '+stage.document_id.slice(0,8)+' - '+stage.document.original_name)};
}
function verifySaved(receipt, stage, decoded) {
  if(!object(receipt)||receipt.document_id!==stage.document_id||receipt.document?.id!==stage.document_id||receipt.document.file_status!=='saved'||receipt.document.sha256!==decoded.sha256||Number(receipt.document.size_bytes)!==decoded.sizeBytes||receipt.document.drive_file_id!==stage.drive_file_id||receipt.document.drive_folder_id!==stage.document.drive_folder_id)fail('drive_confirmation_unproven');
  return {document_id:receipt.document_id,status:'saved'};
}
export {EXPECTED_MAILBOX,MAX_BYTES,MAX_MIME_DEPTH,fail,object,stableId,unwrap,verifyProfile,validateWindow,listQuery,metadataFields,listIds,header,senderAddress,inspectMessage,decideReservation,decodeOriginal,validateFolder,validateStage,inspectDriveObject,verifySaved};
