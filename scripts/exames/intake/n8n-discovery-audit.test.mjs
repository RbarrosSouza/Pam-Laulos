import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { buildN8nAuditWorkflow } from './n8n-discovery-audit-build.mjs';
import { validateAuditConfig, loadAuditState, nextAuditOperation, applyAuditResponse, applyAuditFailure,
  auditPersistenceRow, verifyAuditPersistence } from './n8n-discovery-audit-runtime.mjs';

const now = Date.parse('2026-10-27T18:00:00Z');
const cfg = { provider: 'gmail', enabled: true, allowScheduled: false, dataTableId: 'syntheticPrivateTable', collectorId: 'gmail_audit_v2',
  serviceUrl: 'https://fixture.supabase.co/functions/v1/exam-document-service', mailbox: 'fixture@example.invalid',
  intakeCutoff: '2026-10-27T00:00:00Z', includeSpamTrash: true, maxActions: 100, maxMillis: 180000, monitoring: false, auditLookbackSeconds: 86400, leaseMillis: 900000,
  gmailMetadataFields: 'id,internalDate,payload' };
const supportCfg = { ...cfg, provider: 'chatwoot', collectorId: 'chatwoot_audit_v2', chatwootBaseUrl: 'https://support.example.invalid', accountId: 1, inboxId: 2 };
const run = { sweep_id: '11111111-1111-4111-a111-111111111111', run_token: '22222222-2222-4222-a222-222222222222', mode: 'audit' };
const ok = body => ({ statusCode: 200, body });
const source = { nodes: [{ name: 'Configuração', parameters: { jsCode: 'const cfg=' + JSON.stringify({ ...cfg, accountId: 1, inboxId: 2, chatwootBaseUrl: supportCfg.chatwootBaseUrl }) + ';\nif(false){}' } },
  { name: 'Reservar origem', credentials: { httpHeaderAuth: { id: 'SYNTHETIC_WORKER', name: 'Existing worker header' } } },
  { name: 'Gmail - IDs paginados', credentials: { oAuth2Api: { id: 'SYNTHETIC_GMAIL', name: 'Existing readonly Gmail' } } },
  { name: 'Chatwoot - listar conversas da caixa', credentials: { chatwootApi: { id: 'SYNTHETIC_CHATWOOT', name: 'Existing Chatwoot' } } }] };

function persisted(state, config) {
  const expected = auditPersistenceRow(state, config, now);
  const row = { collector_key: expected.collector_key, state_json: expected.state_json, revision: expected.revision, id: state.rowId || 1 };
  return { row, state: verifyAuditPersistence([row], expected) };
}

const unknownLookup = identities => ({ contract: 'exam_intake_source_lookup_v1', items: identities.map(identity => ({ ...identity, status: 'not_found', reason: 'source_origin_not_recorded' })) });

async function simulate(config, provide, row = null, executionId = 'fixture-execution', lookup = unknownLookup) {
  let state = loadAuditState(row ? [row] : [], config, executionId, now), saved, result;
  const events = [], requests = [], order = [];
  for (let guard = 0; guard < 2000; guard++) {
    ({ row: saved, state } = persisted(state, config));
    order.push('state_saved');
    const operation = nextAuditOperation(state, config, now);
    if (operation.target === 'stop') {
      if (!state.releaseLease) { state = { ...operation.state, releaseLease: true, finalResult: operation.result }; continue; }
      result = operation.result; break;
    }
    requests.push(operation);
    let response;
    if (operation.target === 'backend') {
      order.push(operation.action);
      if (operation.action === 'intake_begin') response = ok(run);
      else if (operation.action === 'intake_finish') response = ok({ coverageComplete: true, allPreserved: false, scanFinished: false, checkpointAdvanced: false });
      else if (operation.action === 'intake_lookup_source') response = ok(await lookup(operation.payload.identities));
      else { events.push(operation.payload.event); order.push(operation.payload.event.kind); response = ok({ recorded: true, sweep_id: run.sweep_id }); }
    } else { order.push('provider:' + operation.state.phase); response = await provide(operation); }
    try { state = applyAuditResponse(operation, response, config, now); }
    catch (error) { state = applyAuditFailure(operation, error.message, now); }
  }
  assert(result, 'simulation must finish or yield its budget');
  return { row: saved, state, result, events, requests, order };
}

function gmailMetadata(id, count = 1) {
  return { id, internalDate: String(Date.parse('2026-10-27T12:00:00Z')), payload: { partId: '', mimeType: 'multipart/mixed',
    parts: Array.from({ length: count }, (_, index) => ({ partId: String(index), mimeType: 'application/pdf', filename: 'Sem nome.pdf', body: { attachmentId: 'pdf-' + index, size: 100 } })) } };
}

test('private n8n workflow is inactive, has native persistent table nodes and only reuses credential references', () => {
  for (const provider of ['gmail', 'chatwoot']) {
    const workflow = buildN8nAuditWorkflow(provider, source, 'syntheticPrivateTable');
    assert.equal(workflow.active, false); assert.deepEqual(workflow.pinData, {});
    assert.equal(workflow.settings.saveDataSuccessExecution, 'none'); assert.equal(workflow.settings.saveDataErrorExecution, 'none');
    assert.equal(workflow.nodes.filter(node => node.type.endsWith('dataTable')).length, 4);
    const names = new Set(workflow.nodes.map(node => node.name));
    for (const [from, connections] of Object.entries(workflow.connections)) {
      assert(names.has(from)); for (const edge of connections.main.flat()) assert(names.has(edge.node));
    }
    for (const node of workflow.nodes.filter(node => node.type.endsWith('httpRequest'))) {
      if (node.name === 'Ledger — evento durável') { assert.equal(node.parameters.method, 'POST'); assert.equal(node.credentials.httpHeaderAuth.id, 'SYNTHETIC_WORKER'); }
      else assert.equal(node.parameters.method, 'GET');
      assert.equal(node.retryOnFail, false); assert.equal(node.parameters.options.redirect.redirect.followRedirects, false);
    }
    assert(!JSON.stringify(workflow).includes('httpRequestWithAuthentication'));
    assert(!JSON.stringify(workflow).includes('$getWorkflowStaticData'));
    const table = workflow.nodes.find(node => node.parameters.operation === 'update');
    assert.equal(table.parameters.matchType, 'allConditions');
    assert.deepEqual(table.parameters.filters.conditions.map(filter => filter.keyName), ['collector_key', 'id', 'revision']);
    assert.deepEqual(Object.keys(table.parameters.columns.value), ['collector_key', 'state_json', 'revision']);
    assert(!workflow.nodes.some(node => node.parameters.operation === 'upsert'));
  }
});

