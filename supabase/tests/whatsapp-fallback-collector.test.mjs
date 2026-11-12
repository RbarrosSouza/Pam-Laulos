import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../functions/exam-whatsapp-fallback/collector.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { collectWhatsappOrigins, inspectFallbackMessage, verifyFallbackSourceConversation, allowedAttachmentUrl, resolveAllowedAttachmentRedirect, MAX_PDF_BYTES } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const cfg = () => ({ accountId: '1', inboxId: '2', knownConversationIds: ['3'], authorizedSenders: ['5511999998888'],
  chatwootBaseUrl: 'https://chatwoot.example.invalid', allowedAttachmentOrigins: ['https://media.example.invalid'], intakeCutoff: '2026-11-03T00:00:00Z' });
const window = () => ({ receivedFrom: '2026-11-03T00:00:00Z', receivedThrough: '2026-11-04T00:00:00Z' });
const conversation = (id = '3') => ({ id: Number(id), inbox_id: 2, account_id: 1, status: 'resolved',
  meta: { sender: { id: 7, type: 'contact', phone_number: '+55 (11) 99999-8888' } }, contact_inbox: { source_id: '5511999998888@s.whatsapp.net' } });
const attachment = (id = 31, extra = {}) => ({ id, message_id: 300, account_id: 1, file_name: 'Laudo.pdf', content_type: 'application/pdf', file_size: 123,
  data_url: 'https://chatwoot.example.invalid/rails/blob/Laudo.pdf?signature=transient', ...extra });
const message = (id = 300, extra = {}) => ({ id, account_id: 1, inbox_id: 2, conversation_id: 3, private: false, message_type: 0,
  created_at: Date.parse('2026-11-03T10:00:00Z') / 1000, sender: { id: 7, type: 'contact', phone_number: '5511999998888' },
  attachments: [attachment(id + 1000, { message_id: id })], ...extra });
function provider(rows, pageSize = 21) {
  const calls = [];
  return { calls, io: {
    getConversation: async id => { calls.push(['conversation', id]); return conversation(id); },
    getMessages: async (id, before) => { calls.push(['messages', id, before]); return { payload: rows.filter(x => before === null || x.id < Number(before)).sort((a, b) => b.id - a.id).slice(0, pageSize) }; },
  } };
}

test('discovers unreserved attachments in resolved pinned conversation without n8n or database inventory', async () => {
  const p = provider([message(301), message(300)]);
  const result = await collectWhatsappOrigins(cfg(), p.io, window());
  assert.equal(result.complete, true); assert.equal(result.coverageGuaranteed, false); assert.equal(result.scope, 'configured_conversations_only');
  assert.deepEqual(result.origins.map(x => [x.source.message_id, x.source.attachment_id]), [['301', 'chatwoot-attachment:1301'], ['300', 'chatwoot-attachment:1300']]);
  assert.equal(result.origins[0].source.account_id, 'chatwoot:1:inbox:2');
  assert.equal(result.origins[0].source.metadata.sender_allowlisted, true);
  assert(!JSON.stringify(result.origins[0].source).includes('signature='));
  assert.equal(result.cursor, null); assert.equal(result.highWaterMessageIds['3'], '301');
  assert.deepEqual(p.calls.at(-1), ['messages', '3', '300']); // Short page was not treated as EOF.
});

test('rejects wrong scope, changed contact identity, unlisted sender and group metadata', () => {
  for (const [conv, msg] of [
    [conversation('4'), message()],
    [{ ...conversation(), inbox_id: 99 }, message()],
    [conversation(), message(300, { sender: { id: 8, phone_number: '5511999998888' } })],
    [{ ...conversation(), meta: { sender: { id: 7, phone_number: '5511988887777' } } }, message()],
    [{ ...conversation(), additional_attributes: { is_group: true } }, message()],
    [conversation(), message(300, { account_id: 99 })],
  ]) assert.throws(() => inspectFallbackMessage(conv, msg, cfg()), /whatsapp_/);
});

test('source preflight authorizes a resolved pinned conversation before any message exists', () => {
  const source = conversation();
  assert.equal(verifyFallbackSourceConversation(source, cfg()), source);
  assert.equal(verifyFallbackSourceConversation({ statusCode: 200, body: source }, cfg()), source);
  assert.throws(() => verifyFallbackSourceConversation(source, { ...cfg(), authorizedSenders: [] }), /senders_config_invalid/);
});

