import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pendingSummaryClock, pendingSummaryConfiguration, preparePendingSummary, verifyPendingSummaryConversation,
  verifyPendingSummaryRecentMessages, pendingSummaryDispatchPermission, classifyPendingSummarySubmission } from './pending-summary-runtime.mjs';
import { PENDING_SUMMARY_CONFIG } from './pending-summary-build.mjs';

const asOf = '2026-10-19T11:00:00Z';
const raw = { ...PENDING_SUMMARY_CONFIG, enabled: true, dryRun: false,
  serviceUrl: 'https://backend.example.invalid/functions/v1/exam-document-service', chatwootBaseUrl: 'https://support.example.invalid',
  pamLaudosBaseUrl: 'https://pamlaudos.example.invalid', accountId: 1, inboxId: 2, conversationId: 3, groupJid: '123456@g.us' };
const cfg = pendingSummaryConfiguration(raw, { id: 'test-execution' }, asOf);
const id = '10000000-0000-4000-8000-000000000001';
const token = '20000000-0000-4000-8000-000000000001';
const snapshot = () => ({ claimed: true, summary_id: id, lease_token: token, day: '2026-10-19', as_of: asOf,
  destination_key: cfg.destinationKey, total: 1, has_more: false, documents: [{ document_id: '30000000-0000-4000-8000-000000000001',
    client_name: 'Tutora de demonstração', pet_name: 'Pet de demonstração', exam_type: 'Hemograma', responsible_vet_id: null, first_group_sent_at: '2026-10-18T11:00:00Z' }] });
const context = () => preparePendingSummary(snapshot(), cfg);
const permission = ctx => ({ dispatch_allowed: true, summary_id: ctx.summary_id, content_sha256: crypto.createHash('sha256').update(ctx.content).digest('hex') });

test('São Paulo clock is daily, includes weekends, and accepts only 08:00 through 08:59 for sends', () => {
  for (const [value, allowed] of [['2026-10-18T10:59:59Z', false], ['2026-10-18T11:00:00Z', true], ['2026-10-18T11:59:59Z', true], ['2026-10-18T12:00:00Z', false]]) {
    assert.equal(pendingSummaryClock(value).withinWindow, allowed);
    if (allowed) assert.equal(pendingSummaryConfiguration(raw, { id: 'test' }, value).localDay, '2026-10-18');
    else assert.throws(() => pendingSummaryConfiguration(raw, { id: 'test' }, value), /OUTSIDE_SEND_WINDOW/);
    assert.equal(pendingSummaryConfiguration({ ...raw, dryRun: true }, { id: 'test' }, value).dryRun, true);
  }
});

test('neutral disabled config and unknown destinations cannot reach the backend or dispatch', () => {
  assert.throws(() => pendingSummaryConfiguration(PENDING_SUMMARY_CONFIG, { id: 'test' }, asOf), /PAUSADO/);
  for (const extra of [{ serviceUrl: 'http://unsafe.invalid' }, { groupJid: 'individual@c.us' }, { inboxId: null }, { maxCharacters: 24000 }]) {
    assert.throws(() => pendingSummaryConfiguration({ ...raw, ...extra }, { id: 'test' }, asOf), /CONFIGURATION/);
  }
  assert.throws(() => pendingSummaryConfiguration({ ...raw, worker: 'a'.repeat(95) }, { id: 'x' }, asOf), /WORKER_TOO_LONG/);
  assert.throws(() => preparePendingSummary({ ...snapshot(), destination_key: 'another-group' }, cfg), /DESTINATION/);
});

test('empty, unclaimed, and read-only responses do not permit a message POST', () => {
  const empty = preparePendingSummary({ claimed: false, total: 0, status: 'empty' }, cfg);
  assert.equal(empty.sendRequired, false);
  assert.equal(empty.content, undefined);
  assert.equal(preparePendingSummary({ claimed: false, status: 'uncertain' }, cfg).sendRequired, false);
  const preview = preparePendingSummary({ ...snapshot(), claimed: undefined }, { ...cfg, dryRun: true });
  assert.equal(preview.sendRequired, false); assert.equal(preview.readOnly, true);
  assert.match(preview.content, /^📋 \*Exames pendentes\*/); assert.doesNotMatch(preview.content, /Teste de resumo/);
  assert.throws(() => pendingSummaryDispatchPermission(permission(preview), preview, cfg), /PERMISSION_INVALID/);
});

test('complete snapshots retain every item and over-limit summaries fail before begin rather than drop any document', () => {
  const ctx = context(); assert.equal(ctx.total, 1); assert.equal(ctx.sendRequired, true); assert.equal(ctx.lease_token, token);
  assert.throws(() => preparePendingSummary({ ...snapshot(), has_more: true }, cfg), /incompleta/);
  const large = snapshot(); large.documents[0].client_name = 'Nome completo '.repeat(1000);
  assert.throws(() => preparePendingSummary(large, cfg), /TOO_LONG_NO_DOCUMENTS_DROPPED/);
  assert.throws(() => preparePendingSummary({ ...snapshot(), day: '2026-10-18' }, cfg), /RESERVATION/);
});

test('group verification requires the exact conversation, inbox and canonical JID', () => {
  const group = { id: 3, inbox_id: 2, meta: { sender: { identifier: '123456@g.us' } } };
  assert.equal(verifyPendingSummaryConversation(group, context(), cfg).summary_id, id);
  for (const extra of [{ id: 4 }, { inbox_id: 3 }, { meta: { sender: { identifier: 'wrong@g.us' } } }]) {
    assert.throws(() => verifyPendingSummaryConversation({ ...group, ...extra }, context(), cfg), /IDENTITY_MISMATCH/);
  }
});