test('all bundled Code nodes parse in a sandbox without URL/global network helpers; disabled guard runs before any access', () => {
  const workflow = buildN8nAuditWorkflow('gmail', source, 'syntheticPrivateTable');
  for (const node of workflow.nodes.filter(node => node.type.endsWith('code'))) new vm.Script('(async function(){' + node.parameters.jsCode + '})');
  const config = workflow.nodes.find(node => node.name === 'Configuração de auditoria');
  const sandbox = { require: name => { assert.equal(name, 'crypto'); return crypto; }, $execution: { mode: 'test' } };
  assert.throws(() => new vm.Script('(function(){' + config.parameters.jsCode + '})()').runInNewContext(sandbox), /DISABLED/);
  assert.throws(() => validateAuditConfig(cfg, 'trigger'), /MANUAL_REVIEW_ONLY/);
});

test('authorized manual pilot is enabled only for test/manual execution, keeps workflow inactive and disables its schedule node', () => {
  const workflow = buildN8nAuditWorkflow('gmail', source, 'syntheticPrivateTable', { manualPilot: true });
  assert.equal(workflow.active, false);
  assert.equal(workflow.nodes.find(node => node.type.endsWith('scheduleTrigger')).disabled, true);
  const code = workflow.nodes.find(node => node.name === 'Configuração de auditoria').parameters.jsCode;
  const sandbox = mode => ({ require: name => { assert.equal(name, 'crypto'); return crypto; }, $execution: { mode } });
  const settings = new vm.Script('(function(){' + code + '})()').runInNewContext(sandbox('test'))[0].json;
  assert.equal(settings.enabled, true); assert.equal(settings.allowScheduled, false); assert.equal(settings.monitoring, false);
  assert.equal(settings.auditLookbackSeconds, 86400);
  assert.throws(() => new vm.Script('(function(){' + code + '})()').runInNewContext(sandbox('trigger')), /MANUAL_REVIEW_ONLY/);
});

test('pending receipts are rechecked by exact origin and cursor advances only after confirmed idempotent resolutions', () => {
  const config = { ...cfg, recheckPending: true };
  const receipt = '10000000-0000-4000-a000-000000000001';
  const row = { receipt_id: receipt, account_id: 'gmail:fixture@example.invalid', partition_key: 'mailbox',
    message_id: 'abcdef01', attachment_id: 'gmail-part:["1","pdf-1"]', artifact_kind: 'attachment' };
  let state = loadAuditState([], config, 'fixture', now);
  state = applyAuditResponse(nextAuditOperation(state, config, now), ok(run), config, now);
  let op = nextAuditOperation(state, config, now);
  assert.equal(op.action, 'intake_list_pending_sources'); assert.equal(op.payload.after_receipt_id, null);
  state = applyAuditResponse(op, ok({ contract: 'exam_intake_pending_source_page_v1', collector_id: config.collectorId,
    items: [row], next_cursor: receipt }), config, now);
  op = nextAuditOperation(state, config, now); assert.equal(op.action, 'intake_lookup_source');
  const lookup = savedLookup(op.payload.identities);
  state = applyAuditResponse(op, ok(lookup), config, now);
  op = nextAuditOperation(state, config, now); assert.equal(op.action, 'intake_resolve_receipt_saved');
  const request = structuredClone(op.payload);
  const lost = applyAuditFailure(op, 'AUDIT_PROVIDER_OR_BACKEND_UNAVAILABLE', now);
  assert.equal(lost.recheckCursor, null); assert.deepEqual(lost.recheckResolutions[0].receipt_id, receipt);
  const restored = { ...lost, halt: false };
  assert.deepEqual(nextAuditOperation(restored, config, now).payload, request);
  state = applyAuditResponse(nextAuditOperation(restored, config, now), ok({ contract: 'exam_intake_receipt_resolution_v1',
    receipt_id: receipt, source_id: request.source_id, document_id: request.document_id, sha256: 'a'.repeat(64), size_bytes: 100,
    disposition: 'saved', already_saved: true }), config, now);
  assert.equal(state.recheckCursor, null);
  const next = nextAuditOperation(state, config, now);
  assert.equal(next.state.recheckCursor, receipt); assert.equal(next.state.phase, 'gmail_list');
});

test('an in-flight old message-only retry returns to lookup instead of processing every attachment', () => {
  const config={...cfg,recheckPending:true};
  const receipt={receipt_id:'10000000-0000-4000-a000-000000000001',account_id:'gmail:fixture@example.invalid',partition_key:'mailbox',message_id:'abcdef01',attachment_id:'gmail-part:["3","old-locator"]',artifact_kind:'attachment'};
  const initial=loadAuditState([],config,'fixture-old-state',now);
  const state={...initial,phase:'bridge',bridgeMode:'recheck',bridgeMessageId:receipt.message_id,recheckBridgeQueue:[receipt.message_id],recheckItems:[receipt]};
  const op=nextAuditOperation(state,config,now);
  assert.equal(op.target,'backend');assert.equal(op.action,'intake_lookup_source');assert.equal(op.payload.identities[0].attachment_id,receipt.attachment_id);
  assert.equal(op.state.recheckBridgeQueue,undefined);assert.equal(op.state.bridgeMode,undefined);
});

test('empty Gmail page requires explicit zero estimate and 204 never means a verified empty page', () => {
  const state={...loadAuditState([],cfg,'fixture-empty-page',now),phase:'gmail_list',receivedFrom:'2026-10-27T00:00:00Z',receivedThrough:'2026-10-27T01:00:00Z',cursor:null};
  const op=nextAuditOperation(state,cfg,now);
  assert.match(decodeURIComponent(op.url),/fields=messages\(id\),nextPageToken,resultSizeEstimate/);
  const accepted=applyAuditResponse(op,ok({resultSizeEstimate:0}),cfg,now);
  assert.equal(accepted.phase,'events');
  assert.throws(()=>applyAuditResponse(op,ok({}),cfg,now),/INTAKE_AUDIT_GMAIL_EMPTY_UNPROVEN/);
  const failed=applyAuditResponse(op,{statusCode:204,body:''},cfg,now);
  assert.equal(failed.phase,'gmail_list');assert.equal(failed.halt,true);
});

