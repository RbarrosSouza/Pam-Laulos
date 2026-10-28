import crypto from 'node:crypto';

// Chatwoot metadata/bytes adapter. Pure functions: no network, credentials or writes.
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 100;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
function fail(code) { throw new Error(code); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function id(value, code) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)) return value;
  fail(code);
}

/** Canonical Brazilian phone digits. A legacy mobile alias is never inferred here. */
export function normalizeBrazilPhone(value) {
  if (typeof value !== 'string' || value.length > 64 || !/^\+?[\d\s().-]+$/.test(value)) return null;
  const digits = value.replace(/\D/g, '');
  const national = digits.length === 12 || digits.length === 13 ? (digits.startsWith('55') ? digits.slice(2) : '') : digits;
  // 10-digit numbers are retained as such; matching a 9-digit mobile needs explicit config.
  if (!/^[1-9]\d[2-9]\d{7,8}$/.test(national)) return null;
  if (national.length === 11 && national[2] !== '9') return null;
  return '55' + national;
}

function providerPhone(value) {
  if (typeof value !== 'string') return null;
  return normalizeBrazilPhone(value.replace(/@(s\.whatsapp\.net|c\.us)$/, ''));
}
function phoneAliases(phone, legacy) {
  const values = [phone];
  if (legacy && /^55[1-9]\d9[6-9]\d{7}$/.test(phone)) values.push(phone.slice(0, 4) + phone.slice(5));
  return values;
}
function publicOrigin(value, code) {
  // Deliberately narrow HTTPS grammar for n8n's Code sandbox, which exposes neither
  // the URL global nor the url builtin. Do not turn this into a general URL resolver.
  if (typeof value !== 'string' || !value.length || value.length > 8192 || /[\x00-\x20\x7f\\#]/.test(value)
    || /%(?![a-f\d]{2})/i.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(value)) fail(code);
  const match = /^https:\/\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?$/i.exec(value);
  if (!match) fail(code);
  const authority = /^([a-z\d.-]+)(?::443)?$/i.exec(match[1]);
  if (!authority) fail(code);
  const hostname = authority[1].toLowerCase(), labels = hostname.split('.');
  if (hostname.length > 253 || labels.length < 2 || labels.some(label => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label))
    || !/^[a-z][a-z\d-]*$/.test(labels.at(-1))
    || labels.some(label => ['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home'].includes(label))) fail(code);
  const pathname = match[2] || '/', search = match[3] || '';
  const origin = 'https://' + hostname;
  return { origin, hostname, pathname, search, href: origin + pathname + search };
}
function configValues(config) {
  if (!object(config)) fail('whatsapp_config_invalid');
  const accountId = id(config.accountId, 'whatsapp_account_config_invalid');
  const inboxId = id(config.inboxId, 'whatsapp_inbox_config_invalid');
  if (!Array.isArray(config.authorizedSenders) || !config.authorizedSenders.length || config.authorizedSenders.length > 20) fail('whatsapp_senders_config_invalid');
  if (config.allowBrazilLegacyMobileAlias !== undefined && typeof config.allowBrazilLegacyMobileAlias !== 'boolean') fail('whatsapp_alias_config_invalid');
  const senders = config.authorizedSenders.map(value => {
    const phone = normalizeBrazilPhone(value);
    if (!phone || phone.length !== 13) fail('whatsapp_senders_config_invalid');
    return phone;
  });
  const base = publicOrigin(config.chatwootBaseUrl, 'whatsapp_base_url_config_invalid');
  if (base.pathname !== '/' || base.search) fail('whatsapp_base_url_config_invalid');
  if (config.allowedAttachmentOrigins !== undefined && (!Array.isArray(config.allowedAttachmentOrigins) || config.allowedAttachmentOrigins.length > 20)) fail('whatsapp_attachment_origins_config_invalid');
  const origins = new Set([base.origin]);
  for (const value of config.allowedAttachmentOrigins || []) {
    const url = publicOrigin(value, 'whatsapp_attachment_origins_config_invalid');
    if (url.pathname !== '/' || url.search) fail('whatsapp_attachment_origins_config_invalid');
    origins.add(url.origin);
  }
  const maxBytes = config.maxBytes ?? MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) fail('whatsapp_max_bytes_invalid');
  let cutoff = null;
  if (config.intakeCutoff !== undefined) {
    if (typeof config.intakeCutoff !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(config.intakeCutoff)) fail('whatsapp_cutoff_invalid');
    cutoff = Date.parse(config.intakeCutoff);
    if (!Number.isFinite(cutoff)) fail('whatsapp_cutoff_invalid');
  }
  return { accountId, inboxId, senders, origins, maxBytes, cutoff, legacy: config.allowBrazilLegacyMobileAlias === true };
}
function attachmentUrl(value, origins) {
  if (typeof value !== 'string' || !value.length || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) return null;
  try {
    const url = publicOrigin(value, 'whatsapp_attachment_url_not_allowed');
    return origins.has(url.origin) ? url.href : null;
  } catch { return null; }
}

