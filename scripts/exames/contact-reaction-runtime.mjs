// Pure Chatwoot OP07 guards. Reaction writes are toggles, never retryable setters.
const REACTION_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const REACTION_SHA = /^[a-f0-9]{64}$/i;
function reactionObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function reactionFail(code) { throw new Error(code); }
function reactionBody(value) {
  const body = reactionObject(value?.body) ? value.body : value;
  if (!reactionObject(body) || body.error || body.success === false) reactionFail('REACTION_API_RESPONSE_INVALID');
  return body;
}
function reactionId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)) return value;
  reactionFail('REACTION_MESSAGE_ID_INVALID');
}
function compareReactionId(a, b) { return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0); }
function previousReactionId(value) {
  const digits = reactionId(value).split('');
  for (let index = digits.length - 1; index >= 0; index--) {
    if (digits[index] !== '0') { digits[index] = String(Number(digits[index]) - 1); break; }
    digits[index] = '9';
  }
  return digits.join('').replace(/^0+(?=[0-9])/, '');
}
function reactionOrigin(value) { return typeof value === 'string' && /^https:\/\/[a-z0-9]+(?:[.-][a-z0-9]+)*(?::443)?\/?$/i.test(value); }
function reactionOutcome(context, status, errorCode, verified = false) {
  return { ...context, postRequired: false, outcome: { status, external_message_id: context.external_message_id,
    emoji: '✅', actor_id: context.actor_id, ...(verified ? { own_reaction_verified: true } : {}), ...(errorCode ? { error_code: errorCode } : {}) } };
}

export function contactReactionConfiguration(raw, execution) {
  if (!reactionObject(raw) || raw.enabled !== true) reactionFail('EXAMES_REACAO_PAUSADA');
  if (typeof raw.dryRun !== 'boolean' || !reactionOrigin(raw.chatwootBaseUrl)
    || typeof raw.serviceUrl !== 'string' || !/^https:\/\/[a-z0-9]+(?:[.-][a-z0-9]+)*(?::443)?\/functions\/v1\/exam-document-service$/i.test(raw.serviceUrl)
    || ![raw.accountId, raw.inboxId, raw.conversationId, raw.expectedActorId].every(id => Number.isSafeInteger(id) && id > 0)
    || typeof raw.groupJid !== 'string' || !/^[0-9-]+@g\.us$/.test(raw.groupJid)
    || raw.emoji !== '✅' || raw.maxMessagePages !== 20 || typeof raw.worker !== 'string'
    || !/^[A-Za-z0-9_.:-]{1,96}$/.test(raw.worker) || !/^[A-Za-z0-9_.:-]{1,96}$/.test(String(execution?.id || ''))
    || (raw.worker + ':' + execution.id).length > 96) reactionFail('REACTION_CONFIGURATION_INVALID');
  if (raw.diagnosticTarget && !raw.dryRun) reactionFail('REACTION_DIAGNOSTIC_READ_ONLY');
  return { ...raw, worker: raw.worker + ':' + execution.id,
    destinationKey: `chatwoot:${raw.accountId}:${raw.inboxId}:${raw.conversationId}:${raw.groupJid}` };
}

export function verifyContactReactionActor(response, cfg) {
  const body = reactionBody(response);
  if (Number(body.id) !== cfg.expectedActorId) reactionFail('REACTION_CREDENTIAL_ACTOR_MISMATCH');
  if (Array.isArray(body.accounts) && !body.accounts.some(account => Number(account.id) === cfg.accountId)) reactionFail('REACTION_ACTOR_ACCOUNT_MISMATCH');
  return { ...cfg, verifiedActorId: cfg.expectedActorId };
}

