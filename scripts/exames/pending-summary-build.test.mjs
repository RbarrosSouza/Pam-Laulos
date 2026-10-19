import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildPendingSummaryWorkflows, writePendingSummaryWorkflows } from './pending-summary-build.mjs';

const asOf = '2026-10-19T11:00:00Z', id = '10000000-0000-4000-8000-000000000001', token = '20000000-0000-4000-8000-000000000001';
const settings = { config: { enabled: true, dryRun: false,
  serviceUrl: 'https://backend.example.invalid/functions/v1/exam-document-service', chatwootBaseUrl: 'https://support.example.invalid',
  pamLaudosBaseUrl: 'https://pamlaudos.example.invalid', accountId: 1, inboxId: 2, conversationId: 3, groupJid: '123456@g.us' },
credentials: { worker: { id: 'EXISTING_SYNTHETIC_WORKER', name: 'Existing synthetic worker' }, chatwoot: { id: 'EXISTING_SYNTHETIC_CHATWOOT', name: 'Existing synthetic Chatwoot' } } };
const workflows = await buildPendingSummaryWorkflows(settings), neutral = await buildPendingSummaryWorkflows();
const node = (name, workflow = workflows.daily) => workflow.nodes.find(value => value.name === name);
const snapshot = total => ({ claimed: true, summary_id: id, lease_token: token, day: '2026-10-19', as_of: asOf,
  destination_key: 'chatwoot:1:2:3:123456@g.us', has_more: false, total,
  documents: total ? [{ document_id: '30000000-0000-4000-8000-000000000001', pet_name: 'Pet de demonstração', client_name: 'Tutora de demonstração',
    responsible_vet_id: null, first_group_sent_at: '2026-10-18T11:00:00Z' }] : [] });
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [asOf])); } static now() { return Date.parse(asOf); } }
const plain = value => JSON.parse(JSON.stringify(value));

function sandbox(json, outputs, all = [{ json }]) {
  return { $json: json, $input: { first: () => all[0], all: () => all },
    $execution: { id: 'synthetic-execution', mode: 'manual' },
    $: name => ({ first: () => outputs[name]?.[0], item: outputs[name]?.at(-1), all: () => outputs[name] || [] }),
    Date: FixedDate, Intl, Buffer, require: name => { throw new Error('No module allowed: ' + name); } };
}
function expression(value, json, outputs) {
  return new vm.Script('(' + value.slice(3, -2).trim() + ')').runInNewContext(sandbox(json, outputs));
}
async function run(workflow, state = {}, { empty = false, losePost = false, loseBegin = false, loseResult = false } = {}) {
  const outputs = {}, queue = [['Executar manualmente', {}]];
  state.posts ??= []; state.actions ??= []; state.reads ??= [];
  while (queue.length) {
    const [name, json] = queue.shift(), n = node(name, workflow);
    let result = [{ json }], branch = 0;
    if (n.type.endsWith('code')) result = await new vm.Script('(async function(){' + n.parameters.jsCode + '})()').runInNewContext(sandbox(json, outputs));
    else if (n.type.endsWith('if')) branch = expression(n.parameters.conditions.conditions[0].leftValue, json, outputs) === true ? 0 : 1;
    else if (n.type.endsWith('httpRequest')) {
      const method = n.parameters.method, url = expression(n.parameters.url, json, outputs);
      if (url.includes('/exam-document-service')) {
        const body = JSON.parse(expression(n.parameters.jsonBody, json, outputs)); state.actions.push(body.action);
        let response;
        if (body.action === 'pending_summary_preview') response = { ...snapshot(empty ? 0 : 1), claimed: undefined };
        else if (body.action === 'pending_summary_reserve') {
          response = state.claimed ? { claimed: false, status: state.started ? 'uncertain' : 'reserved' } : empty ? { claimed: false, status: 'empty', total: 0 } : snapshot(1);
          state.claimed = true;
        } else if (body.action === 'pending_summary_begin') {
          assert.equal(body.payload.destination_key, snapshot(1).destination_key);
          assert.equal(typeof body.payload.content, 'string');
          response = state.started ? { dispatch_allowed: false } : { dispatch_allowed: true, summary_id: id,
            content_sha256: crypto.createHash('sha256').update(body.payload.content).digest('hex') };
          state.started = true;
          if (loseBegin) throw new Error('simulated lost begin ACK');
        } else if (body.action === 'pending_summary_result') {
          state.outcome = body.payload.outcome; response = { status: body.payload.outcome.status };
          assert.match(body.payload.outcome.content_sha256, /^[a-f0-9]{64}$/);
          if (loseResult) throw new Error('simulated lost result ACK');
        } else assert.fail('Unknown worker action ' + body.action);
        result = [{ json: response }];
      } else if (method === 'POST') {
        const body = JSON.parse(expression(n.parameters.jsonBody, json, outputs)); state.posts.push(body);
        assert.equal(state.started, true); assert.equal(body.private, false); assert.equal(body.message_type, 'outgoing');
        assert.equal(body.attachments, undefined); assert.equal(body['attachments[]'], undefined);
        result = [{ json: losePost ? { error: 'simulated lost HTTP response' } : { statusCode: 200, body: { id: 91, status: 'sent', content: body.content, content_attributes: body.content_attributes, inbox_id: 2, conversation_id: 3 } } }];
      } else if (url.endsWith('/messages')) {
        state.reads.push(name); result = [{ json: { payload: [{ id: 11, created_at: Date.parse('2026-10-17T11:00:00Z') / 1000,
          private: false, message_type: 1, inbox_id: 2, conversation_id: 3, content_attributes: {} }] } }];
      } else { state.reads.push(name); result = [{ json: { id: 3, inbox_id: 2, meta: { sender: { identifier: '123456@g.us' } } } }]; }
    }
    outputs[name] = plain(result);
    for (const edge of workflow.connections[name]?.main?.[branch] || []) queue.push([edge.node, result[0]?.json]);
  }
  return { state, outputs };
}

