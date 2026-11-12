import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
async function module(name) {
  const source = await readFile(new URL(`../functions/exam-whatsapp-fallback/${name}.ts`, import.meta.url), 'utf8');
  return import('data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText).toString('base64'));
}
const { mergeDiscoveredOrigins, persistDiscoveredOrigins, DISCOVERY_BATCH_BYTES } = await module('discovery');
const { fallbackBackendError, isFallbackTransient, processFallbackOrigin } = await module('runner');
function origin(id, extra = {}) {
  return { source: { channel: 'whatsapp', account_id: 'chatwoot:1:inbox:2', message_id: '7', attachment_id: `chatwoot-attachment:${id}`,
    original_name: 'fixture.pdf', mime_type: 'application/pdf', received_at: '2026-11-11T00:00:00Z', metadata: {} },
    attachment: { downloadUrl: 'https://media.invalid/old' }, missing: false, pendingReason: null, ...extra };
}
const ack = args => ({ acknowledged: args.p_sources.length, enqueued: args.p_sources.length, unchanged: 0 });

test('fast/back overlap queues one identity while retaining fresh authorized media and late attachments', async () => {
  const stale = origin(1), fresh = origin(1, { attachment: { downloadUrl: 'https://media.invalid/fresh' } });
  const origins = mergeDiscoveredOrigins([stale], [fresh, origin(2)]);
  assert.equal(origins.size, 2); assert.equal([...origins.values()][0], fresh);
  const calls = [];
  const result = await persistDiscoveredOrigins(origins, async (name, args) => { calls.push({ name, args }); return ack(args); }, new AbortController().signal);
  assert.equal(calls.length, 1); assert.equal(calls[0].name, 'enqueue_exam_fallback_sources');
  assert.equal(result.acknowledged, 2); assert(!JSON.stringify(calls).includes('https://'));
});

test('batches respect item and byte limits without omitting any origin', async () => {
  for (const padding of [0, 6000]) {
    const items = Array.from({ length: 250 }, (_, i) => { const item = origin(i + 1); item.source.original_name = 'x'.repeat(padding) || 'fixture.pdf'; return item; });
    const calls = [];
    const result = await persistDiscoveredOrigins(mergeDiscoveredOrigins(items), async (_, args) => { calls.push(args.p_sources); return ack(args); }, new AbortController().signal);
    assert.equal(result.acknowledged, 250);
    for (const batch of calls) { assert(batch.length <= 100); assert(Buffer.byteLength(JSON.stringify(batch)) <= DISCOVERY_BATCH_BYTES); }
    assert.equal(new Set(calls.flat().map(s => s.attachment_id)).size, 250);
  }
});

test('partial ACK, failure and interruption stop subsequent batches for replay with unchanged cursor', async () => {
  const items = mergeDiscoveredOrigins(Array.from({ length: 250 }, (_, i) => origin(i + 1)));
  for (const failure of ['partial', 'lost', 'interrupt']) {
    let calls = 0; const controller = new AbortController();
    await assert.rejects(persistDiscoveredOrigins(items, async (_, args) => {
      calls++;
      if (failure === 'partial') return { ...ack(args), acknowledged: 99 };
      if (failure === 'lost') throw new Error('fallback_backend_unavailable');
      controller.abort(); return ack(args);
    }, controller.signal), /fallback_/);
    assert.equal(calls, 1);
  }
});

test('native backend failures open the circuit; business fences, authorization and malformed inputs do not', () => {
  for (const error of [{ code: '40001' }, { code: '08006' }, { code: '53300' }, { code: '57P03' }, { code: 'PGRST002' }, { message: 'Error: fallback_backend_unavailable' }]) {
    assert.equal(fallbackBackendError(error).message, 'fallback_backend_unavailable');
  }
  assert.equal(fallbackBackendError({ code: '57014' }).message, 'fallback_backend_timeout');
  assert.equal(fallbackBackendError({ code: 'PT409' }, 409).message, 'fallback_fence_conflict');
  assert.equal(fallbackBackendError({ code: '42501' }, 403).message, 'fallback_scope_denied');
  assert.equal(isFallbackTransient(fallbackBackendError({ code: '22023' }, 400).message), false);
  assert.equal(isFallbackTransient('fallback_run_deadline'), false);
  assert.equal(isFallbackTransient('pdf_size_invalid_or_exceeds_limit'), false);
});

test('runner ends on shared backend failure without per-item event or extra RPC', async () => {
  const calls = [];
  await assert.rejects(processFallbackOrigin(origin(1), 'fallback:test', {
    rpc: async name => { calls.push(name); throw new Error('fallback_backend_timeout'); },
    failure: async () => { calls.push('failure'); },
  }, {}), /fallback_backend_timeout/);
  assert.deepEqual(calls, ['reserve_exam_intake_source']);
});
