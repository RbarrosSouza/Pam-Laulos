// Executes the actual Edge handler with offline adapters. SQL/CAS and provider
// completeness are tested separately; this suite never contacts a real service.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const sweepId = '71000000-0000-4000-8000-000000000001';
const requestId = '71000000-0000-4000-8000-000000000002';
const revision = '7'; // PostgreSQL bigint is carried as an exact decimal string.
const memberId = '71000000-0000-4000-8000-000000000004';
const scopeKey = 'a'.repeat(64);
const env = new Map([
  ['SUPABASE_URL', 'https://offline-fixture.invalid'],
  ['SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service-secret'],
  ['EXAM_INGESTION_API_KEY', 'synthetic-worker-secret'],
]);
const rpcCalls = [];
const networkCalls = [];
const clientCalls = [];
let rpcFailure = null;

const client = {
  auth: {
    async getUser(token) {
      if (token === 'synthetic-member-token') return {data: {user: {id: memberId}}, error: null};
      if (token === 'synthetic-outsider-token') return {data: {user: {id: requestId}}, error: null};
      return {data: {user: null}, error: {message: 'synthetic authentication failure'}};
    },
  },
  from(name) {
    assert.equal(name, 'exam_document_member', 'collection routes must not read clinical files');
    const filters = new Map();
    const chain = {
      select() { return chain; },
      eq(key, value) { filters.set(key, value); return chain; },
      async maybeSingle() {
        return {data: filters.get('user_id') === memberId && filters.get('active') === true
          ? {user_id: memberId, active: true} : null, error: null};
      },
    };
    return chain;
  },
  async rpc(name, args) {
    // Copy the VM object so cross-realm prototypes cannot hide an argument change.
    const copied = JSON.parse(JSON.stringify(args));
    rpcCalls.push({name, args: copied});
    return rpcFailure ? {data: null, error: rpcFailure} : {data: {rpc: name, args: copied}, error: null};
  },
};

const keyExports={};
const keySource=await readFile(new URL('../functions/exam-document-service/supabase-privileged-key.ts',import.meta.url),'utf8');
vm.runInNewContext(ts.transpileModule(keySource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports:keyExports});
const intakeExports={};
const intakeSource=await readFile(new URL('../functions/exam-document-service/intake-service-routes.ts',import.meta.url),'utf8');
vm.runInNewContext(ts.transpileModule(intakeSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports:intakeExports,TextEncoder});
const monitorAuthExports={};
const monitorAuthSource=await readFile(new URL('../functions/exam-document-service/intake-monitor-auth.ts',import.meta.url),'utf8');
vm.runInNewContext(ts.transpileModule(monitorAuthSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports:monitorAuthExports});
let handler;
const source = await readFile(new URL('../functions/exam-document-service/index.ts', import.meta.url), 'utf8');
const script = ts.transpileModule(source.replace(/^import .*;\s*$/gm, ''), {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None},
}).outputText;
vm.runInNewContext(script, {
  ...monitorAuthExports,
  intakeActions:intakeExports.intakeActions,runIntakeAction:intakeExports.runIntakeAction,
  selectExamSupabasePrivilegedKey:keyExports.selectExamSupabasePrivilegedKey,
  createClient(url, key, options) {
    clientCalls.push({url, key, options});
    return client;
  },
  Deno: {env: {get: key => env.get(key)}, serve(fn) { handler = fn; }},
  Request, Response, File, Blob, FormData, URL, URLSearchParams, crypto,
  TextDecoder, Uint8Array, ArrayBuffer, Date,
  fetch: async (...args) => {
    networkCalls.push(args);
    throw new Error('External I/O is forbidden in collection handler fixtures');
  },
  composioReaderConfig() { throw new Error('Collection must not use the PDF reader'); },
  readComposioDriveOriginal() { throw new Error('Collection must not use the PDF reader'); },
});
assert.equal(typeof handler, 'function');

