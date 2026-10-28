const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');

function load(file, mocks = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8').replaceAll('import.meta.env', '({})');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    throw new Error('Unmocked dependency: ' + name);
  }, module, module.exports);
  return module.exports;
}

const errors = load('src/lib/document-action-error.ts');
const normalize = errors.normalizeDocumentActionError;
let checks = 0;
const check = async (name, run) => { await run(); console.log(`ok ${++checks} - ${name}`); };

(async () => {
  await check('plain PostgREST business failure becomes an Error the detail toast can display', () => {
    const raw = { code: 'P0001', message: 'Tipo do exame necessário para criar resultado externo', details: null, hint: null };
    assert.equal(raw instanceof Error, false);
    const error = normalize(raw);
    assert(error instanceof Error);
    assert.equal(error.code, 'P0001');
    assert.equal(error.message, 'Preencha o tipo do exame antes de confirmar o cadastro.');
    assert.equal(normalize(error), error);
  });
  await check('conflict, invalid date and access failures give actionable instructions', () => {
    assert.match(normalize({ code: '40001', message: 'internal detail' }).message, /atualizado em outra etapa/);
    assert.match(normalize({ code: '22008', message: 'date/time field value out of range: secret' }).message, /data válida/);
    assert.match(normalize({ code: '42501', message: 'permission denied for function private_helper' }).message, /não tem permissão/);
    assert.match(normalize({ code: 'PGRST301', message: 'secret JWT' }).message, /Entre novamente/);
    assert.match(normalize({ code: '23514', message: 'Item pertence a outro paciente/tutor ou card arquivado' }).message, /Confira a seleção/);
  });
  await check('unknown SQL, hints and record values never reach the toast', () => {
    for (const raw of [
      { code: '42702', message: 'column reference "secret_column" is ambiguous', details: 'private patient record', hint: 'SQL private helper' },
      { code: 'P0001', message: 'secret custom exception', details: 'private patient record' },
      new Error('secret token or SQL exception'), null, undefined,
    ]) {
      const error = normalize(raw);
      assert.match(error.message, /Não foi possível salvar a alteração/);
      assert.doesNotMatch(error.message, /secret|SQL|private/);
      assert.equal('details' in error, false);assert.equal('hint' in error, false);
    }
  });
  await check('network failure has a connection instruction and no raw technical text', () => {
    assert.match(normalize({ code: '', message: 'TypeError: Failed to fetch' }).message, /Confira sua conexão/);
  });

  let response = { data: null, error: null }, thrown;
  const writes = [], invalidations = [];
  const hooks = load('src/hooks/useExamDocuments.ts', {
    '@/lib/document-service-request': { requestDocumentDeletion: () => { throw Error('Unexpected deletion in unrelated query test') } },
    '@tanstack/react-query': { useMutation: options => options, useQuery: () => {}, useQueryClient: () => ({ invalidateQueries: input => invalidations.push(input) }) },
    '@/lib/supabase': { supabase: { rpc: async (name, args) => { writes.push({ name, args });if (thrown) throw thrown;return response; } } },
    '@/contexts/exam-auth': { useExamAuth: () => ({}) },
    '@/lib/document-action-error': errors,
  });
  const mutation = hooks.useDocumentAction();
  const args = { p_document_id: 'synthetic-document', p_pet_id: 'synthetic-pet', p_expected_version: 7, p_item_ids: [], p_confirmed: { pet_name: 'Bono', client_name: 'Pessoa fictícia', exam_type: 'Hemograma', exam_date: '2026-10-16' } };
  await check('the real mutation preserves request fields, normalizes conflict, refreshes queries and does not retry', async () => {
    response = { data: null, error: { code: '40001', message: 'Documento mudou; atualize a tela' } };
    let failure;
    try { await mutation.mutationFn({ name: 'confirm_exam_document_link', args }); } catch (error) { failure = error; }
    assert(failure instanceof errors.DocumentActionError);assert.equal(failure.code, '40001');
    mutation.onError(failure);
    assert.equal(writes.length, 1);assert.equal(writes[0].args, args);assert.equal(args.p_confirmed.exam_date, '2026-10-16');
    assert.deepEqual(invalidations, [{ queryKey: ['exam-documents'] }, { queryKey: ['exam-document'] }, { queryKey: ['exam-document-events'] }]);
  });
  await check('business and transport errors are normalized without an automatic write or success refresh', async () => {
    invalidations.length = 0;
    response = { data: null, error: { code: 'P0001', message: 'Tipo do exame necessário para criar resultado externo' } };
    await assert.rejects(() => mutation.mutationFn({ name: 'confirm_exam_document_link', args }), error => {
      mutation.onError(error);return error instanceof Error && /Preencha o tipo/.test(error.message);
    });
    assert.deepEqual(invalidations, []);
    thrown = new TypeError('Failed to fetch');
    await assert.rejects(() => mutation.mutationFn({ name: 'confirm_exam_document_link', args }), /Confira sua conexão/);
    thrown = undefined;
    response = { data: { success: false, error: 'Motivo obrigatório' }, error: null };
    await assert.rejects(() => mutation.mutationFn({ name: 'review_exam_document', args }), /Informe o motivo/);
    assert.equal(writes.length, 4);
  });
  await check('successful confirmation returns the exact saved record and retains existing invalidations', async () => {
    const saved = { document: { id: 'synthetic-document', version: 8 } };
    response = { data: saved, error: null };
    assert.equal(await mutation.mutationFn({ name: 'confirm_exam_document_link', args }), saved);
    mutation.onSuccess();assert.equal(invalidations.length, 7);
  });
  console.log(`${checks} document action error checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
