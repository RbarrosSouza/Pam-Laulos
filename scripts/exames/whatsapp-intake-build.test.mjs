import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { URL } from 'node:url';
import { buildWhatsappWorkflow, writeWhatsappWorkflow, WHATSAPP_CONFIG } from './whatsapp-intake-build.mjs';
import { inspectChatwootMessage } from './whatsapp-intake-runtime.mjs';
import { decideReservation } from './operacional-runtime.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
const bytes = Buffer.from('%PDF-1.4\nExame inteiramente fictício para teste local.\n%%EOF\n');
const digest = crypto.createHash('sha256').update(bytes).digest('hex');
const documentId = '11111111-1111-4111-a111-111111111111';
const canonicalId = '22222222-2222-4222-a222-222222222222';
const settings = { config: { enabled: true, accountId: 41, inboxId: 73, authorizedSenders: ['11987654321'],
  allowedAttachmentOrigins: ['https://files.example.invalid'], chatwootBaseUrl: 'https://support.example.invalid',
  serviceUrl: 'https://synthetic.example.invalid/functions/v1/exam-document-service', driveFolderId: 'synthetic-private-folder',
  intakeCutoff: '2026-10-18T00:00:00Z', webhookPath: 'synthetic-whatsapp-intake', worker: 'synthetic-worker' },
  credentials: { drive: { id: 'SYNTHETIC_EXISTING_DRIVE', name: 'Existing synthetic Drive' },
    worker: { id: 'SYNTHETIC_EXISTING_WORKER', name: 'Existing synthetic worker' },
    chatwoot: { id: 'SYNTHETIC_EXISTING_CHATWOOT', name: 'Existing synthetic Chatwoot' } } };
const cfg = { ...WHATSAPP_CONFIG, ...settings.config };
const template = await buildWhatsappWorkflow();
const workflow = await buildWhatsappWorkflow(settings);
const node = (name, selected = workflow) => {
  const value = selected.nodes.find(item => item.name === name);
  assert(value, 'missing node ' + name); return value;
};
const auditState = {};
function message() {
  return { event: 'message_created', id: 910, account: { id: 41 }, inbox: { id: 73 }, private: false, message_type: 'incoming',
    created_at: '2026-10-18T12:30:00Z', sender: { id: 200, type: 'contact', phone_number: '+5511987654321' },
    conversation: { id: 300, inbox_id: 73, contact_inbox: { source_id: '5511987654321' }, meta: { sender: { id: 200, type: 'contact', phone_number: '+5511987654321' } } },
    attachments: [{ id: 811, account_id: 41, message_id: 910, file_type: 'file', file_size: bytes.length,
      data_url: 'https://files.example.invalid/original.pdf?signature=synthetic' }] };
}
function canonicalMessage(payload = message()) {
  return { ...plain(payload), conversation_id: payload.conversation.id, inbox_id: payload.inbox.id, account_id: payload.account.id, message_type: 0 };
}
function expression(value, json, outputs = {}) {
  assert(value.startsWith('={{') && value.endsWith('}}'));
  return new vm.Script('(' + value.slice(3, -2).trim() + ')').runInNewContext({ $json: json, $: name => ({ first: () => outputs[name], item: outputs[name] }), encodeURIComponent, Math, Date });
}
async function code(name, input, outputs = {}, helpers = {}, selected = workflow, execution = {}) {
  const lookup = { Configuração: [{ json: cfg }], ...outputs };
  const inputs = Array.isArray(input) ? input : [input];
  input = inputs[0];
  // The real n8n Code sandbox has Buffer/Date but may omit the URL global.
  const sandbox = { Buffer, Date, require: name => {
    if (name === 'crypto') return crypto;
    assert.fail('Module is disallowed in Code node: ' + name);
  },
    $json: input.json, $input: { first: () => input, all: () => inputs }, $execution: { id: 'synthetic-execution', mode: 'production', ...execution },
    $getWorkflowStaticData: () => auditState,
    $: name => ({ first: () => lookup[name]?.[0], item: lookup[name]?.at(-1), all: () => lookup[name] || [] }),
    helpers: { getBinaryDataBuffer: async () => input.binary?.data?.bytes ?? bytes,
      prepareBinaryData: async (value, fileName, mimeType) => ({ bytes: Buffer.from(value), fileName, mimeType }), ...helpers } };
  return new vm.Script('(async function(){' + node(name, selected).parameters.jsCode + '}).call(this)').runInNewContext(sandbox);
}
function reserved() {
  return decideReservation(inspectChatwootMessage(message(), cfg).origins[0], { document_id: documentId, document: { id: documentId, file_status: 'pending' } });
}
function stage(id = documentId) {
  return { document_id: id, drive_file_id: 'persisted-drive-id', claimed: true, upload_required: true,
    delivery_id: '33333333-3333-4333-a333-333333333333', lease_token: '44444444-4444-4444-a444-444444444444',
    document: { id, sha256: digest, size_bytes: bytes.length, file_status: 'pending', drive_file_id: 'persisted-drive-id',
      drive_folder_id: cfg.driveFolderId, received_at: '2026-10-18T12:30:00Z', original_name: 'original.pdf' } };
}