/** Follow only an absolute HTTPS URL or an origin-rooted path, always within the media allowlist. */
export function resolveChatwootRedirect(location, currentUrl, origins) {
  if (typeof location !== 'string' || !location.length || typeof origins?.has !== 'function') fail('whatsapp_media_redirect_not_allowed');
  let candidate;
  if (/^https:\/\//i.test(location)) candidate = location;
  else if (location.startsWith('/') && !location.startsWith('//')) candidate = publicOrigin(currentUrl, 'whatsapp_media_redirect_not_allowed').origin + location;
  else fail('whatsapp_media_redirect_not_allowed');
  const url = attachmentUrl(candidate, origins);
  if (!url) fail('whatsapp_media_redirect_not_allowed');
  return url;
}
function isGroup(payload) {
  const conversation = payload.conversation, sender = payload.sender, contact = conversation?.meta?.sender;
  const objects = [payload, conversation, sender, contact, payload.additional_attributes, conversation?.additional_attributes,
    sender?.additional_attributes, contact?.additional_attributes, conversation?.custom_attributes, sender?.custom_attributes, contact?.custom_attributes];
  if (objects.some(value => object(value) && (value.is_group === true || value.group === true || value.type === 'group' || value.contact_type === 'group'
    || (typeof value.group_type === 'string' && value.group_type.toLowerCase() === 'group') || value.group_id != null))) return true;
  const identifiers = [conversation?.contact_inbox?.source_id, sender?.identifier, sender?.phone_number, contact?.identifier, contact?.phone_number,
    ...objects.filter(object).flatMap(value => [value.chat_id, value.remote_jid, value.jid, value.identifier, value.source_id])];
  return identifiers.some(value => typeof value === 'string' && /@(?:g\.us|broadcast)$/i.test(value));
}

function safeProviderId(value, code) {
  const normalized = id(value, code), numeric = Number(normalized);
  if (!Number.isSafeInteger(numeric) || numeric >= Number.MAX_SAFE_INTEGER) fail(code);
  return normalized;
}
function unwrapChatwootResponse(response, code) {
  if (!object(response)) fail(code);
  if (Object.hasOwn(response, 'statusCode')) {
    if (response.statusCode !== 200 || !object(response.body)) fail(code);
    return response.body;
  }
  return response;
}
function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }

/** Webhook hints only choose API reads; they never authorize a sender or a file URL. */
export function inspectChatwootWebhook(payload, config) {
  const cfg = configValues(config);
  if (!object(payload)) fail('whatsapp_webhook_payload_invalid');
  if (payload.event !== 'message_created') return { excluded: true, reason: 'not_message_created' };
  if (![0, 'incoming'].includes(payload.message_type) || payload.private !== false) return { excluded: true, reason: 'not_external_incoming' };
  if (isGroup(payload)) return { excluded: true, reason: 'group_or_broadcast' };
  if (isMirror(payload)) return { excluded: true, reason: 'internal_exam_message' };
  const accountId = safeProviderId(payload.account?.id, 'whatsapp_webhook_account_invalid');
  const inboxId = safeProviderId(payload.inbox?.id, 'whatsapp_webhook_inbox_invalid');
  if (accountId !== cfg.accountId || inboxId !== cfg.inboxId) return { excluded: true, reason: 'wrong_account_or_inbox' };
  const conversationId = safeProviderId(payload.conversation?.id, 'whatsapp_webhook_conversation_invalid');
  if (safeProviderId(payload.conversation?.inbox_id, 'whatsapp_webhook_conversation_inbox_invalid') !== inboxId) fail('whatsapp_webhook_conversation_inbox_mismatch');
  if (payload.conversation.account_id != null && safeProviderId(payload.conversation.account_id, 'whatsapp_webhook_conversation_account_invalid') !== accountId) fail('whatsapp_webhook_conversation_account_mismatch');
  const messageId = safeProviderId(payload.id, 'whatsapp_webhook_message_invalid');
  return { excluded: false, request: { accountId, inboxId, conversationId, messageId, beforeMessageId: String(Number(messageId) + 1) } };
}