test('daily cron and read-only preview are inactive neutral templates with no saved executions', async () => {
  for (const workflow of Object.values(neutral)) {
    assert.equal(workflow.active, false); assert.deepEqual(workflow.pinData, {});
    assert.equal(workflow.settings.timezone, 'America/Sao_Paulo');
    assert.equal(workflow.settings.saveDataSuccessExecution, 'none'); assert.equal(workflow.settings.saveDataErrorExecution, 'none');
    assert.equal(workflow.settings.saveManualExecutions, false); assert.equal(workflow.settings.saveExecutionProgress, false);
    const names = new Set(workflow.nodes.map(n => n.name)); assert.equal(names.size, workflow.nodes.length);
    for (const [from, connections] of Object.entries(workflow.connections)) {
      assert(names.has(from)); for (const output of connections.main) for (const edge of output) assert(names.has(edge.node));
    }
  }
  assert.deepEqual(node('Todos os dias às 08h').parameters.rule.interval, [{ field: 'cronExpression', expression: '0 8 * * *' }]);
  assert.equal(workflows.preview.nodes.length, 9);
  assert(!workflows.preview.nodes.some(n => n.type.endsWith('scheduleTrigger')));
  for (const [key, file] of [['daily', 'OPERACIONAL-06.json'], ['preview', 'OPERACIONAL-06-PREVIEW.json']]) {
    const saved = JSON.parse(await fs.readFile(new URL('../../n8n/exames/' + file, import.meta.url), 'utf8'));
    assert.deepEqual(saved, neutral[key]);
    await assert.rejects(run(neutral[key]), /PAUSADO/);
  }
});

