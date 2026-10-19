import { buildPendingGroupSummary } from './pending-group-summary.mjs';

const SUMMARY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function summaryObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function summaryFail(code) { throw new Error(code); }
function summaryBody(value) {
  const body = summaryObject(value?.body) ? value.body : value;
  if (!summaryObject(body) || body.error || body.success === false) summaryFail('SUMMARY_BACKEND_RESPONSE_INVALID');
  return body;
}
function summaryOrigin(value) {
  return typeof value === 'string' && /^https:\/\/[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?\/?$/i.test(value);
}

export function pendingSummaryClock(asOf) {
  const now = Date.parse(asOf);
  if (!Number.isFinite(now)) summaryFail('SUMMARY_CLOCK_INVALID');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(part => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), withinWindow: Number(parts.hour) === 8 };
}

export function pendingSummaryConfiguration(raw, execution, asOf = new Date().toISOString()) {
  if (!summaryObject(raw) || raw.enabled !== true) summaryFail('EXAMES_RESUMO_PAUSADO');
  if (typeof raw.dryRun !== 'boolean' || !summaryOrigin(raw.chatwootBaseUrl) || !summaryOrigin(raw.pamLaudosBaseUrl)
    || typeof raw.serviceUrl !== 'string' || !/^https:\/\/[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?\/functions\/v1\/exam-document-service$/i.test(raw.serviceUrl)
    || ![raw.accountId, raw.inboxId, raw.conversationId].every(value => Number.isSafeInteger(value) && value > 0)
    || typeof raw.groupJid !== 'string' || !/^[0-9-]+@g\.us$/.test(raw.groupJid)
    || typeof raw.worker !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(raw.worker)
    || raw.maxCharacters !== 12000 || raw.maxMessagePages !== 20) summaryFail('SUMMARY_CONFIGURATION_INVALID');
  if (!summaryObject(execution) || !/^[A-Za-z0-9_.:-]{1,100}$/.test(String(execution.id || ''))) summaryFail('SUMMARY_EXECUTION_INVALID');
  const clock = pendingSummaryClock(asOf);
  // The server independently enforces its own clock and the unique day/group.
  // Manual inspection outside the window is strictly a read-only preview.
  if (!raw.dryRun && !clock.withinWindow) summaryFail('SUMMARY_OUTSIDE_SEND_WINDOW');
  const worker = raw.worker + ':' + execution.id;
  if (worker.length > 96) summaryFail('SUMMARY_WORKER_TOO_LONG');
  return { ...raw, worker, localDay: clock.day,
    destinationKey: `chatwoot:${raw.accountId}:${raw.inboxId}:${raw.conversationId}:${raw.groupJid}` };
}

export function preparePendingSummary(response, cfg) {
  const body = summaryBody(response);
  if (!cfg.dryRun && body.claimed !== true) return { sendRequired: false, readOnly: false, status: body.status || 'not_claimed', reason: body.reason || null, total: body.total ?? null };
  if (body.destination_key !== cfg.destinationKey) summaryFail('SUMMARY_DESTINATION_MISMATCH');
  const formatted = buildPendingGroupSummary(body, { baseUrl: cfg.pamLaudosBaseUrl, mode: 'daily' });
  if (formatted.content.length > cfg.maxCharacters) summaryFail('SUMMARY_TOO_LONG_NO_DOCUMENTS_DROPPED');
  if (cfg.dryRun || formatted.count === 0) return { readOnly: true, sendRequired: false, total: formatted.count,
    as_of: body.as_of, day: pendingSummaryClock(body.as_of).day, destination_key: body.destination_key,
    characters: formatted.content.length, content: formatted.content, documentIds: formatted.documentIds, status: formatted.count ? 'preview' : 'empty' };
  if (!SUMMARY_UUID.test(body.summary_id || '') || !SUMMARY_UUID.test(body.lease_token || '') || body.day !== cfg.localDay) summaryFail('SUMMARY_RESERVATION_INVALID');
  return { summary_id: body.summary_id, lease_token: body.lease_token, day: body.day, as_of: body.as_of,
    destination_key: body.destination_key, content: formatted.content, documentIds: formatted.documentIds,
    total: formatted.count, characters: formatted.content.length, sendRequired: true, readOnly: false };
}

export function verifyPendingSummaryConversation(response, context, cfg) {
  const body = summaryBody(response), contact = body.meta?.sender || body.contact || {};
  const jid = contact.identifier || body.contact_inbox?.source_id || body.meta?.sender?.additional_attributes?.jid;
  if (Number(body.id) !== cfg.conversationId || Number(body.inbox_id) !== cfg.inboxId || jid !== cfg.groupJid
    || context.destination_key !== cfg.destinationKey) summaryFail('SUMMARY_GROUP_IDENTITY_MISMATCH');
  return context;
}

function summaryMessageTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') return Date.parse(value);
  return NaN;
}

