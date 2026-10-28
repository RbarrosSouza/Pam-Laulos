import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const source = await readFile(new URL('./intake-monitor.gs', import.meta.url), 'utf8');
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(overrides = {}) {
  let now = Date.parse('2026-10-27T23:00:00.000Z'), serial = 20;
  const props = new Map(Object.entries({ ENABLED: 'true', BACKEND_URL: 'https://backend.example/functions/v1/exam-document-service', BACKEND_AUTHORIZATION: 'a'.repeat(64), RELAY_BASE_URL: 'https://chat.example', RELAY_CAPABILITY_TOKEN: 'offline-relay-capability-token-at-least-32-characters', CHATWOOT_ACCOUNT_ID: '1', CHATWOOT_INBOX_ID: '2', CHATWOOT_CONVERSATION_ID: '99', EXPECTED_DESTINATION_PHONE: '+5511999999999', EXPECTED_CHATWOOT_CHANNEL: 'Channel::Api', DESTINATION_KEY: 'whatsapp_primary', EXPECTED_COLLECTOR_IDS: '["gmail-main","outlook-main","chatwoot-main"]', ...overrides }));
  const calls = [], messages = [], results = [], triggers = [];
  const env = { props, calls, messages, results, triggers, down: false, chatAuthWrong: false, postMode: 'ok', beginAckLost: false, resultDown: false, backendAuthWrong: false, stale: false, paused: false, locked: false, reserve: [], page: null, failFence: false,
    conversation: { relay_contract:'exam_intake_relay_v1', id: 99, inbox_id: 2, account_id: 1, meta: { channel: 'Channel::Api', sender: { id: 4, phone_number: '+5511999999999', identifier: '5511999999999@s.whatsapp.net' } } },
    advance(ms) { now += ms; },
    get now() { return now; },
    jobs() { return [...props].filter(([k]) => k.startsWith('PIM_JOB_V1_')).map(([, v]) => JSON.parse(v)); },
    posts() { return calls.filter((c) => c.url.startsWith('https://chat.example') && c.options.method === 'post'); },
    status() { return { contract: 'exam_intake_monitor_v1', authorization_scope: 'intake_monitor', as_of: new Date(now).toISOString(), open_incidents: this.stale ? 1 : 0, pending_alerts: this.reserve.length, collectors: ['gmail','outlook','chatwoot'].map((provider) => ({ collector_id: provider + '-main', provider, monitored: true, stale_after_seconds: 900, heartbeat_at: new Date(now - (this.stale ? 1800000 : 0)).toISOString(), progress_at: new Date(now - (this.stale ? 1800000 : 0)).toISOString(), last_success_at: new Date(now).toISOString() })) }; },
  };
  const response = (body, code = 200) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body) });
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({ Date: ClockDate, console,
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => { if (env.failFence && k.startsWith('PIM_JOB_V1_') && JSON.parse(v).status === 'started') throw new Error('offline storage failure'); props.set(k, v); }, getProperties: () => Object.fromEntries(props), deleteProperty: (k) => props.delete(k) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => !env.locked, releaseLock() {} }) },
    Utilities: { getUuid: () => uuid(serial++), DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' }, computeDigest: (_, value) => [...createHash('sha256').update(value).digest()].map((b) => b > 127 ? b - 256 : b) },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger() {}, newTrigger: (handler) => ({ timeBased() { return this; }, everyMinutes(n) { this.minutes = n; return this; }, create() { triggers.push({ handler, minutes: this.minutes }); } }) },
    UrlFetchApp: { fetch(url, options) {
      calls.push({ url, options });
      if (url.startsWith('https://backend.example')) {
        if (env.down) throw new Error('offline backend transport');
        if (env.backendAuthWrong) return response({ error: 'unauthorized' }, 401);
        const { action, payload } = JSON.parse(options.payload);
        if (action === 'intake_health') return response({ stale_collectors: env.stale ? 3 : 0 });
        if (action === 'intake_status') return response(env.status());
        if (action === 'intake_alert_reserve') return response(env.reserve.shift() || { claimed: false, paused: env.paused });
        if (action === 'intake_alert_begin') {
          if (env.beginAckLost) throw new Error('offline ACK lost');
          return response({ dispatch_allowed: true, alert_id: payload.alert_id, destination_key: payload.destination_key, content_sha256: createHash('sha256').update(payload.content).digest('hex') });
        }
        if (action === 'intake_alert_result') {
          if (env.resultDown) throw new Error('offline result failure');
          results.push(payload);
          return response({ alert_id: payload.alert_id, status: ['delivered','read'].includes(payload.outcome.status) ? 'sent' : ['created','sent'].includes(payload.outcome.status) ? 'submitted' : payload.outcome.status });
        }
        throw new Error('unexpected backend action');
      }
      if (!url.startsWith('https://chat.example/api/v1/accounts/1/conversations/99')) throw new Error('unexpected URL');
      if (env.chatAuthWrong) return response({ error: 'unauthorized' }, 401);
      if (!url.includes('/messages')) return response(env.conversation);
      if (options.method === 'post') {
        if (env.postMode === 'reject') return response({ error: 'unauthorized' }, 401);
        const payload = JSON.parse(options.payload);
        const message = { ...payload, id: 1000 + messages.length, message_type: 1, created_at: now / 1000, status: 'sent' };
        messages.push(message);
        if (env.postMode === 'ack_lost') throw new Error('offline provider ACK lost');
        return response(message, 201);
      }
      const before = new URL(url).searchParams.get('before');
      if (env.page) return response({ payload: env.page(before && Number(before)) });
      return response({ payload: messages.filter((m) => !before || m.id < Number(before)) });
    } },
  });
  vm.runInContext(source, context, { filename: 'intake-monitor.gs' });
  env.context = context;
  env.run = () => context.intakeMonitorTick();
  env.reservation = () => ({ claimed: true, alert: { id: uuid(1), lease_token: uuid(2), destination_key: 'whatsapp_primary' }, incident: { stage: 'health', code: 'collector_heartbeat_stale' } });
  return env;
}