test('every Code node runs without URL, imports or require; every expression parses and uses stringify for bodies', () => {
  for (const workflow of Object.values(workflows)) {
    function parse(value) {
      if (typeof value === 'string' && value.startsWith('={{')) {
        assert(value.endsWith('}}')); new vm.Script('(' + value.slice(3, -2).trim() + ')');
        assert(!value.slice(3, -2).includes('}}'), 'No adjacent nested closing braces in n8n expressions');
      } else if (Array.isArray(value)) value.forEach(parse);
      else if (value && typeof value === 'object') Object.values(value).forEach(parse);
    }
    for (const n of workflow.nodes) {
      parse(n.parameters);
      if (n.type.endsWith('code')) { new vm.Script('(async function(){' + n.parameters.jsCode + '})'); assert(!/\bnew URL\(|\brequire\(|^import /m.test(n.parameters.jsCode)); }
      if (n.type.endsWith('httpRequest') && n.parameters.method === 'POST') { assert.equal(n.retryOnFail, false); assert(n.parameters.jsonBody.includes('JSON.stringify(')); }
    }
  }
});

test('preview verifies the actual group/history with GET only; empty daily claims never begin or POST', async () => {
  const preview = await run(workflows.preview);
  assert.deepEqual(preview.state.actions, ['pending_summary_preview']); assert.equal(preview.state.posts.length, 0);
  assert.deepEqual(preview.state.reads, ['Chatwoot - conferir grupo', 'Chatwoot - procurar resumo existente']);
  const out = preview.outputs['Preparar resumo completo'][0].json;
  assert.equal(out.readOnly, true); assert.equal(out.sendRequired, false); assert.match(out.content, /^📋 \*Exames pendentes\*/);
  const safe = preview.outputs['Prévia conferida sem envio'][0].json;
  assert.equal(safe.group_verified, true); assert.equal(safe.history_scan_complete, true); assert.equal(safe.post_permitted, false);
  assert.equal(safe.content, undefined); assert.equal(safe.documentIds, undefined);
  const empty = await run(workflows.daily, {}, { empty: true });
  assert.deepEqual(empty.state.actions, ['pending_summary_reserve']); assert.equal(empty.state.posts.length, 0);
  assert.equal(empty.state.reads.length, 0);
  assert.equal(empty.outputs['Encerramento sem envio'][0].json.post_permitted, false);
});

test('the generated graph makes one text POST after the durable begin, and a duplicate run makes no second POST', async () => {
  const { state } = await run(workflows.daily);
  assert.deepEqual(state.actions, ['pending_summary_reserve', 'pending_summary_begin', 'pending_summary_result']);
  assert.equal(state.posts.length, 1); assert.equal(state.outcome.status, 'sent'); assert.equal(state.outcome.external_id, '91');
  assert.match(state.posts[0].content, /^📋 \*Exames pendentes\*/); assert.doesNotMatch(state.posts[0].content, /Teste de resumo/);
  assert.equal(state.posts[0].content_attributes.pamvet_exam_summary_id, id);
  await run(workflows.daily, state); assert.equal(state.posts.length, 1);
});

test('a lost POST response stays uncertain and the day is never automatically replayed', async () => {
  const { state } = await run(workflows.daily, {}, { losePost: true });
  assert.equal(state.posts.length, 1); assert.equal(state.outcome.status, 'uncertain');
  await run(workflows.daily, state); assert.equal(state.posts.length, 1);
});

test('lost begin ACK prevents any POST; lost result ACK cannot trigger a second POST', async () => {
  const before = {}; await assert.rejects(run(workflows.daily, before, { loseBegin: true }), /lost begin ACK/);
  assert.equal(before.posts.length, 0); await run(workflows.daily, before); assert.equal(before.posts.length, 0);
  const after = {}; await assert.rejects(run(workflows.daily, after, { loseResult: true }), /lost result ACK/);
  assert.equal(after.posts.length, 1); await run(workflows.daily, after); assert.equal(after.posts.length, 1);
});

test('private bindings accept only existing id/name references and are refused inside the public tree', async () => {
  for (const forbidden of [{ credentials: { worker: { id: 'reference', name: 'Existing', token: 'secret' } } }, { config: { apiKey: 'secret' } }, { secrets: {} }]) {
    await assert.rejects(buildPendingSummaryWorkflows(forbidden));
  }
  const root = path.resolve(new URL('../../', import.meta.url).pathname);
  await assert.rejects(writePendingSummaryWorkflows(path.join(root, 'n8n/exames'), settings), /outside/);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pending-summary-binding-'));
  try {
    const written = await writePendingSummaryWorkflows(directory, settings);
    assert.equal(written.length, 2);
    for (const file of written) assert.equal((await fs.stat(file.path)).mode & 0o777, 0o600);
    const text = await fs.readFile(written[0].path, 'utf8'); assert(text.includes('EXISTING_SYNTHETIC_WORKER'));
    const source = JSON.stringify(neutral); assert(!source.includes('EXISTING_SYNTHETIC_WORKER')); assert(!source.includes('backend.example.invalid'));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