export function prepareContactReactionTasks(response, cfg) {
  const body = reactionBody(response);
  if (!Array.isArray(body.tasks) || body.reconcile_tasks != null && !Array.isArray(body.reconcile_tasks)) reactionFail('REACTION_TASK_LIST_INVALID');
  let tasks = [...(body.reconcile_tasks || []).map(task => ({ ...task, reconcile_only: true })), ...body.tasks];
  if (tasks.length > 20) reactionFail('REACTION_TASK_LIMIT_EXCEEDED');
  if (cfg.dryRun && cfg.diagnosticTarget) tasks = [{ ...cfg.diagnosticTarget, diagnostic_only: true, actor_id: cfg.verifiedActorId, destination_key: cfg.destinationKey }];
  const seen = new Set();
  return tasks.map(task => {
    const actor = task.actor_id ?? body.actor_id;
    if (!reactionObject(task) || task.destination_key !== cfg.destinationKey || Number(actor) !== cfg.verifiedActorId
      || !REACTION_UUID.test(task.document_id || '') || !REACTION_UUID.test(task.delivery_id || '') || !REACTION_SHA.test(task.sha256 || '')
      || task.emoji != null && task.emoji !== '✅') reactionFail('REACTION_TASK_IDENTITY_MISMATCH');
    const external = reactionId(task.external_message_id);
    if (seen.has(external)) reactionFail('REACTION_DUPLICATE_TARGET');
    seen.add(external);
    if (!cfg.dryRun && (!REACTION_UUID.test(task.reaction_id || '') || !REACTION_UUID.test(task.lease_token || ''))) reactionFail('REACTION_RESERVATION_INVALID');
    return { ...task, external_message_id: external, actor_id: cfg.verifiedActorId, emoji: '✅', scan_after: previousReactionId(external),
      readOnly: cfg.dryRun, postRequired: false, reconcile_only: !!task.reconcile_only, available: true };
  });
}

export function verifyContactReactionGroup(response, context, cfg) {
  const body = reactionBody(response), sender = body.meta?.sender || body.contact || {};
  const jid = sender.identifier || body.contact_inbox?.source_id || sender.additional_attributes?.jid;
  if (Number(body.id) !== cfg.conversationId || Number(body.inbox_id) !== cfg.inboxId || jid !== cfg.groupJid
    || context.destination_key !== cfg.destinationKey || context.actor_id !== cfg.verifiedActorId) reactionFail('REACTION_GROUP_IDENTITY_MISMATCH');
  return context;
}

function canonicalContactReactionMessages(pages, context, cfg) {
  if (!Array.isArray(pages) || !pages.length || pages.length > cfg.maxMessagePages) reactionFail('REACTION_MESSAGE_SCAN_INCOMPLETE');
  const list = [], seen = new Set(); let last = context.scan_after, complete = false;
  for (const page of pages) {
    const body = reactionBody(page), messages = body.payload || body.messages;
    if (!Array.isArray(messages) || complete) reactionFail('REACTION_MESSAGE_PAGE_INVALID');
    if (!messages.length) { complete = true; continue; }
    for (const message of messages) {
      if (!reactionObject(message)) reactionFail('REACTION_MESSAGE_INVALID');
      const id = reactionId(message.id);
      if (seen.has(id) || compareReactionId(id, last) <= 0) reactionFail('REACTION_MESSAGE_ORDER_INVALID');
      seen.add(id); last = id;
      if (message.inbox_id != null && Number(message.inbox_id) !== cfg.inboxId
        || message.conversation_id != null && Number(message.conversation_id) !== cfg.conversationId
        || message.account_id != null && Number(message.account_id) !== cfg.accountId) reactionFail('REACTION_MESSAGE_DESTINATION_MISMATCH');
      list.push(message);
    }
  }
  if (!complete) reactionFail('REACTION_MESSAGE_SCAN_INCOMPLETE');
  return list;
}