test('source preflight rejects a readable conversation outside the exact source policy', () => {
  for (const [source, expected] of [
    [conversation('4'), /conversation_scope_mismatch/],
    [{ ...conversation(), account_id: 99 }, /conversation_scope_mismatch/],
    [{ ...conversation(), inbox_id: 99 }, /conversation_scope_mismatch/],
    [{ ...conversation(), meta: {} }, /contact_unproven/],
    [{ ...conversation(), meta: { sender: { id: 7, type: 'user', phone_number: '5511999998888' } } }, /contact_unproven/],
    [{ ...conversation(), meta: { sender: { id: 7, type: 'contact', phone_number: '5511988887777' } } }, /sender_not_authorized/],
    [{ ...conversation(), contact_inbox: { source_id: '5511988887777@s.whatsapp.net' } }, /individual_conversation_unproven/],
    [{ ...conversation(), additional_attributes: { is_group: true } }, /individual_conversation_required/],
    [{ ...conversation(), contact_inbox: { source_id: '120363999999999999@g.us' } }, /individual_conversation_required/],
    [{ ...conversation(), additional_attributes: { pamvet_exam_document_id: 'fixture' } }, /individual_conversation_required/],
  ]) assert.throws(() => verifyFallbackSourceConversation(source, cfg()), expected);
});

test('does not accept outgoing, private or mirrored exam messages as new incoming PDFs', () => {
  for (const extra of [{ message_type: 1 }, { message_type: 'outgoing' }, { private: true }, { content_attributes: { pamvet_exam_document_id: 'fixture' } }]) {
    assert.deepEqual(inspectFallbackMessage(conversation(), message(300, extra), cfg()), []);
  }
  assert.throws(() => inspectFallbackMessage(conversation(), message(300, { private: undefined }), cfg()), /privacy_unproven/);
});

test('missing and generic MIME remains a candidate, invalid metadata remains a visible pending origin', () => {
  for (const mime of [undefined, 'application/octet-stream']) {
    const a = attachment(31, { file_name: 'documento', data_url: 'https://chatwoot.example.invalid/rails/blob/opaque', content_type: mime });
    const [origin] = inspectFallbackMessage(conversation(), message(300, { attachments: [a] }), cfg());
    assert(origin); assert.equal(origin.missing, false);
  }
  const tooBig = attachment(31, { file_size: MAX_PDF_BYTES + 1 });
  const badMime = attachment(32, { content_type: 'text/html' });
  const badUrl = attachment(33, { data_url: 'http://127.0.0.1/private' });
  const found = inspectFallbackMessage(conversation(), message(300, { attachments: [tooBig, badMime, badUrl] }), cfg());
  assert.deepEqual(found.map(x => x.pendingReason), ['pdf_size_invalid_or_exceeds_limit', 'pdf_metadata_mismatch', 'pdf_url_missing_or_untrusted']);
  assert(found.every(x => x.attachment.downloadUrl === null));
  assert.throws(() => inspectFallbackMessage(conversation(), message(300, { attachments: { unexpected: true } }), cfg()), /inventory_invalid/);
});

test('media URLs and every redirect require explicit HTTPS origin, no userinfo, IP, private host or URL trick', () => {
  for (const url of ['http://chatwoot.example.invalid/a.pdf', 'https://127.0.0.1/a.pdf', 'https://localhost/a.pdf',
    'https://chatwoot.example.invalid@evil.example/a.pdf', 'https://evil.example/a.pdf', 'https://chatwoot.example.invalid/a%0ab.pdf',
    'https://chatwoot.example.invalid:8443/a.pdf', 'https://chatwoot.example.invalid\\@evil.example/a.pdf']) assert.equal(allowedAttachmentUrl(url, cfg()), null);
  assert.equal(resolveAllowedAttachmentRedirect('/rails/blob/a.pdf', cfg().chatwootBaseUrl + '/old', cfg()), cfg().chatwootBaseUrl + '/rails/blob/a.pdf');
  assert.equal(resolveAllowedAttachmentRedirect('https://media.example.invalid/a.pdf', cfg().chatwootBaseUrl, cfg()), 'https://media.example.invalid/a.pdf');
  for (const location of ['//evil.example/a.pdf', '../a.pdf', 'https://evil.example/a.pdf', 'http://media.example.invalid/a.pdf']) assert.throws(() => resolveAllowedAttachmentRedirect(location, cfg().chatwootBaseUrl, cfg()), /redirect_not_allowed/);
});

test('paginates even unordered timestamps and short pages; time cutoff does not hide a later eligible lower ID', async () => {
  const p = provider([message(303), message(302, { created_at: Date.parse('2026-11-02T12:00:00Z') / 1000 }), message(301)], 1);
  const result = await collectWhatsappOrigins(cfg(), p.io, window());
  assert.equal(result.complete, true); assert.deepEqual(result.origins.map(x => x.source.message_id), ['303', '301']); assert.equal(result.pages, 4);
});