test('recent-message scan must prove coverage and stops before any duplicate day or summary POST', () => {
  const ctx = context();
  const old = { id: 1, created_at: Date.parse('2026-10-17T11:00:00Z') / 1000, private: false, message_type: 1, inbox_id: 2, conversation_id: 3, content_attributes: {} };
  assert.equal(verifyPendingSummaryRecentMessages([{ payload: [old] }], ctx, cfg).recentScanComplete, true);
  assert.equal(verifyPendingSummaryRecentMessages([{ payload: [] }], ctx, cfg).recentScanComplete, true);
  assert.throws(() => verifyPendingSummaryRecentMessages([{ payload: [{ ...old, created_at: Date.parse(asOf) / 1000 }] }], ctx, cfg), /SCAN_INCOMPLETE/);
  for (const attributes of [{ pamvet_exam_summary_id: id }, { pamvet_exam_summary_day: ctx.day, pamvet_exam_summary_destination: cfg.destinationKey }]) {
    assert.throws(() => verifyPendingSummaryRecentMessages([{ payload: [{ ...old, content_attributes: attributes }] }], ctx, cfg), /EXISTING_MESSAGE/);
  }
  const preview = { ...ctx, summary_id: undefined, readOnly: true };
  assert.equal(verifyPendingSummaryRecentMessages([{ payload: [old] }], preview, cfg).existingSummaryMessages, 0);
  assert.equal(verifyPendingSummaryRecentMessages([{ payload: [{ ...old, content_attributes: { pamvet_exam_summary_day: ctx.day, pamvet_exam_summary_destination: cfg.destinationKey } }] }], preview, cfg).existingSummaryMessages, 1);
  assert.throws(() => verifyPendingSummaryRecentMessages([{ payload: [{ ...old, conversation_id: 4 }] }], ctx, cfg), /DESTINATION_MISMATCH/);
  assert.throws(() => verifyPendingSummaryRecentMessages([{ error: 'private provider text' }], ctx, cfg), /BACKEND_RESPONSE/);
});

test('only a positive persisted begin grant with matching summary/hash permits the one outgoing message', () => {
  const ctx = context(), grant = permission(ctx);
  assert.equal(pendingSummaryDispatchPermission({ dispatch_allowed: false }, ctx, cfg).sendRequired, false);
  const permitted = pendingSummaryDispatchPermission(grant, ctx, cfg);
  assert.equal(permitted.dispatch_allowed, true);
  assert.deepEqual(permitted.contentAttributes, { pamvet_exam_summary_id: id, pamvet_exam_summary_day: ctx.day,
    pamvet_exam_summary_destination: cfg.destinationKey, pamvet_exam_summary_sha256: grant.content_sha256 });
  for (const extra of [{ summary_id: token }, { content_sha256: null }, { content_sha256: 'bad-hash' }]) {
    assert.throws(() => pendingSummaryDispatchPermission({ ...grant, ...extra }, ctx, cfg), /PERMISSION_INVALID/);
  }
});

test('created/sent is submission only and response loss or transport errors remain uncertain without leaking provider bodies', () => {
  const ctx = context(), permitted = pendingSummaryDispatchPermission(permission(ctx), ctx, cfg);
  for (const status of ['created', 'sent', 'delivered', 'read']) {
    const out = classifyPendingSummarySubmission({ statusCode: 200, body: { id: 42, status, content: permitted.content, content_attributes: permitted.contentAttributes, inbox_id: 2, conversation_id: 3 } }, permitted);
    assert.equal(out.outcome.status, status); assert.equal(out.outcome.external_id, '42');
    assert.equal(out.outcome.content_sha256, permitted.content_sha256);
  }
  for (const response of [{ error: 'secret provider details' }, { statusCode: 200, body: {} }, { statusCode: 429 }, { statusCode: 500 }]) {
    const out = classifyPendingSummarySubmission(response, permitted);
    assert.equal(out.outcome.status, 'uncertain'); assert.equal(out.outcome.error_code, 'SUMMARY_POST_UNCERTAIN');
    assert(!JSON.stringify(out.outcome).includes('secret'));
  }
  assert.equal(classifyPendingSummarySubmission({ statusCode: 403 }, permitted).outcome.status, 'failed');
  assert.throws(() => classifyPendingSummarySubmission({ statusCode: 200 }, ctx), /POST_WITHOUT_PERMISSION/);
});

test('a positive POST response with mismatched text, destination or summary identity stays uncertain', () => {
  const ctx = context(), permitted = pendingSummaryDispatchPermission(permission(ctx), ctx, cfg);
  const good = { id: 42, status: 'sent', content: permitted.content, content_attributes: permitted.contentAttributes };
  for (const extra of [{ content: 'another message' }, { conversation_id: 4 }, { inbox_id: 99 }, { account_id: 99 },
    { content_attributes: { ...good.content_attributes, pamvet_exam_summary_day: '2020-01-01' } },
    { content_attributes: { ...good.content_attributes, pamvet_exam_summary_sha256: '0'.repeat(64) } }]) {
    const result = classifyPendingSummarySubmission({ statusCode: 200, body: { ...good, ...extra } }, permitted);
    assert.equal(result.outcome.status, 'uncertain'); assert.equal(result.outcome.error_code, 'SUMMARY_POST_RESPONSE_MISMATCH');
  }
});