function reset() {
  rpcCalls.length = 0;
  networkCalls.length = 0;
  clientCalls.length = 0;
  rpcFailure = null;
}
async function request(action, payload = {}, auth = 'synthetic-worker-secret') {
  return handler(new Request('https://offline-fixture.invalid/exam-document-service', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', ...(auth ? {Authorization: `Bearer ${auth}`} : {})},
    body: JSON.stringify({action, payload}),
  }));
}
async function expectRpc(action, payload, name, args) {
  const response = await request(action, payload);
  assert.equal(response.status, 200);
  assert.deepEqual(rpcCalls, [{name, args}]);
  assert.deepEqual(await response.json(), {rpc: name, args});
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(networkCalls.length, 0);
}

const actions = ['collection_checkpoint', 'collection_begin', 'collection_event', 'collection_commit'];

test('existing n8n origin and metadata actions reach the guarded intake wrappers', async () => {
  reset();
  const source={channel:'email',account_id:'gmail:fixture@example.invalid',message_id:'1111222233334444',attachment_id:'hopelab-link:'+scopeKey,metadata:{hopelab_notice_protocol:'gmail_notice_link_v2',gmail_message_id:'1111222233334444',link_sha256:scopeKey}};
  await expectRpc('reserve_source',{source},'reserve_exam_intake_source',{p_source:source});
  reset();
  await expectRpc('stage_file',{document_id:sweepId,file:{sha256:scopeKey,size_bytes:123,staging_bucket:'blocked',staging_path:'blocked'},worker:'n8n-fixture'},'stage_exam_intake_file',{p_document_id:sweepId,p_file:{sha256:scopeKey,size_bytes:123},p_worker:'n8n-fixture'});
});

test('all collection routes refuse missing or invalid authentication before an RPC', async () => {
  for (const auth of [null, 'synthetic-expired-token']) for (const action of actions) {
    reset();
    assert.equal((await request(action, {}, auth)).status, 401);
    assert.equal(rpcCalls.length, 0);
    assert.equal(networkCalls.length, 0);
  }
});

test('active exam membership does not grant worker collection actions', async () => {
  for (const action of actions) {
    reset();
    assert.equal((await request(action, {}, 'synthetic-member-token')).status, 403);
    assert.equal(rpcCalls.length, 0);
    assert.equal(networkCalls.length, 0);
  }
});

test('missing worker configuration cannot turn a supplied worker string into authorization', async () => {
  const workerSecret = env.get('EXAM_INGESTION_API_KEY');
  env.delete('EXAM_INGESTION_API_KEY');
  try {
    for (const action of actions) {
      reset();
      assert.equal((await request(action)).status, 401);
      assert.equal(rpcCalls.length, 0);
      assert.equal(networkCalls.length, 0);
    }
  } finally {
    env.set('EXAM_INGESTION_API_KEY', workerSecret);
  }
});

test('authenticated outsiders cannot inspect checkpoints or mutate collection state', async () => {
  for (const action of actions) {
    reset();
    assert.equal((await request(action, {}, 'synthetic-outsider-token')).status, 403);
    assert.equal(rpcCalls.length, 0);
  }
});

test('checkpoint routes exact scope and optional sweep without using file/provider adapters', async () => {
  reset();
  await expectRpc('collection_checkpoint', {collector_id: 'fixture-collector', scope_key: scopeKey},
    'load_exam_collection_checkpoint', {p_collector_id: 'fixture-collector', p_scope_key: scopeKey, p_sweep_id: null});
  reset();
  await expectRpc('collection_checkpoint', {collector_id: 'fixture-collector', scope_key: scopeKey, sweep_id: sweepId},
    'load_exam_collection_checkpoint', {p_collector_id: 'fixture-collector', p_scope_key: scopeKey, p_sweep_id: sweepId});
});