/** Reconstruct an event solely from matching API objects, never from webhook sender/attachments. */
export function canonicalChatwootEvent(request, conversationResponse, messagesResponse, config) {
  const cfg = configValues(config);
  if (!object(request) || safeProviderId(request.accountId, 'whatsapp_canonical_request_invalid') !== cfg.accountId
    || safeProviderId(request.inboxId, 'whatsapp_canonical_request_invalid') !== cfg.inboxId) fail('whatsapp_canonical_request_mismatch');
  const conversationId = safeProviderId(request.conversationId, 'whatsapp_canonical_request_invalid');
  const messageId = safeProviderId(request.messageId, 'whatsapp_canonical_request_invalid');
  if (request.beforeMessageId !== String(Number(messageId) + 1)) fail('whatsapp_canonical_request_window_mismatch');
  const conversation = unwrapChatwootResponse(conversationResponse, 'whatsapp_conversation_response_unproven');
  if (safeProviderId(conversation.id, 'whatsapp_canonical_conversation_invalid') !== conversationId
    || safeProviderId(conversation.inbox_id, 'whatsapp_canonical_inbox_invalid') !== cfg.inboxId) fail('whatsapp_canonical_conversation_mismatch');
  if (conversation.account_id != null && safeProviderId(conversation.account_id, 'whatsapp_canonical_account_invalid') !== cfg.accountId) fail('whatsapp_canonical_account_mismatch');
  const messages = unwrapChatwootResponse(messagesResponse, 'whatsapp_messages_response_unproven');
  if (!Array.isArray(messages.payload) || messages.payload.length > 100) fail('whatsapp_messages_payload_invalid');
  const matches = messages.payload.filter(item => object(item) && safeProviderId(item.id, 'whatsapp_canonical_message_invalid') === messageId);
  if (matches.length !== 1) fail('whatsapp_canonical_message_not_unique');
  const message = matches[0];
  for (const [field, expected] of [['conversation_id', conversationId], ['account_id', cfg.accountId], ['inbox_id', cfg.inboxId]]) {
    if (message[field] != null && safeProviderId(message[field], 'whatsapp_canonical_message_' + field + '_invalid') !== expected) fail('whatsapp_canonical_message_' + field + '_mismatch');
  }
  if (![0, 'incoming'].includes(message.message_type) || message.private !== false) fail('whatsapp_canonical_not_external_incoming');
  const sender = message.sender, contact = conversation.meta?.sender;
  const probe = { ...message, conversation };
  if (isGroup(probe)) fail('whatsapp_canonical_group_or_broadcast');
  if (isMirror(probe)) fail('whatsapp_canonical_internal_exam_message');
  if (!object(sender) || !object(contact) || (sender.type != null && sender.type !== 'contact') || (contact.type != null && contact.type !== 'contact')
    || safeProviderId(sender.id, 'whatsapp_canonical_sender_id_invalid') !== safeProviderId(contact.id, 'whatsapp_canonical_contact_id_invalid')) fail('whatsapp_canonical_sender_mismatch');
  const phone = normalizeBrazilPhone(sender.phone_number), contactPhone = normalizeBrazilPhone(contact.phone_number);
  const phonesAgree = phone && contactPhone && (phone === contactPhone || (cfg.legacy && cfg.senders.some(value => {
    const aliases = phoneAliases(value, true); return aliases.includes(phone) && aliases.includes(contactPhone);
  })));
  if (!phonesAgree) fail('whatsapp_canonical_sender_phone_mismatch');
  // Some Chatwoot serializers omit contact_inbox. Only the two independently returned,
  // convergent API contact identities permit reconstructing that individual source.
  let contactInbox = conversation.contact_inbox;
  if (contactInbox == null) contactInbox = { source_id: phone };
  else if (!object(contactInbox) || ![phone, contactPhone].includes(providerPhone(contactInbox.source_id))) fail('whatsapp_canonical_contact_inbox_mismatch');
  return { event: 'message_created', id: messageId, account: { id: cfg.accountId }, inbox: { id: cfg.inboxId },
    message_type: message.message_type, private: message.private, created_at: message.created_at,
    sender: cloneJson(sender), content: message.content,
    content_attributes: cloneJson(message.content_attributes || {}), additional_attributes: cloneJson(message.additional_attributes || {}),
    attachments: cloneJson(message.attachments || []), conversation: { ...cloneJson(conversation), contact_inbox: cloneJson(contactInbox) } };
}
function isMirror(payload) {
  const attributes = [payload.content_attributes, payload.additional_attributes, payload.conversation?.additional_attributes];
  return attributes.some(value => object(value) && Object.keys(value).some(key => /^pamvet_exam_/.test(key)))
    || (typeof payload.content === 'string' && /\[EXAM:[a-f\d-]+:DELIVERY:[a-f\d-]+\]/i.test(payload.content));
}
function receivedTime(value) {
  let time;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) time = value < 1e12 ? value * 1000 : value;
  else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) time = Date.parse(value);
  if (!Number.isFinite(time) || time <= 0) fail('whatsapp_received_at_invalid');
  return new Date(time).toISOString();
}
function originalName(attachment) {
  for (const value of [attachment.file_name, attachment.filename, attachment.name, attachment.fallback_title]) {
    if (typeof value === 'string' && value.trim() && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value)) return value.trim().replace(/[\\/]/g, '_');
  }
  if (typeof attachment.data_url === 'string') {
    try {
      const name = decodeURIComponent(publicOrigin(attachment.data_url, 'whatsapp_attachment_url_not_allowed').pathname.split('/').pop() || '');
      if (/\.pdf$/i.test(name) && name.length <= 512 && !/[\x00-\x1f\x7f]/.test(name)) return name.replace(/[\\/]/g, '_');
    } catch { /* An invalid URL becomes a pending source below. */ }
  }
  return 'Exame.pdf';
}
function pdfCandidate(attachment) {
  const mime = attachment.content_type || attachment.mime_type;
  if (typeof mime === 'string' && mime.split(';')[0].trim().toLowerCase() === 'application/pdf') return true;
  if (typeof attachment.extension === 'string' && attachment.extension.toLowerCase().replace(/^\./, '') === 'pdf') return true;
  if ([attachment.file_name, attachment.filename, attachment.name, attachment.fallback_title].some(value => typeof value === 'string' && /\.pdf$/i.test(value))) return true;
  try { return typeof attachment.data_url === 'string' && /\.pdf$/i.test(decodeURIComponent(publicOrigin(attachment.data_url, 'whatsapp_attachment_url_not_allowed').pathname)); } catch { return false; }
}