test('rechecking unknown origins leaves them pending, rejects forged page/ack, and repeats complete UUID passes', () => {
  const config = { ...cfg, recheckPending: true };
  const receipt = '10000000-0000-4000-a000-000000000001';
  const row = { receipt_id: receipt, account_id: 'gmail:fixture@example.invalid', partition_key: 'mailbox',
    message_id: 'abcdef01', attachment_id: 'pdf-1', artifact_kind: 'attachment' };
  let state = loadAuditState([], config, 'fixture', now);
  state = applyAuditResponse(nextAuditOperation(state, config, now), ok(run), config, now);
  const op = nextAuditOperation(state, config, now);
  const page = { contract: 'exam_intake_pending_source_page_v1', collector_id: config.collectorId, items: [row], next_cursor: null };
  assert.throws(() => applyAuditResponse(op, ok({ ...page, items: [{ ...row, account_id: 'other' }] }), config, now), /IDENTITY_INVALID/);
  assert.throws(() => applyAuditResponse(op, ok({ ...page, next_cursor: '20000000-0000-4000-a000-000000000001' }), config, now), /CURSOR_INVALID/);
  state = applyAuditResponse(op, ok(page), config, now);
  const lookup = nextAuditOperation(state, config, now);
  state = applyAuditResponse(lookup, ok(unknownLookup(lookup.payload.identities)), config, now);
  assert.equal(state.recheckResolutions.length, 0);
  const next = nextAuditOperation(state, config, now);
  assert.equal(next.state.recheckCursor, null); assert.equal(next.state.phase, 'gmail_list');
  assert(!next.action?.includes('resolve'));
});

test('Gmail persists all message IDs before metadata, accounts for four unnamed PDFs and declares every outcome pending', async () => {
  const result = await simulate(cfg, async operation => operation.state.phase === 'gmail_list'
    ? ok({ messages: [{ id: 'abcdef01' }] }) : ok(gmailMetadata('abcdef01', 4)));
  assert.equal(result.result.coverageComplete, true);
  assert.equal(result.result.scanFinished, false); assert.equal(result.result.checkpointAdvanced, false);
  assert(result.order.indexOf('page_discovered') < result.order.indexOf('provider:gmail_metadata'));
  const declaration = result.events.find(event => event.kind === 'origins_declared');
  assert.equal(declaration.origins.length, 4);
  assert.equal(new Set(declaration.origins.map(origin => origin.attachment_id)).size, 4);
  const outcomes = result.events.filter(event => event.kind === 'origin_outcome');
  assert.equal(outcomes.length, 4); assert(outcomes.every(event => event.disposition === 'pending'));
  assert(outcomes.every(event => event.code === 'source_origin_not_recorded'));
  assert(!result.row.state_json.includes('Sem nome.pdf'));
  const listing = result.requests.find(request => request.state.phase === 'gmail_list');
  const query = decodeURIComponent(listing.url);
  assert(!query.includes('has:attachment')); assert(!query.includes('subject:'));
});

test('per-attachment details are declared before processing with names or null and controlled sender metadata',async()=>{
  const config={...cfg,captureAttachmentDetails:true};
  const result=await simulate(config,async operation=>{
    if(operation.state.phase==='gmail_list')return ok({messages:[{id:'abcdef01'}]});
    const m=gmailMetadata('abcdef01',4);m.payload.headers=[{name:'From',value:'Pessoa fictícia <fixture@example.invalid>'}];
    m.payload.parts[0].filename='Exame A.pdf';m.payload.parts[1].filename='';m.payload.parts[2].filename='https://example.invalid/secret';m.payload.parts[3].filename='bad\nname.pdf';return ok(m);
  });
  const details=result.events.filter(e=>e.kind==='attachment_details');assert.equal(details.length,4);
  assert.deepEqual(details.map(d=>d.position),[1,2,3,4]);assert.deepEqual(details.map(d=>d.display_name),['Exame A.pdf',null,null,null]);
  assert(details.every(d=>d.sender==='fixture@example.invalid'&&d.mime_type==='application/pdf'));
  assert(result.order.indexOf('origins_declared')<result.order.indexOf('attachment_details'));
  assert(result.order.lastIndexOf('attachment_details')<result.order.indexOf('origin_outcome'));
});

test('no-PDF metadata stays as an explicit review notice; lack of subject or known sender never drops the message', async () => {
  const result = await simulate(cfg, async operation => operation.state.phase === 'gmail_list'
    ? ok({ messages: [{ id: 'abcdef01' }] }) : ok(gmailMetadata('abcdef01', 0)));
  const declaration = result.events.find(event => event.kind === 'origins_declared');
  assert.equal(declaration.origins[0].artifact_kind, 'notice');
  assert(result.events.some(event => event.code === 'audit_notice_requires_review'));
});

test('a failed metadata item records a failure receipt and continues to the remaining message', async () => {
  const result = await simulate(cfg, async operation => {
    if (operation.state.phase === 'gmail_list') return ok({ messages: [{ id: 'abcdef01' }, { id: 'abcdef02' }] });
    return operation.url.includes('abcdef01') ? { statusCode: 503, body: {} } : ok(gmailMetadata('abcdef02', 1));
  });
  assert(result.events.some(event => event.kind === 'origin_outcome' && event.message_id === 'abcdef01' && event.disposition === 'failed'));
  assert(result.events.some(event => event.kind === 'origin_outcome' && event.message_id === 'abcdef02' && event.disposition === 'pending'));
  assert(result.events.some(event => event.kind === 'enumeration_complete' && event.expected_message_count === 2));
});

test('budget yields preserve the same request ID and cursor across a fresh execution', async () => {
  const limited = { ...cfg, maxActions: 4 };
  const first = await simulate(limited, async () => ok({ messages: [{ id: 'abcdef01' }], nextPageToken: 'private-next-token' }));
  assert.equal(first.result.continuationRequired, true); assert.equal(first.result.checkpointAdvanced, false);
  const restored = loadAuditState([first.row], limited, 'next-execution', now + 60000);
  assert.equal(restored.requestId, first.state.requestId); assert.equal(restored.sweepId, first.state.sweepId);
  assert.equal(restored.tick.actions, 0); assert.equal(restored.tick.executionId, 'next-execution');
  assert.equal(restored.cursor, 'private-next-token');
});

test('lost backend ACK retains the exact event for idempotent retry and cannot request another provider page', () => {
  let state = loadAuditState([], cfg, 'fixture', now);
  state = applyAuditResponse(nextAuditOperation(state, cfg, now), ok(run), cfg, now);
  const listing = nextAuditOperation(state, cfg, now);
  state = applyAuditResponse(listing, ok({ messages: [{ id: 'abcdef01' }], nextPageToken: 'next' }), cfg, now);
  const event = nextAuditOperation(state, cfg, now);
  assert.equal(event.action, 'intake_event'); assert.equal(event.payload.event.kind, 'page_discovered');
  const failed = applyAuditResponse(event, { statusCode: 0 }, cfg, now);
  assert.equal(failed.halt, true); assert.deepEqual(failed.pendingEvents[0], event.payload.event);
  assert.equal(nextAuditOperation(failed, cfg, now).target, 'stop');
});

