import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { webcrypto, createHash } from 'node:crypto';
import vm from 'node:vm';
import { examPresentation as sharedPresentation } from '../../scripts/exames/notification-presentation.mjs';
import { examPresentation as edgePresentation } from '../functions/exam-whatsapp-fallback/exam-presentation.generated.mjs';
import { generatedExamPresentationSource } from '../functions/exam-whatsapp-fallback/generate-exam-presentation.mjs';

const ts = createRequire(import.meta.url)('typescript');
const source = await readFile(new URL('../functions/exam-whatsapp-fallback/chatwoot.ts', import.meta.url), 'utf8');
const api = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
  exports: api, URL, Response, Request, Headers, FormData, Blob, TextEncoder, TextDecoder, Uint8Array,
  crypto: webcrypto, btoa, AbortController, setTimeout, clearTimeout, fetch() { throw new Error('Unexpected real fetch'); },
  require(specifier) {
    assert.equal(specifier, './exam-presentation.generated.mjs');
    return { examPresentation: edgePresentation };
  },
});
const base = 'https://chatwoot.example.com';
const cfg = { baseUrl: base, apiAccessToken: 'test-private-token', accountId: 1, inboxId: 2,
  groupConversationId: 23, groupJid: '120000000000000@g.us', documentBaseUrl: 'https://pam.example.com',
  allowedAttachmentOrigins: ['https://media.example.com'], timeoutMs: 1000 };
const bytes = new TextEncoder().encode('%PDF-1.4\nSynthetic fallback fixture\n%%EOF');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const pdf = { bytes, sizeBytes: bytes.length, sha256 };
const task = { documentId: '11111111-1111-4111-a111-111111111111', deliveryId: '22222222-2222-4222-a222-222222222222',
  leaseToken: '33333333-3333-4333-a333-333333333333', sha256, sizeBytes: bytes.length,
  originalName: 'Laudo ECO Teste.pdf', receivedAt: '2026-11-03T12:30:00.000Z', createdAt: '2026-11-03T12:31:00.000Z',
  status: 'reserved', configuredDestination: 'chatwoot:1:2:23:120000000000000@g.us',
  link: 'https://pam.example.com/e/' + Buffer.from('1111111111114111a1111111111111111', 'hex').toString('base64url') };
const attrs = { pamvet_exam_document_id: task.documentId, pamvet_exam_delivery_id: task.deliveryId, pamvet_exam_sha256: sha256 };
const group = { id: 23, inbox_id: 2, account_id: 1, meta: { sender: { identifier: cfg.groupJid } } };
const message = { id: 100, account_id: 1, inbox_id: 2, conversation_id: 23, private: false, message_type: 'outgoing',
  content_attributes: attrs, attachments: [{ id: 80, file_type: 'file', extension: 'pdf', file_size: bytes.length }],
  created_at: Date.parse(task.createdAt) / 1000, status: 'delivered' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const grant = { beginDispatch: async () => ({ dispatch_allowed: true }) };
function client(fetcher, overrides = {}) { return api.createChatwootClient({ ...cfg, ...overrides }, { fetch: fetcher }); }

test('source getters bind account/inbox/conversation and reject nonadvancing cursors', async () => {
  const requests = [];
  const c = client(async (url, init) => {
    requests.push([url, init]);
    return url.includes('/messages') ? json({ payload: [{ id: 44, conversation_id: 3, inbox_id: 2, account_id: 1 }] })
      : json({ id: 3, inbox_id: 2, account_id: 1 });
  });
  assert.equal((await c.getConversation(3)).id, 3);
  assert.equal((await c.listMessages(3, 45))[0].id, 44);
  assert.equal(requests[1][0], base + '/api/v1/accounts/1/conversations/3/messages?before=45');
  assert.equal(requests[0][1].headers.api_access_token, cfg.apiAccessToken);
  assert.equal(requests[0][1].redirect, 'manual');
  await assert.rejects(c.listMessages(3, 44), /message_cursor_not_advancing/);
  await assert.rejects(client(async () => json({ id: 3, inbox_id: 99 })).getConversation(3), /conversation_scope_mismatch/);
  await assert.rejects(client(async () => json({ payload: [{ id: 2, account_id: 9 }] })).listMessages(3), /provider_scope_mismatch/);
});

test('activation preflight proves source and group message read access without any dispatch', async () => {
  const requests = [];
  const c = client(async (url, init) => {
    requests.push(url);
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.api_access_token, cfg.apiAccessToken);
    if (url.endsWith('/messages')) return json({ payload: [] });
    return json(url.endsWith('/23') ? group : { id: 3, account_id: 1, inbox_id: 2 });
  });
  const result = await c.preflightReadAccess(3);
  assert.equal(result.sourceConversation.id, 3);
  assert.equal(result.groupConversation.id, 23);
  assert.deepEqual(requests, [
    base + '/api/v1/accounts/1/conversations/3',
    base + '/api/v1/accounts/1/conversations/23',
    base + '/api/v1/accounts/1/conversations/3/messages',
    base + '/api/v1/accounts/1/conversations/23/messages',
  ]);
});