/** Normalize only provider metadata; the returned download URL is transient and never part of source metadata. */
export function inspectChatwootMessage(payload, config) {
  const cfg = configValues(config);
  if (!object(payload)) fail('whatsapp_payload_invalid');
  if (payload.event !== 'message_created') return { excluded: true, reason: 'not_message_created', origins: [] };
  if (![0, 'incoming'].includes(payload.message_type) || payload.private !== false) return { excluded: true, reason: 'not_external_incoming', origins: [] };
  if (isGroup(payload)) return { excluded: true, reason: 'group_or_broadcast', origins: [] };
  if (isMirror(payload)) return { excluded: true, reason: 'internal_exam_message', origins: [] };
  if (id(payload.account?.id, 'whatsapp_account_missing') !== cfg.accountId || id(payload.inbox?.id, 'whatsapp_inbox_missing') !== cfg.inboxId) return { excluded: true, reason: 'wrong_account_or_inbox', origins: [] };
  const messageId = id(payload.id, 'whatsapp_message_id_invalid');
  const conversationId = id(payload.conversation?.id, 'whatsapp_conversation_id_invalid');
  if (id(payload.conversation?.inbox_id, 'whatsapp_conversation_inbox_missing') !== cfg.inboxId) fail('whatsapp_conversation_inbox_mismatch');
  if (payload.conversation.account_id != null && id(payload.conversation.account_id, 'whatsapp_conversation_account_invalid') !== cfg.accountId) fail('whatsapp_conversation_account_mismatch');
  if (!object(payload.sender) || (payload.sender.type != null && payload.sender.type !== 'contact')) return { excluded: true, reason: 'not_contact_sender', origins: [] };
  const phone = normalizeBrazilPhone(payload.sender.phone_number);
  if (!phone) return { excluded: true, reason: 'sender_phone_unproven', origins: [] };
  const sender = cfg.senders.find(value => phoneAliases(value, cfg.legacy).includes(phone));
  if (!sender) return { excluded: true, reason: 'sender_not_authorized', origins: [] };
  const allowedPhones = phoneAliases(sender, cfg.legacy);
  // A contact_inbox source is required to prove this is the individual conversation, not its group participant.
  const conversationPhone = providerPhone(payload.conversation.contact_inbox?.source_id);
  if (!conversationPhone || !allowedPhones.includes(conversationPhone)) return { excluded: true, reason: 'individual_conversation_unproven', origins: [] };
  const contact = payload.conversation.meta?.sender;
  if (object(contact)) {
    if (contact.type != null && contact.type !== 'contact') fail('whatsapp_contact_sender_mismatch');
    if (contact.phone_number != null && !allowedPhones.includes(normalizeBrazilPhone(contact.phone_number))) fail('whatsapp_contact_sender_mismatch');
    if (contact.id != null && payload.sender.id != null && id(contact.id, 'whatsapp_contact_id_invalid') !== id(payload.sender.id, 'whatsapp_sender_id_invalid')) fail('whatsapp_contact_sender_mismatch');
  }
  const receivedAt = receivedTime(payload.created_at);
  if (cfg.cutoff !== null && Date.parse(receivedAt) < cfg.cutoff) return { excluded: true, reason: 'before_intake_cutoff', origins: [] };
  if (!Array.isArray(payload.attachments) || !payload.attachments.length) return { excluded: true, reason: 'no_pdf', origins: [] };
  if (payload.attachments.length > MAX_ATTACHMENTS) fail('whatsapp_attachment_limit');
  const origins = [], seen = new Set();
  for (const attachment of payload.attachments) {
    if (!object(attachment)) fail('whatsapp_attachment_invalid');
    if (!pdfCandidate(attachment)) continue;
    const attachmentId = id(attachment.id, 'whatsapp_attachment_id_invalid');
    if (seen.has(attachmentId)) fail('whatsapp_duplicate_attachment_id');
    seen.add(attachmentId);
    if (attachment.account_id != null && id(attachment.account_id, 'whatsapp_attachment_account_invalid') !== cfg.accountId) fail('whatsapp_attachment_account_mismatch');
    if (attachment.message_id != null && id(attachment.message_id, 'whatsapp_attachment_message_invalid') !== messageId) fail('whatsapp_attachment_message_mismatch');
    const key = 'chatwoot-attachment:' + attachmentId;
    const name = originalName(attachment);
    const downloadUrl = attachmentUrl(attachment.data_url, cfg.origins);
    const size = attachment.file_size == null ? null : (typeof attachment.file_size === 'number'
      || (typeof attachment.file_size === 'string' && /^\d+$/.test(attachment.file_size))) ? Number(attachment.file_size) : NaN;
    const badSize = size !== null && (!Number.isSafeInteger(size) || size <= 0 || size > cfg.maxBytes);
    const mime = attachment.content_type || attachment.mime_type;
    const badMime = mime != null && (typeof mime !== 'string' || !['application/pdf', 'application/octet-stream'].includes(mime.split(';')[0].trim().toLowerCase()));
    const reason = badSize ? 'pdf_size_invalid_or_exceeds_limit' : badMime ? 'pdf_metadata_mismatch' : !downloadUrl ? 'pdf_url_missing_or_untrusted' : null;
    const source = { channel: 'whatsapp', account_id: 'chatwoot:' + cfg.accountId + ':inbox:' + cfg.inboxId, message_id: messageId,
      attachment_id: key, original_name: name, mime_type: 'application/pdf', received_at: receivedAt,
      metadata: { provider: 'chatwoot', chatwoot_account_id: cfg.accountId, chatwoot_inbox_id: cfg.inboxId,
        chatwoot_conversation_id: conversationId, chatwoot_message_id: messageId, chatwoot_attachment_id: attachmentId,
        sender_phone: sender, sender_allowlisted: true, unknown_sender: false, exam_candidate: true,
        attachment_url_sha256: downloadUrl ? crypto.createHash('sha256').update(downloadUrl).digest('hex') : null,
        missing_attachment: !downloadUrl, unsupported_attachment: badSize || badMime, pending_reason: reason } };
    origins.push({ message: { id: messageId, receivedDateTime: receivedAt, sender, conversationId },
      attachment: { id: key, chatwootAttachmentId: attachmentId, name, contentType: 'application/pdf', size, downloadUrl: reason ? null : downloadUrl },
      source, missing: reason !== null, needsReview: false, pendingReason: reason });
  }
  for (const origin of origins) origin.messageAttachmentCount = origins.length;
  return origins.length ? { excluded: false, origins } : { excluded: true, reason: 'no_pdf', origins: [] };
}

