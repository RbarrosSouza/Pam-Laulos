import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildContactReactionWorkflows, writeContactReactionWorkflows } from './contact-reaction-build.mjs';

const documentId = '10000000-0000-4000-8000-000000000001', deliveryId = '20000000-0000-4000-8000-000000000001';
const reactionId = '30000000-0000-4000-8000-000000000001', token = '40000000-0000-4000-8000-000000000001', sha = 'a'.repeat(64);
const settings = { config: { enabled: true, dryRun: false, serviceUrl: 'https://backend.example.invalid/functions/v1/exam-document-service',
  chatwootBaseUrl: 'https://support.example.invalid', accountId: 1, inboxId: 2, conversationId: 3, groupJid: '123456@g.us', expectedActorId: 1 },
  credentials: { worker: { id: 'SYNTHETIC_WORKER', name: 'Existing synthetic worker' }, chatwoot: { id: 'SYNTHETIC_CHATWOOT', name: 'Existing synthetic support' } } };
const workflows = await buildContactReactionWorkflows(settings), neutral = await buildContactReactionWorkflows();
const task = { reaction_id: reactionId, lease_token: token, document_id: documentId, delivery_id: deliveryId, sha256: sha,
  destination_key: 'chatwoot:1:2:3:123456@g.us', external_message_id: '1498', emoji: '✅', actor_id: 1 };
const original = { id: 1498, message_type: 1, private: false, status: 'delivered', source_id: 'original-wa-id', content: 'Synthetic fixture',
  inbox_id: 2, conversation_id: 3, content_attributes: { pamvet_exam_document_id: documentId, pamvet_exam_delivery_id: deliveryId, pamvet_exam_sha256: sha },
  attachments: [{ id: 901, file_type: 'file' }] };
const ownReaction = { id: 1510, message_type: 1, private: false, status: 'sent', source_id: 'check-wa-id', content: '✅', sender: { id: 1, type: 'user' },
  content_attributes: { is_reaction: true, in_reply_to: 1498 }, attachments: [] };
const node = (name, workflow = workflows.worker) => workflow.nodes.find(n => n.name === name);
const plain = value => JSON.parse(JSON.stringify(value));
function sandbox(json, outputs, items = [{ json }], extra = {}) {
  return { $json: json, $input: { all: () => items, first: () => items[0] }, $execution: { id: 'synthetic-execution' },
    $: name => ({ first: () => outputs[name]?.[0], item: outputs[name]?.at(-1), all: () => outputs[name] || [] }),
    require: name => { throw new Error('Module unavailable: ' + name); }, ...extra };
}
const expr = (value, json, outputs, extra = {}) => new vm.Script('(' + value.slice(3, -2).trim() + ')').runInNewContext(sandbox(json, outputs, undefined, extra));

