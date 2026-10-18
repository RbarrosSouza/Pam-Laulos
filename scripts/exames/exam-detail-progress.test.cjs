const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const ts = require('typescript');

const source = fs.readFileSync(path.resolve(__dirname, '../../src/lib/exam-detail-progress.ts'), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', code)(name => { throw new Error(`Unexpected runtime dependency: ${name}`); }, loaded, loaded.exports);
const { getExamDetailProgress } = loaded.exports;

const now = Date.parse('2026-10-18T15:00:00Z');
const received = '2026-10-17T10:00:00Z';
const sent = '2026-10-18T13:00:00Z';
const contacted = '2026-10-18T14:00:00Z';
function doc(overrides = {}) {
  return {
    id: 'synthetic-document', version: 1, original_name: 'synthetic.pdf',
    received_at: received, file_status: 'saved', identification_status: 'suggested',
    drive_file_id: 'synthetic-file', drive_name: 'synthetic.pdf', extracted_data: {}, confirmed_data: {},
    evidence: {}, review_reason: null, pet_id: null, assigned_to: null, group_release_at: received,
    group_exception_reason: null, previous_document_id: null, oldest_group_sent_at: sent,
    contact_status: 'pending', group_status: 'sent', nexus_status: 'awaiting_link', process_status: 'completed',
    completed: false, sources: [{ id: 'source', channel: 'email', received_at: received }],
    items: [], deliveries: [], ...overrides,
  };
}
const doneItems = [{ item_id: 'item-1', contacted_at: contacted, contacted_by: 'actual-user' }];

test('group proof and email source stay distinct from API submission and other intake channels', () => {
  for (const status of ['pending', 'reserved', 'submitted', 'uncertain', 'failed', 'completed', 'waived', 'delivered']) {
    const result = getExamDetailProgress(doc({ group_status: status }), now);
    assert.equal(result.groupSent, false, status);
    assert.equal(result.groupAgeLabel, null, status);
  }
  assert.equal(getExamDetailProgress(doc(), now).groupSent, true);
  assert.equal(getExamDetailProgress(doc(), now).emailReceived, true);
  assert.equal(getExamDetailProgress(doc({ sources: [{ id: 'manual', channel: 'manual', received_at: received }] }), now).emailReceived, false);
  assert.equal(getExamDetailProgress(doc({ sources: [{ id: 'email', source_channel: 'email' }] }), now).emailReceived, true);
  assert.equal(getExamDetailProgress(doc({ sources: [], received_at: received }), now).emailReceived, false);
});

test('assuming a document never completes contact; mixed item outcomes remain partial', () => {
  const result = getExamDetailProgress(doc({
    assigned_to: 'vet', contact_status: 'assigned',
    items: [doneItems[0], { item_id: 'item-2', contacted_at: null }],
  }), now);
  assert.equal(result.contactCompleted, false);
  assert.equal(result.contactedCount, 1);
  assert.equal(result.itemCount, 2);
  assert.equal(result.summary, 'Contato parcial');
  assert.equal(result.groupAgeLabel, 'No grupo há 2 h');
  assert.equal(getExamDetailProgress(doc({ assigned_to: 'vet', contact_status: 'assigned' }), now).contactCompleted, false);
});

test('complete contact requires nonempty, fully contacted items and the persisted complete status', () => {
  assert.equal(getExamDetailProgress(doc({ contact_status: 'completed', items: [] }), now).contactCompleted, false);
  assert.equal(getExamDetailProgress(doc({ contact_status: 'completed', items: [{ item_id: 'item', contacted_at: 'invalid' }] }), now).contactCompleted, false);
  assert.equal(getExamDetailProgress(doc({ contact_status: 'assigned', items: doneItems }), now).contactCompleted, false);
  const complete = getExamDetailProgress(doc({ contact_status: 'completed', items: doneItems }), now);
  assert.equal(complete.contactCompleted, true);
  assert.equal(complete.groupAgeLabel, null);
});

test('only a missing patient link receives the waiting-to-link summary', () => {
  const ready = doc({ contact_status: 'completed', items: doneItems });
  assert.equal(getExamDetailProgress(ready, now).summary, 'Aguardando vincular cliente');
  for (const extra of [
    { group_status: 'submitted' }, { sources: [] }, { file_status: 'pending' },
    { nexus_status: 'failed' }, { pet_id: 'already-selected', identification_status: 'review' },
  ]) {
    assert.notEqual(getExamDetailProgress({ ...ready, ...extra }, now).summary, 'Aguardando vincular cliente');
  }
});

test('patient selection is not a completed attachment, and an attachment failure is not mislabeled as missing client', () => {
  const selected = doc({ pet_id: 'patient', identification_status: 'confirmed', nexus_status: 'pending', contact_status: 'completed', items: doneItems });
  const waiting = getExamDetailProgress(selected, now);
  assert.equal(waiting.nexusLinked, false);
  assert.equal(waiting.summary, 'Aguardando salvar no cadastro');
  assert.equal(getExamDetailProgress({ ...selected, nexus_status: 'failed' }, now).summary, 'Em andamento');
  assert.equal(getExamDetailProgress({ ...selected, nexus_status: 'completed' }, now).nexusLinked, true);
  assert.equal(getExamDetailProgress({ ...selected, nexus_status: 'completed' }, now).summary, 'Em andamento');
});

test('overall completion comes only from the database and preserves authorized group exceptions', () => {
  const complete = doc({ completed: true, pet_id: 'patient', identification_status: 'confirmed', nexus_status: 'completed', contact_status: 'completed', items: doneItems });
  assert.equal(getExamDetailProgress(complete, now).summary, 'Concluído');
  assert.equal(getExamDetailProgress({ ...complete, completed: false }, now).summary, 'Em andamento');
  const waived = getExamDetailProgress({ ...complete, group_status: 'waived', group_exception_reason: 'authorized exception' }, now);
  assert.equal(waived.summary, 'Concluído');
  assert.equal(waived.groupSent, false);
  assert.equal(waived.groupAgeLabel, null);
});

test('group clock uses the group timestamp, never email receipt, and hides invalid or future clocks', () => {
  assert.equal(getExamDetailProgress(doc({ received_at: '2020-01-01T00:00:00Z' }), now).groupAgeLabel, 'No grupo há 2 h');
  for (const timestamp of [null, '', 'not a date', '2026-10-18T15:01:00Z']) {
    assert.equal(getExamDetailProgress(doc({ oldest_group_sent_at: timestamp }), now).groupAgeLabel, null);
  }
  assert.equal(getExamDetailProgress(doc(), NaN).groupAgeLabel, null);
  assert.equal(getExamDetailProgress(doc({ oldest_group_sent_at: '2026-10-18T14:59:50Z' }), now).groupAgeLabel, 'No grupo há menos de 1 min');
  assert.equal(getExamDetailProgress(doc({ oldest_group_sent_at: '2026-10-18T14:01:00Z' }), now).groupAgeLabel, 'No grupo há 59 min');
  assert.equal(getExamDetailProgress(doc({ oldest_group_sent_at: '2026-10-17T15:00:00Z' }), now).groupAgeLabel, 'No grupo há 1 dia');
  assert.equal(getExamDetailProgress(doc({ oldest_group_sent_at: '2026-10-16T15:00:00Z' }), now).groupAgeLabel, 'No grupo há 2 dias');
});

test('calculation is pure and does not mutate the persisted document or its arrays', () => {
  const frozen = doc({ items: Object.freeze([Object.freeze({ item_id: 'item', contacted_at: null })]) });
  frozen.sources.forEach(Object.freeze);
  Object.freeze(frozen.sources); Object.freeze(frozen.deliveries); Object.freeze(frozen);
  const before = JSON.stringify(frozen);
  assert.deepEqual(getExamDetailProgress(frozen, now), getExamDetailProgress(frozen, now));
  assert.equal(JSON.stringify(frozen), before);
});
