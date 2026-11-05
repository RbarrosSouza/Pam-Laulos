import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildContactReactionWorkflows, writeContactReactionWorkflows, prepareContactReactionCandidates } from './contact-reaction-build.mjs';

const documentId = '10000000-0000-4000-8000-000000000001', deliveryId = '20000000-0000-4000-8000-000000000001';
const reactionId = '30000000-0000-4000-8000-000000000001', token = '40000000-0000-4000-8000-000000000001', sha = 'a'.repeat(64);
const settings = { config: { enabled: true, dryRun: false, serviceUrl: 'https://backend.example.invalid/functions/v1/exam-document-service',
  chatwootBaseUrl: 'https://support.example.invalid', accountId: 1, inboxId: 2, conversationId: 3, groupJid: '123456@g.us', expectedActorId: 1 },
  credentials: { worker: { id: 'SYNTHETIC_WORKER', name: 'Existing synthetic worker' }, chatwoot: { id: 'SYNTHETIC_CHATWOOT', name: 'Existing synthetic support' } } };
const workflows = await buildContactReactionWorkflows(settings), neutral = await buildContactReactionWorkflows();
const task = { reaction_id: reactionId, lease_token: token, document_id: documentId, delivery_id: deliveryId, sha256: sha,
  destination_key: 'chatwoot:1:2:3:123456@g.us', external_message_id: '1498', emoji: '✅', actor_id: 1,lease_until:new Date(Date.now()+120000).toISOString() };
const original = { id: 1498, message_type: 1, private: false, status: 'delivered', source_id: 'original-wa-id', content: 'Synthetic fixture',
  inbox_id: 2, conversation_id: 3, content_attributes: { pamvet_exam_document_id: documentId, pamvet_exam_delivery_id: deliveryId, pamvet_exam_sha256: sha },
  attachments: [{ id: 901, file_type: 'file' }] };
const ownReaction = { id: 1510, message_type: 1, private: false, status: 'sent', source_id: 'check-wa-id', content: '✅', sender: { id: 1, type: 'user' },
  content_attributes: { is_reaction: true, in_reply_to: 1498 }, attachments: [] };
const providerState=(events=[],patch={})=>({contract:'pamvet_check_v1',complete:true,evidence_complete:true,actor_id:1,
 scope:{account_id:1,inbox_id:2,conversation_id:3,message_id:1498,group_jid:'123456@g.us'},
 original:{...original,content:undefined,content_sha256:'b'.repeat(64),legacy_reference:null},own_reactions:events.map(e=>({parent_identity_valid:true,invalid_emoji:false,own_scope:e.sender?.id===1&&e.sender?.type==='user'?'actor':'other_support',same_account_echo:false,...e})),
 current_own_reaction_id:events.find(e=>e.content&&!e.content_attributes?.deleted)?.id??null,...patch});
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
        else if (body.action === 'reaction_reserve_tasks') response = { actor_id: 1, tasks: options.empty || state.started || state.done || state.held ? [] : [task],reconcile_tasks:[] };
        else if (body.action === 'reaction_reserve_reconciliations') {
          const rt={...task,reconcile_only:true,reconcile_token:token,status:state.started?'submitted':'held',submit_started_at:state.started?'2026-10-01T00:00:00Z':null};delete rt.lease_token;
          response={tasks:!options.empty&&!state.done&&(state.started||state.held)?[rt]:[],lane:'reconcile',dispatch_allowed:false};
        }
        else if (body.action === 'reaction_begin') {
          assert.equal(body.payload.actor_id, 1); assert.equal(body.payload.external_message_id, '1498'); assert.equal(body.payload.destination_key, task.destination_key);
          response = { dispatch_allowed: !state.started && !state.held, reaction_id: reactionId, external_message_id: '1498' }; state.started = true;
          if (options.loseBegin) throw new Error('lost begin ACK');
        } else if (['reaction_result','reaction_reconcile_result'].includes(body.action)) {
          if(body.action==='reaction_reconcile_result'){assert.equal(body.payload.reconcile_token,token);assert.equal(body.payload.lease_token,undefined);}
          assert.equal(body.payload.outcome.actor_id, 1); assert.equal(body.payload.outcome.external_message_id, '1498'); assert.equal(body.payload.outcome.emoji, '✅');
          state.results.push(body.payload.outcome); response = { status: body.payload.outcome.status };
          if (['confirmed', 'already_present'].includes(body.payload.outcome.status)) { assert.equal(body.payload.outcome.own_reaction_verified, true); state.done = true; }
          else if (!state.started) state.held = true;
          if (options.loseResult) throw new Error('lost result ACK');
        } else assert.fail('Unknown worker action ' + body.action);
        result = [{ json: response }];
      } else if (method === 'POST') {
        assert.equal(url, 'https://support.example.invalid/api/v1/accounts/1/conversations/3/messages/1498/reactions/ensure');
        assert.equal(state.started, true); assert.equal(state.posts.length, 0, 'A toggle must not repeat');
        const body = JSON.parse(expr(n.parameters.jsonBody, json, outputs)); assert.equal(body.contract,'pamvet_check_v1');assert.equal(body.emoji,'✅');assert.equal(body.expected.document_id,documentId);assert.equal(body.expected.content_sha256,'b'.repeat(64));
        state.posts.push(body); state.events.push('TOGGLE');
        if(options.racingOwn)state.own=true;const already=!!state.own;
        if (!already && options.providerAck !== false) {state.own=true;state.dispatches=(state.dispatches||0)+1;}
        result=[{json:options.losePost?{error:'lost response'}:{statusCode:already?200:201,body:providerState([ownReaction],{action:already?'already_present':'created',dispatch_performed:!already})}}];
      } else if (url.endsWith('/profile')) {
        state.reads.push('profile'); result = [{ json: { id: options.wrongActor ? 9 : 1, type: 'SuperAdmin' } }];
      } else if (url.endsWith('/reactions/state')) {
        assert.equal(n.parameters.queryParameters,undefined);assert.equal(n.parameters.options.pagination,undefined);
        state.reads.push('messages');
        const existing=options.existingOwn||state.own;
        const events=existing?[{...ownReaction,...(options.unprovenOwn?{source_id:null}:{})}]:[];
        result=[{json:options.stateTimeout?{error:{message:'ETIMEDOUT'}}:{statusCode:options.oldServer?404:200,body:options.oldServer?{}:providerState(events,options.wrongContract?{contract:'legacy'}:{})}}];
      } else {
        state.reads.push('group'); result = [{ json:options.groupTimeout?{error:{message:'Request timed out'}}:{statusCode:200,body:{ id: 3, inbox_id: 2, meta: { sender: { identifier:options.wrongGroup?'999@g.us':'123456@g.us' } } }} }];
      }
    }
    outputs[name] = plain(result);
    for (const edge of workflow.connections[name]?.main?.[branch] || []) queue.push([edge.node, result]);
  }
  return { state, outputs };
}