test('provider reads distinguish temporary unavailability from authorization and permanent response failures', async () => {
  for (const status of [408, 429, 500, 503]) {
    const c = client(async () => new Response(null, { status }));
    await assert.rejects(c.getConversation(3), /source_request_failed/);
    await assert.rejects(c.listMessages(3), /source_request_failed/);
  }
  for (const status of [401, 403, 404]) {
    const c = client(async () => new Response(null, { status }));
    await assert.rejects(c.getConversation(3), /conversation_unavailable/);
    await assert.rejects(c.listMessages(3), /messages_unavailable/);
  }
});

test('preflight rejects bot-style partial permission, wrong group JID, and message scope mismatch', async () => {
  for (const deniedConversation of ['3', '23']) {
    const c = client(async (url, init) => {
      assert.equal(init.method, 'GET');
      if (url.endsWith('/' + deniedConversation + '/messages')) return json({ error: 'not authorized for bots' }, 401);
      if (url.endsWith('/messages')) return json({ payload: [] });
      return json(url.endsWith('/23') ? group : { id: 3, account_id: 1, inbox_id: 2 });
    });
    await assert.rejects(c.preflightReadAccess(3), /messages_unavailable/);
  }
  let messageReads = 0;
  const wrongGroup = client(async (url, init) => {
    assert.equal(init.method, 'GET');
    if (url.endsWith('/messages')) messageReads++;
    return json(url.endsWith('/23') ? { ...group, meta: { sender: { identifier: '999999999@g.us' } } }
      : { id: 3, account_id: 1, inbox_id: 2 });
  });
  await assert.rejects(wrongGroup.preflightReadAccess(3), /group_destination_mismatch/);
  assert.equal(messageReads, 0);
  const wrongScope = client(async url => url.endsWith('/messages')
    ? json({ payload: [{ id: 44, conversation_id: 99, account_id: 1, inbox_id: 2 }] })
    : json(url.endsWith('/23') ? group : { id: 3, account_id: 1, inbox_id: 2 }));
  await assert.rejects(wrongScope.preflightReadAccess(3), /provider_scope_mismatch/);
});

test('media download follows only exact allowed origins, without API credentials, and proves bytes', async () => {
  const requests = [];
  const c = client(async (url, init) => {
    requests.push([url, init]);
    if (url === base + '/source.pdf') return new Response(null, { status: 302, headers: { location: 'https://media.example.com/private/file.pdf' } });
    return new Response(bytes, { headers: { 'content-type': 'application/pdf', 'content-length': String(bytes.length) } });
  });
  const result = await c.downloadPdf(base + '/source.pdf', { sizeBytes: bytes.length, sha256 });
  assert.equal(result.sha256, sha256); assert.equal(result.sizeBytes, bytes.length);
  assert.deepEqual(Array.from(result.bytes), Array.from(bytes));
  assert.equal(requests.length, 2);
  for (const [, init] of requests) {
    assert.equal(init.headers.api_access_token, undefined);
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'manual');
  }
});

test('SSRF and untrusted redirects stop before a second fetch; no credential is redirected', async () => {
  for (const location of ['http://media.example.com/x', 'https://127.0.0.1/x', 'https://media.example.com.evil.org/x',
    'https://user:secret@media.example.com/x', '//media.example.com/x', 'https://media.example.com/%0dattack',
    'https://metadata.internal/x', '/\\evil.org/x']) {
    let calls = 0;
    const c = client(async () => { calls++; return new Response(null, { status: 302, headers: { location } }); });
    await assert.rejects(c.downloadPdf(base + '/source.pdf'), /not_allowed/);
    assert.equal(calls, 1, location);
  }
  for (const baseUrl of ['http://chatwoot.example.com', 'https://127.0.0.1', 'https://localhost', 'https://host.internal',
    'https://chatwoot.example.com/path', 'https://user:secret@chatwoot.example.com']) {
    assert.throws(() => client(async () => json({}), { baseUrl }), /not_allowed/);
  }
});

