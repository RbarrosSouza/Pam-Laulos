import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { normalizeBrazilPhone, inspectChatwootWebhook, canonicalChatwootEvent, inspectChatwootMessage, decodeChatwootOriginal, resolveChatwootRedirect,
  startChatwootSweep, advanceChatwootConversationPage, startChatwootMessagePages, advanceChatwootMessagePage, summarizeChatwootIntake } from './whatsapp-intake-runtime.mjs';
import { decideReservation } from './operacional-runtime.mjs';

const bytes = Buffer.from('%PDF-1.4\nDocumento inteiramente fictício.\n%%EOF');
const cfg = { accountId: 41, inboxId: 73, authorizedSenders: ['(11) 98765-4321'], chatwootBaseUrl: 'https://support.example.invalid',
  allowedAttachmentOrigins: ['https://files.example.invalid'], driveFolderId: 'fixture-private-folder', intakeCutoff: '2026-10-18T00:00:00Z' };
const docId = '11111111-1111-4111-a111-111111111111';
function message() {
  return { event: 'message_created', id: 910, account: { id: 41 }, inbox: { id: 73 }, message_type: 'incoming', private: false,
    created_at: '2026-10-18T12:30:00Z', sender: { id: 200, type: 'contact', phone_number: '+5511987654321' },
    content: 'Documento fictício', conversation: { id: 300, account_id: 41, inbox_id: 73, contact_inbox: { source_id: '5511987654321@s.whatsapp.net' },
      meta: { sender: { id: 200, type: 'contact', phone_number: '+5511987654321' } } },
    attachments: [{ id: 811, account_id: 41, message_id: 910, file_type: 'file', data_url: 'https://files.example.invalid/private/original.pdf?signature=fixture-only', file_size: bytes.length }] };
}
const inspect = (payload = message(), config = cfg) => inspectChatwootMessage(payload, config);
const reserved = () => decideReservation(inspect().origins[0], { document_id: docId, document: { id: docId, file_status: 'pending' } });
const response = { statusCode: 200, headers: { 'content-type': 'application/pdf' } };
function canonicalInputs() {
  const payload = message(), request = inspectChatwootWebhook(payload, cfg).request;
  const conversation = structuredClone(payload.conversation);
  const target = { id: payload.id, conversation_id: conversation.id, account_id: payload.account.id, inbox_id: payload.inbox.id,
    message_type: 0, private: false, created_at: payload.created_at, sender: structuredClone(payload.sender), attachments: structuredClone(payload.attachments), content: payload.content };
  return { request, conversation, messages: { payload: [{ id: 909, message_type: 1 }, target] }, target };
}

test('webhook hints authorize only fixed conversation/message API reads, without trusting sender, caption or URL', () => {
  const payload = message(); payload.sender.phone_number = '+5511987654322'; payload.attachments[0].data_url = 'https://evil.example.invalid/stolen.pdf';
  const result = inspectChatwootWebhook(payload, cfg);
  assert.deepEqual(result, { excluded: false, request: { accountId: '41', inboxId: '73', conversationId: '300', messageId: '910', beforeMessageId: '911' } });
  assert(!JSON.stringify(result).includes('evil')); assert(!JSON.stringify(result).includes('4322'));
  for (const field of ['sender', 'attachments', 'content']) delete payload[field];
  assert.deepEqual(inspectChatwootWebhook(payload, cfg), result);
});

test('webhook coarse guards ignore other events/inboxes, notes, group mirrors and unsafe numeric IDs', () => {
  for (const mutate of [p => { p.event = 'message_updated'; }, p => { p.message_type = 1; }, p => { p.private = true; }, p => { p.account.id = 42; }, p => { p.inbox.id = 74; },
    p => { p.conversation.contact_inbox.source_id = '123@g.us'; }, p => { p.content_attributes = { pamvet_exam_delivery_id: docId }; }]) {
    const payload = message(); mutate(payload); assert.equal(inspectChatwootWebhook(payload, cfg).excluded, true);
  }
  for (const value of [0, -1, '9007199254740991', '9007199254740992', '910?before=1', 1.1]) {
    const payload = message(); payload.id = value; assert.throws(() => inspectChatwootWebhook(payload, cfg), /message_invalid/);
  }
  const mismatch = message(); mismatch.conversation.inbox_id = 74; assert.throws(() => inspectChatwootWebhook(mismatch, cfg), /inbox_mismatch/);
});

