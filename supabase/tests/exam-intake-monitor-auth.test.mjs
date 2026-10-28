import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const ts = createRequire(import.meta.url)('typescript');
const source = await readFile(new URL('../functions/exam-document-service/intake-monitor-auth.ts', import.meta.url), 'utf8');
const api = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports: api });
const monitor = 'e'.repeat(64), ingestion = 'a'.repeat(64);
const env = (m = monitor, w = ingestion) => (key) => key === 'EXAM_INTAKE_MONITOR_API_KEY' ? m : key === 'EXAM_INGESTION_API_KEY' ? w : undefined;
const equal = (a, b) => a === b;

test('no dedicated secret keeps the new authentication path disabled', () => {
  assert.equal(api.authenticateExamIntakeMonitor('Bearer ' + monitor, env(''), equal), false);
  assert.equal(api.authenticateExamIntakeMonitor('Bearer ' + monitor, () => undefined, equal), false);
});
test('only exact raw or Bearer dedicated values authenticate', () => {
  for (const value of [monitor, 'Bearer ' + monitor, 'bearer ' + monitor]) assert.equal(api.authenticateExamIntakeMonitor(value, env(), equal), true);
  for (const value of [ingestion, 'Bearer ' + ingestion, monitor.slice(1), 'Token ' + monitor, monitor.toUpperCase(), 'Bearer ' + monitor + ' suffix', '']) assert.equal(api.authenticateExamIntakeMonitor(value, env(), equal), false);
});
test('malformed or shared monitor configuration disables only monitor authentication', () => {
  for (const [m, w] of [['short-private-value', ingestion], [monitor, monitor]]) {
    assert.equal(api.authenticateExamIntakeMonitor('Bearer ' + monitor, env(m, w), equal),false);
  }
});
test('dedicated action allowlist excludes every clinical/file/ingestion/collection path and multipart', () => {
  for (const action of ['intake_health','intake_status','intake_alert_reserve','intake_alert_begin','intake_alert_result']) {
    assert.doesNotThrow(() => api.authorizeExamIntakeMonitorAction(true, action, false));
    assert.throws(() => api.authorizeExamIntakeMonitorAction(true, action, true), (e) => e.status === 403);
  }
  for (const action of ['file','file_url','upload','reserve_source','reserve_intake_source','stage_intake_file','collection_begin','intake_resume','intake_event','intake_finish','intake_lookup_source','intake_list_pending_sources','intake_resolve_receipt_saved','reaction_begin','pending_summary_begin','unknown']) assert.throws(() => api.authorizeExamIntakeMonitorAction(true, action, false), (e) => e.status === 403);
  assert.doesNotThrow(() => api.authorizeExamIntakeMonitorAction(false, 'file', true));
});
test('only authenticated monitor scope survives even if a SQL result already contains a forged ACK', () => {
  const input = { contract: 'exam_intake_monitor_v1', authorization_scope: 'intake_monitor', collectors: [] };
  assert.equal(api.filterExamIntakeMonitorResult('intake_status', input, false).authorization_scope, undefined);
  assert.equal(api.filterExamIntakeMonitorResult('intake_status', { ...input, authorization_scope: 'forged' }, true).authorization_scope, 'intake_monitor');
  assert.equal(input.authorization_scope, 'intake_monitor');
});
test('monitor reservation returns lease fences and diagnostic codes without clinical identifiers', () => {
  const original = { claimed: true, alert: { id: 'alert', lease_token: 'lease', destination_key: 'approved', worker: 'private' }, incident: { stage: 'capture', code: 'capture_failed', receipt_id: 'private-receipt', document_id: 'private-document' } };
  const filtered = api.filterExamIntakeMonitorResult('intake_alert_reserve', original, true);
  assert.deepEqual(JSON.parse(JSON.stringify(filtered)), { claimed: true, alert: { id: 'alert', lease_token: 'lease', destination_key: 'approved' }, incident: { stage: 'capture', code: 'capture_failed' } });
  assert.equal(api.filterExamIntakeMonitorResult('intake_alert_reserve', original, false), original);
});