test('Data Table write mismatch or duplicate collector rows stop before any provider/backend call', () => {
  const state = loadAuditState([], cfg, 'fixture', now), row = auditPersistenceRow(state, cfg);
  assert.throws(() => verifyAuditPersistence([{ ...row, revision: row.revision + 1 }], row), /UNPROVEN/);
  assert.throws(() => verifyAuditPersistence([row, row], row), /UNPROVEN/);
  assert.throws(() => loadAuditState([row, row], cfg, 'fixture', now), /DUPLICATE_STATE_ROWS/);
  assert.throws(() => loadAuditState([{ ...row, collector_key: 'other' }], cfg, 'fixture', now), /COLLECTOR_MISMATCH/);
});

test('Chatwoot discovers 21 IDs, including outgoing and notes, before subsequent inventory events', async () => {
  const rows = Array.from({ length: 21 }, (_, index) => ({ id: 100 - index, account_id: 1, inbox_id: 2, conversation_id: 300,
    created_at: Date.parse('2026-10-27T12:00:00Z') / 1000, message_type: index === 0 ? 0 : 1, private: false,
    attachments: index === 0 ? [{ id: 811 }] : [] }));
  const result = await simulate({ ...supportCfg, maxActions: 200 }, async operation => {
    if (operation.state.phase === 'chatwoot_conversations') return ok({ data: { payload: operation.state.cursor === 1 ? [{ id: 300, inbox_id: 2 }] : [] } });
    return ok({ payload: operation.state.cursor === null ? rows : [] });
  });
  const messagePage = result.events.find(event => event.kind === 'page_discovered' && event.partition_key === 'conversation:300' && event.message_ids.length);
  assert.equal(messagePage.message_ids.length, 21);
  assert.equal(result.events.filter(event => event.kind === 'origins_declared').length, 21);
  assert(result.events.some(event => event.policy_code === 'not_external_incoming_message'));
  assert(result.events.some(event => event.kind === 'enumeration_complete' && event.expected_message_count === 21 && event.page_count === 4));
  assert.equal(result.events.filter(event => event.kind === 'origin_outcome').length, 1);
});

test('provider pagination cycles and oversized pages become explicit ledger failures, without truncating IDs', async () => {
  const result = await simulate(cfg, async () => ok({ messages: Array.from({ length: 101 }, (_, index) => ({ id: (0xabcdef00 + index).toString(16) })) }));
  assert(result.events.some(event => event.kind === 'failure'));
  assert.equal(result.events.some(event => event.kind === 'page_discovered'), false);
  assert.equal(result.result.coverageComplete, false); assert.equal(result.result.continuationRequired, true);
});

const savedLookup = identities => ({ contract: 'exam_intake_source_lookup_v1', items: identities.map(identity => ({
  ...identity, status: 'saved', reason: 'canonical_original_preserved', match_kind: 'exact_origin',
  source_id: '33333333-3333-4333-a333-333333333333', document_id: '44444444-4444-4444-a444-444444444444',
  source_document_id: '44444444-4444-4444-a444-444444444444', sha256: 'a'.repeat(64), size_bytes: 100,
  file_status: 'saved', canonical_file_preserved: true, group_status: 'sent' })) });

test('exact read-only lookup proof produces saved receipts without any reservation or clinical mutation action', async () => {
  const result = await simulate(cfg, async operation => operation.state.phase === 'gmail_list'
    ? ok({ messages: [{ id: 'abcdef01' }] }) : ok(gmailMetadata('abcdef01', 4)), null, 'saved-proof', savedLookup);
  const outcomes = result.events.filter(event => event.kind === 'origin_outcome');
  assert.equal(outcomes.length, 4); assert(outcomes.every(event => event.disposition === 'saved' && event.source_id && event.document_id));
  assert.equal(result.result.originsSaved, 4); assert.equal(result.result.originsPending, 0);
  assert.equal(result.result.monitoring, false); assert.equal(result.result.auditOnly, true);
  assert(result.requests.filter(request => request.target === 'backend').every(request => ['intake_begin', 'intake_lookup_source', 'intake_event', 'intake_finish'].includes(request.action)));
  assert(result.order.indexOf('page_discovered') < result.order.indexOf('intake_lookup_source'));
});

test('lookup chunks every origin by at most 100 identities before declaring the complete message', async () => {
  const result = await simulate({ ...cfg, maxActions: 200 }, async operation => operation.state.phase === 'gmail_list'
    ? ok({ messages: [{ id: 'abcdef01' }] }) : ok(gmailMetadata('abcdef01', 125)), null, 'chunks', savedLookup);
  const calls = result.requests.filter(request => request.action === 'intake_lookup_source');
  assert.deepEqual(calls.map(call => call.payload.identities.length), [100, 25]);
  const declaration = result.events.find(event => event.kind === 'origins_declared');
  assert.equal(declaration.origins.length, 125);
  assert.equal(result.events.filter(event => event.kind === 'origin_outcome').length, 125);
});

test('unproven saved lookup or reordered identities stop before declaring a false saved receipt and retain the lookup request', async () => {
  for (const lookup of [identities => { const response = savedLookup(identities); response.items[0].canonical_file_preserved = false; return response; },
    identities => { const response = savedLookup(identities); response.items.reverse(); return response; }]) {
    const result = await simulate(cfg, async operation => operation.state.phase === 'gmail_list'
      ? ok({ messages: [{ id: 'abcdef01' }] }) : ok(gmailMetadata('abcdef01', 2)), null, 'bad-proof', lookup);
    assert.equal(result.result.coverageComplete, false); assert.equal(result.result.scanFinished, false);
    assert.equal(result.state.phase, 'lookup'); assert.equal(result.state.lookupJobs[0].lookupOffset, undefined);
    assert(!result.events.some(event => event.kind === 'origin_outcome'));
  }
});

test('a live lease blocks another execution while a conditional revision write rejects a stale contender', () => {
  const loaded = loadAuditState([], cfg, 'owner', now), first = persisted(loaded, cfg);
  const competing = loadAuditState([first.row], cfg, 'competitor', now + 1000);
  assert.equal(competing.busy, true);
  assert.throws(() => auditPersistenceRow(competing, cfg, now), /LEASE_NOT_OWNED/);
  const expired = loadAuditState([first.row], cfg, 'competitor', now + 900001);
  assert.equal(expired.busy, false); assert.equal(expired.lease.owner, 'competitor');
  const winner = auditPersistenceRow(first.state, cfg, now);
  const loser = auditPersistenceRow(expired, cfg, now + 900001);
  assert.equal(winner.expected_revision, loser.expected_revision);
  const database = { id: first.row.id, collector_key: winner.collector_key, state_json: winner.state_json, revision: winner.revision };
  assert.throws(() => verifyAuditPersistence([database], loser), /UNPROVEN/);
  assert.equal(verifyAuditPersistence([database], winner).lease.owner, 'owner');
});