test('begin carries manifest, closed window, CAS revision and caller request UUID', async () => {
  reset();
  const manifest = {account_id: 'outlook_fixture', mailbox: 'me', folder_ids: ['inbox'], identity_policy: 'require_translation'};
  const payload = {collector_id: 'fixture-collector', scope_key: scopeKey, scope_manifest: manifest,
    received_from: '2026-10-09T00:00:00Z', received_through: '2026-10-10T00:00:00Z',
    expected_revision: revision, request_id: requestId, ttl_seconds: 120,
    extra_ignored_field: 'must-not-enter-rpc'};
  await expectRpc('collection_begin', payload, 'begin_exam_collection_sweep', {
    p_collector_id: payload.collector_id, p_scope_key: scopeKey, p_scope_manifest: manifest,
    p_received_from: payload.received_from, p_received_through: payload.received_through,
    p_expected_revision: revision, p_request_id: requestId, p_ttl_seconds: 120,
  });
});

test('first begin preserves null revision and uses the documented default TTL', async () => {
  reset();
  const payload = {collector_id: 'fixture-collector', scope_key: scopeKey, scope_manifest: {},
    received_from: '2026-10-09T00:00:00Z', received_through: '2026-10-10T00:00:00Z', request_id: requestId};
  await expectRpc('collection_begin', payload, 'begin_exam_collection_sweep', {
    p_collector_id: payload.collector_id, p_scope_key: scopeKey, p_scope_manifest: {},
    p_received_from: payload.received_from, p_received_through: payload.received_through,
    p_expected_revision: null, p_request_id: requestId, p_ttl_seconds: 900,
  });
});

test('event forwards only its sweep UUID and event contract to the durable RPC', async () => {
  reset();
  const event = {kind: 'origin_discovered', origin: {account_id: 'outlook_fixture', message_id: 'm1', attachment_id: 'a1'}};
  await expectRpc('collection_event', {sweep_id: sweepId, event, another_field: 'ignored'},
    'record_exam_collection_event', {p_sweep_id: sweepId, p_event: event});
});

test('commit keeps expected revision distinct from sweep identity and does not accept client success counts', async () => {
  reset();
  await expectRpc('collection_commit', {sweep_id: sweepId, expected_revision: revision, counts: {saved: 999}},
    'commit_exam_collection_sweep', {p_sweep_id: sweepId, p_expected_revision: revision});
  reset();
  await expectRpc('collection_commit', {sweep_id: sweepId},
    'commit_exam_collection_sweep', {p_sweep_id: sweepId, p_expected_revision: null});
});

test('invalid required or optional UUIDs cannot reach any collection RPC', async () => {
  const malformed = [
    ['collection_checkpoint', {collector_id: 'fixture', scope_key: scopeKey, sweep_id: 'not-a-uuid'}],
    ['collection_begin', {request_id: 'not-a-uuid'}],
    ['collection_begin', {}],
    ['collection_event', {sweep_id: 'not-a-uuid', event: {}}],
    ['collection_event', {event: {}}],
    ['collection_commit', {sweep_id: 'not-a-uuid'}],
    ['collection_commit', {}],
  ];
  for (const [action, payload] of malformed) {
    reset();
    assert.equal((await request(action, payload)).status, 400);
    assert.equal(rpcCalls.length, 0);
    assert.equal(networkCalls.length, 0);
  }
});

test('controlled database failures remain failures with permission and CAS statuses', async () => {
  for (const [code, status] of [['42501', 403], ['40001', 409], ['22023', 400]]) {
    reset();
    rpcFailure = {code, message: 'Falha controlada da fixture'};
    const response = await request('collection_commit', {sweep_id: sweepId});
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), {error: rpcFailure.message, code: 'EXAM_DOCUMENT_ERROR'});
    assert.equal(rpcCalls.length, 1);
    assert.equal(networkCalls.length, 0);
  }
});

test('collection RPC arguments and responses never receive the worker/service credential', async () => {
  reset();
  const response = await request('collection_checkpoint', {collector_id: 'fixture-collector', scope_key: scopeKey});
  assert.equal(response.status, 200);
  const serialized = JSON.stringify(rpcCalls) + await response.text();
  for (const secret of [env.get('EXAM_INGESTION_API_KEY'), env.get('SUPABASE_SERVICE_ROLE_KEY')]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(clientCalls.length, 1);
  assert.equal(networkCalls.length, 0);
});