test('canonical event uses only uniquely matched API message and API conversation, then enters the existing PDF adapter', () => {
  const values = canonicalInputs();
  const result = canonicalChatwootEvent(values.request, { statusCode: 200, body: values.conversation }, { statusCode: 200, body: values.messages }, cfg);
  assert.equal(result.id, '910'); assert.equal(result.account.id, '41'); assert.equal(result.inbox.id, '73');
  assert.equal(result.sender.phone_number, message().sender.phone_number); assert.deepEqual(result.attachments, values.target.attachments);
  assert.equal(inspect(result).origins[0].source.attachment_id, 'chatwoot-attachment:811');
  result.attachments[0].id = 999; assert.equal(values.target.attachments[0].id, 811);
});

test('missing contact_inbox is reconstructed only from convergent API contact ID and phone, not a group participant', () => {
  const values = canonicalInputs(); delete values.conversation.contact_inbox;
  const result = canonicalChatwootEvent(values.request, values.conversation, values.messages, cfg);
  assert.equal(result.conversation.contact_inbox.source_id, '5511987654321'); assert.equal(inspect(result).excluded, false);
  for (const mutate of [v => { v.conversation.meta.sender.id = 201; }, v => { v.conversation.meta.sender.phone_number = '+5511987654322'; },
    v => { delete v.conversation.meta.sender.phone_number; }, v => { v.target.sender.identifier = '123@g.us'; }, v => { v.conversation.meta.sender.additional_attributes = { is_group: true }; },
    v => { v.conversation.custom_attributes = { group_id: 'group' }; }, v => { v.conversation.additional_attributes = { remote_jid: '123@g.us' }; },
    v => { v.target.sender.additional_attributes = { remote_jid: '123@g.us' }; }, v => { v.conversation.meta.sender.additional_attributes = { jid: '123@G.US' }; }]) {
    const changed = canonicalInputs(); delete changed.conversation.contact_inbox; mutate(changed);
    assert.throws(() => canonicalChatwootEvent(changed.request, changed.conversation, changed.messages, cfg), /whatsapp_canonical_/);
  }
});

test('real API shape supports group_type individual, omitted contact_inbox/account_id and Unix message timestamps', () => {
  const config = { ...cfg, inboxId: 2 };
  const conversation = { id: 3, inbox_id: 2, meta: { sender: { id: 3, phone_number: '+5511987654321', group_type: 'individual' } } };
  const apiMessage = { id: 910, conversation_id: 3, inbox_id: 2, message_type: 0, private: false, created_at: 1792326600,
    sender: { id: 3, type: 'contact', phone_number: '+5511987654321' }, attachments: message().attachments };
  apiMessage.attachments[0].message_id = 910;
  const request = { accountId: '41', inboxId: '2', conversationId: '3', messageId: '910', beforeMessageId: '911' };
  const event = canonicalChatwootEvent(request, conversation, { payload: [apiMessage] }, config);
  const result = inspectChatwootMessage(event, config);
  assert.equal(result.excluded, false); assert.equal(result.origins.length, 1);
  assert.equal(result.origins[0].source.received_at, new Date(apiMessage.created_at * 1000).toISOString());
  assert.equal(result.origins[0].source.account_id, 'chatwoot:41:inbox:2');
  for (const location of ['conversation', 'message', 'additional_attributes']) {
    const changedConversation = structuredClone(conversation), changedMessage = structuredClone(apiMessage);
    if (location === 'conversation') changedConversation.meta.sender.group_type = 'group';
    else if (location === 'message') changedMessage.sender.group_type = 'group';
    else changedConversation.meta.sender.additional_attributes = { group_type: 'GROUP' };
    assert.throws(() => canonicalChatwootEvent(request, changedConversation, { payload: [changedMessage] }, config), /group_or_broadcast/);
  }
});

test('canonical read rejects missing/duplicate target, alternate payload locations, non-200 and cross-conversation identities', () => {
  for (const mutate of [v => { v.messages.payload = []; }, v => { v.messages.payload.push(structuredClone(v.target)); }, v => { v.messages = { messages: v.messages.payload }; },
    v => { v.messages = { payload: { payload: v.messages.payload } }; }, v => { v.conversation.id = 301; }, v => { v.conversation.inbox_id = 74; },
    v => { v.conversation.account_id = 42; }, v => { v.target.conversation_id = 301; }, v => { v.target.account_id = 42; }, v => { v.target.inbox_id = 74; },
    v => { v.target.private = true; }, v => { v.target.message_type = 1; }, v => { v.request.beforeMessageId = '912'; },
    v => { v.conversation = { statusCode: 401, body: v.conversation }; }, v => { v.messages = { statusCode: 500, body: v.messages }; }]) {
    const values = canonicalInputs(); mutate(values); assert.throws(() => canonicalChatwootEvent(values.request, values.conversation, values.messages, cfg), /whatsapp_/);
  }
});