test('oversize PDF stops by header or while streaming, including chunked responses', async () => {
  let pulls = 0, cancelled = false;
  const streaming = new ReadableStream({ pull(controller) {
    pulls++; controller.enqueue(new Uint8Array(10));
  }, cancel() { cancelled = true; } });
  await assert.rejects(client(async () => new Response(streaming, { headers: { 'content-type': 'application/pdf' } }),
    { maxBytes: 15 }).downloadPdf(base + '/large.pdf'), /response_size_exceeded/);
  assert.equal(cancelled, true); assert(pulls <= 4);
  await assert.rejects(client(async () => new Response(bytes, { headers: { 'content-type': 'application/pdf', 'content-length': String(api.MAX_PDF_BYTES + 1) } }))
    .downloadPdf(base + '/large.pdf'), /response_size_exceeded/);
  assert.throws(() => client(async () => json({}), { maxBytes: api.MAX_PDF_BYTES + 1 }), /limits_invalid/);
});

test('PDF signature, MIME, expected size and hash must all agree', async () => {
  const c = client(async () => new Response(bytes, { headers: { 'content-type': 'application/pdf' } }));
  await assert.rejects(c.downloadPdf(base + '/x.pdf', { sha256: 'a'.repeat(64) }), /pdf_hash_mismatch/);
  await assert.rejects(c.downloadPdf(base + '/x.pdf', { sizeBytes: bytes.length + 1 }), /pdf_size_mismatch/);
  await assert.rejects(client(async () => new Response('not PDF', { headers: { 'content-type': 'application/pdf' } })).downloadPdf(base + '/x.pdf'), /pdf_bytes_invalid/);
  await assert.rejects(client(async () => new Response(bytes, { headers: { 'content-type': 'text/html' } })).downloadPdf(base + '/x.pdf'), /media_mime_invalid/);
});

test('single multipart POST follows durable grant, preserves bytes/correlation and stays submitted after HTTP success', async () => {
  let begun = false, posts = 0;
  const c = client(async (url, init) => {
    if (init.method === 'GET') return json(group);
    posts++; assert.equal(begun, true);
    assert.equal(url, base + '/api/v1/accounts/1/conversations/23/messages');
    const body = init.body;
    assert.equal(body.get('message_type'), 'outgoing'); assert.equal(body.get('private'), 'false');
    assert.deepEqual(JSON.parse(body.get('content_attributes')), attrs);
    const attachment = body.get('attachments[]');
    assert.equal(attachment.name, 'Exame.pdf'); assert.equal(attachment.type, 'application/pdf');
    assert.equal(createHash('sha256').update(new Uint8Array(await attachment.arrayBuffer())).digest('hex'), sha256);
    assert.match(body.get('content'), /🧪 \*Exame\*/u);
    assert(body.get('content').includes(task.link));
    assert.match(body.get('content'), /03\/11\/2026 às 09:30/);
    assert(!body.get('content').includes(task.deliveryId));
    return json({ id: 100, status: 'delivered', account_id: 1, inbox_id: 2, conversation_id: 23 });
  });
  const result = await c.sendGroupOnce(task, pdf, { beginDispatch: async input => {
    assert.equal(input.deliveryId, task.deliveryId); assert.equal(input.leaseToken, task.leaseToken);
    assert.match(input.contentSha256, /^[a-f\d]{64}$/); begun = true; return { dispatch_allowed: true };
  } });
  assert.equal(result.status, 'submitted'); assert.equal(result.external_id, '100'); assert.equal(posts, 1);
});

test('accepted POST with lost response stays uncertain, then GET-only readback recovers delivered without resending', async () => {
  let posts = 0, begins = 0;
  const c = client(async (url, init) => {
    if (init.method === 'POST') {
      posts++;
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('response lost')), { once: true }));
    }
    if (!url.includes('/messages')) return json(group);
    return json({ payload: url.includes('?before=') ? [] : [message] });
  }, { timeoutMs: 20 });
  const callback = { beginDispatch: async () => { begins++; return { dispatch_allowed: true }; } };
  assert.equal((await c.sendGroupOnce(task, pdf, callback)).status, 'uncertain');
  const recovered = await c.sendGroupOnce({ ...task, status: 'uncertain' }, pdf, callback);
  assert.equal(recovered.status, 'sent'); assert.equal(recovered.external_id, '100');
  assert.equal(posts, 1); assert.equal(begins, 1);
});

