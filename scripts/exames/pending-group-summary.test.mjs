import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPendingGroupSummary, MAX_PENDING_SUMMARY_CHARACTERS } from './pending-group-summary.mjs';

const baseUrl = 'https://pamlaudos.example.invalid';
const as_of = '2026-10-18T11:00:00Z';
const id = number => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const vetId = '20000000-0000-4000-8000-000000000001';
const document = (number = 1, extra = {}) => ({
  id: id(number), pet_name: `Pet de demonstração ${number}`, client_name: `Tutor de demonstração ${number}`,
  exam_type: 'Hemograma de demonstração', responsible_vet_id: vetId, responsible_vet_name: 'Veterinária de demonstração',
  first_group_sent_at: '2026-10-17T08:00:00Z', ...extra,
});
const snapshot = documents => ({ as_of, total: documents.length, documents, has_more: false });
const render = value => buildPendingGroupSummary(value, { baseUrl });

test('the one test message uses the exact snapshot, complete names, confirmed vet and short document links', () => {
  const result = render(snapshot([document()]));
  assert.match(result.content, /^🧪 \*Teste de resumo\*\nSegue a lista dos exames que precisam de atenção\n18\/10 às 08:00\n/);
  assert.match(result.content, /1\. \*Tutor de demonstração 1 — Pet de demonstração 1\*/);
  assert.match(result.content, /Hemograma de demonstração · no grupo há 1d 3h/);
  assert.match(result.content, /🩺 Veterinária de demonstração/);
  const short = Buffer.from(id(1).replaceAll('-', ''), 'hex').toString('base64url');
  assert.ok(result.content.includes(`${baseUrl}/e/${short}`));
  assert.ok(result.content.endsWith(`Total: 1 exame\n📋 Pam Laudos: ${baseUrl}/novos-exames`));
  assert.deepEqual(result.documentIds, [id(1)]);
  assert.equal(result.count, 1);
  assert.doesNotMatch(result.content, /\.pdf|attachments|PDF recebido|EXAM:|DELIVERY:/);
});

test('ordering is oldest group delivery first, with stable UUID ties, and never mutates the input', () => {
  const value = snapshot([
    document(3, { first_group_sent_at: '2026-10-18T10:59:00Z' }),
    document(2), document(1),
  ]);
  const before = structuredClone(value);
  Object.freeze(value.documents); value.documents.forEach(Object.freeze); Object.freeze(value);
  const out = render(value);
  assert.deepEqual(out.documentIds, [id(1), id(2), id(3)]);
  assert.deepEqual(value, before);
  assert.ok(out.content.indexOf('Tutor de demonstração 1') < out.content.indexOf('Tutor de demonstração 2'));
  assert.ok(out.content.indexOf('Tutor de demonstração 2') < out.content.indexOf('Tutor de demonstração 3'));
});

test('the SQL document_id contract is primary, accepts precise PostgreSQL timestamps, and rejects contradictory IDs', () => {
  const row = document();
  row.document_id = row.id;
  delete row.id;
  row.first_group_sent_at = '2026-10-17T08:00:00.123456+00:00';
  const out = render({ ...snapshot([row]), as_of: '2026-10-18T11:00:00.123456+00:00' });
  assert.deepEqual(out.documentIds, [id(1)]);
  assert.ok(out.content.includes('no grupo há 1d 3h'));
  assert.throws(() => render(snapshot([{ ...row, id: id(2) }])), /não correspondem/);
});

