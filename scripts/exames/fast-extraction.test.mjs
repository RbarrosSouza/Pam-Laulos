import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExamExtraction } from './extraction-validation.mjs';
import {
  parseHopeLabFastCandidate, validateFastExamCandidate, inspectFastExtraction,
  createJevRoutingRequest, parseJevRoutingResponse, requestJevRoutingShadow,
} from './fast-extraction.mjs';

// Entirely fictitious identities. No PDF, production record or network is used.
const text = [
  'HopeLab',
  'Clínica veterinária   Médico veterinário   CRMV',
  'Clínica Aurora   Marina Costa   SP 12345',
  'Paciente   Idade   Sexo',
  'Luna   8a   Fêmea',
  'Responsável   Raça   Data coleta',
  'Ana Clara   SRD   04/11/2026',
  'Espécie: Canina',
  'Protocolo: HL-123',
  'ERITROGRAMA',
  'Hemácias 7,1 milhões/mm³',
  'Hemoglobina 15,0 g/dL',
  'LEUCOGRAMA',
  'Leucócitos 10.500 /mm³',
  'Segmentados 70 %',
  'PLAQUETOGRAMA',
  'Plaquetas 320.000 /mm³',
].join('\n');
const context = (page = text, overrides = {}) => ({ pages: [page], totalPages: 1, isVision: false, canExtract: true, ...overrides });
const general = { accepted: false, route: 'general', reason: 'ambiguous_identification_columns' };
const answer = (choice = 'general_extraction', overrides = {}) => ({
  model: 'typesafe/jev-1.14', answers: { extraction_route: { type: 'choice', choice, confidence: 0.93 } },
  usage: { cost: 0.00001 }, ...overrides,
});

test('active fast path retains every literal field and evidence through the existing validator', () => {
  const result = inspectFastExtraction(context(), { mode: 'active' });
  assert.equal(result.accepted, true);
  assert.equal(result.route, 'fast');
  assert.deepEqual(result.extraction.fields, {
    pet_name: 'Luna', client_name: 'Ana Clara', exam_type: 'Hemograma', exam_date: '2026-11-04',
    lab_name: 'HopeLab', species: 'Canina', report_number: 'HL-123',
    requesting_vet_name: 'Marina Costa', requesting_vet_crmv: 'SP 12345',
  });
  assert.equal(result.extraction.extractor_version, 'hopelab-columnar-hemogram-v1');
  assert.equal(result.extraction.classification, 'exam');
  assert.equal(result.extraction.review_reason, null);
  assert(result.extraction.evidence.every(item => item.page === 1 && text.includes(item.excerpt)));
});

test('shadow is the default and never exposes persistable fields; off bypasses parsing', () => {
  const result = inspectFastExtraction(context());
  assert.equal(result.accepted, false);
  assert.equal(result.route, 'general');
  assert.equal(result.extraction, null);
  assert.equal(result.shadow.eligible, true);
  assert(result.shadow.fieldNames.includes('requesting_vet_name'));
  assert.equal(JSON.stringify(result).includes('Ana Clara'), false);
  const throwingContext = { get pages() { throw new Error('must not parse'); } };
  assert.deepEqual(inspectFastExtraction(throwingContext, { mode: 'off' }), {
    accepted: false, route: 'general', reason: 'fast_extraction_disabled', extraction: null, shadow: null,
  });
  assert.throws(() => inspectFastExtraction(context(), { mode: 'typo' }), /FAST_EXTRACTION_MODE_INVALID/u);
});

test('literal matching preserves accents, canonical Unicode, tabs and CRLF', () => {
  for (const page of [text.normalize('NFD'), text.replaceAll('   ', '\t'), text.replaceAll('\n', '\r\n')]) {
    const result = inspectFastExtraction(context(page), { mode: 'active' });
    assert.equal(result.accepted, true);
    assert.equal(result.extraction.fields.client_name, 'Ana Clara');
    assert(result.extraction.evidence.every(item => page.includes(item.excerpt)));
  }
});

test('optional missing fields remain null; a supported printed identifier is retained', () => {
  const noOptionals = text.replace('Espécie: Canina\nProtocolo: HL-123\n', '');
  const result = inspectFastExtraction(context(noOptionals), { mode: 'active' });
  assert.equal(result.accepted, true);
  assert.equal(result.extraction.fields.species, null);
  assert.equal(result.extraction.fields.report_number, null);
  const numericId = inspectFastExtraction(context(text.replace('Protocolo: HL-123', 'Número do laudo: 12345')), { mode: 'active' });
  assert.equal(numericId.accepted, true);
  assert.equal(numericId.extraction.fields.report_number, '12345');
});

