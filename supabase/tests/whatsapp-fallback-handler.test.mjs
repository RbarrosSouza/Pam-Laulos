import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import ts from 'typescript';

// Execute the real handler and relative modules. Only the Supabase client and
// provider HTTP boundary are replaced; no production endpoint is contacted.
const root = fileURLToPath(new URL('../functions/', import.meta.url));
const secret = 'synthetic-fallback-handler-key-at-least-32-bytes';
const runToken = '11111111-1111-4111-8111-111111111111';
let directory, handler, active;
const previousDeno = globalThis.Deno, previousFetch = globalThis.fetch;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'fallback-handler-'));
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(join(directory, 'client.mjs'), 'export const createClient=(...args)=>globalThis.__fallbackHandlerFixture.createClient(...args);');
  const compiled = new Map();
  async function compile(file) {
    if (compiled.has(file)) return compiled.get(file);
    const target = join(directory, relative(root, file).replace(/\.ts$/, '.js'));
    compiled.set(file, target);
    const text = await readFile(file, 'utf8');
    let js = file.endsWith('.ts') ? ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText : text;
    const tree = ts.createSourceFile(target, js, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    const replacements = [];
    for (const node of tree.statements) {
      if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
      const spec = node.moduleSpecifier;
      if (!spec || !ts.isStringLiteral(spec)) continue;
      let destination;
      if (spec.text.startsWith('https://esm.sh/@supabase/supabase-js@')) destination = join(directory, 'client.mjs');
      else if (spec.text.startsWith('.')) destination = await compile(resolve(dirname(file), spec.text));
      else { assert.equal(spec.text, 'node:buffer', 'unexpected external import'); continue; }
      replacements.push([spec.getStart(tree), spec.end, JSON.stringify(pathToFileURL(destination).href)]);
    }
    for (const [start, end, value] of replacements.sort((a, b) => b[0] - a[0])) js = js.slice(0, start) + value + js.slice(end);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, js);
    return target;
  }
  globalThis.Deno = { env: { get: name => active?.env[name] }, serve: value => { handler = value; } };
  globalThis.fetch = (...args) => active.fetch(...args);
  await import(pathToFileURL(await compile(join(root, 'exam-whatsapp-fallback/index.ts'))).href);
});
after(async () => {
  globalThis.Deno = previousDeno;
  globalThis.fetch = previousFetch;
  delete globalThis.__fallbackHandlerFixture;
  if (directory) await rm(directory, { recursive: true, force: true });
});

function fixture(options = {}) {
  const cfg = { enabled: true, received_from: '2026-11-03T00:00:00Z', minimum_age_seconds: 120,
    source_account_id: 'chatwoot:1:inbox:2', source_conversation_id: '3' };
  const state = { rpc: [], reads: [], http: [], cfg, env: {
    EXAM_FALLBACK_TRIGGER_KEY: secret, SUPABASE_URL: 'https://backend.example.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic-unused-client-key', EXAM_FALLBACK_CHATWOOT_API_TOKEN: 'synthetic-token',
    EXAM_FALLBACK_CONFIG: JSON.stringify({ chatwootBaseUrl: 'https://chatwoot.example.invalid', authorizedSenders: ['5511999998888'], documentBaseUrl: 'https://documents.example.invalid' }),
  } };
  state.createClient = () => ({
    rpc: async (name, args) => {
      state.rpc.push({ name, args });
      const custom = await options.rpc?.(name, args, state);
      if (custom !== undefined) return custom;
      let data;
      if (name === 'consume_exam_fallback_scheduler_trigger') data = { accepted: true, request_id: 71 };
      else if (name === 'claim_exam_fallback_run_health') data = options.claim || { claimed: true, run_token: runToken, config: cfg, scan: {} };
      else if (name.startsWith('checkpoint_exam_fallback_run')) data = { recorded: true };
      else if (name === 'enqueue_exam_fallback_sources') data = { acknowledged: args.p_sources.length, enqueued: args.p_sources.length, unchanged: 0 };
      else if (['list_exam_fallback_group_reconciliation', 'claim_exam_fallback_sources'].includes(name)) data = { tasks: [] };
      else throw new Error('Unexpected RPC: ' + name);
      return { data, error: null, status: 200 };
    },
    from: table => {
      state.reads.push(table);
      const query = { select: () => query, eq: () => query, single: async () => {
        if (table === 'exam_fallback_configuration') return { data: cfg, error: null };
        assert.equal(table, 'exam_document_configuration');
        return { data: { group_destination_key: 'chatwoot:1:2:4:12345678@g.us', max_file_bytes: 20 * 1024 * 1024 }, error: null };
      } };
      return query;
    },
  });
  state.fetch = async (url, init = {}) => {
    state.http.push({ url: String(url), method: init.method || 'GET' });
    assert.equal(new URL(url).origin, 'https://chatwoot.example.invalid');
    assert.equal(init.method, 'GET', 'handler fixtures must never send messages');
    if (options.providerStatus) return Response.json({ error: 'synthetic-provider-failure' }, { status: options.providerStatus });
    if (new URL(url).pathname.endsWith('/messages')) {
      const beforeId = new URL(url).searchParams.get('before');
      return Response.json({ payload: (options.messages || []).filter(row => beforeId === null || BigInt(row.id) < BigInt(beforeId)) });
    }
    return Response.json({ id: 3, account_id: 1, inbox_id: 2, meta: { sender: { id: 7, type: 'contact', phone_number: '5511999998888' } }, contact_inbox: { source_id: '5511999998888@s.whatsapp.net' } });
  };
  active = state; globalThis.__fallbackHandlerFixture = state;
  return state;
}
const request = (authorization = 'Bearer ' + secret) => new Request('https://function.example.invalid', { method: 'POST', headers: { Authorization: authorization }, body: '{"action":"run"}' });
const backendFailure = () => ({ data: null, error: { code: 'PGRST003', message: 'synthetic backend timeout' }, status: 503 });
const sourceMessage = () => ({ id: 300, account_id: 1, inbox_id: 2, conversation_id: 3, private: false, message_type: 0,
  created_at: Date.parse('2026-11-04T10:00:00Z') / 1000, sender: { id: 7, type: 'contact', phone_number: '5511999998888' },
  attachments: [{ id: 1300, message_id: 300, account_id: 1, file_name: 'Synthetic.pdf', content_type: 'application/pdf', file_size: 123,
    data_url: 'https://chatwoot.example.invalid/rails/blob/synthetic.pdf?signature=fixture' }] });