async function run(workflow, state = {}, options = {}) {
  const outputs = {}, queue = [['Executar manualmente', [{ json: {} }]]]; let loopTasks, loopIndex = 0, steps = 0;
  state.posts ??= []; state.actions ??= []; state.reads ??= []; state.events ??= []; state.results ??= [];
  while (queue.length) {
    assert(++steps < 150, 'Graph must terminate');
    const [name, items] = queue.shift(), n = node(name, workflow), json = items[0]?.json;
    let result = items, branch = 0;
    if (n.type.endsWith('code')) result = await new vm.Script('(async function(){' + n.parameters.jsCode + '})()').runInNewContext(sandbox(json, outputs, items));
    else if (n.type.endsWith('if')) branch = expr(n.parameters.conditions.conditions[0].leftValue, json, outputs) === true ? 0 : 1;
    else if (n.type.endsWith('splitInBatches')) {
      loopTasks ??= items; if (loopIndex >= loopTasks.length) { result = []; branch = 0; }
      else { result = [loopTasks[loopIndex++]]; branch = 1; }
    } else if (n.type.endsWith('httpRequest')) {
      const url = expr(n.parameters.url, json, outputs), method = n.parameters.method;
      if (url.includes('/exam-document-service')) {
        const body = JSON.parse(expr(n.parameters.jsonBody, json, outputs)); state.actions.push(body.action); state.events.push(body.action);
        let response;
        if (body.action === 'reaction_preview') response = { actor_id: 1, tasks: options.empty ? [] : [task] };
        else if (body.action === 'reaction_reserve_tasks') response = { actor_id: 1, tasks: options.empty || state.started || state.done || state.held ? [] : [task],
          reconcile_tasks: !state.done && (state.started || state.held) ? [{ ...task, reconcile_only: true }] : [] };
        else if (body.action === 'reaction_begin') {
          assert.equal(body.payload.actor_id, 1); assert.equal(body.payload.external_message_id, '1498'); assert.equal(body.payload.destination_key, task.destination_key);
          response = { dispatch_allowed: !state.started && !state.held, reaction_id: reactionId, external_message_id: '1498' }; state.started = true;
          if (options.loseBegin) throw new Error('lost begin ACK');
        } else if (body.action === 'reaction_result') {
          assert.equal(body.payload.outcome.actor_id, 1); assert.equal(body.payload.outcome.external_message_id, '1498'); assert.equal(body.payload.outcome.emoji, '✅');
          state.results.push(body.payload.outcome); response = { status: body.payload.outcome.status };
          if (['confirmed', 'already_present'].includes(body.payload.outcome.status)) { assert.equal(body.payload.outcome.own_reaction_verified, true); state.done = true; }
          else if (!state.started) state.held = true;
          if (options.loseResult) throw new Error('lost result ACK');
        } else assert.fail('Unknown worker action ' + body.action);
        result = [{ json: response }];
      } else if (method === 'POST') {
        assert.equal(url, 'https://support.example.invalid/api/v1/accounts/1/conversations/3/messages/1498/reactions');
        assert.equal(state.started, true); assert.equal(state.posts.length, 0, 'A toggle must not repeat');
        const body = JSON.parse(expr(n.parameters.jsonBody, json, outputs)); assert.deepEqual(body, { emoji: '✅' });
        state.posts.push(body); state.events.push('TOGGLE');
        if (options.providerAck !== false) state.own = true;
        result = [{ json: options.losePost ? { error: 'lost response' } : { statusCode: 200, body: {} } }];
      } else if (url.endsWith('/profile')) {
        state.reads.push('profile'); result = [{ json: { id: options.wrongActor ? 9 : 1, type: 'SuperAdmin' } }];
      } else if (url.endsWith('/messages')) {
        assert.equal(expr(n.parameters.queryParameters.parameters[0].value, json, outputs), '1497');
        state.reads.push('messages');
        const existing = options.existingOwn || state.own;
        const events = existing ? [{ ...ownReaction, ...(options.unprovenOwn ? { source_id: null } : {}) }] : [];
        result = [{ json: { payload: [original] } }, { json: { payload: events } }, ...(!events.length ? [] : [{ json: { payload: [] } }])];
        // The second empty page is the required terminal proof when no reaction exists.
        const p = n.parameters.options.pagination.pagination;
        assert.equal(expr(p.completeExpression, json, outputs, { $response: { body: { payload: [] } } }), true);
        assert.equal(expr(p.completeExpression, json, outputs, { $response: { body: { payload: [original] } } }), false);
        assert.equal(expr(p.parameters.parameters[0].value, json, outputs, { $response: { body: { payload: [original] } } }), '1498');
      } else {
        state.reads.push('group'); result = [{ json: { id: 3, inbox_id: 2, meta: { sender: { identifier: '123456@g.us' } } } }];
      }
    }
    outputs[name] = plain(result);
    for (const edge of workflow.connections[name]?.main?.[branch] || []) queue.push([edge.node, result]);
  }
  return { state, outputs };
}

test('neutral templates are reproducible, paused, private-logging off, with every-minute production and manual read-only preview', async () => {
  for (const [key, file] of [['worker', 'OPERACIONAL-07.json'], ['preview', 'OPERACIONAL-07-PREVIEW.json']]) {
    const w = neutral[key]; assert.equal(w.active, false); assert.deepEqual(w.pinData, {}); assert.equal(w.settings.timezone, 'America/Sao_Paulo');
    assert.equal(w.settings.saveDataSuccessExecution, 'none'); assert.equal(w.settings.saveDataErrorExecution, 'none'); assert.equal(w.settings.saveManualExecutions, false);
    assert.equal(w.settings.saveExecutionProgress, false); assert.deepEqual(JSON.parse(await fs.readFile(new URL('../../n8n/exames/' + file, import.meta.url), 'utf8')), w);
    await assert.rejects(run(w), /PAUSADA/);
    const names = new Set(w.nodes.map(n => n.name)); assert.equal(names.size, w.nodes.length);
    for (const [from, c] of Object.entries(w.connections)) { assert(names.has(from)); for (const branch of c.main) for (const edge of branch) assert(names.has(edge.node)); }
  }
  assert.deepEqual(node('A cada minuto').parameters.rule.interval, [{ field: 'minutes', minutesInterval: 1 }]);
  assert(!workflows.preview.nodes.some(n => n.type.endsWith('scheduleTrigger')));
  assert(!workflows.preview.nodes.some(n => n.type.endsWith('httpRequest') && n.parameters.method === 'POST' && n.parameters.nodeCredentialType === 'chatwootApi'));
});