test('collapsed columns and alternate layouts always keep the general extractor', () => {
  for (const page of [text.replaceAll('   ', ' '), text.replace('Responsável   Raça', 'Tutor   Raça'),
    text.replace('Ana Clara   SRD', 'Ana Clara\nSRD'), text.replace('SP 12345', '12345'),
    text.replace('Luna   8a', 'Luna   indefinida'), text.replace('Luna   8a', 'Luna / Sol   8a'),
    text.replace('Luna   8a', 'Luna e Sol   8a')]) {
    const result = inspectFastExtraction(context(page), { mode: 'active' });
    assert.equal(result.accepted, false, page);
    assert.equal(result.extraction, null);
    assert.equal(result.route, 'general');
  }
});

test('page, vision, lab and missing text limits cannot activate the fast path', () => {
  for (const ctx of [null, {}, context('', {}), context(text, { isVision: true }),
    context(text, { canExtract: false }), context(text, { totalPages: 2, pages: [text, text] }),
    context(text, { totalPages: 2 }), context(text.repeat(300)), context(text.replace('HopeLab', 'Outro Laboratório')),
    context(text.replace('HopeLab', 'HopeLab - Outro Laboratório'))]) {
    assert.equal(inspectFastExtraction(ctx, { mode: 'active' }).accepted, false);
  }
});

test('duplicate, contradictory and additional identification must be fully extracted normally', () => {
  for (const additional of ['Paciente: Sol', 'Nome: Sol', 'Proprietário: Bruno Alves',
    'Solicitante: Outra Veterinária', 'Médica Veterinária Solicitante: Outra Veterinária',
    'Espécie: Felina', 'Protocolo: HL-999', 'Espécie\nCanina', 'Registro: 12345',
    'Código do exame: 888', 'Paciente   Idade   Sexo\nSol   3a   Macho']) {
    const result = inspectFastExtraction(context(text + '\n' + additional), { mode: 'active' });
    assert.equal(result.accepted, false, additional);
    assert.equal(result.extraction, null);
  }
});

test('invalid dates never become evidence-backed clinical dates', () => {
  for (const date of ['31/02/2026', '2026-13-01', '11/2026', '04/11/26', 'sem data']) {
    assert.equal(inspectFastExtraction(context(text.replace('04/11/2026', date)), { mode: 'active' }).accepted, false, date);
  }
});

test('historic, requested, cancelled or pending numeric examples are not fast results', () => {
  for (const qualifier of ['Histórico', 'Resultados anteriores', 'Solicitação', 'Requisição',
    'Orçamento', 'Exames solicitados', 'Cancelado', 'Pendente', 'Não foi realizado',
    'Sem material', 'Exemplo']) {
    for (const normalized of [qualifier, qualifier.normalize('NFD')]) {
      assert.equal(inspectFastExtraction(context(normalized + '\n' + text), { mode: 'active' }).accepted, false, qualifier);
    }
  }
});

test('other panels and missing blood results must not lose exam types', () => {
  for (const page of [text + '\nCreatinina 1,2 mg/dL', text + '\nHemograma + PCR',
    text + '\nALT 45 U/L', text + '\nTeste Resultado Referência',
    text.replace('Plaquetas 320.000 /mm³', ''), text.replace('Leucócitos 10.500 /mm³', 'Resultado pendente'),
    text.replace('PLAQUETOGRAMA', 'RETICULÓCITOS'), text + '\nERITROGRAMA\nHemácias 6,1 milhões/mm³']) {
    assert.equal(inspectFastExtraction(context(page), { mode: 'active' }).accepted, false, page);
  }
});

test('parser eligibility fails if the existing validator drops even an optional field', () => {
  const parsed = parseHopeLabFastCandidate(context());
  parsed.candidate.fields.species = 'Felina';
  const result = validateFastExamCandidate(context(), parsed);
  assert.equal(result.eligible, false);
  assert.equal(result.extraction, null);
  assert.equal(result.reason, 'fast_candidate_failed_existing_validation');
});

test('n8n can embed the pure functions without importing a module or hidden closure', () => {
  const functions = [validateExamExtraction, parseHopeLabFastCandidate, validateFastExamCandidate, inspectFastExtraction];
  const bundled = new Function('context', functions.map(fn => fn.toString()).join('\n') + '\nreturn inspectFastExtraction(context, {mode:"active"});');
  assert.deepEqual(bundled(context()), inspectFastExtraction(context(), { mode: 'active' }));
});