function authorizedConversation(conversation, cfg) {
  if (!object(conversation)) fail('whatsapp_sweep_conversation_invalid');
  safeProviderId(conversation.id, 'whatsapp_sweep_conversation_invalid');
  if (safeProviderId(conversation.inbox_id, 'whatsapp_sweep_inbox_invalid') !== cfg.inboxId) fail('whatsapp_sweep_inbox_mismatch');
  if (conversation.account_id != null && safeProviderId(conversation.account_id, 'whatsapp_sweep_account_invalid') !== cfg.accountId) fail('whatsapp_sweep_account_mismatch');
  if (isGroup({ conversation }) || isMirror({ conversation })) return false;
  const contact = conversation.meta?.sender;
  if (!object(contact) || (contact.type != null && contact.type !== 'contact')) return false;
  const phone = normalizeBrazilPhone(contact.phone_number);
  const sender = cfg.senders.find(value => phoneAliases(value, cfg.legacy).includes(phone));
  if (!sender) return false;
  safeProviderId(contact.id, 'whatsapp_sweep_contact_invalid');
  if (conversation.contact_inbox != null && !phoneAliases(sender, cfg.legacy).includes(providerPhone(conversation.contact_inbox.source_id))) return false;
  return true;
}

export function startChatwootSweep(config) {
  const cfg = configValues(config);
  if (cfg.cutoff === null) fail('whatsapp_sweep_cutoff_required');
  return { conversationPage: 1, conversationPagesComplete: false, conversations: [], seenConversationIds: [],
    conversationIndex: 0, conversationsChecked: 0, messagesChecked: 0, origins: [], sweepComplete: false };
}