test('neutral templates are reproducible, paused, private-logging off, with two isolated minute schedules and a manual preview', async () => {
  assert.deepEqual(await buildContactReactionWorkflows(),neutral);
  for (const key of ['worker','reconciler','preview']) {
    const w = neutral[key]; assert.equal(w.active, false); assert.deepEqual(w.pinData, {}); assert.equal(w.settings.timezone, 'America/Sao_Paulo');
    assert.equal(w.settings.saveDataSuccessExecution, 'none'); assert.equal(w.settings.saveDataErrorExecution, 'none'); assert.equal(w.settings.saveManualExecutions, false);
    assert.equal(w.settings.saveExecutionProgress, false);assert.equal(w.settings.executionTimeout,120);
    await assert.rejects(run(w), /PAUSADA/);
    const names = new Set(w.nodes.map(n => n.name)); assert.equal(names.size, w.nodes.length);
    for (const [from, c] of Object.entries(w.connections)) { assert(names.has(from)); for (const branch of c.main) for (const edge of branch) assert(names.has(edge.node)); }
  }
  assert.deepEqual(node('A cada minuto').parameters.rule.interval, [{ field: 'minutes', minutesInterval: 1 }]);
  assert(!workflows.preview.nodes.some(n => n.type.endsWith('scheduleTrigger')));
  assert(!workflows.preview.nodes.some(n => n.type.endsWith('httpRequest') && n.parameters.method === 'POST' && n.parameters.nodeCredentialType === 'chatwootApi'));
  assert(!workflows.reconciler.nodes.some(n=>n.type.endsWith('httpRequest')&&n.parameters.method==='POST'&&n.parameters.nodeCredentialType==='chatwootApi'));
  assert(!workflows.reconciler.nodes.some(n=>n.name==='Persistir autorização antes de garantir'));
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
      if(n.type.endsWith('httpRequest')){assert.equal(n.parameters.options.timeout,10000);assert.equal(n.retryOnFail,false);}
      if (n.name.includes('ler original')) { assert.equal(n.parameters.options.pagination,undefined);assert.equal(n.parameters.queryParameters,undefined);assert(n.parameters.url.includes('/reactions/state')); }
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

test('new graph persists begin before one toggle; a separate reconciliation graph proves it without blocking new claims', async () => {
  const { state } = await run(workflows.worker); assert.equal(state.posts.length, 1);
  assert(state.events.indexOf('reaction_begin') < state.events.indexOf('TOGGLE'));
  assert.deepEqual(state.results.map(r => r.status), ['submitted']); await run(workflows.worker, state); assert.equal(state.posts.length, 1);
  await run(workflows.reconciler,state);assert.equal(state.posts.length,1);assert.equal(state.results.at(-1).status,'already_present');
  assert(state.actions.includes('reaction_reserve_reconciliations'));assert(state.actions.includes('reaction_reconcile_result'));
});

test('our existing check closes without begin or toggle; pending/unknown provider reaction holds without claiming confirmation', async () => {
  const already = await run(workflows.worker, {}, { existingOwn: true }); assert.equal(already.state.posts.length, 0); assert.equal(already.state.started, undefined);
  assert.equal(already.state.results[0].status, 'already_present');
  const hold = await run(workflows.worker, {}, { existingOwn: true, unprovenOwn: true }); assert.equal(hold.state.posts.length, 0); assert.equal(hold.state.held, true);
  assert.equal(hold.state.results[0].status, 'uncertain'); await run(workflows.worker, hold.state); assert.equal(hold.state.posts.length, 0);
});

test('lost begin/POST/result acknowledgments never cause a second toggle; later executions reconcile with GET only', async () => {
  const before = {}; await assert.rejects(run(workflows.worker, before, { loseBegin: true }), /lost begin ACK/); assert.equal(before.posts.length, 0);
  await run(workflows.worker, before);await run(workflows.reconciler,before); assert.equal(before.posts.length, 0);
  const lostPost = {}; await run(workflows.worker, lostPost, { losePost: true, providerAck: false }); assert.equal(lostPost.posts.length, 1);
  assert.deepEqual(lostPost.results.map(r => r.status), ['uncertain']); await run(workflows.worker, lostPost);await run(workflows.reconciler,lostPost); assert.equal(lostPost.posts.length, 1);assert.equal(lostPost.results.at(-1).status,'uncertain');
  const lostResult = {}; await assert.rejects(run(workflows.worker, lostResult, { loseResult: true }), /lost result ACK/); assert.equal(lostResult.posts.length, 1);
  await run(workflows.worker, lostResult);await run(workflows.reconciler,lostResult); assert.equal(lostResult.posts.length, 1); assert.equal(lostResult.results.at(-1).status, 'already_present');
});

test('old providers fail closed; a concurrent manual check is an ensure no-op without a legacy toggle',async()=>{
 const bad=await run(workflows.worker,{}, {wrongContract:true});assert.equal(bad.state.posts.length,0);assert.equal(bad.state.results.at(-1).error_code,'REACTION_PROVIDER_CONTRACT_INVALID');
 const state={};await run(workflows.worker,state,{oldServer:true});assert.equal(state.posts.length,0);assert.equal(state.started,undefined);assert.equal(state.results.at(-1).error_code,'REACTION_HTTP_4XX');
 const race=await run(workflows.worker,{}, {racingOwn:true});assert.equal(race.state.posts.length,1);assert.equal(race.state.dispatches||0,0);assert.equal(race.state.results.at(-1).status,'already_present');
 for(const w of Object.values(workflows))for(const n of w.nodes)if(n.type.endsWith('httpRequest')&&n.parameters.method==='POST'&&n.parameters.nodeCredentialType==='chatwootApi')assert(n.parameters.url.includes('/reactions/ensure'));
});

test('native n8n HTTP errors after a claim persist a bounded diagnostic without state reads or provider writes',async()=>{
 for(const options of [{groupTimeout:true},{wrongGroup:true},{stateTimeout:true}]) {
  const {state}=await run(workflows.worker,{},options);assert.equal(state.posts.length,0);assert.equal(state.started,undefined);
  assert.equal(state.results.length,1);assert.match(state.results[0].error_code,/REACTION_(HTTP_TIMEOUT|GROUP_IDENTITY_MISMATCH)/);
  if(options.groupTimeout||options.wrongGroup)assert(!state.reads.includes('messages'));
 }
 const r=await run(workflows.reconciler,{started:true},{stateTimeout:true});assert.equal(r.state.posts.length,0);assert.equal(r.state.results.at(-1).error_code,'REACTION_HTTP_TIMEOUT');
});

test('pure live binding preserves credentials, existing node identities/positions and privacy settings while fencing drift',async()=>{
 const live=plain(workflows.worker);live.id='existing-op07';live.versionId='before-version';live.activeVersionId='before-version';live.active=true;
 live.settings={...live.settings,executionTimeout:900,callerPolicy:'workflowsFromSameOwner',binaryMode:'separate'};
 live.nodes.forEach((n,i)=>{n.id='live-'+i;n.position=[i*2,i*3]});
 const result=await prepareContactReactionCandidates(live,'before-version');
 assert.equal(result.worker.id,live.id);assert.equal(result.worker.active,true);assert.equal(result.reconciler.active,false);
 for(const n of result.worker.nodes){const old=live.nodes.find(x=>x.name===n.name);if(old){assert.equal(n.id,old.id);assert.deepEqual(n.position,old.position);assert.deepEqual(n.credentials,old.credentials)}}
 assert.equal(result.worker.settings.executionTimeout,120);assert.equal(result.worker.settings.callerPolicy,live.settings.callerPolicy);
 assert.equal(result.reconciler.settings.saveDataSuccessExecution,'none');
 await assert.rejects(prepareContactReactionCandidates(live,'stale-version'),/drift/);
 const drift=plain(live);drift.nodes.find(n=>n.name==='Chatwoot - conferir grupo original').credentials.chatwootApi.id='different';
 await assert.rejects(prepareContactReactionCandidates(drift,'before-version'),/credential reference drift/);
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