test('forged authorized webhook identity cannot replace an actual unauthorized API sender or a different PDF', () => {
  const values = canonicalInputs(); values.target.sender.phone_number = '+5511987654322'; values.conversation.meta.sender.phone_number = '+5511987654322'; values.conversation.contact_inbox.source_id = '5511987654322';
  const canonical = canonicalChatwootEvent(values.request, values.conversation, values.messages, cfg);
  assert.equal(inspect(canonical).reason, 'sender_not_authorized');
  values.target.sender.phone_number = '+5511987654321'; values.conversation.meta.sender.phone_number = '+5511987654321'; values.conversation.contact_inbox.source_id = '5511987654321';
  values.target.attachments = [{ id: 812, extension: 'pdf', data_url: 'https://support.example.invalid/api-version.pdf' }];
  const actual = inspect(canonicalChatwootEvent(values.request, values.conversation, values.messages, cfg));
  assert.equal(actual.origins[0].source.attachment_id, 'chatwoot-attachment:812');
  assert.equal(actual.origins[0].attachment.name, 'api-version.pdf');
});

test('the complete pure module embeds in the n8n Code VM without URL global, url builtin or structuredClone', async () => {
  const source = (await fs.readFile(new URL('./whatsapp-intake-runtime.mjs', import.meta.url), 'utf8')).replace(/^import crypto[^\n]+\n/, '').replace(/^export /gm, '');
  assert.equal(new vm.Script('typeof URL').runInNewContext({ crypto, Buffer }), 'undefined');
  const api = vm.runInNewContext(source + '\n;({inspectChatwootWebhook,canonicalChatwootEvent,inspectChatwootMessage,decodeChatwootOriginal})', { crypto, Buffer });
  const values = canonicalInputs();
  const request = api.inspectChatwootWebhook(message(), cfg).request;
  const event = api.canonicalChatwootEvent(request, values.conversation, values.messages, cfg);
  const origin = api.inspectChatwootMessage(event, cfg).origins[0];
  const decoded = api.decodeChatwootOriginal(bytes, response, decideReservation(origin, { document_id: docId, document: { id: docId, file_status: 'pending' } }), cfg);
  assert.equal(decoded.json.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
});

test('strict HTTPS parser normalizes public DNS and default port without losing encoded PDF filenames or signed query', () => {
  const payload = message(); payload.attachments[0].data_url = 'https://FILES.EXAMPLE.INVALID:443/private/Exame%20Fict%C3%ADcio.pdf?signature=fixture%2Bonly';
  const origin = inspect(payload, { ...cfg, chatwootBaseUrl: 'HTTPS://SUPPORT.EXAMPLE.INVALID:443', allowedAttachmentOrigins: ['https://FILES.EXAMPLE.INVALID:443/'] }).origins[0];
  assert.equal(origin.missing, false); assert.equal(origin.attachment.name, 'Exame Fictício.pdf');
  assert.equal(origin.attachment.downloadUrl, 'https://files.example.invalid/private/Exame%20Fict%C3%ADcio.pdf?signature=fixture%2Bonly');
  assert.equal(origin.source.metadata.attachment_url_sha256, crypto.createHash('sha256').update(origin.attachment.downloadUrl).digest('hex'));
});

test('strict HTTPS parser rejects encoded hosts, bad ports, userinfo, backslashes, fragments, malformed percents and private/IP hosts', () => {
  const invalid = [
    'https://%66iles.example.invalid/original.pdf', 'https://files.example.invalid%2fevil.invalid/original.pdf', 'https://files.example.invalid:0443/original.pdf',
    'https://files.example.invalid:80/original.pdf', 'https://files.example.invalid:443:443/original.pdf', 'https://user@files.example.invalid/original.pdf',
    'https://files.example.invalid\\@evil.invalid/original.pdf', 'https://files.example.invalid/path%5Coriginal.pdf', 'https://files.example.invalid/original.pdf#fragment',
    'https://files.example.invalid/original%GG.pdf', 'https://files.example.invalid/original%.pdf', 'https://files.example.invalid/original%0d%0a.pdf',
    'https://files.example.invalid./original.pdf', 'https://-files.example.invalid/original.pdf', 'https://files..example.invalid/original.pdf',
    'https://127.0.0.1/original.pdf', 'https://127.1/original.pdf', 'https://0x7f.1/original.pdf', 'https://[::1]/original.pdf', 'https://localhost/original.pdf',
    'https://media.local/original.pdf', 'https://media.internal/original.pdf', 'https://média.example.invalid/original.pdf',
  ];
  for (const url of invalid) {
    const payload = message(); payload.attachments[0].extension = 'pdf'; payload.attachments[0].data_url = url;
    const origin = inspect(payload).origins[0]; assert.equal(origin.missing, true, url); assert.equal(origin.attachment.downloadUrl, null, url);
  }
});

test('redirect resolver accepts only allowlisted absolute HTTPS or origin-rooted paths', () => {
  const origins = new Set(['https://support.example.invalid', 'https://files.example.invalid']);
  const current = 'https://support.example.invalid/rails/private/original.pdf';
  assert.equal(resolveChatwootRedirect('/storage/Exame%20Ficticio.pdf?sig=fixture', current, origins), 'https://support.example.invalid/storage/Exame%20Ficticio.pdf?sig=fixture');
  assert.equal(resolveChatwootRedirect('HTTPS://FILES.EXAMPLE.INVALID:443/original.pdf', current, origins), 'https://files.example.invalid/original.pdf');
  for (const location of ['//files.example.invalid/original.pdf', 'next.pdf', '../next.pdf', '?signature=next', '#fragment', '/next.pdf#fragment', '/bad%GG.pdf',
    '/\\evil.invalid/file.pdf', 'http://files.example.invalid/original.pdf', 'https://files.example.invalid:444/original.pdf', 'https://user@files.example.invalid/original.pdf',
    'https://files.example.invalid%2fevil.invalid/file.pdf', 'https://127.0.0.1/original.pdf']) {
    assert.throws(() => resolveChatwootRedirect(location, current, origins), /redirect_not_allowed/, location);
  }
});

test('Brazilian phone normalization requires a genuine number and never guesses a mobile alias', () => {
  for (const value of ['11987654321', '(11) 98765-4321', '+55 (11) 98765-4321', '5511987654321']) assert.equal(normalizeBrazilPhone(value), '5511987654321');
  assert.equal(normalizeBrazilPhone('1187654321'), '551187654321');
  for (const value of [null, 5511987654321, '9911987654321', '5511876543210', 'tel:+5511987654321', '+5511987654321@g.us', 'abc11987654321', '0000000000']) assert.equal(normalizeBrazilPhone(value), null);
});

test('only an explicit legacy alias allows the same historic eight-digit mobile', () => {
  const payload = message(); payload.sender.phone_number = '+551187654321'; payload.conversation.contact_inbox.source_id = '551187654321'; payload.conversation.meta.sender.phone_number = '+551187654321';
  assert.equal(inspect(payload).reason, 'sender_not_authorized');
  assert.equal(inspect(payload, { ...cfg, allowBrazilLegacyMobileAlias: true }).origins[0].source.metadata.sender_phone, '5511987654321');
  payload.sender.phone_number = '+551187654322';
  assert.equal(inspect(payload, { ...cfg, allowBrazilLegacyMobileAlias: true }).reason, 'sender_not_authorized');
});

test('authorized individual PDF metadata maps to the shared stable origin without persisted signed URLs', () => {
  const result = inspect(); assert.equal(result.excluded, false); assert.equal(result.origins.length, 1);
  const origin = result.origins[0];
  assert.equal(origin.source.channel, 'whatsapp'); assert.equal(origin.source.account_id, 'chatwoot:41:inbox:73');
  assert.equal(origin.source.message_id, '910'); assert.equal(origin.source.attachment_id, 'chatwoot-attachment:811');
  assert.equal(origin.source.original_name, 'original.pdf'); assert.equal(origin.source.metadata.exam_candidate, true);
  assert.equal(origin.source.metadata.sender_allowlisted, true); assert.equal(origin.source.metadata.unknown_sender, false);
  assert.equal(origin.missing, false); assert.equal(origin.attachment.downloadUrl, message().attachments[0].data_url);
  assert(!JSON.stringify(origin.source).includes('https://')); assert(!JSON.stringify(origin.source).includes('signature=fixture-only'));
  assert.equal(origin.source.metadata.attachment_url_sha256, crypto.createHash('sha256').update(origin.attachment.downloadUrl).digest('hex'));
});

test('redelivery keeps the message/attachment origin and multiple PDFs have separate stable identities', () => {
  const payload = message(); payload.attachments.push({ ...payload.attachments[0], id: 812, data_url: 'https://support.example.invalid/files/second.pdf' });
  payload.attachments.push({ id: 813, file_type: 'image', data_url: 'https://files.example.invalid/photo.jpg' });
  const first = inspect(payload), again = inspect(structuredClone(payload));
  assert.deepEqual(first, again); assert.equal(first.origins.length, 2);
  assert.notEqual(first.origins[0].source.attachment_id, first.origins[1].source.attachment_id);
  const changed = structuredClone(payload); changed.id = 911; changed.attachments.forEach(item => { if (item.message_id != null) item.message_id = 911; });
  assert.notEqual(inspect(changed).origins[0].source.message_id, first.origins[0].source.message_id);
  const once = decideReservation(first.origins[0], { document_id: docId, document: { id: docId, file_status: 'saved' } });
  assert.equal(once.skip, true); assert.throws(() => decodeChatwootOriginal(bytes, response, once, cfg), /not_reserved/);
});

test('outgoing, notes, other inboxes/accounts, unauthorized senders and quoted authorization do not enter intake', () => {
  for (const mutate of [p => { p.event = 'message_updated'; }, p => { p.message_type = 'outgoing'; }, p => { p.message_type = 1; }, p => { p.private = true; }, p => { delete p.private; },
    p => { p.account.id = 42; }, p => { p.inbox.id = 74; }, p => { p.sender.phone_number = '+5511987654322'; p.content = 'Encaminhado por +5511987654321'; }, p => { delete p.sender.phone_number; }, p => { p.sender.type = 'user'; }]) {
    const payload = message(); mutate(payload); assert.equal(inspect(payload).excluded, true);
  }
});

test('group and broadcast participants never masquerade as the authorized individual', () => {
  for (const mutate of [p => { p.conversation.contact_inbox.source_id = '123456789@g.us'; }, p => { p.conversation.contact_inbox.source_id = 'status@broadcast'; },
    p => { p.conversation.additional_attributes = { is_group: true }; }, p => { p.sender.identifier = '123@g.us'; }, p => { delete p.conversation.contact_inbox; },
    p => { p.conversation.contact_inbox.source_id = '5511987654322'; }]) {
    const payload = message(); mutate(payload); assert.equal(inspect(payload).excluded, true);
  }
});

test('internal exam mirrors and any account/message identity conflict are rejected', () => {
  for (const mutate of [p => { p.content_attributes = { pamvet_exam_document_id: docId }; }, p => { p.content = '[EXAM:' + docId + ':DELIVERY:' + docId + ']'; }]) {
    const payload = message(); mutate(payload); assert.equal(inspect(payload).reason, 'internal_exam_message');
  }
  for (const mutate of [p => { p.id = 0; }, p => { p.conversation.inbox_id = 74; }, p => { p.conversation.account_id = 42; }, p => { p.conversation.meta.sender.id = 201; },
    p => { p.conversation.meta.sender.phone_number = '+5511987654322'; }, p => { p.attachments[0].account_id = 42; }, p => { p.attachments[0].message_id = 911; },
    p => { p.attachments.push(structuredClone(p.attachments[0])); }, p => { delete p.attachments[0].id; }]) {
    const payload = message(); mutate(payload); assert.throws(() => inspect(payload), /whatsapp_/);
  }
});

test('unsafe/missing URLs and unusable PDF metadata remain visible as pending origins without a GET', () => {
  for (const url of [null, 'http://files.example.invalid/x.pdf', 'https://files.example.invalid.evil.invalid/x.pdf', 'https://user:pass@files.example.invalid/x.pdf',
    'https://127.0.0.1/x.pdf', 'https://[::1]/x.pdf', 'https://files.example.invalid/x.pdf#frag', 'https://files.example.invalid:8443/x.pdf', 'data:application/pdf;base64,abcd']) {
    const payload = message(); payload.attachments[0].extension = 'pdf'; payload.attachments[0].data_url = url;
    const origin = inspect(payload).origins[0]; assert.equal(origin.missing, true); assert.equal(origin.attachment.downloadUrl, null); assert.equal(origin.pendingReason, 'pdf_url_missing_or_untrusted');
  }
  for (const size of [0, -1, 20 * 1024 * 1024 + 1, 'not-a-size', true]) {
    const payload = message(); payload.attachments[0].file_size = size;
    const origin = inspect(payload).origins[0]; assert.equal(origin.missing, true); assert.equal(origin.pendingReason, 'pdf_size_invalid_or_exceeds_limit');
  }
  const mismatch = message(); mismatch.attachments[0].content_type = 'image/png'; assert.equal(inspect(mismatch).origins[0].pendingReason, 'pdf_metadata_mismatch');
});

test('files without a PDF hint, old messages and empty payloads are excluded; invalid configuration fails closed', () => {
  const noPdf = message(); noPdf.attachments = [{ id: 811, data_url: 'https://files.example.invalid/image.jpg' }]; assert.equal(inspect(noPdf).reason, 'no_pdf');
  const old = message(); old.created_at = '2026-10-17T12:30:00Z'; assert.equal(inspect(old).reason, 'before_intake_cutoff');
  const empty = message(); delete empty.attachments; assert.equal(inspect(empty).reason, 'no_pdf');
  for (const config of [{ ...cfg, authorizedSenders: [] }, { ...cfg, authorizedSenders: ['bad'] }, { ...cfg, maxBytes: 0 }, { ...cfg, chatwootBaseUrl: 'https://localhost' },
    { ...cfg, allowedAttachmentOrigins: ['https://files.example.invalid/private'] }, { ...cfg, intakeCutoff: 'today' }, { ...cfg, allowBrazilLegacyMobileAlias: 'true' }]) assert.throws(() => inspect(message(), config), /whatsapp_/);
});

test('numeric provider timestamps and absent size are supported without using reception time as exam date', () => {
  const payload = message(); payload.created_at = 1792326600; delete payload.attachments[0].file_size;
  const result = inspect(payload).origins[0]; assert.equal(result.source.received_at, new Date(payload.created_at * 1000).toISOString());
  assert.equal(result.source.exam_date, undefined); assert.equal(result.source.metadata.exam_date, undefined);
  const decoded = decodeChatwootOriginal(bytes, response, decideReservation(result, { document_id: docId, document: { id: docId } }), cfg);
  assert.equal(decoded.json.sizeBytes, bytes.length);
});

test('original PDF bytes require reservation, bound URL, 200, allowed MIME, signature, configured limit and stated size', () => {
  const decoded = decodeChatwootOriginal(bytes, response, reserved(), cfg);
  assert.equal(decoded.bytes, bytes); assert.equal(decoded.json.folderId, cfg.driveFolderId);
  assert.equal(decoded.json.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(decodeChatwootOriginal(bytes, { statusCode: 200, headers: { 'Content-Type': 'application/octet-stream' } }, reserved(), cfg).json.sha256, decoded.json.sha256);
  assert.throws(() => decodeChatwootOriginal(bytes, response, inspect().origins[0], cfg), /not_reserved/);
  const unproven = reserved(); delete unproven.reservation; assert.throws(() => decodeChatwootOriginal(bytes, response, unproven, cfg), /not_reserved/);
  const swapped = reserved(); swapped.attachment.downloadUrl = 'https://files.example.invalid/other.pdf'; assert.throws(() => decodeChatwootOriginal(bytes, response, swapped, cfg), /url_mismatch/);
  for (const statusCode of [201, 301, 302, 403, 500]) assert.throws(() => decodeChatwootOriginal(bytes, { ...response, statusCode }, reserved(), cfg), /http_response/);
  for (const type of ['text/html', 'application/zip']) assert.throws(() => decodeChatwootOriginal(bytes, { statusCode: 200, headers: { 'content-type': type } }, reserved(), cfg), /mime/);
  const wrongBytes = Buffer.from('html'.padEnd(bytes.length, ' ')); assert.throws(() => decodeChatwootOriginal(wrongBytes, response, reserved(), cfg), /signature/);
  assert.throws(() => decodeChatwootOriginal(Buffer.concat([bytes, Buffer.from('x')]), response, reserved(), cfg), /size_mismatch/);
  assert.throws(() => decodeChatwootOriginal(bytes, response, reserved(), { ...cfg, maxBytes: bytes.length - 1 }), /size_invalid/);
});

function sweepForConversation(conversation = message().conversation) {
  let state = advanceChatwootConversationPage(startChatwootSweep(cfg), { data: { payload: [conversation] } }, cfg);
  state = advanceChatwootConversationPage(state, { data: { payload: [] } }, cfg);
  return startChatwootMessagePages(state, conversation, cfg);
}

test('scheduled sweep recovers four unnamed PDFs across message pages with the same identities as webhooks', () => {
  const fixture = canonicalInputs(), second = structuredClone(fixture.target);
  fixture.target.attachments = [811, 812].map(attachmentId => ({ ...fixture.target.attachments[0], id: attachmentId, file_name: 'Sem nome.pdf' }));
  second.id = 900; second.attachments = [813, 814].map(attachmentId => ({ ...fixture.target.attachments[0], id: attachmentId, message_id: 900, file_name: 'Sem nome.pdf' }));
  let state = sweepForConversation();
  state = advanceChatwootMessagePage(state, { payload: [fixture.target] }, cfg);
  assert.equal(state.beforeMessageId, '910'); assert.equal(state.sweepComplete, false);
  state = advanceChatwootMessagePage(state, { payload: [second] }, cfg);
  assert.equal(state.beforeMessageId, '900');
  state = advanceChatwootMessagePage(state, { payload: [] }, cfg);
  assert.equal(state.sweepComplete, true); assert.equal(state.conversationsChecked, 1); assert.equal(state.messagesChecked, 2);
  assert.equal(state.origins.length, 4);
  assert.equal(new Set(state.origins.map(origin => origin.source.attachment_id)).size, 4);
  const webhook = canonicalChatwootEvent(fixture.request, fixture.conversation, { payload: [fixture.target] }, cfg);
  assert.deepEqual(state.origins.slice(0, 2), inspectChatwootMessage(webhook, cfg).origins);
  const repeated = advanceChatwootMessagePage(sweepForConversation(), { payload: [fixture.target] }, cfg);
  assert.deepEqual(repeated.origins, state.origins.slice(0, 2));
});

test('sweep excludes groups, unauthorized contacts, notes, outgoing messages and PDFs before the configured cutoff', () => {
  const unauthorized = structuredClone(message().conversation); unauthorized.id = 301; unauthorized.meta.sender.phone_number = '+5511987654322';
  const group = structuredClone(message().conversation); group.id = 302; group.contact_inbox.source_id = '123@g.us';
  let state = advanceChatwootConversationPage(startChatwootSweep(cfg), { data: { payload: [unauthorized, group, message().conversation] } }, cfg);
  assert.deepEqual(state.conversations, ['300']);
  state = advanceChatwootConversationPage(state, { data: { payload: [] } }, cfg);
  state = startChatwootMessagePages(state, message().conversation, cfg);
  const original = canonicalInputs().target;
  const variants = [{ ...original, id: 909, private: true }, { ...original, id: 908, message_type: 1 },
    { ...original, id: 907, created_at: '2026-10-17T23:59:59Z' }];
  state = advanceChatwootMessagePage(state, { payload: variants }, cfg);
  assert.equal(state.origins.length, 0); assert.equal(state.messagesChecked, 3);
  assert.throws(() => startChatwootSweep({ ...cfg, intakeCutoff: undefined }), /cutoff_required/);
});

test('sweep rejects incomplete, repeated, oversized and cross-inbox pages instead of claiming success', () => {
  const first = startChatwootSweep(cfg), conversation = message().conversation;
  const page = advanceChatwootConversationPage(first, { data: { payload: [conversation] } }, cfg);
  assert.equal(page.conversationPagesComplete, false);
  assert.throws(() => advanceChatwootConversationPage(page, { data: { payload: [conversation] } }, cfg), /pagination_cycle/);
  assert.throws(() => advanceChatwootConversationPage(first, { payload: [] }, cfg), /payload_invalid/);
  assert.throws(() => advanceChatwootConversationPage(first, { data: { payload: [{ ...conversation, inbox_id: 74 }] } }, cfg), /inbox_mismatch/);
  assert.throws(() => advanceChatwootConversationPage({ ...first, conversationPage: 100 }, { data: { payload: [conversation] } }, cfg), /page_limit/);
  const started = sweepForConversation(); const target = canonicalInputs().target;
  const next = advanceChatwootMessagePage(started, { payload: [target] }, cfg);
  assert.throws(() => advanceChatwootMessagePage(next, { payload: [target] }, cfg), /pagination_cycle/);
  assert.throws(() => advanceChatwootMessagePage(started, { payload: [{ ...target, conversation_id: 301 }] }, cfg), /scope_mismatch/);
  assert.throws(() => advanceChatwootMessagePage(started, { payload: Array(101).fill(target) }, cfg), /payload_invalid/);
  assert.throws(() => advanceChatwootMessagePage({ ...started, messagePage: 100 }, { payload: [target] }, cfg), /page_limit/);
  assert.throws(() => startChatwootMessagePages({ ...page, conversationPagesComplete: true }, { ...conversation, meta: { sender: { ...conversation.meta.sender, phone_number: '+5511987654322' } } }, cfg), /conversation_changed/);
});

test('a fully enumerated empty inbox completes without producing an origin', () => {
  const state = advanceChatwootConversationPage(startChatwootSweep(cfg), { data: { payload: [] } }, cfg);
  assert.equal(state.sweepComplete, true); assert.deepEqual(state.origins, []);
});

test('provider pages with 21 messages preserve every PDF and continue by the oldest ID without truncation', () => {
  const fixture = canonicalInputs();
  const messages = Array.from({ length: 21 }, (_, index) => ({ ...structuredClone(fixture.target), id: 910 - index,
    attachments: [{ ...fixture.target.attachments[0], id: 811 + index, message_id: 910 - index }] }));
  const state = advanceChatwootMessagePage(sweepForConversation(), { payload: messages }, cfg);
  assert.equal(state.origins.length, 21);
  assert.equal(state.messagesChecked, 21);
  assert.equal(state.beforeMessageId, '890');
  assert.equal(state.sweepComplete, false);
  assert.equal(new Set(state.origins.map(origin => origin.source.attachment_id)).size, 21);
  assert.equal(advanceChatwootMessagePage(state, { payload: [] }, cfg).sweepComplete, true);
  assert.equal(canonicalChatwootEvent(fixture.request, fixture.conversation, { payload: messages }, cfg).id, '910');
  assert.throws(() => canonicalChatwootEvent(fixture.request, fixture.conversation, { payload: Array(101).fill(fixture.target) }, cfg), /payload_invalid/);
});

test('a conversation with thousands of older messages stops at its proven temporal cutoff', () => {
  const target = canonicalInputs().target;
  let state = advanceChatwootMessagePage(sweepForConversation(), { payload: [target] }, cfg);
  const older = Array.from({ length: 20 }, (_, index) => ({ ...target, id: 800 + index, created_at: '2026-10-17T12:00:00Z' }));
  state = advanceChatwootMessagePage(state, { payload: older }, cfg);
  assert.equal(state.sweepComplete, true); assert.equal(state.conversationsChecked, 1);
  assert.equal(state.messagesChecked, 21); assert.equal(state.origins.length, 1);
  const reversedDates = [{ ...target, id: 800, created_at: '2026-10-18T12:00:00Z' }, { ...target, id: 801, created_at: '2026-10-17T12:00:00Z' }];
  assert.throws(() => advanceChatwootMessagePage(sweepForConversation(), { payload: reversedDates }, cfg), /time_order_unproven/);
  assert.throws(() => advanceChatwootMessagePage(advanceChatwootMessagePage(sweepForConversation(), { payload: [target] }, cfg),
    { payload: [{ ...target, id: 800, created_at: '2026-10-19T00:00:00Z' }] }, cfg), /time_order_unproven/);
});

test('receipt summary checks every expected attachment and never closes a four-PDF sweep with only three receipts', () => {
  const origins = inspect().origins;
  const fourOrigins = Array.from({ length: 4 }, (_, index) => ({ ...structuredClone(origins[0]),
    source: { ...origins[0].source, attachment_id: 'chatwoot-attachment:' + (811 + index) } }));
  const receipts = fourOrigins.map(origin => ({ intakeReceipt: true, kind: 'attachment', message_id: origin.source.message_id,
    attachment_id: origin.source.attachment_id, disposition: 'saved' }));
  const partial = summarizeChatwootIntake(receipts.slice(0, 3), fourOrigins);
  assert.equal(partial.scanFinished, false); assert.equal(partial.counts.failed, 1); assert.equal(partial.counts.checked, 3);
  assert.equal(partial.issues[0].reason, 'attachment_receipt_missing');
  assert.equal(summarizeChatwootIntake(receipts, fourOrigins).scanFinished, true);
  assert.equal(summarizeChatwootIntake([...receipts, receipts[0]], fourOrigins).scanFinished, false);
  assert.equal(summarizeChatwootIntake([{ ...receipts[0], disposition: 'pending' }, ...receipts.slice(1)], fourOrigins).scanFinished, false);
});