export function verifyPendingSummaryRecentMessages(pages, context, cfg) {
  if (!Array.isArray(pages) || !pages.length || pages.length > cfg.maxMessagePages) summaryFail('SUMMARY_MESSAGE_PAGES_INVALID');
  const cutoff = Date.parse(context.as_of) - 86_400_000;
  if (!Number.isFinite(cutoff)) summaryFail('SUMMARY_CLOCK_INVALID');
  let complete = false, existing = 0;
  const seen = new Set();
  for (const page of pages) {
    const body = summaryBody(page), messages = body.payload || body.messages;
    if (!Array.isArray(messages)) summaryFail('SUMMARY_MESSAGE_LIST_INVALID');
    if (!messages.length) complete = true;
    for (const message of messages) {
      if (!summaryObject(message) || message.id == null || !Number.isFinite(summaryMessageTime(message.created_at))) summaryFail('SUMMARY_MESSAGE_INVALID');
      if (summaryMessageTime(message.created_at) < cutoff) complete = true;
      if (seen.has(String(message.id))) continue;
      seen.add(String(message.id));
      if (message.inbox_id != null && Number(message.inbox_id) !== cfg.inboxId
        || message.conversation_id != null && Number(message.conversation_id) !== cfg.conversationId) summaryFail('SUMMARY_MESSAGE_DESTINATION_MISMATCH');
      const attributes = message.content_attributes || {};
      if (message.private === false && [1, 'outgoing'].includes(message.message_type)
        && (context.summary_id && attributes.pamvet_exam_summary_id === context.summary_id
          || attributes.pamvet_exam_summary_day === context.day && attributes.pamvet_exam_summary_destination === cfg.destinationKey)) {
        existing++;
      }
    }
  }
  if (!complete) summaryFail('SUMMARY_MESSAGE_SCAN_INCOMPLETE_DO_NOT_POST');
  if (existing && !context.readOnly) summaryFail('SUMMARY_EXISTING_MESSAGE_FOUND_DO_NOT_POST');
  return { ...context, recentScanComplete: true, existingSummaryMessages: existing };
}

export function pendingSummaryDispatchPermission(response, context, cfg) {
  const body = summaryBody(response);
  if (body.dispatch_allowed !== true) return { sendRequired: false, status: 'dispatch_not_granted', summary_id: context.summary_id };
  if (body.summary_id !== context.summary_id || !/^[a-f0-9]{64}$/i.test(body.content_sha256 || '')
    || context.destination_key !== cfg.destinationKey || context.readOnly || context.sendRequired !== true) summaryFail('SUMMARY_DISPATCH_PERMISSION_INVALID');
  return { ...context, dispatch_allowed: true, content_sha256: body.content_sha256,
    expectedInboxId: cfg.inboxId, expectedConversationId: cfg.conversationId, expectedAccountId: cfg.accountId,
    contentAttributes: { pamvet_exam_summary_id: context.summary_id, pamvet_exam_summary_day: context.day,
      pamvet_exam_summary_destination: context.destination_key, pamvet_exam_summary_sha256: body.content_sha256 } };
}

export function classifyPendingSummarySubmission(response, context) {
  if (context.dispatch_allowed !== true || !/^[a-f0-9]{64}$/i.test(context.content_sha256 || '')) summaryFail('SUMMARY_POST_WITHOUT_PERMISSION');
  const status = Number(response?.statusCode || 0), body = response?.body || {};
  const base = { content_sha256: context.content_sha256 };
  if (status >= 200 && status < 300 && body.id != null) {
    const attributes = body.content_attributes;
    const consistent = body.content === context.content
      && (body.conversation_id == null || Number(body.conversation_id) === context.expectedConversationId)
      && (body.inbox_id == null || Number(body.inbox_id) === context.expectedInboxId)
      && (body.account_id == null || Number(body.account_id) === context.expectedAccountId)
      && (body.private == null || body.private === false)
      && (body.message_type == null || [1, 'outgoing'].includes(body.message_type))
      && (attributes == null || summaryObject(attributes) && attributes.pamvet_exam_summary_id === context.summary_id
        && attributes.pamvet_exam_summary_day === context.day
        && attributes.pamvet_exam_summary_destination === context.destination_key
        && attributes.pamvet_exam_summary_sha256 === context.content_sha256);
    if (!consistent) return { ...context, outcome: { ...base, status: 'uncertain', error_code: 'SUMMARY_POST_RESPONSE_MISMATCH' } };
    const observed = ['created', 'sent', 'delivered', 'read'].includes(body.status) ? body.status : 'created';
    return { ...context, outcome: { ...base, status: observed, external_id: String(body.id), external_status: observed } };
  }
  const rejected = status >= 400 && status < 500 && ![408, 409, 429].includes(status);
  return { ...context, outcome: { ...base, status: rejected ? 'failed' : 'uncertain',
    error_code: rejected ? 'SUMMARY_POST_REJECTED' : 'SUMMARY_POST_UNCERTAIN' } };
}