test('neutral webhook template has a valid graph, parses every Code/expression and never stores execution payloads', async () => {
  assert.equal(template.active, false); assert.deepEqual(template.pinData, {});
  assert.equal(template.nodes.filter(item => item.type.endsWith('webhook')).length, 1);
  assert.equal(template.nodes.filter(item => item.type.endsWith('manualTrigger')).length, 1);
  assert.equal(template.nodes.filter(item => item.type.endsWith('scheduleTrigger')).length, 1);
  assert.equal(node('Conferir WhatsApp a cada 5 minutos').parameters.rule.interval[0].minutesInterval, 5);
  assert.equal(template.settings.saveDataSuccessExecution, 'none'); assert.equal(template.settings.saveDataErrorExecution, 'none');
  assert.equal(template.settings.saveManualExecutions, false); assert.equal(template.settings.saveExecutionProgress, false);
  const names = new Set(template.nodes.map(item => item.name)); assert.equal(names.size, template.nodes.length);
  const ids = new Set(template.nodes.map(item => item.id)); assert.equal(ids.size, template.nodes.length);
  for (const [from, connections] of Object.entries(template.connections)) {
    assert(names.has(from)); for (const output of connections.main) for (const edge of output) assert(names.has(edge.node), edge.node);
  }
  let expressions = 0;
  function parse(value) {
    if (typeof value === 'string' && value.startsWith('={{')) { assert(value.endsWith('}}')); new vm.Script('(' + value.slice(3, -2).trim() + ')'); expressions++; }
    else if (Array.isArray(value)) value.forEach(parse);
    else if (value && typeof value === 'object') Object.values(value).forEach(parse);
  }
  for (const item of template.nodes) {
    if (item.type.endsWith('code')) new vm.Script('(async function(){' + item.parameters.jsCode + '})');
    parse(item.parameters);
  }
  assert(expressions > 20);
  await assert.rejects(code('Configuração', { json: { body: message() } }, {}, {}, template), /EXAMES_WHATSAPP_PAUSADO/);
  const saved = JSON.parse(await fs.readFile(new URL('../../n8n/exames/OPERACIONAL-05.json', import.meta.url), 'utf8'));
  const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.equal(hash(saved), hash(template), 'Regenerate the neutral OPERACIONAL-05 template after builder/runtime changes');
});