test('disabled by default; no fetch, message, or trigger is installed', () => {
  const f = fixture({ ENABLED: '' }); assert.equal(f.run().code, 'MONITOR_DISABLED'); assert.equal(f.calls.length, 0); assert.equal(f.triggers.length, 0);
});
test('required credentials and all three expected collectors are mandatory', () => {
  const f = fixture({ RELAY_CAPABILITY_TOKEN: '' }); assert.equal(f.run().code, 'CONFIG_INVALID'); assert.equal(f.calls.length, 0);
  const g = fixture({ EXPECTED_COLLECTOR_IDS: '[]' }); assert.equal(g.run().code, 'COLLECTOR_CONFIG_INVALID'); assert.equal(g.posts().length, 0);
});
test('wrong Chatwoot credentials fail in GET before any POST', () => {
  const f = fixture(); f.chatAuthWrong = true; f.down = true; assert.equal(f.run().code, 'CHATWOOT_HTTP_401'); assert.equal(f.posts().length, 0);
});
test('wrong destination phone, inbox, channel and group are all rejected', () => {
  for (const mutate of [(c) => c.meta.sender.phone_number = '+5516000000000', (c) => c.inbox_id = 7, (c) => c.meta.channel = 'Channel::Email', (c) => c.meta.sender.identifier = '123@g.us', (c) => c.meta.sender.custom_attributes = { is_group: true }]) {
    const f = fixture(); f.down = true; mutate(f.conversation); assert.equal(f.run().code, 'DESTINATION_MISMATCH'); assert.equal(f.posts().length, 0);
  }
});
test('backend/database outage produces one independently scheduled alert and no n8n request', () => {
  const f = fixture(); f.down = true; assert.equal(f.run().health, 'BACKEND_UNAVAILABLE'); f.advance(300000); f.run(); assert.equal(f.posts().length, 1); assert.equal(f.jobs()[0].status, 'submitted'); assert.ok(f.calls.every((c) => !c.url.includes('n8n')));
});
test('wrong backend credentials alert through the separately verified WhatsApp path', () => {
  const f = fixture(); f.backendAuthWrong = true; f.run(); f.run(); assert.equal(f.posts().length, 1); assert.equal(f.jobs()[0].status, 'submitted');
});
test('empty or disabled collector registration never reports healthy', () => {
  for (const mode of ['empty','disabled','missingProvider']) {
    const f = fixture(); const original = f.status.bind(f); f.status = () => { const s = original(); if (mode === 'empty') s.collectors = []; if (mode === 'disabled') s.collectors[0].monitored = false; if (mode === 'missingProvider') s.collectors[0].provider = 'outlook'; return s; };
    assert.equal(f.run().health, 'COLLECTOR_CONFIGURATION_INVALID'); assert.equal(f.posts().length, 1);
  }
});
test('n8n-down stale collector uses the durable SQL outbox and exact begin/result fences', () => {
  const f = fixture(); f.stale = true; f.reserve.push(f.reservation()); f.run(); assert.equal(f.posts().length, 1); assert.equal(f.jobs()[0].kind, 'backend'); assert.equal(f.results[0].outcome.status, 'created'); assert.equal(f.results[0].outcome.content_sha256.length, 64);
  const sequence = f.calls.map((c) => c.url.includes('backend.example') ? JSON.parse(c.options.payload).action : c.options.method === 'post' ? 'message_POST' : 'destination_GET');
  assert.ok(sequence.indexOf('intake_alert_begin') < sequence.indexOf('message_POST'));
  f.messages[0].status = 'delivered'; f.advance(300000); f.run(); assert.equal(f.jobs()[0].status, 'sent'); assert.equal(f.results.at(-1).outcome.status, 'delivered'); assert.equal(f.posts().length, 1);
});
test('provider ACK lost is persistent uncertainty and can only reconcile by GET', () => {
  const f = fixture(); f.down = true; f.postMode = 'ack_lost'; f.run(); assert.equal(f.posts().length, 1); assert.equal(f.jobs()[0].status, 'uncertain');
  f.messages[0].status = 'read'; f.advance(300000); f.run(); assert.equal(f.jobs()[0].status, 'sent'); assert.equal(f.posts().length, 1);
});
test('uncertain provider response with no found message is never resent', () => {
  const f = fixture(); f.down = true; f.postMode = 'reject'; f.run(); f.advance(300000); f.run(); assert.equal(f.posts().length, 1); assert.equal(f.jobs()[0].status, 'uncertain');
});
test('lost backend begin ACK never reaches provider POST', () => {
  const f = fixture(); f.stale = true; f.beginAckLost = true; f.reserve.push(f.reservation()); f.run(); f.advance(300000); f.run(); assert.equal(f.posts().length, 0); assert.equal(f.jobs()[0].status, 'uncertain'); assert.equal(f.results[0].outcome.status, 'uncertain');
});
test('persistent BEFOREPOST fence must succeed before network mutation', () => {
  const f = fixture(); f.down = true; f.failFence = true; f.run(); assert.equal(f.posts().length, 0); assert.equal(f.jobs()[0].status, 'planned');
  f.failFence = false; f.run(); assert.equal(f.posts().length, 1);
});
test('recovery is a separate one-time episode and does not declare incidents resolved', () => {
  const f = fixture(); f.down = true; f.run(); f.messages[0].status = 'delivered'; f.down = false; f.advance(300000); f.run(); assert.equal(f.posts().length, 2); assert.match(f.messages[1].content, /Incidentes ainda em aberto/); f.advance(300000); f.run(); assert.equal(f.posts().length, 2);
});
test('outbox paused with stale coverage produces one configuration alert', () => {
  const f = fixture(); f.stale = true; f.paused = true; f.run(); f.advance(300000); f.run(); assert.equal(f.posts().length, 1); assert.match(f.messages[0].content, /fila de alertas.*pausada/);
});
test('outbox destination key mismatch never reaches provider POST', () => {
  const f = fixture(); const claim = f.reservation(); claim.alert.destination_key = 'other'; f.reserve.push(claim); assert.equal(f.run().code, 'ALERT_RESERVATION_MISMATCH'); assert.equal(f.posts().length, 0);
});
test('result ACK loss is retried as a result update, never as a message POST', () => {
  const f = fixture(); f.stale = true; f.resultDown = true; f.reserve.push(f.reservation()); f.run(); assert.equal(f.jobs()[0].backendResultPending, true); f.resultDown = false; f.messages[0].status = 'delivered'; f.advance(300000); f.run(); assert.equal(f.posts().length, 1); assert.equal(f.jobs()[0].backendResultPending, false); assert.equal(f.results.at(-1).outcome.status, 'delivered');
});
test('21-message page is accepted completely, over 100 is rejected', () => {
  const f = fixture(); f.down = true; f.run(); const job = f.jobs()[0]; const stored = f.messages[0]; stored.status = 'delivered';
  f.page = (before) => before ? [] : [stored, ...Array.from({ length: 20 }, (_, i) => ({ id: 999 - i, created_at: (f.now - 1000 - i) / 1000, message_type: 1, status: 'sent', content: 'Other' }))];
  assert.equal(f.context.pimFindMessage(f.context.pimConfig(), job).id, stored.id);
  f.page = () => Array.from({ length: 101 }, (_, i) => ({ id: 2000 - i, created_at: f.now / 1000 })); assert.throws(() => f.context.pimFindMessage(f.context.pimConfig(), job), /MESSAGE_PAGE_INVALID/);
});
test('pagination cycles, timestamp disorder, duplicate correlation and 10-page exhaustion fail closed', () => {
  for (const mode of ['cycle','time','duplicates','limit']) {
    const f = fixture(); f.down = true; f.run(); const job = f.jobs()[0], stored = f.messages[0]; stored.status = 'read';
    if (mode === 'cycle') f.page = () => [{ id: 1000, created_at: f.now / 1000 }];
    if (mode === 'time') f.page = () => [{ id: 2, created_at: (f.now - 1000) / 1000 }, { id: 1, created_at: f.now / 1000 }];
    if (mode === 'duplicates') f.page = (before) => before ? [] : [stored, { ...stored, id: 999 }];
    if (mode === 'limit') f.page = (before) => [{ id: (before || 10000) - 1, created_at: f.now / 1000 }];
    assert.throws(() => f.context.pimFindMessage(f.context.pimConfig(), job));
  }
});
test('incoming or altered content cannot confirm the outgoing correlation', () => {
  const f = fixture(); f.down = true; f.run(); f.messages[0].message_type = 0; f.messages[0].status = 'read'; f.advance(300000); f.run(); assert.equal(f.jobs()[0].status, 'uncertain'); assert.equal(f.posts().length, 1);
});
test('current episode dedup survives completed history pruning', () => {
  const f = fixture(); f.down = true; f.run(); f.messages[0].status = 'read'; f.run(); const local = f.jobs()[0];
  for (let i = 0; i < 30; i++) f.context.pimSaveJob({ ...local, id: 'backend:old-' + i, kind: 'backend', episode: undefined, checkedAt: new Date(f.now + i).toISOString() });
  f.context.pimPruneCompleted(); f.run(); assert.equal(f.posts().length, 1); assert.ok(f.jobs().some((j) => j.id === local.id));
});
test('an independent script lock prevents concurrent dispatch and no trigger auto-runs', () => {
  const f = fixture(); f.locked = true; assert.equal(f.run().code, 'MONITOR_BUSY'); assert.equal(f.calls.length, 0); assert.equal(f.triggers.length, 0);
});
test('preflight is read-only and installer is explicit five-minute timer', () => {
  const f = fixture(); assert.equal(f.context.intakeMonitorValidate().code, 'PREFLIGHT_OK'); assert.equal(f.posts().length, 0); assert.equal(f.triggers.length, 0); assert.equal(f.calls.filter((c) => c.options.payload && JSON.parse(c.options.payload).action === 'intake_health').length, 0);
  f.context.intakeMonitorInstallFiveMinuteTrigger(); assert.equal(f.triggers[0].minutes, 5); assert.equal(f.posts().length, 0);
});
test('preflight works while disabled and installer cannot enable the monitor implicitly', () => {
  const f = fixture({ ENABLED: 'false' }); assert.equal(f.context.intakeMonitorValidate().code, 'PREFLIGHT_OK'); assert.throws(() => f.context.intakeMonitorInstallFiveMinuteTrigger(), /MONITOR_DISABLED/); assert.equal(f.triggers.length, 0); assert.equal(f.posts().length, 0); assert.equal(f.props.get('ENABLED'), 'false');
});
test('HTTP requests request a bounded timeout and cannot follow redirects with credentials', () => {
  const f = fixture(); f.down = true; f.run(); assert.ok(f.calls.length > 0); assert.ok(f.calls.every((c) => c.options.followRedirects === false && c.options.timeoutSeconds > 0 && c.options.timeoutSeconds <= 20));
});
test('broad or unknown backend credential scope cannot pass preflight', () => {
  for (const scope of [undefined, 'ingestion_worker', 'member']) {
    const f = fixture({ ENABLED: 'false' }); const original = f.status.bind(f); f.status = () => ({ ...original(), authorization_scope: scope });
    assert.throws(() => f.context.intakeMonitorValidate(), /STATUS_INVALID/); assert.equal(f.posts().length, 0); assert.equal(f.triggers.length, 0);
  }
});
test('scope ACK precedes every backend mutation, including health incident creation', () => {
  const f = fixture(); const original = f.status.bind(f); f.status = () => ({ ...original(), authorization_scope: 'ingestion_worker' }); f.run();
  const actions = f.calls.filter((c) => c.url.startsWith('https://backend.example')).map((c) => JSON.parse(c.options.payload).action);
  assert.deepEqual(actions, ['intake_status']);
});
test('all backend calls carry explicit monitor intent and cannot fall back to broad worker authentication',()=>{
  const f=fixture();f.run();const calls=f.calls.filter(c=>c.url.startsWith('https://backend.example'));assert.ok(calls.length>0);assert.ok(calls.every(c=>c.options.headers['X-Exam-Intake-Monitor']==='1'));
});
test('relay transport uses only its capability and never reads a legacy native Chatwoot token',()=>{
 const f=fixture();f.down=true;f.run();const relay=f.calls.filter(c=>c.url.startsWith('https://chat.example'));assert.ok(relay.length>0);assert.ok(relay.every(c=>c.options.headers.Authorization==='Bearer offline-relay-capability-token-at-least-32-characters'&&!c.options.headers.api_access_token));
 const g=fixture({RELAY_CAPABILITY_TOKEN:'',CHATWOOT_TOKEN:'native-token-must-not-be-used'});assert.equal(g.run().code,'CONFIG_INVALID');assert.equal(g.calls.length,0);
});
test('a native Chatwoot response without the relay contract cannot pass preflight or reach any message POST',()=>{
 const f=fixture();delete f.conversation.relay_contract;assert.equal(f.run().code,'DESTINATION_MISMATCH');assert.equal(f.posts().length,0);assert.equal(f.calls.some(c=>c.url.startsWith('https://backend.example')),false);
});