async function scheduledRequest() {
  const body = '{"action":"run"}', nonce = crypto.randomUUID(), stamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(stamp + '\n' + nonce + '\n' + body)));
  return new Request('https://function.example.invalid', { method: 'POST', body, headers: { 'x-exam-fallback-timestamp': stamp,
    'x-exam-fallback-nonce': nonce, 'x-exam-fallback-signature': Buffer.from(signed).toString('hex') } });
}

test('unauthorized request does not touch backend or provider', async () => {
  const state = fixture(); const response = await handler(request('Bearer invalid'));
  assert.equal(response.status, 401); assert.equal(state.rpc.length + state.reads.length + state.http.length, 0);
});
test('cooldown exits before configuration reads or provider work', async () => {
  const state = fixture({ claim: { claimed: false, reason: 'cooldown', retry_after_seconds: 120 } });
  const response = await handler(request()); const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.claimed, false); assert.equal(body.reason, 'cooldown');
  assert.deepEqual(state.rpc.map(x => x.name), ['claim_exam_fallback_run_health']);
  assert.equal(state.reads.length + state.http.length, 0);
});
test('failed claim halts without starting discovery or repeatedly calling the backend', async () => {
  const state = fixture({ rpc: name => name === 'claim_exam_fallback_run_health' ? backendFailure() : undefined });
  const response = await handler(request());
  assert.equal(response.status, 503); assert.deepEqual(state.rpc.map(x => x.name), ['claim_exam_fallback_run_health']);
  assert.equal(state.http.length, 0);
});
test('signed trigger consumption failure stops before claim, configuration, or provider access', async () => {
  const state = fixture({ rpc: name => name === 'consume_exam_fallback_scheduler_trigger' ? backendFailure() : undefined });
  const response = await handler(await scheduledRequest());
  assert.equal(response.status, 503);
  assert.deepEqual(state.rpc.map(x => x.name), ['consume_exam_fallback_scheduler_trigger']);
  assert.equal(state.reads.length + state.http.length, 0);
});
test('healthy empty scan retains one-minute operation and checkpoints without enqueuing or sending', async () => {
  const state = fixture(); const response = await handler(request());
  assert.equal(response.status, 200);
  assert.equal(state.rpc.filter(x => x.name === 'enqueue_exam_fallback_sources').length, 0);
  const checkpoints = state.rpc.filter(x => x.name.startsWith('checkpoint_exam_fallback_run'));
  assert.equal(checkpoints.length, 1); assert.equal(checkpoints[0].args.p_completed, true);
  assert.equal(checkpoints[0].args.p_error_code, null); assert.equal((await response.json()).processed, 0);
});
test('provider failure cannot become a healthy completed scan or dispatch', async () => {
  const state = fixture({ providerStatus: 503 }); const response = await handler(request()); await response.json();
  const checkpoints = state.rpc.filter(x => x.name.startsWith('checkpoint_exam_fallback_run'));
  assert.equal(checkpoints.length, 1); assert.equal(checkpoints[0].args.p_completed, false);
  assert.notEqual(checkpoints[0].args.p_error_code, null);
  assert(!state.rpc.some(x => ['enqueue_exam_fallback_sources', 'claim_exam_fallback_sources'].includes(x.name)));
});
test('overlapping fast and historical pages enqueue one identity while retaining the pending work queue', async () => {
  const state = fixture({ messages: [sourceMessage()] }); const response = await handler(request());
  assert.equal(response.status, 200);
  const batches = state.rpc.filter(x => x.name === 'enqueue_exam_fallback_sources');
  assert.equal(batches.flatMap(x => x.args.p_sources).length, 1);
  assert(!state.rpc.some(x => x.name === 'enqueue_exam_fallback_source'));
  assert(state.rpc.some(x => x.name === 'claim_exam_fallback_sources'));
  assert(state.rpc.some(x => x.name.startsWith('checkpoint_exam_fallback_run') && x.args.p_completed));
});
test('batch failure stops processing and preserves the unconfirmed scan for the next attempt', async () => {
  const state = fixture({ messages: [sourceMessage()], rpc: name => name === 'enqueue_exam_fallback_sources' ? backendFailure() : undefined });
  const response = await handler(request());
  assert.equal(response.status, 503);
  assert.equal(state.rpc.filter(x => x.name === 'enqueue_exam_fallback_sources').length, 1);
  assert(!state.rpc.some(x => x.name === 'claim_exam_fallback_sources'));
  const checkpoints = state.rpc.filter(x => x.name.startsWith('checkpoint_exam_fallback_run'));
  assert(checkpoints.length <= 1);
  for (const checkpoint of checkpoints) { assert.equal(checkpoint.args.p_completed, false); assert.deepEqual(checkpoint.args.p_state, {}); }
});
test('incomplete batch acknowledgement cannot advance discovery or claim clinical work', async () => {
  const state = fixture({ messages: [sourceMessage()], rpc: name => name === 'enqueue_exam_fallback_sources' ? { data: { acknowledged: 0, enqueued: 0, unchanged: 0 }, error: null, status: 200 } : undefined });
  const response = await handler(request());
  assert(response.status >= 400);
  assert(!state.rpc.some(x => x.name === 'claim_exam_fallback_sources'));
  for (const checkpoint of state.rpc.filter(x => x.name.startsWith('checkpoint_exam_fallback_run'))) {
    assert.equal(checkpoint.args.p_completed, false); assert.deepEqual(checkpoint.args.p_state, {});
  }
});
test('signed healthy run carries its exact request ID through claim and checkpoint', async () => {
  const state = fixture(); const response = await handler(await scheduledRequest());
  assert.equal(response.status, 200);
  const claim = state.rpc.find(x => x.name === 'claim_exam_fallback_run_health');
  const checkpoint = state.rpc.find(x => x.name === 'checkpoint_exam_fallback_run_health');
  assert.equal(claim.args.p_scheduler_request_id, 71);
  assert.equal(checkpoint.args.p_scheduler_request_id, 71);
  assert.equal(checkpoint.args.p_health, 'healthy');
});
test('failed checkpoint is attempted only once and leaves the HTTP failure for scheduler reconciliation', async () => {
  const state = fixture({ rpc: name => name === 'checkpoint_exam_fallback_run_health' ? backendFailure() : undefined });
  const response = await handler(await scheduledRequest());
  assert.equal(response.status, 503);
  assert.equal(state.rpc.filter(x => x.name === 'checkpoint_exam_fallback_run_health').length, 1);
});
test('provider authorization failure is neutral and cannot masquerade as a server outage', async () => {
  const state = fixture({ providerStatus: 401 }); const response = await handler(request());
  assert.equal(response.status, 422);
  const checkpoint = state.rpc.find(x => x.name === 'checkpoint_exam_fallback_run_health');
  assert.equal(checkpoint.args.p_health, 'neutral'); assert.equal(checkpoint.args.p_completed, false);
});
test('deterministic claim fence returns 409 without triggering a transient failure checkpoint', async () => {
  const state = fixture({ rpc: name => name === 'claim_exam_fallback_run_health' ? { data: null, error: { code: 'PT409', message: 'fenced' }, status: 409 } : undefined });
  const response = await handler(request());
  assert.equal(response.status, 409);
  assert.deepEqual(state.rpc.map(x => x.name), ['claim_exam_fallback_run_health']);
});