export function advanceChatwootConversationPage(state, response, config) {
  const cfg = configValues(config);
  if (!object(state) || !Number.isSafeInteger(state.conversationPage) || state.conversationPage < 1 || state.conversationPage > 100
    || state.conversationPagesComplete || !Array.isArray(state.conversations) || !Array.isArray(state.seenConversationIds)) fail('whatsapp_sweep_state_invalid');
  const body = unwrapChatwootResponse(response, 'whatsapp_sweep_conversations_unproven');
  const rows = body.data?.payload;
  if (!Array.isArray(rows) || rows.length > 100) fail('whatsapp_sweep_conversations_payload_invalid');
  const next = cloneJson(state), seen = new Set(state.seenConversationIds);
  for (const conversation of rows) {
    const conversationId = safeProviderId(conversation?.id, 'whatsapp_sweep_conversation_invalid');
    if (seen.has(conversationId)) fail('whatsapp_sweep_conversation_pagination_cycle');
    seen.add(conversationId);
    if (authorizedConversation(conversation, cfg)) next.conversations.push(conversationId);
  }
  next.seenConversationIds = [...seen];
  next.conversationPagesComplete = rows.length === 0;
  if (!next.conversationPagesComplete && state.conversationPage === 100) fail('whatsapp_sweep_conversation_page_limit');
  next.conversationPage++;
  next.sweepComplete = next.conversationPagesComplete && next.conversations.length === 0;
  return next;
}