test('manual window is limited to one day and clean yield persists lease release before a fresh execution resumes', async () => {
  const oldCutoff = { ...cfg, intakeCutoff: '2026-01-01T00:00:00Z', maxActions: 3 };
  const first = await simulate(oldCutoff, async () => ok({ messages: [{ id: 'abcdef01' }], nextPageToken: 'next' }));
  assert.equal(first.state.receivedFrom, '2026-10-26T18:00:00.000Z');
  assert.equal(JSON.parse(first.row.state_json).lease.owner, null);
  assert.equal(JSON.parse(first.row.state_json).lease.until, 0);
  const next = loadAuditState([first.row], oldCutoff, 'next', now + 1000);
  assert.equal(next.busy, false); assert.equal(next.sweepId, first.state.sweepId);
  assert.equal(next.receivedFrom, first.state.receivedFrom);
});

test('two Hopelab notices sharing a URL keep separate message identities and never inherit each other’s preserved proof', async () => {
  const url = 'https://hopelab.exames.vet.br/laudos/download/123/456/' + 'a'.repeat(32) + '/' + 'b'.repeat(32);
  const text = 'Texto clínico que não deve persistir. ' + url + '?utm_source=email';
  const metadata = (id, withBody) => ({ id, internalDate: String(Date.parse('2026-10-27T12:00:00Z')), payload: { partId: '', mimeType: 'multipart/alternative',
    headers: [{ name: 'From', value: 'Hopelab <hopelab@exames.vet.br>' }, { name: 'Subject', value: 'Exame finalizado: aviso' }],
    parts: [{ partId: '0', mimeType: 'text/plain', body: { size: Buffer.byteLength(text), ...(withBody ? { data: Buffer.from(text).toString('base64url') } : {}) } }] } });
  const requests = [];
  const result = await simulate(cfg, async operation => {
    if (operation.state.phase === 'gmail_list') return ok({ messages: [{ id: 'abcdef01' }, { id: 'abcdef02' }] });
    const id = operation.state.messageQueue[operation.state.messageIndex].id;
    return ok(metadata(id, operation.state.phase === 'gmail_notice_body'));
  }, null, 'notice-proof', identities => {
    requests.push(...identities);
    return identities[0].message_id === 'abcdef01' ? savedLookup(identities) : unknownLookup(identities);
  });
  assert.equal(requests.length, 2); assert.deepEqual(requests.map(item => item.message_id), ['abcdef01', 'abcdef02']);
  const digest = crypto.createHash('sha256').update(url).digest('hex');
  assert(requests.every(item => item.attachment_id === 'hopelab-link:' + digest));
  const outcomes = result.events.filter(event => event.kind === 'origin_outcome');
  assert.deepEqual(outcomes.map(event => event.disposition), ['saved', 'pending']);
  assert(result.events.filter(event => event.kind === 'origins_declared').every(event => event.origins[0].artifact_kind === 'download_link' && event.origins[0].relation_sha256 === digest));
  assert(!result.row.state_json.includes('Texto clínico')); assert(!result.row.state_json.includes(url));
  assert(!result.requests.some(request => request.url?.startsWith(url)));
});

test('truncated MIME produces an explicit per-message failure without losing the next message', async () => {
  const result = await simulate(cfg, async operation => {
    if (operation.state.phase === 'gmail_list') return ok({ messages: [{ id: 'abcdef01' }, { id: 'abcdef02' }] });
    if (operation.url.includes('abcdef01')) return ok({ id: 'abcdef01', internalDate: String(now - 60000), payload: { partId: '', mimeType: 'multipart/mixed', parts: [{ partId: 'deep' }] } });
    return ok(gmailMetadata('abcdef02', 1));
  });
  assert(result.events.some(event => event.kind === 'origin_outcome' && event.message_id === 'abcdef01' && event.disposition === 'failed'));
  assert(result.events.some(event => event.kind === 'origin_outcome' && event.message_id === 'abcdef02' && event.disposition === 'pending'));
});

test('all image, docx, zip, locator-only and inline PDF attachments get independent receipts with incompatible files pending', async () => {
  const parts = [
    { partId: '1', mimeType: 'image/png', filename: 'image.png', body: { attachmentId: 'img', size: 100 } },
    { partId: '2', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: 'exam.docx', body: { attachmentId: 'docx', size: 100 } },
    { partId: '3', mimeType: 'application/zip', filename: 'exams.zip', body: { attachmentId: 'zip', size: 100 } },
    { partId: '4', mimeType: 'application/octet-stream', body: { attachmentId: 'unnamed', size: 100 } },
    { partId: '5', mimeType: 'application/pdf', body: { size: 100 } },
  ];
  const result = await simulate(cfg, async operation => operation.state.phase === 'gmail_list' ? ok({ messages: [{ id: 'abcdef01' }] })
    : ok({ id: 'abcdef01', internalDate: String(now - 60000), payload: { partId: '', mimeType: 'multipart/mixed', parts } }));
  const origins = result.events.find(event => event.kind === 'origins_declared').origins;
  assert.equal(origins.length, 5); assert.equal(new Set(origins.map(origin => origin.attachment_id)).size, 5);
  assert(origins.some(origin => origin.attachment_id === 'gmail-part:["5",null]'));
  const outcomes = result.events.filter(event => event.kind === 'origin_outcome');
  assert.equal(outcomes.length, 5); assert(outcomes.every(event => event.disposition === 'pending'));
  assert.equal(outcomes.filter(event => event.code === 'unsupported_attachment_requires_review').length, 4);
});

test('HTML-only Hopelab href is detected, shares one hash with plain text and rejects scripts, styles, comments and external hosts', async () => {
  const path = '/laudos/download/123/456/' + 'a'.repeat(32) + '/' + 'b'.repeat(32), url = 'https://hopelab.exames.vet.br' + path;
  const second = 'https://hopelab.exames.vet.br/laudos/download/999/456/' + 'a'.repeat(32) + '/' + 'b'.repeat(32);
  for (const includePlain of [false, true]) {
    const html = '<script><a href="' + second + '">hidden</a></script><style>' + second + '</style><!--<a href="' + second + '">comment</a>-->'
      + '<a data-href="' + second + '" href="' + url + '?utm_source=email">Baixar laudo</a><a href="https://evil.invalid' + path + '">externo</a>';
    const make = withBody => ({ id: 'abcdef01', internalDate: String(now - 60000), payload: { partId: '', mimeType: 'multipart/mixed',
      headers: [{ name: 'From', value: 'hopelab@exames.vet.br' }, { name: 'Subject', value: 'Exame finalizado' }],
      parts: [{ partId: 'logo', mimeType: 'image/png', filename: 'logo.png', body: { attachmentId: 'logo', size: 10 } },
        ...[['html', 'text/html', html], ...(includePlain ? [['plain', 'text/plain', url]] : [])].map(([partId, mimeType, text]) => ({
          partId, mimeType, body: { size: Buffer.byteLength(text), ...(withBody ? { data: Buffer.from(text).toString('base64url') } : {}) } }))] } });
    const result = await simulate(cfg, async operation => operation.state.phase === 'gmail_list' ? ok({ messages: [{ id: 'abcdef01' }] }) : ok(make(operation.state.phase === 'gmail_notice_body')));
    const origins = result.events.find(event => event.kind === 'origins_declared').origins;
    assert.equal(origins.length, 2); assert.equal(origins.filter(origin => origin.artifact_kind === 'download_link').length, 1);
    assert.equal(origins.find(origin => origin.artifact_kind === 'download_link').relation_sha256, crypto.createHash('sha256').update(url).digest('hex'));
    assert.equal(result.events.filter(event => event.kind === 'origin_outcome' && event.code === 'unsupported_attachment_requires_review').length, 1);
    assert(!result.row.state_json.includes(url)); assert(!result.row.state_json.includes('hidden'));
  }
});