test('fence denial or unconfirmed fence sends nothing; corrupt preflight never consumes grant', async () => {
  let posts = 0, begins = 0;
  const c = client(async (_url, init) => { if (init.method === 'POST') posts++; return json(group); });
  await assert.rejects(c.sendGroupOnce(task, pdf, { beginDispatch: async () => ({ dispatch_allowed: false }) }), /dispatch_fence_denied/);
  await assert.rejects(c.sendGroupOnce(task, pdf, { beginDispatch: async () => { throw new Error('DB response lost'); } }), /DB response lost/);
  const badPdf = { ...pdf, bytes: new TextEncoder().encode('%PDF-1.4\nDifferent bytes') };
  const result = await c.sendGroupOnce(task, badPdf, { beginDispatch: async () => { begins++; return { dispatch_allowed: true }; } });
  assert.equal(result.status, 'failed'); assert.equal(result.external_status, 'preflight_failed');
  assert.equal(begins, 0); assert.equal(posts, 0);
});

test('every HTTP failure after the durable grant remains uncertain and never auto-retries', async () => {
  for (const status of [401, 403, 422, 408, 409, 429, 500]) {
    let posts = 0;
    const c = client(async (_url, init) => {
      if (init.method === 'GET') return json(group);
      posts++; return json({ error: 'private provider body not exposed' }, status);
    });
    const result = await c.sendGroupOnce(task, pdf, grant);
    assert.equal(result.status, 'uncertain', String(status)); assert.equal(posts, 1);
    if ([401, 403, 422].includes(status)) assert.equal(result.external_status, 'rejected');
    assert(!JSON.stringify(result).includes('private provider body'));
  }
});

function reconcileClient(rows, overrides = {}) {
  return client(async (url, init) => {
    assert.equal(init.method, 'GET');
    if (!url.includes('/messages')) return json(group);
    const before = new URL(url).searchParams.get('before');
    return json({ payload: before ? rows.filter(row => Number(row.id) < Number(before)) : rows });
  }, overrides);
}
test('readback collisions, absent proof or invalid attachment stay uncertain', async () => {
  assert.equal((await reconcileClient([message, { ...message, id: 101 }]).reconcileGroup(task)).external_status, 'reconciliation_multiple_matches');
  for (const row of [
    { ...message, content_attributes: { ...attrs, pamvet_exam_sha256: 'b'.repeat(64) } },
    { ...message, attachments: [] },
    { ...message, attachments: [{ id: 80, file_type: 'file', file_size: 1 }] },
    { ...message, attachments: [{ id: 80, file_type: 'image' }] },
    { ...message, private: true },
    { ...message, message_type: 'incoming' },
  ]) assert.equal((await reconcileClient([row]).reconcileGroup(task)).status, 'uncertain');
  assert.equal((await reconcileClient([]).reconcileGroup(task)).status, 'uncertain');
});

test('incomplete pagination cannot prove unique correlation; known external ID and strict attributes can confirm', async () => {
  const incomplete = await reconcileClient([message], { maxReconcilePages: 1 }).reconcileGroup(task);
  assert.equal(incomplete.status, 'uncertain'); assert.equal(incomplete.external_status, 'reconciliation_incomplete');
  const known = await reconcileClient([message], { maxReconcilePages: 1 }).reconcileGroup({ ...task, externalId: '100' });
  assert.equal(known.status, 'sent');
  const mismatch = await reconcileClient([{ ...message, content_attributes: {} }], { maxReconcilePages: 1 }).reconcileGroup({ ...task, externalId: '100' });
  assert.equal(mismatch.status, 'uncertain');
});

test('provider sent is submitted; delivered/read alone mean sent; failed requires reconciliation', async () => {
  for (const [status, expected] of [['sent', 'submitted'], ['created', 'submitted'], ['delivered', 'sent'], ['read', 'sent'], ['failed', 'uncertain']]) {
    const result = await reconcileClient([{ ...message, status }]).reconcileGroup(task);
    assert.equal(result.status, expected); assert.equal(result.external_status, status);
  }
});