export function startChatwootMessagePages(state, response, config) {
  const cfg = configValues(config);
  if (!object(state) || state.conversationPagesComplete !== true || state.sweepComplete || !Array.isArray(state.conversations)
    || !Number.isSafeInteger(state.conversationIndex) || state.conversationIndex < 0 || state.conversationIndex >= state.conversations.length) fail('whatsapp_sweep_state_invalid');
  const conversation = unwrapChatwootResponse(response, 'whatsapp_sweep_conversation_unproven');
  if (safeProviderId(conversation.id, 'whatsapp_sweep_conversation_invalid') !== state.conversations[state.conversationIndex]
    || !authorizedConversation(conversation, cfg)) fail('whatsapp_sweep_conversation_changed');
  return { ...cloneJson(state), conversation: cloneJson(conversation), beforeMessageId: null, oldestMessageTime: null,
    messagePage: 1, seenMessageIds: [], messagePagesComplete: false };
}

export function advanceChatwootMessagePage(state, response, config) {
  const cfg = configValues(config);
  if (!object(state) || !object(state.conversation) || state.messagePagesComplete || !Array.isArray(state.origins)
    || !Array.isArray(state.seenMessageIds) || !Number.isSafeInteger(state.messagePage) || state.messagePage < 1 || state.messagePage > 100) fail('whatsapp_sweep_state_invalid');
  const body = unwrapChatwootResponse(response, 'whatsapp_sweep_messages_unproven');
  if (!Array.isArray(body.payload) || body.payload.length > 100) fail('whatsapp_sweep_messages_payload_invalid');
  const next = cloneJson(state), seen = new Set(state.seenMessageIds);
  let before = state.beforeMessageId === null ? Number.MAX_SAFE_INTEGER : Number(safeProviderId(state.beforeMessageId, 'whatsapp_sweep_cursor_invalid'));
  const ordered = body.payload.map(message => ({ id: Number(safeProviderId(message?.id, 'whatsapp_sweep_message_invalid')),
    time: Date.parse(receivedTime(message.created_at)) })).sort((first, second) => first.id - second.id);
  for (let index = 0; index < ordered.length; index++) {
    if ((index > 0 && ordered[index].time < ordered[index - 1].time)
      || (state.oldestMessageTime !== null && ordered[index].time > state.oldestMessageTime)) fail('whatsapp_sweep_message_time_order_unproven');
  }
  for (const message of body.payload) {
    const messageId = safeProviderId(message?.id, 'whatsapp_sweep_message_invalid');
    if (seen.has(messageId) || Number(messageId) >= before) fail('whatsapp_sweep_message_pagination_cycle');
    seen.add(messageId);
    for (const [field, expected] of [['conversation_id', String(state.conversation.id)], ['account_id', cfg.accountId], ['inbox_id', cfg.inboxId]]) {
      if (message[field] != null && safeProviderId(message[field], 'whatsapp_sweep_message_scope_invalid') !== expected) fail('whatsapp_sweep_message_scope_mismatch');
    }
    next.messagesChecked++;
    if (![0, 'incoming'].includes(message.message_type) || message.private !== false) continue;
    const receivedAt = Date.parse(receivedTime(message.created_at));
    if (receivedAt < cfg.cutoff || !Array.isArray(message.attachments) || !message.attachments.length) continue;
    const request = { accountId: cfg.accountId, inboxId: cfg.inboxId, conversationId: String(state.conversation.id),
      messageId, beforeMessageId: String(Number(messageId) + 1) };
    const canonical = canonicalChatwootEvent(request, state.conversation, { payload: [message] }, config);
    const inspected = inspectChatwootMessage(canonical, config);
    next.origins.push(...inspected.origins);
    if (next.origins.length > 1000) fail('whatsapp_sweep_origin_limit');
  }
  next.seenMessageIds = [...seen];
  next.messagePagesComplete = body.payload.length === 0 || ordered.every(message => message.time < cfg.cutoff);
  if (!next.messagePagesComplete && state.messagePage === 100) fail('whatsapp_sweep_message_page_limit');
  next.messagePage++;
  if (body.payload.length) {
    next.beforeMessageId = String(ordered[0].id);
    next.oldestMessageTime = ordered[0].time;
  }
  if (next.messagePagesComplete) {
    next.conversationIndex++;
    next.conversationsChecked++;
    next.sweepComplete = next.conversationIndex === next.conversations.length;
  }
  return next;
}