test('Hopelab body failure preserves already discovered non-PDF attachments and an explicit failed notice', async () => {
  const message = { id: 'abcdef01', internalDate: String(now - 60000), payload: { partId: '', mimeType: 'multipart/mixed',
    headers: [{ name: 'From', value: 'hopelab@exames.vet.br' }, { name: 'Subject', value: 'Exame finalizado' }],
    parts: [{ partId: '1', mimeType: 'image/png', filename: 'logo.png', body: { attachmentId: 'logo', size: 10 } }] } };
  const result = await simulate(cfg, async operation => operation.state.phase === 'gmail_list' ? ok({ messages: [{ id: 'abcdef01' }] })
    : operation.state.phase === 'gmail_notice_body' ? { statusCode: 503, body: {} } : ok(message));
  const origins = result.events.find(event => event.kind === 'origins_declared').origins;
  assert.equal(origins.length, 2); assert(origins.some(origin => origin.attachment_id === 'gmail-part:["1","logo"]'));
  assert(result.events.some(event => event.kind === 'origin_outcome' && event.disposition === 'failed'));
  assert(result.events.some(event => event.kind === 'origin_outcome' && event.code === 'unsupported_attachment_requires_review'));
});

const continuousCfg = { ...cfg, allowScheduled: true, continuous: true, overlapSeconds: 300, maxRepeatedFailures: 3, notificationMode: 'home_only' };

test('scheduled candidate remains inactive, keeps budget 100, allows its schedule and contains no alert or provider write action', () => {
  const workflow = buildN8nAuditWorkflow('gmail', source, 'syntheticPrivateTable', { scheduledCandidate: true });
  assert.equal(workflow.active, false); assert.equal(workflow.nodes.find(node => node.type.endsWith('scheduleTrigger')).disabled, false);
  const code = workflow.nodes.find(node => node.name === 'Configuração de auditoria').parameters.jsCode;
  const settings = new vm.Script('(function(){' + code + '})()').runInNewContext({ require: () => crypto, $execution: { mode: 'trigger' } })[0].json;
  assert.equal(settings.maxActions, 100); assert.equal(settings.maxMillis, 180000); assert.equal(settings.leaseMillis, 900000);
  assert.equal(settings.notificationMode, 'home_only'); assert.equal(settings.monitoring, false); assert.equal(settings.collectorId, cfg.collectorId);
  assert(workflow.nodes.filter(node => node.type.endsWith('httpRequest')).every(node => node.parameters.method === 'GET' || node.name === 'Ledger — evento durável'));
  assert(!JSON.stringify(workflow).includes('intake_reserve_alert')); assert(workflow.nodes.every(node => !node.credentials?.chatwootApi));
  assert.throws(() => buildN8nAuditWorkflow('chatwoot', source, 'syntheticPrivateTable', { scheduledCandidate: true }), /Gmail-only/);
});

test('prospective candidate requires an exact cutoff and a separate collector, with no history before activation', () => {
  const cutoff='2026-10-25T18:00:00.000Z';
  const workflow=buildN8nAuditWorkflow('gmail',source,'syntheticPrivateTable',{scheduledCandidate:true,prospectiveCutoff:cutoff});
  const code=workflow.nodes.find(n=>n.name==='Configuração de auditoria').parameters.jsCode;
  const settings=new vm.Script('(function(){'+code+'})()').runInNewContext({require:()=>crypto,$execution:{mode:'trigger'}})[0].json;
  assert.equal(workflow.active,false);assert.equal(settings.intakeCutoff,cutoff);assert.equal(settings.prospective,true);assert.equal(settings.includeSpamTrash,true);
  assert.match(settings.collectorId,/^gmail_prospective_[a-f\d]{16}$/);assert.notEqual(settings.collectorId,cfg.collectorId);
  const first=loadAuditState([],settings,'delayed-first-start',now);
  assert.equal(first.receivedFrom,cutoff);assert.equal(first.receivedThrough,'2026-10-26T18:00:00.000Z');
  const completed={...first,phase:'done',sweepId:run.sweep_id,finishResult:{coverageComplete:true},coverageProof:{sweepId:run.sweep_id,receivedThrough:first.receivedThrough}};
  const {row}=persisted(completed,settings);
  const next=loadAuditState([row],settings,'next-day',now);
  assert.equal(next.receivedFrom,'2026-10-26T17:55:00.000Z');assert.equal(next.receivedThrough,'2026-10-27T17:55:00.000Z');
  assert.throws(()=>buildN8nAuditWorkflow('gmail',source,'syntheticPrivateTable',{scheduledCandidate:true,prospectiveCutoff:'2026-10-25'}),/canonical UTC/);
  assert.throws(()=>buildN8nAuditWorkflow('gmail',source,'syntheticPrivateTable',{manualPilot:true,prospectiveCutoff:cutoff}),/activation cutoff/);
  assert.throws(()=>validateAuditConfig({...settings,includeSpamTrash:false},'trigger'),/PROSPECTIVE_POLICY/);
});