test('JEV uses the official decisions envelope, fixed provider and only bounded document text', () => {
  const request = createJevRoutingRequest(context(text.repeat(10)), general);
  assert.equal(request.model, 'typesafe/jev-1.14');
  assert.deepEqual(request.provider, { zdr: true, data_collection: 'deny', allow_fallbacks: false });
  assert.equal(request.questions.extraction_route.type, 'choice');
  assert.deepEqual(Object.keys(request.questions.extraction_route.criteria), ['hopelab_parser_candidate', 'general_extraction', 'manual_review_candidate']);
  assert.equal(request.state.truncated, true);
  assert.equal(request.state.pages[0].excerpt.length, 2000);
  assert.equal(Object.hasOwn(request, 'messages'), false);
  assert.equal(Object.hasOwn(request, 'apiKey'), false);
  assert.equal(Object.hasOwn(request, 'token'), false);
  const many = createJevRoutingRequest({ pages: Array(5).fill('x'.repeat(3000)), totalPages: 5 }, general);
  assert(many.state.pages.reduce((sum, page) => sum + page.excerpt.length, 0) <= 6000);
});

test('JEV is skipped for deterministic acceptance, vision, missing or malformed text', () => {
  assert.equal(createJevRoutingRequest(context(), { accepted: true }), null);
  assert.equal(createJevRoutingRequest(context(), { shadow: { eligible: true } }), null);
  for (const ctx of [null, {}, context(''), context(text, { isVision: true }),
    context(text, { canExtract: false }),
    context(text, { totalPages: 2 }), context(text, { pages: [5] })]) {
    assert.equal(createJevRoutingRequest(ctx, general), null);
  }
});

test('JEV responses produce advisory observations only, never extraction fields', () => {
  for (const route of ['hopelab_parser_candidate', 'general_extraction', 'manual_review_candidate']) {
    assert.deepEqual(parseJevRoutingResponse(answer(route)), { ok: true, route, confidence: 0.93, costUsd: 0.00001, model: 'typesafe/jev-1.14', errorCode: null });
  }
  assert.equal(parseJevRoutingResponse(answer('general_extraction', { model: 'typesafe/jev-1.14-20261030' })).ok, true);
  for (const body of [null, {}, answer('unknown'), answer('general_extraction', { error: {} }),
    answer('general_extraction', { model: 'other/model' }), answer('general_extraction', { answers: {} }),
    answer('general_extraction', { answers: { extraction_route: { type: 'choice', choice: 'general_extraction', confidence: 1.5 } } })]) {
    const result = parseJevRoutingResponse(body);
    assert.equal(result.ok, false);
    assert.equal(result.route, null);
    assert.equal(Object.hasOwn(result, 'fields'), false);
  }
  assert.equal(parseJevRoutingResponse(answer('general_extraction', { usage: { cost: -1 } })).costUsd, null);
});

test('JEV transport is injected, disabled by default and capped at two seconds', async () => {
  let calls = 0;
  const requestDecision = async request => {
    calls++;
    assert.equal(request.url, 'https://openrouter.ai/api/alpha/decisions');
    assert.equal(request.timeoutMs, 2000);
    assert.equal(request.signal.aborted, false);
    assert.equal(request.body.model, 'typesafe/jev-1.14');
    return answer();
  };
  assert.equal(await requestJevRoutingShadow(context(), general, { requestDecision }), undefined);
  assert.equal(calls, 0);
  const observed = await requestJevRoutingShadow(context(), general, { enabled: true, requestDecision, timeoutMs: 9000 });
  assert.equal(calls, 1);
  assert.equal(observed.route, 'general_extraction');
  assert.deepEqual(general, { accepted: false, route: 'general', reason: 'ambiguous_identification_columns' });
});

test('JEV timeout aborts its own request and transport failure never throws into extraction', async () => {
  let signal;
  const timedOut = await requestJevRoutingShadow(context(), general, { enabled: true, timeoutMs: 5,
    requestDecision: request => { signal = request.signal; return new Promise(() => {}); } });
  assert.equal(timedOut, undefined);
  assert.equal(signal.aborted, true);
  const failed = await requestJevRoutingShadow(context(), general, { enabled: true,
    requestDecision: async () => { throw new Error('synthetic transport failure'); } });
  assert.equal(failed, undefined);
  let calls = 0;
  assert.equal(await requestJevRoutingShadow(context(), { accepted: true }, { enabled: true, requestDecision: async () => { calls++; } }), undefined);
  assert.equal(calls, 0);
});