test('bounded pagination returns resumable scope-bound cursor rather than claiming complete coverage', async () => {
  const p = provider([message(303), message(302), message(301)], 1);
  const first = await collectWhatsappOrigins(cfg(), p.io, { ...window(), maxPages: 1 });
  assert.equal(first.complete, false); assert.equal(first.reason, 'page_budget'); assert.equal(first.cursor.beforeMessageId, '303');
  assert.match(first.cursor.scope, /^[a-f0-9]{64}$/); assert(!JSON.stringify(first.cursor).includes('5511999998888'));
  const second = await collectWhatsappOrigins(cfg(), p.io, { ...window(), cursor: first.cursor });
  assert.equal(second.complete, true); assert.deepEqual(second.origins.map(x => x.source.message_id), ['302', '301']);
  await assert.rejects(collectWhatsappOrigins({ ...cfg(), knownConversationIds: ['3', '4'] }, p.io, { ...window(), cursor: first.cursor }), /cursor_invalid/);
  await assert.rejects(collectWhatsappOrigins(cfg(), p.io, { ...window(), receivedThrough: '2026-11-05T00:00:00Z', cursor: first.cursor }), /cursor_invalid/);
});

test('origin budget stops before a whole message; resume never drops remaining attachments', async () => {
  const many = id => message(id, { attachments: Array.from({ length: 60 }, (_, index) => attachment(id * 1000 + index, { message_id: id })) });
  const p = provider([many(303), many(302)]);
  const first = await collectWhatsappOrigins(cfg(), p.io, window());
  assert.equal(first.reason, 'origin_budget'); assert.equal(first.origins.length, 60); assert.equal(first.cursor.beforeMessageId, '303');
  const second = await collectWhatsappOrigins(cfg(), p.io, { ...window(), cursor: first.cursor });
  assert.equal(second.complete, true); assert.equal(second.origins.length, 60); assert(second.origins.every(x => x.source.message_id === '302'));
});

test('rejects duplicate IDs and non-decreasing before pagination without unsafe cursor advance', async () => {
  const p = provider([message(303)]);
  let calls = 0;
  p.io.getMessages = async () => ({ payload: calls++ ? [message(303)] : [message(303)] });
  const result = await collectWhatsappOrigins(cfg(), p.io, window());
  assert.equal(result.complete, false); assert.equal(result.errorCode, 'whatsapp_message_pagination_cycle'); assert.equal(result.cursor.beforeMessageId, '303');
  p.io.getMessages = async () => ({ payload: [message(303), message(303)] });
  const duplicate = await collectWhatsappOrigins(cfg(), p.io, window());
  assert.equal(duplicate.errorCode, 'whatsapp_message_page_duplicate'); assert.equal(duplicate.cursor.beforeMessageId, null);
});

test('source error is sanitized and leaves remaining work resumable', async () => {
  const p = provider([]);
  p.io.getMessages = async () => { throw new Error('Authorization secret must not leave adapter'); };
  const result = await collectWhatsappOrigins(cfg(), p.io, window());
  assert.equal(result.complete, false); assert.equal(result.reason, 'source_error'); assert.equal(result.errorCode, 'whatsapp_source_request_failed');
  assert(!JSON.stringify(result).includes('Authorization'));
});

test('typed provider authorization and scope failures remain distinct from transient availability', async () => {
  for (const code of ['conversation_unavailable', 'provider_scope_mismatch', 'provider_json_invalid', 'source_request_failed', 'request_timeout']) {
    const p = provider([]);
    p.io.getMessages = async () => { const error = new Error(code); error.name = 'ChatwootFallbackError'; throw error; };
    const result = await collectWhatsappOrigins(cfg(), p.io, window());
    assert.equal(result.reason, 'source_error'); assert.equal(result.errorCode, 'whatsapp_' + code);
    assert.equal(result.cursor.beforeMessageId, null);
  }
});

test('time budget aborts an unresponsive provider read and does not discard cursor', async () => {
  let aborted = false;
  const result = await collectWhatsappOrigins(cfg(), {
    getConversation: (_id, signal) => { signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); },
    getMessages: async () => { throw new Error('should not be reached'); },
  }, { ...window(), maxMillis: 20 });
  assert.equal(result.complete, false); assert.equal(result.errorCode, 'whatsapp_request_timeout'); assert(aborted); assert.equal(result.cursor.beforeMessageId, null);
});

test('safe highwater never skips a message received after the frozen time window', async () => {
  const p = provider([message(303), message(302, { created_at: Date.parse('2026-11-04T01:00:00Z') / 1000 }), message(301)]);
  const result = await collectWhatsappOrigins(cfg(), p.io, window());
  assert.equal(result.complete, true); assert.deepEqual(result.origins.map(x => x.source.message_id), ['303', '301']);
  assert.equal(result.highWaterMessageIds['3'], '301');
  const next = await collectWhatsappOrigins(cfg(), p.io, { ...window(), receivedThrough: '2026-11-05T00:00:00Z', stopBeforeMessageIds: result.highWaterMessageIds });
  assert.deepEqual(next.origins.map(x => x.source.message_id), ['303', '302']); // Idempotent replay of 303 is safer than losing 302.
});