export function inspectContactReactionMessages(pages, context, cfg, afterPost = false) {
  try {
    const list = canonicalContactReactionMessages(pages, context, cfg);
    const message = list.find(item => reactionId(item.id) === context.external_message_id);
    if (!message || message.private !== false || ![1, 'outgoing'].includes(message.message_type)
      || typeof message.source_id !== 'string' || !message.source_id.trim() || !['sent', 'delivered', 'read'].includes(message.status)
      || !Array.isArray(message.attachments) || !message.attachments.some(item => item.file_type === 'file')) reactionFail('REACTION_ORIGINAL_MESSAGE_UNPROVEN');
    const attributes = message.content_attributes || {};
    const tagged = attributes.pamvet_exam_document_id === context.document_id && attributes.pamvet_exam_delivery_id === context.delivery_id
      && attributes.pamvet_exam_sha256 === context.sha256;
    const anyTag = ['pamvet_exam_document_id', 'pamvet_exam_delivery_id', 'pamvet_exam_sha256'].some(key => Object.hasOwn(attributes, key));
    const legacy = !anyTag && typeof message.content === 'string'
      && message.content.trim().endsWith(`[EXAM:${context.document_id}:DELIVERY:${context.delivery_id}]`);
    if (!tagged && !legacy || attributes.deleted === true || attributes.is_reaction === true) reactionFail('REACTION_ORIGINAL_CORRELATION_MISMATCH');
    if (afterPost && (context.originalContent !== message.content
      || JSON.stringify(context.originalAttachmentIds) !== JSON.stringify(message.attachments.map(item => reactionId(item.id))))) reactionFail('REACTION_ORIGINAL_CHANGED');
    let own = null, unsafe = false, ownProviderStatus = null;
    for (const event of list) {
      const fields = event.content_attributes || {};
      if (fields.is_reaction !== true) continue;
      const internal = fields.in_reply_to != null && String(fields.in_reply_to) === context.external_message_id;
      const external = fields.in_reply_to_external_id != null && typeof message.source_id === 'string' && fields.in_reply_to_external_id === message.source_id;
      if (!internal && !external) continue;
      if (fields.in_reply_to != null && !internal || fields.in_reply_to_external_id != null && !external) reactionFail('REACTION_PARENT_IDENTITY_MISMATCH');
      if (fields.deleted === true) continue;
      const outgoing = [1, 'outgoing'].includes(event.message_type);
      if (!outgoing) continue; // A participant's reaction is not the authenticated support user's choice.
      const sender = event.sender;
      if (!reactionObject(sender) || Number(sender.id) !== context.actor_id || String(sender.type).toLowerCase() !== 'user') { unsafe = true; continue; }
      const emoji = typeof event.content === 'string' ? event.content.normalize('NFC').replace(/\ufe0f/g, '').trim() : '';
      if (!emoji || own !== null) { unsafe = true; continue; }
      own = emoji;
      ownProviderStatus = event.status;
      if (typeof event.source_id !== 'string' || !event.source_id.trim() || !['sent', 'delivered', 'read'].includes(event.status)) unsafe = true;
    }
    if (unsafe || own !== null && own !== '✅') return reactionOutcome(context, 'uncertain', 'REACTION_EXISTING_SUPPORT_CHOICE');
    if (own === '✅') return { ...reactionOutcome(context, afterPost ? 'confirmed' : 'already_present', null, true), observedProviderStatus: ownProviderStatus };
    if (afterPost || context.reconcile_only) return reactionOutcome(context, 'uncertain', 'REACTION_NOT_OBSERVED_NO_RETRY');
    return { ...context, postRequired: !context.readOnly, verifiedOriginal: true, ownReactionAbsent: true,
      originalContent: typeof message.content === 'string' ? message.content : null,
      originalAttachmentIds: message.attachments.map(item => reactionId(item.id)), inspection: 'no_own_reaction' };
  } catch (error) {
    const code = error instanceof Error && /^REACTION_[A-Z_]+$/.test(error.message) ? error.message : 'REACTION_READ_FAILED';
    return reactionOutcome(context, 'uncertain', code);
  }
}

export function contactReactionDispatchPermission(response, context, cfg) {
  const body = reactionBody(response);
  if (body.dispatch_allowed !== true) return { ...context, postRequired: false, dispatch_allowed: false, inspection: 'dispatch_not_granted' };
  if (context.readOnly || context.reconcile_only || !context.verifiedOriginal || context.postRequired !== true
    || body.reaction_id !== context.reaction_id || body.external_message_id != null && String(body.external_message_id) !== context.external_message_id
    || context.actor_id !== cfg.verifiedActorId) reactionFail('REACTION_DISPATCH_PERMISSION_INVALID');
  return { ...context, dispatch_allowed: true, postRequired: true };
}

export function classifyContactReactionSubmission(response, context) {
  if (!context.dispatch_allowed || context.readOnly || context.reconcile_only) reactionFail('REACTION_POST_WITHOUT_PERMISSION');
  const status = Number(response?.statusCode || 0);
  return reactionOutcome(context, status >= 200 && status < 300 ? 'submitted' : 'uncertain', status >= 200 && status < 300 ? null : 'REACTION_POST_UNCERTAIN');
}

export function contactReactionDiagnostic(context) {
  return { read_only: true, post_permitted: false, diagnostic_only: !!context.diagnostic_only, target_verified: context.verifiedOriginal === true || context.outcome?.own_reaction_verified === true,
    own_check_present: context.outcome?.own_reaction_verified === true, provider_status: context.observedProviderStatus || null,
    inspection: context.outcome?.error_code || context.outcome?.status || context.inspection || 'empty' };
}
