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
  return '{has:attachment (from:hopelab@exames.vet.br subject:"Exame finalizado")} after:' + (Math.floor(from / 1000) - 60) + ' before:' + (Math.ceil(through / 1000) + 60);
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
function inspectHopelabNotice(response, expectedId, config) {
  const checked = inspectMessage(response, expectedId, config), message = unwrap(response);
  if (checked.excluded && checked.reason === 'outside_received_window') return null;
  if (senderAddress(header(message.payload.headers, 'From')) !== 'hopelab@exames.vet.br' || !/^Exame finalizado(?:\s|:|$)/i.test(header(message.payload.headers, 'Subject').trim())) return null;
  // Existing PDF attachments keep the established attachment path.
  if (checked.origins.some(origin => origin.attachment.id !== 'missing-pdf')) return null;
  return {id:message.id,internalDate:message.internalDate,sender:'hopelab@exames.vet.br',subject:header(message.payload.headers,'Subject'),internetMessageId:header(message.payload.headers,'Message-ID')};
}
function hopelabBodyFields(maxDepth = MAX_MIME_DEPTH) {
  return metadataFields(maxDepth).replaceAll('body(attachmentId,size)', 'body(attachmentId,size,data)');
}
function canonicalHopelabUrl(value) {
  if (typeof value !== 'string') fail('hopelab_url_not_allowed');
  const match = value.match(/^https:\/\/hopelab\.exames\.vet\.br(\/laudos\/download\/\d{1,10}\/\d{1,10}\/[a-f\d]{32}\/[a-f\d]{32})(?:\?utm_source=email)?$/i);
  if (!match) fail('hopelab_url_not_allowed');
  return 'https://hopelab.exames.vet.br' + match[1].toLowerCase();
}
function parseHopelabNotice(response, notice, config) {
  const message = unwrap(response);
  if (!notice || notice.sender !== 'hopelab@exames.vet.br' || message.id !== notice.id || message.internalDate !== notice.internalDate || senderAddress(header(message.payload?.headers,'From')) !== notice.sender || header(message.payload?.headers,'Subject') !== notice.subject) fail('hopelab_message_identity_mismatch');
  const bounds = validateWindow(config), received = Number(message.internalDate);
  if (!Number.isSafeInteger(received) || received < bounds.from || received >= bounds.through || received < bounds.cutoff) fail('hopelab_message_outside_window');
  const texts = []; let totalBytes = 0;
  function visit(part, depth) {
    if (!object(part) || depth > (config.maxMimeDepth ?? MAX_MIME_DEPTH) || typeof part.mimeType !== 'string' || part.parts !== undefined && !Array.isArray(part.parts)) fail('hopelab_body_structure_invalid');
    if (part.mimeType.toLowerCase() === 'application/pdf' || /\.pdf$/i.test(part.filename || '')) fail('hopelab_unexpected_pdf_in_notice');
    if (['text/plain','text/html'].includes(part.mimeType.toLowerCase()) && part.body?.data !== undefined) {
      const encoded = part.body.data;
      if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(encoded) || encoded.length > 1400000) fail('hopelab_body_encoding_or_limit');
      const raw = encoded.replace(/=+$/,''), bytes = Buffer.from(raw,'base64url');
      if (bytes.toString('base64url') !== raw || !Number.isSafeInteger(part.body.size) || part.body.size !== bytes.length) fail('hopelab_body_encoding_or_size');
      totalBytes += bytes.length;
      if (totalBytes > 1048576) fail('hopelab_body_limit');
      const decoded = bytes.toString('utf8');
      if (!Buffer.from(decoded,'utf8').equals(bytes)) fail('hopelab_body_utf8_invalid');
      // Only visible text may supply the direct URL; tracking href values are ignored.
      texts.push(part.mimeType.toLowerCase() === 'text/html' ? decoded.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&amp;/gi,'&') : decoded);
    }
    for (const child of part.parts || []) visit(child, depth + 1);
  }
  visit(message.payload,0);
  const urls = new Set();
  for (const text of texts) for (const candidate of text.match(/https?:\/\/[^\s<>"']+/gi) || []) {
    try { urls.add(canonicalHopelabUrl(candidate)); } catch { /* Other hosts and tracking links are not downloads. */ }
  }
  const receivedAt = new Date(received).toISOString();
  const create = url => {
    const digest = url ? crypto.createHash('sha256').update(url).digest('hex') : null;
    const key = digest ? 'hopelab-link:' + digest : 'hopelab-link:missing';
    const source = {channel:'email',account_id:'gmail:' + config.mailbox,message_id:message.id,attachment_id:key,original_name:'Laudo Hopelab.pdf',mime_type:url ? 'application/pdf' : null,received_at:receivedAt,
      metadata:{provider:'hopelab_link',mailbox:config.mailbox,gmail_message_id:message.id,source_kind:'download_link',link_sha256:digest,exam_candidate:true,sender_address:notice.sender,subject:notice.subject,internet_message_id:notice.internetMessageId,unknown_sender:!Array.isArray(config.allowedSenders) || !config.allowedSenders.includes(notice.sender),missing_attachment:!url,pending_reason:url ? null : 'hopelab_link_missing_or_untrusted'}};
    return {message:{id:message.id,internalDate:message.internalDate,receivedDateTime:receivedAt,sender:notice.sender,subject:notice.subject},attachment:{id:key,name:'Laudo Hopelab.pdf',contentType:source.mime_type,downloadUrl:url},source,missing:!url,needsReview:false,pendingReason:source.metadata.pending_reason};
  };
  return [...urls].map(create).concat(urls.size ? [] : [create(null)]);
}
function decodeHopelabOriginal(bytes, response, source, config) {
  const maxBytes = config.maxBytes ?? MAX_BYTES;
  if (!source?.documentId || source.skip || source.source?.metadata?.provider !== 'hopelab_link') fail('hopelab_original_not_reserved');
  const url = canonicalHopelabUrl(source.attachment?.downloadUrl);
  const digest = crypto.createHash('sha256').update(url).digest('hex');
  if (source.source.attachment_id !== 'hopelab-link:' + digest || source.source.metadata.link_sha256 !== digest) fail('hopelab_origin_url_mismatch');
  if (!object(response) || response.statusCode !== 200 || !object(response.headers)) fail('hopelab_http_response_unproven');
  const contentType = Object.entries(response.headers).filter(([key]) => key.toLowerCase() === 'content-type');
  if (contentType.length !== 1 || typeof contentType[0][1] !== 'string' || contentType[0][1].split(';')[0].trim().toLowerCase() !== 'application/pdf') fail('hopelab_pdf_mime_unproven');
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maxBytes) fail('hopelab_pdf_size_invalid');
  if (!bytes.subarray(0,1024).includes(Buffer.from('%PDF-'))) fail('hopelab_pdf_signature_missing');
  if (typeof config.driveFolderId !== 'string' || !config.driveFolderId) fail('gmail_destination_folder_missing');
  return {bytes,json:{...source,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length,folderId:config.driveFolderId}};
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
export {EXPECTED_MAILBOX,MAX_BYTES,MAX_MIME_DEPTH,fail,object,stableId,unwrap,verifyProfile,validateWindow,listQuery,metadataFields,listIds,header,senderAddress,inspectMessage,inspectHopelabNotice,hopelabBodyFields,canonicalHopelabUrl,parseHopelabNotice,decodeHopelabOriginal,decideReservation,decodeOriginal,validateFolder,validateStage,inspectDriveObject,verifySaved};