test('manual prospective canary rejects scheduled mode and persists a non-resumable pause on uncertain child',()=>{
  const workflow=buildN8nAuditWorkflow('gmail',source,'syntheticPrivateTable',{scheduledCandidate:true,prospectiveCutoff:'2026-10-27T00:00:00.000Z',bridgeWorkflowId:'syntheticChildId',canary:true,canaryMessageId:'abcdef01'});
  assert.equal(workflow.active,false);assert.equal(workflow.nodes.find(n=>n.type.endsWith('scheduleTrigger')).disabled,true);
  const code=workflow.nodes.find(n=>n.name==='Configuração de auditoria').parameters.jsCode;
  const get=mode=>new vm.Script('(function(){'+code+'})()').runInNewContext({require:()=>crypto,$execution:{mode}})[0].json;
  assert.throws(()=>get('trigger'),/MANUAL_REVIEW_ONLY/);const config=get('test');
  let state=loadAuditState([],config,'canary',now);state={...state,phase:'bridge',bridgeMode:'new',bridgeMessageId:'abcdef01',bridgeJob:{origins:[{attachment_id:'gmail-part:["0","fixture"]'}],lookupItems:[{status:'not_found'}],unsupportedIds:[]}};
  state=applyAuditResponse(nextAuditOperation(state,config,now),{statusCode:200,body:{completed:false}},config,now);
  assert.equal(state.canaryPaused,true);assert.equal(state.halt,true);assert.equal(state.phase,'lookup');
  const {row}=persisted(state,config);assert.throws(()=>loadAuditState([row],config,'attempt-again',now+1000),/CANARY_PAUSED_AFTER_FAILURE/);
  assert.throws(()=>loadAuditState([row],{...config,canaryMessageId:'abcdef02'},'different-fixture',now+1000),/STATE_IDENTITY_INVALID/);
  assert.throws(()=>loadAuditState([row],{...config,canary:false,allowScheduled:true},'promoted',now+1000),/STATE_IDENTITY_INVALID/);
  const separate=buildN8nAuditWorkflow('gmail',source,'syntheticPrivateTable',{scheduledCandidate:true,prospectiveCutoff:'2026-10-27T00:00:00.000Z',bridgeWorkflowId:'syntheticChildId',canary:true,canaryMessageId:'abcdef01',canaryCollectorId:'gmail_canary_recheck_test1234',canaryRecheckOnly:true});
  const separateCode=separate.nodes.find(n=>n.name==='Configuração de auditoria').parameters.jsCode;
  assert.equal(new vm.Script('(function(){'+separateCode+'})()').runInNewContext({require:()=>crypto,$execution:{mode:'test'}})[0].json.collectorId,'gmail_canary_recheck_test1234');
  assert(!separate.nodes.some(n=>n.type.endsWith('.executeWorkflow')));
  assert.throws(()=>buildN8nAuditWorkflow('gmail',source,'syntheticPrivateTable',{scheduledCandidate:true,prospectiveCutoff:'2026-10-27T00:00:00.000Z',canaryCollectorId:'gmail_canary_recheck_test1234'}),/only for a manual canary/);
});

test('a permanently failing first window becomes a durable gap, while later windows advance and retries alternate',()=>{
  const later=Date.parse('2026-10-30T12:00:00Z');
  const config={...cfg,continuous:true,allowScheduled:true,overlapSeconds:300,maxRepeatedFailures:3,notificationMode:'home_only',
    prospective:true,intakeCutoff:'2026-10-27T00:00:00.000Z'};
  const completed=(s,success)=>({...s,phase:'done',sweepId:run.sweep_id,finishResult:{coverageComplete:success}});
  const restart=s=>loadAuditState([persisted(s,config).row],config,'next',later);
  const first=loadAuditState([],config,'start',later);assert.equal(first.receivedFrom,config.intakeCutoff);assert.equal(first.receivedThrough,'2026-10-28T00:00:00.000Z');
  const current=restart(completed(first,false));assert.equal(current.windowKind,'current');assert.equal(current.receivedFrom,'2026-10-27T23:55:00.000Z');
  assert.equal(current.receivedThrough,'2026-10-28T23:55:00.000Z');assert.equal(current.coverageGaps.length,1);assert.equal(current.coverageProof,null);
  const retry=restart(completed(current,true));assert.equal(retry.windowKind,'retry');assert.equal(retry.receivedFrom,first.receivedFrom);assert.equal(retry.receivedThrough,first.receivedThrough);
  const again=restart(completed(retry,false));assert.equal(again.windowKind,'current');assert.equal(again.receivedFrom,'2026-10-28T23:50:00.000Z');
  assert.equal(again.coverageGaps.length,1);assert.equal(again.coverageProof,null);assert.equal(again.coverageHadGap,true);
  const nextRetry=restart(completed(again,true));assert.equal(nextRetry.windowKind,'retry');
  const recovered=restart(completed(nextRetry,true));assert.equal(recovered.windowKind,'current');assert.equal(recovered.coverageGaps.length,0);
  assert.equal(recovered.coverageHadGap,true);assert.equal(recovered.coverageProof,null);
});

test('completed enumeration advances the next time window even with pending preservation while SQL checkpoint stays unchanged', async () => {
  const first = await simulate(continuousCfg, async operation => operation.state.phase === 'gmail_list'
    ? ok({ messages: [{ id: 'abcdef01' }] }) : ok(gmailMetadata('abcdef01', 1)));
  assert.equal(first.result.coverageComplete, true); assert.equal(first.result.allPreserved, false); assert.equal(first.result.scanFinished, false);
  assert.equal(first.result.checkpointAdvanced, false); assert.equal(first.state.coverageProof.receivedThrough, first.state.receivedThrough);
  const next = loadAuditState([first.row], continuousCfg, 'next-window', now + 600000);
  assert.equal(next.receivedFrom, new Date(Date.parse(first.state.receivedThrough) - 300000).toISOString());
  assert.equal(next.receivedThrough, new Date(now + 599000).toISOString());
  assert.notEqual(next.requestId, first.state.requestId); assert.equal(next.coverageProof.sweepId, first.state.sweepId);
});

test('a prior manual pilot proof is adopted without changing collector identity or rechecking the entire prior day', async () => {
  const first = await simulate(cfg, async () => ok({ messages: [],resultSizeEstimate: 0 }));
  assert.equal(first.state.coverageProof, undefined);
  const next = loadAuditState([first.row], continuousCfg, 'scheduled-after-pilot', now + 600000);
  assert.equal(next.identityHash, first.state.identityHash);
  assert.equal(next.receivedFrom, new Date(Date.parse(first.state.receivedThrough) - 300000).toISOString());
  assert.equal(next.coverageProof.sweepId, first.state.sweepId);
});

