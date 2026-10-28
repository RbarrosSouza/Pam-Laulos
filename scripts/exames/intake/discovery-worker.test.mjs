import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRpcDiscoveryLedger, createFileContinuationStore, runIntakeDiscoveryWorker } from './discovery-worker.mjs';

const sweepId = '11111111-1111-4111-a111-111111111111', token = '22222222-2222-4222-a222-222222222222';
const scope = { provider: 'gmail', accountId: 'synthetic-mailbox', collectorId: 'synthetic-gmail-audit', credentialRef: 'existing-reference',
  requestId: '33333333-3333-4333-a333-333333333333', receivedFrom: '2026-10-26T00:00:00Z', receivedThrough: '2026-10-27T00:00:00Z',
  initialReceivedFrom: '2026-10-01T00:00:00Z', mode: 'audit' };
function fixture(pages) {
  const state = new Map(), calls = [], events = [], discovered = new Map();
  return { calls, events, discovered, state,
    continuationStore: { load: async key => state.has(key) ? structuredClone(state.get(key)) : null,
      save: async (key, value) => { state.set(key, structuredClone(value)); }, clear: async key => { state.delete(key); } },
    http: async request => { calls.push(['http', request]); return { status: 200, body: pages.shift() }; },
    rpc: async (name, args) => {
      calls.push(['rpc', name, structuredClone(args)]);
      if (name === 'begin_exam_intake_sweep') return { sweep_id: sweepId, run_token: token, mode: 'audit' };
      if (name === 'record_exam_intake_event') {
        assert.equal(args.p_sweep_id, sweepId); assert.equal(args.p_run_token, token);
        const event = args.p_event; events.push(event);
        assert(!JSON.stringify(event).includes('https://'), 'SQL events must not contain raw provider cursors or URLs');
        if (event.kind === 'page_discovered') for (const id of event.message_ids) discovered.set(event.partition_key + ':' + id, { partition: event.partition_key, id });
        return { recorded: true };
      }
      if (name === 'finish_exam_intake_sweep') return { coverageComplete: true, allPreserved: true, alertDeliveryComplete: true, scanFinished: true, checkpointAdvanced: false };
      throw new Error('unexpected RPC ' + name);
    },
    processMessages: async ({ ledger }) => {
      for (const { partition, id } of discovered.values()) await ledger.recordEvent({ kind: 'origins_declared', partition_key: partition,
        message_id: id, origins: [], policy_code: 'fixture_metadata_contains_no_pdf_or_notice' });
      return { complete: true };
    },
  };
}

test('worker wires provider discovery into SQL ledger and message processing before final confirmation', async () => {
  const testFixture = fixture([{ messages: [{ id: 'abcdef01' }] }]);
  const result = await runIntakeDiscoveryWorker({ scope, ...testFixture });
  assert.equal(result.scanFinished, true); assert.equal(result.checkpointAdvanced, false);
  const names = testFixture.calls.map(call => call[0] === 'rpc' ? call[1] + ':' + (call[2].p_event?.kind || '') : 'http');
  assert(names.indexOf('record_exam_intake_event:page_discovered') < names.indexOf('record_exam_intake_event:enumeration_complete'));
  assert(names.indexOf('record_exam_intake_event:origins_declared') < names.indexOf('finish_exam_intake_sweep:'));
  const begin = testFixture.calls.find(call => call[1] === 'begin_exam_intake_sweep')[2];
  assert.equal(begin.p_mode, 'audit'); assert.equal(begin.p_scope_manifest.sender_policy, 'all');
  assert.equal(begin.p_scope_manifest.policy_version, 'intake_v2'); assert.match(begin.p_scope_key, /^[a-f\d]{64}$/);
});

test('worker resumes the same fenced sweep across budget boundaries and never finishes the first partial call', async () => {
  const testFixture = fixture([{ messages: [{ id: 'abcdef01' }], nextPageToken: 'next-private-token' }, { messages: [{ id: 'abcdef02' }] }]);
  const partial = await runIntakeDiscoveryWorker({ scope, ...testFixture, budget: { maxPages: 1 } });
  assert.equal(partial.continuationRequired, true); assert.equal(partial.scanFinished, false);
  assert.equal(testFixture.calls.filter(call => call[1] === 'finish_exam_intake_sweep').length, 0);
  const completed = await runIntakeDiscoveryWorker({ scope, ...testFixture, budget: { maxPages: 1 } });
  assert.equal(completed.scanFinished, true);
  assert.equal(testFixture.calls.filter(call => call[1] === 'begin_exam_intake_sweep').length, 1);
  assert.equal(testFixture.calls.filter(call => call[0] === 'http').length, 2);
  assert.equal(testFixture.discovered.size, 2);
  const enumEvent = testFixture.events.find(event => event.kind === 'enumeration_complete');
  assert.equal(enumEvent.expected_message_count, 2); assert.equal(enumEvent.page_count, 2);
});

test('pending message processing keeps the sweep open; resumption reuses discovery and does not fetch providers again', async () => {
  const testFixture = fixture([{ messages: [{ id: 'abcdef01' }] }]);
  const pending = await runIntakeDiscoveryWorker({ scope, ...testFixture, processMessages: async () => ({ complete: false }) });
  assert.equal(pending.discoveryComplete, true); assert.equal(pending.scanFinished, false);
  assert.equal(testFixture.calls.filter(call => call[1] === 'finish_exam_intake_sweep').length, 0);
  const completed = await runIntakeDiscoveryWorker({ scope, ...testFixture });
  assert.equal(completed.scanFinished, true);
  assert.equal(testFixture.calls.filter(call => call[0] === 'http').length, 1);
});