test('all API credentials are existing references, with no Gmail call, no group message POST and no media credential', () => {
  const httpNodes = workflow.nodes.filter(item => item.type.endsWith('httpRequest'));
  assert(!httpNodes.some(item => /gmail\.googleapis|googleapis\.com\/gmail|Gmail -/.test(item.parameters.url + item.name)));
  assert(!workflow.nodes.some(item => item.type.endsWith('executeWorkflow')));
  const chatwoot = httpNodes.filter(item => item.name.startsWith('Chatwoot -'));
  assert.equal(chatwoot.length, 5);
  for (const item of chatwoot) {
    assert.equal(item.parameters.method, 'GET'); assert.equal(item.credentials.chatwootApi.id, settings.credentials.chatwoot.id);
    assert.equal(item.parameters.options.redirect.redirect.followRedirects, false);
    assert.equal(item.retryOnFail, true); assert.equal(item.maxTries, 3); assert.equal(item.waitBetweenTries, 1000);
  }
  const workerActions = new Set(['reserve_source', 'stage_file', 'confirm_file', 'source_error']);
  for (const item of httpNodes.filter(item => item.parameters.url.includes('serviceUrl'))) {
    assert.equal(item.parameters.method, 'POST'); assert.equal(item.credentials.httpHeaderAuth.id, settings.credentials.worker.id);
    assert.equal(item.retryOnFail, false); assert(workerActions.has(item.parameters.jsonBody.match(/action:\s*["']([^"']+)/)?.[1]));
  }
  const media = node('Chatwoot - baixar PDF reservado'); assert.equal(media.credentials, undefined);
  assert(!/Authorization|api_access_token|Bearer |httpRequestWithAuthentication/.test(media.parameters.jsCode));
  assert(media.parameters.jsCode.includes("method:'GET'"));
  const folder = node('Drive - conferir pasta privada');
  assert.equal(folder.retryOnFail, true); assert.equal(folder.maxTries, 3); assert.equal(folder.waitBetweenTries, 1000);
  assert.equal(folder.parameters.options.response.response.neverError, false);
  assert.equal(httpNodes.filter(item => item.retryOnFail).length, 6);
});

test('authenticated canonical API reads occur before every source reservation and before all media bytes', () => {
  const graph = workflow.connections;
  const canonical = 'Conferir remetente e todos os PDFs', reserve = 'Reservar origem', download = 'Chatwoot - baixar PDF reservado';
  function reaches(from, target, blocked = [], visited = new Set()) {
    if ([blocked].flat().includes(from) || visited.has(from)) return false; if (from === target) return true; visited.add(from);
    return (graph[from]?.main || []).flat().some(edge => reaches(edge.node, target, blocked, new Set(visited)));
  }
  for (const trigger of ['Entrada WhatsApp da equipe', 'Testar mensagem selecionada', 'Conferir WhatsApp a cada 5 minutos']) {
    assert(reaches(trigger, reserve)); assert(!reaches(trigger, reserve, [canonical, 'Origens recuperadas para conferir']));
    assert(!reaches(trigger, download, reserve));
  }
  assert.equal(graph['Chatwoot - conferir conversa de origem'].main[0][0].node, 'Chatwoot - reler mensagem de origem');
  assert.equal(graph['Chatwoot - reler mensagem de origem'].main[0][0].node, canonical);
  assert.equal(graph[download].main[1][0].node, 'Registrar falha de origem');
  assert.equal(graph['Registrar falha de origem'].main[0][0].node, 'Manter janela para recuperação');
  assert.equal(graph['Manter janela para recuperação'].main[0][0].node, 'Próximo anexo');
});

test('scheduled sweep has no manual selection and uses authenticated inbox/message pagination before intake', async () => {
  const configured = await code('Configuração', { json: { whatsappSweep: true } });
  assert.equal(configured[0].json.polling, true);
  assert.equal(configured[0].json.request, undefined);
  assert.match(configured[0].json.worker, /whatsapp-sweep:synthetic-execution$/);
  const selected = await buildWhatsappWorkflow({ ...settings, config: { ...settings.config, manualMessageId: '910', manualConversationId: '300' } });
  await assert.rejects(code('Configuração', { json: { whatsappSweep: true } }, {}, {}, selected), /Limpe a seleção manual/);
  const outputs = { Configuração: configured[0] };
  assert.equal(expression(node('Chatwoot - listar conversas da caixa').parameters.url, { conversationPage: 2 }, outputs), cfg.chatwootBaseUrl + '/api/v1/accounts/41/conversations?status=all&assignee_type=all&inbox_id=73&page=2');
  assert.equal(expression(node('Chatwoot - listar mensagens para conferência').parameters.url, { conversation: { id: 300 }, beforeMessageId: '900' }, outputs), cfg.chatwootBaseUrl + '/api/v1/accounts/41/conversations/300/messages?before=900');
  const graph = workflow.connections;
  assert.equal(graph['Todas as conversas enumeradas'].main[1][0].node, 'Página de conversas para conferir');
  assert.equal(graph['Todas as mensagens conferidas'].main[1][0].node, 'Página de mensagens para conferir');
  assert.equal(graph['Conferência integral terminada'].main[1][0].node, 'Conversa para conferir');
  assert.equal(graph['Origens recuperadas para conferir'].main[0][0].node, 'PDF autorizado disponível');
  await assert.rejects(code('Origens recuperadas para conferir', { json: { sweepComplete: false, origins: [] } }), /incomplete/);
});

test('scheduled intake persists aggregate evidence and detects the absent fourth attachment receipt', async () => {
  const configured = await code('Configuração', { json: { whatsappSweep: true } });
  const origin = inspectChatwootMessage(message(), cfg).origins[0];
  const origins = Array.from({ length: 4 }, (_, index) => ({ ...plain(origin), source: { ...origin.source, attachment_id: 'chatwoot-attachment:' + (811 + index) } }));
  const receipts = origins.slice(0, 3).map(value => ({ json: { intakeReceipt: true, kind: 'attachment', message_id: value.source.message_id,
    attachment_id: value.source.attachment_id, disposition: 'saved' } }));
  const result = await code('Recebimento encerrado', receipts, { Configuração: configured,
    'Origens recuperadas para conferir': origins.map(json => ({ json })) });
  assert.equal(result[0].json.scanFinished, false);
  assert.equal(result[0].json.counts.failed, 1);
  assert.equal(auditState.lastWhatsappSweep.counts.attachments, 4);
  assert.equal(auditState.lastWhatsappSweep.executionId, 'synthetic-execution');
  assert.equal(auditState.intakeAuditHistory.length, 1);
  assert(!JSON.stringify(auditState).includes(origin.source.attachment_id));
  assert(!JSON.stringify(auditState).includes('original.pdf'));
});

test('Config coarse gate and API URLs expose IDs only; canonical reread overrides forged webhook attachments/sender', async () => {
  const webhook = message(); webhook.sender.phone_number = '+5511987654322'; webhook.attachments[0].data_url = 'https://untrusted.example.invalid/injected.pdf';
  const configured = await code('Configuração', { json: { body: webhook } });
  assert.equal(configured[0].json.request.messageId, '910'); assert.equal(configured[0].json.request.beforeMessageId, '911');
  assert.equal(configured[0].json.body, undefined); assert.equal(configured[0].json.attachments, undefined);
  const lookup = { Configuração: configured };
  const forExpression = { Configuração: configured[0] };
  const conversationUrl = expression(node('Chatwoot - conferir conversa de origem').parameters.url, {}, forExpression);
  const messagesUrl = expression(node('Chatwoot - reler mensagem de origem').parameters.url, {}, forExpression);
  assert.equal(conversationUrl, cfg.chatwootBaseUrl + '/api/v1/accounts/41/conversations/300');
  assert.equal(messagesUrl, conversationUrl + '/messages?before=911');
  const actual = message(), actualMessage = canonicalMessage(actual);
  const result = await code('Conferir remetente e todos os PDFs', { json: { payload: [actualMessage] } }, {
    ...lookup, 'Chatwoot - conferir conversa de origem': [{ json: actual.conversation }] });
  assert.equal(result[0].json.source.metadata.sender_phone, '5511987654321');
  assert.equal(result[0].json.attachment.downloadUrl, actual.attachments[0].data_url);
  assert.equal(result[0].json.resetAttachments, true);
  const unauthorized = message(); unauthorized.sender.phone_number = '+5511987654322'; unauthorized.conversation.meta.sender.phone_number = '+5511987654322'; unauthorized.conversation.contact_inbox.source_id = '5511987654322';
  const excluded = await code('Conferir remetente e todos os PDFs', { json: { payload: [canonicalMessage(unauthorized)] } }, {
    ...lookup, 'Chatwoot - conferir conversa de origem': [{ json: unauthorized.conversation }] });
  assert.equal(excluded[0].json.messageExcluded, true); assert.equal(excluded[0].json.reason, 'sender_not_authorized');
  await assert.rejects(code('Conferir remetente e todos os PDFs', { json: { payload: [] } }, { ...lookup, 'Chatwoot - conferir conversa de origem': [{ json: actual.conversation }] }), /not_unique/);
});

test('manual selection uses the same API reread and invalid/disabled execution configuration cannot bypass it', async () => {
  const selected = await buildWhatsappWorkflow({ ...settings, config: { ...settings.config, manualMessageId: '910', manualConversationId: '300' } });
  const result = await code('Configuração', { json: {} }, {}, {}, selected, { mode: 'test' });
  assert.equal(result[0].json.request.messageId, '910');
  await assert.rejects(code('Configuração', { json: {} }, {}, {}, selected, { mode: 'production' }), /Selecione uma mensagem real/);
  const invalid = message(); invalid.private = true;
  assert.equal((await code('Configuração', { json: { body: invalid } }))[0].json.excluded, true);
  const badNumber = await buildWhatsappWorkflow({ ...settings, config: { ...settings.config, authorizedSenders: [] } });
  await assert.rejects(code('Configuração', { json: { body: message() } }, {}, {}, badNumber), /senders_config_invalid/);
});

test('Code bundle works with neither a URL global nor permission to require the url builtin', async () => {
  assert.equal(new vm.Script('typeof URL').runInNewContext({ Buffer, Date }), 'undefined');
  for (const name of ['Configuração', 'Conferir remetente e todos os PDFs', 'Chatwoot - baixar PDF reservado']) {
    assert(!/new URL\(|require\(["'](?:node:)?url["']\)/.test(node(name).parameters.jsCode));
  }
  const configured = await code('Configuração', { json: { body: message() } });
  assert.equal(configured[0].json.request.messageId, '910');
  const downloaded = await code('Chatwoot - baixar PDF reservado', { json: reserved() }, {}, {
    httpRequest: async () => ({ statusCode: 200, headers: { 'content-type': 'application/pdf' }, body: bytes }),
  });
  assert.equal(downloaded[0].json.sha256, digest);
});

test('download Code sends credential-free bounded GETs and validates original PDF signature, MIME, size and hash', async () => {
  const requests = [];
  const result = await code('Chatwoot - baixar PDF reservado', { json: reserved() }, {}, { httpRequest: async request => {
    requests.push(request); return { statusCode: 200, headers: { 'content-type': 'application/pdf' }, body: bytes };
  } });
  assert.equal(requests.length, 1); const request = requests[0];
  assert.equal(request.method, 'GET'); assert.equal(request.disableFollowRedirect, true); assert.equal(request.ignoreHttpStatusErrors, true);
  assert.equal(request.returnFullResponse, true); assert.equal(request.encoding, 'arraybuffer'); assert.equal(request.timeout, 30000);
  assert.equal(request.headers, undefined); assert.equal(request.authentication, undefined);
  assert.equal(result[0].json.sha256, digest); assert.equal(result[0].json.sizeBytes, bytes.length); assert.equal(result[0].binary.data.mimeType, 'application/pdf');
  const invalidResponses = [
    [{ statusCode: 200, headers: { 'content-type': 'image/png' }, body: bytes }, /mime/],
    [{ statusCode: 200, headers: { 'content-type': 'application/pdf' }, body: Buffer.from('not a pdf'.padEnd(bytes.length)) }, /signature/],
    [{ statusCode: 200, headers: { 'content-type': 'application/pdf' }, body: Buffer.concat([bytes, Buffer.from('x')]) }, /size_mismatch/],
    [{ statusCode: 500, headers: {}, body: '' }, /download_failed/],
  ];
  for (const [response, error] of invalidResponses) await assert.rejects(code('Chatwoot - baixar PDF reservado', { json: reserved() }, {}, { httpRequest: async () => response }), error);
});

test('download Code rejects absent/conflicting reservation and altered URL hash before any HTTP request', async () => {
  for (const mutate of [origin => { delete origin.documentId; }, origin => { origin.documentId = 'not-a-uuid'; }, origin => { delete origin.reservation; },
    origin => { origin.reservation.document_id = canonicalId; }, origin => { origin.reservation.document.id = canonicalId; }, origin => { origin.skip = true; },
    origin => { origin.missing = true; }, origin => { origin.source.channel = 'email'; }, origin => { origin.source.metadata.provider = 'other'; },
    origin => { origin.source.account_id = 'chatwoot:42:inbox:73'; }, origin => { origin.source.message_id = '911'; }, origin => { origin.attachment.id = 'other'; },
    origin => { delete origin.attachment; }, origin => { origin.source.metadata.chatwoot_attachment_id = '812'; },
    origin => { origin.attachment.downloadUrl = 'https://files.example.invalid/other.pdf'; }, origin => { origin.source.metadata.attachment_url_sha256 = '0'.repeat(64); }]) {
    const origin = reserved(); mutate(origin); let count = 0;
    await assert.rejects(code('Chatwoot - baixar PDF reservado', { json: origin }, {}, { httpRequest: async () => {
      count++; return { statusCode: 200, headers: { 'content-type': 'application/pdf' }, body: bytes };
    } }), /whatsapp_original_(not_reserved|url_mismatch)/);
    assert.equal(count, 0);
  }
});

test('redirect hop is validated before GET, with an exact media host allowlist and no redirect cycles or fifth request', async () => {
  const requests = [];
  const result = await code('Chatwoot - baixar PDF reservado', { json: reserved() }, {}, { httpRequest: async request => {
    requests.push(request);
    return requests.length === 1 ? { statusCode: 302, headers: { location: 'https://support.example.invalid/actual.pdf' }, body: '' }
      : { statusCode: 200, headers: { 'Content-Type': 'application/octet-stream' }, body: bytes };
  } });
  assert.equal(requests.length, 2); assert.equal(result[0].json.sha256, digest);
  for (const location of ['http://files.example.invalid/plain.pdf', 'https://127.0.0.1/internal.pdf', 'https://files.example.invalid.evil.invalid/capture.pdf', 'https://user:pass@files.example.invalid/capture.pdf',
    '//files.example.invalid/capture.pdf', 'relative.pdf', '../relative.pdf', '/malformed%GG.pdf', '/path\\file.pdf', '/file.pdf#fragment', reserved().attachment.downloadUrl]) {
    let count = 0;
    await assert.rejects(code('Chatwoot - baixar PDF reservado', { json: reserved() }, {}, { httpRequest: async () => {
      count++; return { statusCode: 302, headers: { location }, body: '' };
    } }), /redirect_not_allowed/); assert.equal(count, 1);
  }
  let count = 0;
  await assert.rejects(code('Chatwoot - baixar PDF reservado', { json: reserved() }, {}, { httpRequest: async () => ({ statusCode: 302, headers: { location: '/hop-' + (++count) + '.pdf' }, body: '' }) }), /redirect_limit/);
  assert.equal(count, 4);
});

test('source reservation, cross-channel canonical receipt and persisted Drive ID retain the shared integrity contract', async () => {
  const origin = inspectChatwootMessage(message(), cfg).origins[0];
  const decision = await code('Decidir recebimento', { json: { document_id: documentId, document: { id: documentId, file_status: 'saved' } } }, { 'Um anexo por vez': [{ json: origin }] });
  assert.equal(decision[0].json.skip, true);
  const stageReceipt = stage(canonicalId); stageReceipt.document.file_status = 'saved'; stageReceipt.claimed = false; stageReceipt.upload_required = false;
  assert.equal(expression(node('Upload reservado').parameters.conditions.conditions[0].leftValue, stageReceipt), false);
  const delay = await code('Adiar sweep quando upload pendente', { json: stageReceipt }); assert.equal(delay[0].json.pending, false);
  const decoded = { ...reserved(), sha256: digest, sizeBytes: bytes.length, folderId: cfg.driveFolderId };
  const stagedPayload = expression(node('Reservar ID e upload Drive').parameters.jsonBody, { ids: ['new-drive-id'] }, {
    'Validar bytes e SHA-256': { json: decoded }, Configuração: { json: cfg } });
  assert.equal(stagedPayload.action, 'stage_file'); assert.equal(stagedPayload.payload.file.sha256, digest); assert.equal(stagedPayload.payload.file.size_bytes, bytes.length);
  assert.equal(stagedPayload.payload.file.drive_file_id, 'new-drive-id');
  const task = stage();
  const outputs = { 'Reservar ID e upload Drive': [{ json: task }], 'Validar bytes e SHA-256': [{ json: decoded }] };
  const verified = await code('Conferir integridade do original', { json: {}, binary: { data: { bytes } } }, outputs);
  assert.equal(verified[0].json.stage.drive_file_id, 'persisted-drive-id');
  await assert.rejects(code('Conferir integridade do original', { json: {}, binary: { data: { bytes: Buffer.concat([bytes, Buffer.from('changed')]) } } }, outputs), /Conflito de integridade/);
  assert.equal(workflow.connections['Objeto já tem bytes'].main[0][0].node, 'Drive - conferir bytes salvos');
  const returned = await code('Próximo anexo', { json: { resetAttachments: true } }, { 'Um anexo por vez': [{ json: origin }] });
  assert.equal(returned[0].json.resetAttachments, undefined);
});

test('WhatsApp source being deleted and a duplicate fingerprint are excluded without upload',async()=>{
  const origin=inspectChatwootMessage(message(),cfg).origins[0];
  for(const state of ['deleting','deleted']){
    const decision=await code('Decidir recebimento',{json:{document_id:documentId,document:{id:documentId,deletion_state:state}}},{'Um anexo por vez':[{json:origin}]});
    assert.equal(decision[0].json.skip,true);
    const receipt=await code('Próximo anexo',decision[0],{'Um anexo por vez':[{json:origin}]});
    assert.equal(receipt[0].json.disposition,'excluded');assert.equal(receipt[0].json.reason,'user_deleted');
  }
  const staged={document_id:canonicalId,excluded:true,claimed:false,upload_required:false};
  assert.equal(expression(node('Upload reservado').parameters.conditions.conditions[0].leftValue,staged),false);
  const delay=await code('Adiar sweep quando upload pendente',{json:staged});
  const receipt=await code('Próximo anexo',delay[0],{'Um anexo por vez':[{json:origin}]});
  assert.equal(receipt[0].json.disposition,'excluded');assert.equal(receipt[0].json.reason,'user_deleted');
});

test('configuration binds only existing id/name references and refuses secrets or public bound output', async () => {
  await assert.rejects(buildWhatsappWorkflow({ config: { apiKey: 'must-not-be-accepted' } }), /Unknown/);
  await assert.rejects(buildWhatsappWorkflow({ credentials: { chatwoot: { id: 'reference', name: 'reference', token: 'must-not-be-accepted' } } }), /never secret/);
  await assert.rejects(writeWhatsappWorkflow(new URL('../../n8n/exames/OPERACIONAL-05.json', import.meta.url).pathname, settings), /outside/);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pamvet-whatsapp-build-test-'));
  try {
    const target = path.join(directory, 'operacional.json'), result = await writeWhatsappWorkflow(target, settings);
    assert.equal(result.nodes, workflow.nodes.length); assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), workflow);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
  assert.equal(WHATSAPP_CONFIG.enabled, false); assert.deepEqual(WHATSAPP_CONFIG.authorizedSenders, []);
});