test('three repeated uncertain backend ACKs close the attempt as incomplete and retry from the same proved time through the new now', () => {
  let state = loadAuditState([], continuousCfg, 'first', now);
  const from = state.receivedFrom;
  state = applyAuditResponse(nextAuditOperation(state, continuousCfg, now), ok(run), continuousCfg, now);
  state = applyAuditResponse(nextAuditOperation(state, continuousCfg, now), ok({ messages: [{ id: 'abcdef01' }], nextPageToken: 'next' }), continuousCfg, now);
  for (let attempt = 0; attempt < 3; attempt++) {
    state.halt = false;
    state = applyAuditFailure(nextAuditOperation(state, continuousCfg, now), 'AUDIT_BACKEND_UNAVAILABLE', now);
  }
  assert.equal(state.failureStreak.count, 3); assert.equal(state.pendingEvents[0].kind, 'page_discovered');
  const saved = persisted(state, continuousCfg);
  const resumed = loadAuditState([saved.row], continuousCfg, 'close-incomplete', now + 900001);
  assert.equal(resumed.phase, 'finish'); assert.equal(resumed.abortIncomplete, true); assert.equal(resumed.coverageProof, null);
  const finish = nextAuditOperation(resumed, continuousCfg, now + 900001);
  assert.equal(finish.action, 'intake_finish');
  state = applyAuditResponse(finish, ok({ coverageComplete: false, allPreserved: false, scanFinished: false, checkpointAdvanced: false }), continuousCfg, now + 900001);
  const closed = persisted(state, continuousCfg), next = loadAuditState([closed.row], continuousCfg, 'retry-window', now + 1800000);
  assert.equal(next.receivedFrom, from); assert.equal(next.receivedThrough, new Date(now + 1799000).toISOString());
  assert.equal(next.coverageProof, null); assert.notEqual(next.requestId, state.requestId);
});

test('resumption nonce is persisted before its HTTP request and a lost ACK preserves nonce, window and pending page', () => {
  const recoveryCfg = { ...cfg, resumeFence: true };
  let state = loadAuditState([], recoveryCfg, 'first', now);
  state = applyAuditResponse(nextAuditOperation(state, recoveryCfg, now), ok(run), recoveryCfg, now);
  state = applyAuditResponse(nextAuditOperation(state, recoveryCfg, now), ok({ messages: [{ id: 'abcdef01' }], nextPageToken: 'next' }), recoveryCfg, now);
  const page = state.pendingEvents[0], saved = persisted({ ...state, releaseLease: true }, recoveryCfg);
  const resumed = loadAuditState([saved.row], recoveryCfg, 'second', now + 60000), durable = persisted(resumed, recoveryCfg);
  const request = nextAuditOperation(durable.state, recoveryCfg, now + 60000);
  assert.equal(request.action, 'intake_resume');
  assert.equal(JSON.parse(durable.row.state_json).resumeRequest.resumeRequestId, request.payload.resume_request_id);
  const lost = applyAuditFailure(request, 'AUDIT_BACKEND_UNAVAILABLE', now + 60000), lostRow = persisted({ ...lost, releaseLease: true }, recoveryCfg);
  const retry = loadAuditState([lostRow.row], recoveryCfg, 'third', now + 120000), replay = nextAuditOperation(retry, recoveryCfg, now + 120000);
  assert.deepEqual(replay.payload, request.payload); assert.deepEqual(retry.pendingEvents[0], page);
  const reply = { ...run, run_token: '33333333-3333-4333-a333-333333333333', resumed: true, replayed: true,
    collector_id: cfg.collectorId, scope_key: request.payload.scope_key, request_id: state.requestId,
    received_from: state.receivedFrom, received_through: state.receivedThrough, expires_at: new Date(now + 3600000).toISOString() };
  assert.throws(() => applyAuditResponse(replay, ok({ ...reply, received_from: new Date(now - 1000).toISOString() }), recoveryCfg, now + 120000), /RESUME_ACK_INVALID/);
  const restored = applyAuditResponse(replay, ok(reply), recoveryCfg, now + 120000);
  assert.equal(restored.resumeRequest, undefined); assert.equal(restored.runToken, reply.run_token); assert.deepEqual(restored.pendingEvents[0], page);
  const pending = nextAuditOperation(restored, recoveryCfg, now + 120000);
  assert.equal(pending.action, 'intake_event'); assert.equal(pending.payload.run_token, reply.run_token); assert.deepEqual(pending.payload.event, page);
});

test('a begin whose original ACK was lost obtains a resume fence before any provider read', () => {
  const recoveryCfg = { ...cfg, resumeFence: true }, fresh = loadAuditState([], recoveryCfg, 'begin-replay', now);
  const state = applyAuditResponse(nextAuditOperation(fresh, recoveryCfg, now), ok({ ...run, replayed: true }), recoveryCfg, now);
  assert.equal(nextAuditOperation(state, recoveryCfg, now).action, 'intake_resume');
});

test('lost finish ACK retries finish idempotently instead of attempting to resume a sweep that may already be closed', () => {
  const recoveryCfg = { ...cfg, resumeFence: true };
  const state = { ...loadAuditState([], recoveryCfg, 'finish-one', now), phase: 'finish', sweepId: run.sweep_id, runToken: run.run_token, halt: true };
  const saved = persisted({ ...state, releaseLease: true }, recoveryCfg), restored = loadAuditState([saved.row], recoveryCfg, 'finish-two', now + 1000);
  assert.equal(restored.resumeRequest, undefined); assert.equal(nextAuditOperation(restored, recoveryCfg, now + 1000).action, 'intake_finish');
});

test('failure identity survives three lease/token rotations for the same event and then closes the attempt explicitly', () => {
  const config = { ...continuousCfg, resumeFence: true };
  let state = loadAuditState([], config, 'event-one', now);
  state = applyAuditResponse(nextAuditOperation(state, config, now), ok(run), config, now);
  state = applyAuditResponse(nextAuditOperation(state, config, now), ok({ messages: [{ id: 'abcdef01' }], nextPageToken: 'next' }), config, now);
  const counts = [];
  for (let index = 0; index < 3; index++) {
    const row = persisted({ ...state, releaseLease: true }, config).row;
    state = loadAuditState([row], config, 'event-' + index, now + index * 1000);
    const resume = nextAuditOperation(state, config, now + index * 1000);
    assert.equal(resume.action, 'intake_resume');
    state = applyAuditResponse(resume, ok({ ...run, run_token: ['33333333-3333-4333-a333-333333333333','44444444-4444-4444-a444-444444444444','55555555-5555-4555-a555-555555555555'][index],
      resumed: true, replayed: false, expires_at: new Date(now + 3600000).toISOString(), collector_id: cfg.collectorId, scope_key: resume.payload.scope_key,
      request_id: state.requestId, received_from: state.receivedFrom, received_through: state.receivedThrough }), config, now + index * 1000);
    const event = nextAuditOperation(state, config, now + index * 1000); assert.equal(event.action, 'intake_event');
    state = applyAuditFailure(event, 'AUDIT_EVENT_REJECTED', now + index * 1000); counts.push(state.failureStreak.count);
  }
  assert.deepEqual(counts, [1, 2, 3]);
  const row = persisted({ ...state, releaseLease: true }, config).row, next = loadAuditState([row], config, 'close-failed-attempt', now + 5000);
  assert.equal(next.phase, 'finish'); assert.equal(next.abortIncomplete, true); assert.equal(nextAuditOperation(next, config, now + 5000).action, 'intake_finish');
});