export function summarizeChatwootIntake(receipts, origins) {
  if (!Array.isArray(receipts) || !Array.isArray(origins)) fail('whatsapp_intake_summary_invalid');
  const expected = new Map(), observed = new Set(), issues = [];
  const counts = { attachments: 0, checked: 0, saved: 0, already_saved: 0, pending: 0, failed: 0, excluded: 0, unproven: 0 };
  for (const origin of origins) {
    if (!object(origin?.source) || typeof origin.source.message_id !== 'string' || typeof origin.source.attachment_id !== 'string') fail('whatsapp_intake_summary_origin_invalid');
    const key = JSON.stringify([origin.source.message_id, origin.source.attachment_id]);
    if (expected.has(key)) fail('whatsapp_intake_summary_duplicate_origin');
    expected.set(key, origin.source);
  }
  counts.attachments = expected.size;
  for (const receipt of receipts) {
    const key = JSON.stringify([receipt?.message_id, receipt?.attachment_id]);
    if (receipt?.intakeReceipt !== true || receipt.kind !== 'attachment' || !expected.has(key) || observed.has(key)
      || !['saved', 'already_saved', 'pending', 'failed', 'excluded'].includes(receipt.disposition)) { counts.unproven++; continue; }
    observed.add(key); counts.checked++; counts[receipt.disposition]++;
    if (['pending', 'failed'].includes(receipt.disposition)) issues.push(receipt);
  }
  for (const [key, source] of expected) if (!observed.has(key)) {
    counts.failed++;
    issues.push({ message_id: source.message_id, attachment_id: source.attachment_id, disposition: 'failed', reason: 'attachment_receipt_missing' });
  }
  return { scanFinished: counts.pending + counts.failed + counts.unproven === 0, counts, issues,
    recovery: 'fixed_cutoff_idempotent_rescan', checkpointAdvanced: false };
}

/** Verify already-downloaded original bytes, only after the durable origin reservation. */
export function decodeChatwootOriginal(bytes, response, origin, config) {
  const cfg = configValues(config);
  if (!object(origin) || typeof origin.documentId !== 'string' || !UUID.test(origin.documentId) || origin.skip || origin.missing
    || origin.reservation?.document_id !== origin.documentId
    || (origin.reservation.document && origin.reservation.document.id !== origin.documentId)
    || origin.source?.channel !== 'whatsapp' || origin.source?.metadata?.provider !== 'chatwoot'
    || origin.source.account_id !== 'chatwoot:' + cfg.accountId + ':inbox:' + cfg.inboxId
    || origin.source.message_id !== origin.source.metadata.chatwoot_message_id
    || origin.source.attachment_id !== origin.attachment?.id
    || origin.attachment.id !== 'chatwoot-attachment:' + origin.source.metadata.chatwoot_attachment_id) fail('whatsapp_original_not_reserved');
  const url = attachmentUrl(origin.attachment.downloadUrl, cfg.origins);
  if (!url || origin.source.metadata.attachment_url_sha256 !== crypto.createHash('sha256').update(url).digest('hex')) fail('whatsapp_original_url_mismatch');
  if (!object(response) || response.statusCode !== 200 || !object(response.headers)) fail('whatsapp_original_http_response_unproven');
  const types = Object.entries(response.headers).filter(([key]) => key.toLowerCase() === 'content-type');
  if (types.length !== 1 || typeof types[0][1] !== 'string' || !['application/pdf', 'application/octet-stream'].includes(types[0][1].split(';')[0].trim().toLowerCase())) fail('whatsapp_pdf_mime_unproven');
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > cfg.maxBytes) fail('whatsapp_pdf_size_invalid');
  if (origin.attachment.size !== null && origin.attachment.size !== bytes.length) fail('whatsapp_pdf_size_mismatch');
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) fail('whatsapp_pdf_signature_missing');
  if (typeof config.driveFolderId !== 'string' || !config.driveFolderId.length) fail('whatsapp_destination_folder_missing');
  return { bytes, json: { ...origin, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length, folderId: config.driveFolderId } };
}