test('HTTP and ledger failures remain explicit incomplete results, with no checkpoint or final confirmation', async () => {
  const testFixture = fixture([]);
  const result = await runIntakeDiscoveryWorker({ scope, ...testFixture, http: async () => ({ status: 503, body: {} }) });
  assert.equal(result.scanFinished, false); assert.equal(result.coverageComplete, false); assert.equal(result.checkpointAdvanced, false);
  assert.equal(result.failureRecorded, true);
  assert(testFixture.events.some(event => event.kind === 'failure'));
  assert.equal(testFixture.calls.filter(call => call[1] === 'finish_exam_intake_sweep').length, 0);
});

test('worker rejects missing processing integration before beginning any sweep and refuses cross-scope resume', async () => {
  const testFixture = fixture([{ messages: [{ id: 'abcdef01' }], nextPageToken: 'next' }]);
  await assert.rejects(runIntakeDiscoveryWorker({ scope, ...testFixture, processMessages: undefined }), /dependencies_invalid/);
  assert.equal(testFixture.calls.length, 0);
  await runIntakeDiscoveryWorker({ scope, ...testFixture, budget: { maxPages: 1 } });
  await assert.rejects(runIntakeDiscoveryWorker({ scope: { ...scope, accountId: 'other-account' }, ...testFixture }), /resume_scope_mismatch/);
});

test('Graph pages persist only cursor hashes into SQL while preserving immutable IDs in the private continuation', async () => {
  const next = 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=private%3D';
  const testFixture = fixture([{ value: [{ id: 'Case+One=', receivedDateTime: '2026-10-26T12:00:00Z', hasAttachments: false }], '@odata.nextLink': next }, { value: [] }]);
  const outlookScope = { ...scope, provider: 'outlook', collectorId: 'synthetic-outlook-audit' };
  const result = await runIntakeDiscoveryWorker({ scope: outlookScope, ...testFixture });
  assert.equal(result.scanFinished, true);
  assert(testFixture.events.some(event => event.kind === 'message_discovered' && event.received_at === '2026-10-26T12:00:00.000Z'));
  const httpCalls = testFixture.calls.filter(call => call[0] === 'http');
  assert.equal(httpCalls[1][1].url, next);
  assert(httpCalls.every(call => call[1].headers.Prefer === 'IdType="ImmutableId"'));
});

test('hierarchical Chatwoot worker includes conversation pages and every conversation-message partition in coverage', async () => {
  const testFixture = fixture([{ data: { payload: [{ id: 300, inbox_id: 2 }] } }, { data: { payload: [] } },
    { payload: [{ id: 10, conversation_id: 300, message_type: 1, private: true, created_at: 1793000000 }] }, { payload: [] }]);
  const chatwootScope = { ...scope, provider: 'chatwoot', collectorId: 'synthetic-chatwoot-audit', baseUrl: 'https://support.example.invalid', chatwootAccountId: 1, inboxId: 2 };
  const result = await runIntakeDiscoveryWorker({ scope: chatwootScope, ...testFixture });
  assert.equal(result.scanFinished, true);
  const pageEvents = testFixture.events.filter(event => event.kind === 'page_discovered');
  assert.equal(pageEvents.length, 4); assert(pageEvents.some(event => event.partition_key === 'conversation:300'));
  const inventory = testFixture.events.find(event => event.kind === 'enumeration_complete');
  assert.equal(inventory.expected_message_count, 1); assert.equal(inventory.page_count, 4);
});

test('private file continuation store survives a new adapter instance and creates files with mode 0600', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'exam-intake-continuation-'));
  try {
    const original = createFileContinuationStore(directory);
    await original.save('mailbox:private', { cursor: 'opaque-secret-next-token', pageCount: 4 });
    const restored = createFileContinuationStore(directory);
    assert.deepEqual(await restored.load('mailbox:private'), { cursor: 'opaque-secret-next-token', pageCount: 4 });
    const files = await fs.readdir(directory);
    assert.equal(files.length, 1); assert.equal((await fs.stat(path.join(directory, files[0]))).mode & 0o777, 0o600);
    await restored.clear('mailbox:private'); assert.equal(await restored.load('mailbox:private'), null);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('RPC discovery binding stores the whole page transaction before per-message timestamp metadata', async () => {
  const events = [];
  const ledger = createRpcDiscoveryLedger({ sweepId, runToken: token, rpc: async (_name, args) => { events.push(args.p_event); return { recorded: true }; } });
  await ledger.recordDiscoveryPage({ partitionKey: 'mailbox', pageKey: 'a'.repeat(64), requestCursorHash: 'b'.repeat(64), nextCursorHash: null,
    digest: 'c'.repeat(64), isTerminal: true, messageIds: ['mailOne'], records: [{ id: 'mailOne', receivedAt: 1793000000 }] });
  assert.deepEqual(events.map(event => event.kind), ['page_discovered', 'message_discovered']);
  assert.equal(events[1].received_at, new Date(1793000000 * 1000).toISOString());
});