test('control characters and WhatsApp formatting are removed without shortening compound names', () => {
  const out = render(snapshot([document(1, {
    client_name: '*Tutora*\n Beatriz\tde Souza\u202E', pet_name: '`Pet` _de_ ~demonstração~',
    exam_type: 'Hemograma\r\n completo', responsible_vet_name: 'Dra.\u0000 Vet Beatriz da Demonstração',
  })]));
  assert.ok(out.content.includes('*Tutora Beatriz de Souza — Pet de demonstração*'));
  assert.ok(out.content.includes('Hemograma completo · no grupo'));
  assert.ok(out.content.includes('🩺 Dra. Vet Beatriz da Demonstração'));
  assert.doesNotMatch(out.content, /\u202E|\u0000|`|~|_de_/);
});

test('missing clinical fields are omitted and a raw auth actor or unconfirmed name never becomes the responsible vet', () => {
  const out = render(snapshot([document(1, {
    client_name: null, pet_name: 'Pet de demonstração', exam_type: null,
    responsible_vet_id: null, responsible_vet_name: 'Nome não confirmado', assigned_to: vetId, assigned_name: 'Login da equipe',
  })]));
  assert.ok(out.content.includes('1. *Pet de demonstração*'));
  assert.ok(out.content.includes('🩺 Sem responsável'));
  assert.doesNotMatch(out.content, /Nome não confirmado|Login da equipe|null|undefined|Tutor:|Exame:|— —/);
  const emptyIdentity = render(snapshot([document(1, { client_name: null, pet_name: null, exam_type: null, responsible_vet_id: null })]));
  assert.ok(emptyIdentity.content.includes('1. Exame a identificar · no grupo há 1d 3h'));
  assert.equal((emptyIdentity.content.match(/Exame a identificar/g) || []).length, 1);
  assert.doesNotMatch(out.content, /Exame a identificar/);
});

test('ages use the declared as_of instead of receipt, exam date, current clock or assignment', () => {
  for (const [sent, expected] of [
    ['2026-10-18T11:00:00Z', 'no grupo há menos de 1 min'],
    ['2026-10-18T10:59:00Z', 'no grupo há 1min'],
    ['2026-10-18T10:01:00Z', 'no grupo há 59min'],
    ['2026-10-18T10:00:00Z', 'no grupo há 1h'],
    ['2026-10-18T09:35:00Z', 'no grupo há 1h 25min'],
    ['2026-10-16T11:00:00Z', 'no grupo há 2d'],
  ]) {
    const out = render(snapshot([document(1, { first_group_sent_at: sent, received_at: '1990-01-01T00:00:00Z', exam_date: '1990-01-01' })]));
    assert.ok(out.content.includes(expected), expected);
  }
});

test('the renderer does not independently remove old, unassigned or caller-selected documents', () => {
  const out = render(snapshot([
    document(1, { first_group_sent_at: '2025-10-18T11:00:00Z', responsible_vet_id: null }),
    document(2, { contact_status: 'assigned', completed: false }),
  ]));
  assert.equal(out.count, 2);
  assert.deepEqual(out.documentIds, [id(1), id(2)]);
  assert.ok(out.content.includes('Sem responsável'));
  assert.ok(out.content.includes('Total: 2 exames'));
});

test('a complete empty snapshot remains an honest zero-result test without fabricated patients', () => {
  const out = render(snapshot([]));
  assert.equal(out.count, 0);
  assert.deepEqual(out.documentIds, []);
  assert.ok(out.content.includes('Total: 0 exames'));
  assert.doesNotMatch(out.content, /Pet de|Tutor de|Veterinária de|\/e\//);
});

test('incomplete pagination, a mismatching total or duplicate UUID is rejected without dropping entries', () => {
  const value = snapshot([document()]);
  for (const extra of [{ has_more: true }, { has_more: undefined }, { total: 2 }, { total: -1 }, { documents: null }]) {
    assert.throws(() => render({ ...value, ...extra }));
  }
  assert.throws(() => render(snapshot([document(), document(1, { id: id(1).toUpperCase() })])), /duplicado/);
});

test('timestamps must be real zoned instants and group delivery cannot be after the snapshot', () => {
  for (const value of ['not a date', '2026-10-18', '2026-10-18T11:00:00', '2026-02-30T11:00:00Z', null]) {
    assert.throws(() => render({ ...snapshot([document()]), as_of: value }));
    assert.throws(() => render(snapshot([document(1, { first_group_sent_at: value })])));
  }
  assert.throws(() => render(snapshot([document(1, { first_group_sent_at: '2026-10-18T11:00:01Z' })])), /futuro/);
  assert.ok(render({ ...snapshot([document()]), as_of: '2026-10-18T08:00:00-03:00' }).content.includes('18/10 às 08:00'));
});

test('invalid identifiers, incomplete vet identity and unsafe public origins fail explicitly', () => {
  for (const extra of [{ id: 'not-a-uuid' }, { responsible_vet_id: 'auth-actor' }, { responsible_vet_name: null }, { pet_name: 123 }]) {
    assert.throws(() => render(snapshot([document(1, extra)])));
  }
  for (const value of ['http://example.invalid', 'https://user:secret@example.invalid', 'https://example.invalid/path', 'https://example.invalid/?token=secret', 'https://example.invalid/#token', 'not a URL']) {
    assert.throws(() => buildPendingGroupSummary(snapshot([document()]), { baseUrl: value }));
  }
});

test('an oversized one-message summary throws instead of silently truncating names, links or documents', () => {
  const oversized = snapshot([document(1, { client_name: 'Texto '.repeat(MAX_PENDING_SUMMARY_CHARACTERS) })]);
  assert.throws(() => render(oversized), /24\.000 caracteres/);
  assert.equal(oversized.documents.length, 1);
  assert.equal(oversized.documents[0].client_name.length, 6 * MAX_PENDING_SUMMARY_CHARACTERS);
});