test('Code and n8n expressions work in the actual VM restrictions; every POST is nonretryable with JSON.stringify body', () => {
  for (const w of Object.values(workflows)) {
    function parse(value) {
      if (typeof value === 'string' && value.startsWith('={{')) { new vm.Script('(' + value.slice(3, -2).trim() + ')'); assert(!value.slice(3, -2).includes('}}')); }
      else if (Array.isArray(value)) value.forEach(parse); else if (value && typeof value === 'object') Object.values(value).forEach(parse);
    }
    for (const n of w.nodes) {
      parse(n.parameters);
      if (n.type.endsWith('code')) { new vm.Script('(async function(){' + n.parameters.jsCode + '})'); assert(!/\bnew URL\(|\brequire\(|^import /m.test(n.parameters.jsCode)); }
      if (n.type.endsWith('httpRequest') && n.parameters.method === 'POST') { assert.equal(n.retryOnFail, false); assert(n.parameters.jsonBody.includes('JSON.stringify(')); }
      if (n.name.includes('ler original') || n.name.includes('conferir reação após')) { assert.equal(n.parameters.options.pagination.pagination.maxRequests, 20); assert.equal(n.parameters.options.pagination.pagination.parameters.parameters[0].name, 'after'); }
    }
  }
});

test('preview and even production configured dry-run read profile/group/all reaction pages but cannot begin/result/toggle; empty queues stop', async () => {
  const p = await run(workflows.preview); assert.deepEqual(p.state.actions, ['reaction_preview']); assert.equal(p.state.posts.length, 0);
  assert.deepEqual(p.state.reads, ['profile', 'group', 'messages']); const d = p.outputs['Diagnóstico sem reação'][0].json;
  assert.equal(d.target_verified, true); assert.equal(d.post_permitted, false); assert.equal(d.content, undefined);
  const dry = await buildContactReactionWorkflows({ ...settings, config: { ...settings.config, dryRun: true } });
  const q = await run(dry.worker); assert.deepEqual(q.state.actions, ['reaction_preview']); assert.equal(q.state.posts.length, 0);
  const empty = await run(workflows.worker, {}, { empty: true }); assert.deepEqual(empty.state.actions, ['reaction_reserve_tasks']); assert.equal(empty.state.posts.length, 0);
  assert.deepEqual(empty.state.reads, ['profile']);
});

test('generated graph persists begin before exactly one toggle, then proves our sent reaction by a fresh GET and does not repeat on another run', async () => {
  const { state } = await run(workflows.worker); assert.equal(state.posts.length, 1);
  assert(state.events.indexOf('reaction_begin') < state.events.indexOf('TOGGLE'));
  assert.deepEqual(state.results.map(r => r.status), ['submitted', 'confirmed']); await run(workflows.worker, state); assert.equal(state.posts.length, 1);
});

test('our existing check closes without begin or toggle; pending/unknown provider reaction holds without claiming confirmation', async () => {
  const already = await run(workflows.worker, {}, { existingOwn: true }); assert.equal(already.state.posts.length, 0); assert.equal(already.state.started, undefined);
  assert.equal(already.state.results[0].status, 'already_present');
  const hold = await run(workflows.worker, {}, { existingOwn: true, unprovenOwn: true }); assert.equal(hold.state.posts.length, 0); assert.equal(hold.state.held, true);
  assert.equal(hold.state.results[0].status, 'uncertain'); await run(workflows.worker, hold.state); assert.equal(hold.state.posts.length, 0);
});

test('lost begin/POST/result acknowledgments never cause a second toggle; later executions reconcile with GET only', async () => {
  const before = {}; await assert.rejects(run(workflows.worker, before, { loseBegin: true }), /lost begin ACK/); assert.equal(before.posts.length, 0);
  await run(workflows.worker, before); assert.equal(before.posts.length, 0);
  const lostPost = {}; await run(workflows.worker, lostPost, { losePost: true, providerAck: false }); assert.equal(lostPost.posts.length, 1);
  assert.deepEqual(lostPost.results.map(r => r.status), ['uncertain', 'uncertain']); await run(workflows.worker, lostPost); assert.equal(lostPost.posts.length, 1);
  const lostResult = {}; await assert.rejects(run(workflows.worker, lostResult, { loseResult: true }), /lost result ACK/); assert.equal(lostResult.posts.length, 1);
  await run(workflows.worker, lostResult); assert.equal(lostResult.posts.length, 1); assert.equal(lostResult.results.at(-1).status, 'already_present');
});

test('bound configuration contains existing credential references only and cannot be written into the public repository', async () => {
  for (const forbidden of [{ credentials: { worker: { id: 'x', name: 'Existing', value: 'secret' } } }, { config: { apiKey: 'secret' } }, { secrets: {} }])
    await assert.rejects(buildContactReactionWorkflows(forbidden));
  await assert.rejects(writeContactReactionWorkflows(new URL('../../n8n/exames', import.meta.url).pathname, settings), /outside/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reaction-binding-'));
  try { const files = await writeContactReactionWorkflows(dir, settings); for (const file of files) assert.equal((await fs.stat(file.path)).mode & 0o777, 0o600); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
  assert(!JSON.stringify(neutral).includes('SYNTHETIC_WORKER')); assert(!JSON.stringify(neutral).includes('backend.example.invalid'));
});