test('known old receipt uses its exact ID cursor despite newer group traffic', async () => {
  const requests = [];
  const c = client(async (url, init) => {
    assert.equal(init.method, 'GET');
    requests.push(url);
    if (!url.includes('/messages')) return json(group);
    if (url.endsWith('/messages?before=101')) return json({ payload: [message] });
    return json({ payload: [{ ...message, id: 900, content_attributes: {} }] });
  }, { maxReconcilePages: 1 });
  const result = await c.reconcileGroup({ ...task, status: 'submitted', externalId: '100' });
  assert.equal(result.status, 'sent');
  assert.equal(result.external_id, '100');
  assert.deepEqual(requests, [base + '/api/v1/accounts/1/conversations/23', base + '/api/v1/accounts/1/conversations/23/messages?before=101']);
});

test('wrong destination, message scope, redirects and unsafe document links do not send', async () => {
  let posts = 0;
  const c = client(async (_url, init) => { if (init.method === 'POST') posts++; return json({ ...group, meta: { sender: { identifier: '999999999@g.us' } } }); });
  assert.equal((await c.sendGroupOnce(task, pdf, grant)).status, 'failed');
  assert.equal(posts, 0);
  assert.equal((await reconcileClient([{ ...message, conversation_id: 99 }]).reconcileGroup(task)).status, 'uncertain');
  await assert.rejects(client(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com' } })).getConversation(3), /conversation_unavailable/);
  assert.throws(() => api.prepareFallbackCaption({ ...task, link: 'https://pam.example.com/e/wrong' }, cfg.documentBaseUrl), /document_link_invalid/);
  const caption = api.prepareFallbackCaption({ ...task, originalName: '*Laudo* _Teste_\n@nome.pdf' }, cfg.documentBaseUrl);
  assert(!caption.content.includes('_Teste_')); assert(!caption.content.includes('Laudo'));
  assert(caption.content.startsWith('🧪 *Exame*'));
});

test('generated Edge presentation is current and has byte-for-byte parity with the shared n8n source', async () => {
  const generated = await readFile(new URL('../functions/exam-whatsapp-fallback/exam-presentation.generated.mjs', import.meta.url), 'utf8');
  assert.equal(generated, generatedExamPresentationSource());
  for (const document of [
    { id: task.documentId, received_at: task.receivedAt },
    { id: task.documentId, received_at: task.receivedAt, extracted_data: { pet_name: 'Luna', client_name: 'Ana Clara', exam_type: 'Hemograma', exam_date: '2026-11-03' } },
    { id: task.documentId, received_at: task.receivedAt, extracted_data: { pet_name: 'Luna', client_name: 'Ana Clara', exam_type: 'Hemograma', exam_date: '2026-11-03' }, confirmed_data: { pet_name: 'Luna revisada', client_name: null }, responsible_vet_id: 'vet-fixture', responsible_vet_name: 'Dra. Marina Costa Lima', responsible_vet_source: 'confirmed' },
    { id: '12345678-1234-4234-a234-123456789012', received_at: task.receivedAt, notification_fields: { pet_name: '*Luna*', client_name: 'Ana\nClara', exam_type: 'Hemograma / PCR', exam_date: '2026-02-31' } },
  ]) assert.deepEqual(edgePresentation(document, cfg.documentBaseUrl), sharedPresentation(document, cfg.documentBaseUrl));
});

test('fenced fallback fields match normal presentation, including human correction and explicit rejection', () => {
  const extracted = { pet_name: 'Luna', client_name: 'Ana Clara', exam_type: 'Hemograma', exam_date: '2026-11-03' };
  const confirmed = { pet_name: 'Luna revisada', client_name: null };
  const current = { ...task, link: undefined, presentationRevision: 'a'.repeat(32), extractedData: extracted, confirmedData: confirmed,
    responsibleVetId: 'vet-fixture', responsibleVetName: 'Dra. Marina Costa Lima', responsibleVetSource: 'confirmed' };
  const expected = sharedPresentation({ id: task.documentId, received_at: task.receivedAt, extracted_data: extracted, confirmed_data: confirmed,
    responsible_vet_id: current.responsibleVetId, responsible_vet_name: current.responsibleVetName, responsible_vet_source: current.responsibleVetSource }, cfg.documentBaseUrl);
  const result = api.prepareFallbackCaption(current, cfg.documentBaseUrl);
  assert.equal(result.content, expected.content);
  assert.equal(result.fileName, expected.fileName);
  assert(!result.content.includes('Ana Clara'));
  assert(result.content.includes('Luna revisada'));
  assert(result.content.includes('Marina Costa'));
  assert(result.content.includes(task.link));
  const supplied = api.prepareFallbackCaption({ ...current, notificationFields: { pet_name: null, client_name: null, exam_type: null, exam_date: null } }, cfg.documentBaseUrl);
  assert.equal(supplied.fileName, 'Exame.pdf');
  assert(!supplied.content.includes('Luna'));
});

test('unfenced fields cannot expose stale identity and raw requester never becomes assigned veterinarian', () => {
  const fields = { pet_name: 'Luna', client_name: 'Ana Clara', requesting_vet_name: 'Veterinário inferido' };
  const unfenced = api.prepareFallbackCaption({ ...task, extractedData: fields }, cfg.documentBaseUrl);
  assert(!unfenced.content.includes('Luna')); assert(!unfenced.content.includes('Ana Clara'));
  const fenced = api.prepareFallbackCaption({ ...task, extractedData: fields, presentationRevision: 'a'.repeat(32), responsibleVetName: 'Veterinário inferido' }, cfg.documentBaseUrl);
  assert(fenced.content.includes('Luna')); assert(!fenced.content.includes('Veterinário inferido'));
});

test('fenced content is hashed before one POST and presentation revision accompanies the grant', async () => {
  const identified = { ...task, presentationRevision: 'b'.repeat(32), notificationFields: { pet_name: 'Sol', client_name: 'Bruna Lima', exam_type: 'Hemograma', exam_date: '2026-11-03' } };
  let posted = 0, grantedHash;
  const c = client(async (_url, init) => {
    if (init.method === 'GET') return json(group);
    posted++;
    assert.equal(createHash('sha256').update(init.body.get('content')).digest('hex'), grantedHash);
    assert.deepEqual(JSON.parse(init.body.get('content_attributes')), attrs);
    assert.equal(init.body.get('attachments[]').name, 'Sol - Bruna Lima - Hemograma - 03-11-2026.pdf');
    return json({ id: 100, status: 'sent', account_id: 1, inbox_id: 2, conversation_id: 23 });
  });
  const result = await c.sendGroupOnce(identified, pdf, { beginDispatch: async input => {
    assert.equal(input.presentationRevision, identified.presentationRevision); grantedHash = input.contentSha256; return { dispatch_allowed: true };
  } });
  assert.equal(result.status, 'submitted'); assert.equal(posted, 1);
});

test('a rejected POST is reconciled without a second grant or second POST', async () => {
  let posts = 0, grants = 0;
  const c = client(async (url, init) => {
    if (init.method === 'POST') { posts++; return json({ error: 'rejected' }, 422); }
    return json(url.includes('/messages') ? { payload: [] } : group);
  });
  const callbacks = { beginDispatch: async () => { grants++; return { dispatch_allowed: true }; } };
  const first = await c.sendGroupOnce(task, pdf, callbacks);
  assert.equal(first.status, 'uncertain'); assert.equal(first.external_status, 'rejected');
  const second = await c.sendGroupOnce({ ...task, status: first.status }, pdf, callbacks);
  assert.equal(second.status, 'uncertain'); assert.equal(posts, 1); assert.equal(grants, 1);
});

test('caller cancellation bounds source requests and prevents any new request after abort', async () => {
  const controller = new AbortController();
  let calls = 0, abortedFetch = false;
  const c = client(async (_url, init) => {
    calls++;
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => {
      abortedFetch = true; reject(new Error('abort'));
    }, { once: true }));
  });
  const pending = c.getConversation(3, controller.signal);
  controller.abort();
  await assert.rejects(pending, /request_aborted/);
  assert.equal(abortedFetch, true);
  await assert.rejects(c.listMessages(3, undefined, controller.signal), /request_aborted/);
  await assert.rejects(c.downloadPdf(base + '/file.pdf', {}, controller.signal), /request_aborted/);
  assert.equal(calls, 1);
});

test('an external message ID prohibits POST even if a stale caller labels the task reserved', async () => {
  let begins = 0;
  const result = await reconcileClient([message]).sendGroupOnce({ ...task, externalId: '100' }, pdf, {
    beginDispatch: async () => { begins++; return { dispatch_allowed: true }; },
  });
  assert.equal(result.status, 'sent'); assert.equal(begins, 0);
});
