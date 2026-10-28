// Exercise the real responsibility UI without a browser, network, or clinical data.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const ts = require('typescript');
const jsx = require('react/jsx-runtime');
const root = path.resolve(__dirname, '../..');

function load(file, mocks = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText.replaceAll('import.meta.env', '({})');
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => {
    if (name in mocks) return mocks[name];
    if (name.endsWith('.css')) return {};
    throw new Error('Unmocked dependency: ' + name);
  }, module, module.exports);
  return module.exports;
}
function nodes(tree) {
  const result = [];
  function walk(value) {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    result.push(value);
    walk(value.props?.children);
  }
  walk(tree);
  return result;
}
function text(value) {
  return Array.isArray(value) ? value.map(text).join('')
    : value && typeof value === 'object' ? text(value.props?.children)
      : value == null || value === false ? '' : String(value);
}
const vets = [
  { id: 'clinical-vet-1', nome: 'Dra. Helena Beatriz', avatar_url: '/fixture-helena.png' },
  { id: 'clinical-vet-2', nome: 'Dr. João Marcos', avatar_url: null },
];
function fixture(overrides = {}) {
  return {
    id: '10000000-0000-4000-8000-000000000001', version: 7,
    original_name: 'Exame.pdf', received_at: '2026-10-18T12:00:00Z',
    file_status: 'saved', identification_status: 'unidentified',
    extracted_data: { pet_name: 'Luna', client_name: 'Maria Souza', exam_type: 'Hemograma', exam_date: '2026-10-18' },
    confirmed_data: {}, pet_id: null, assigned_to: null, assigned_name: null,
    responsible_vet_id: null, responsible_vet_name: null, responsible_vet_avatar_url: null, responsible_vet_source: null,
    group_status: 'pending', nexus_status: 'awaiting_link', contact_status: 'pending',
    completed: false, sources: [], items: [], deliveries: [], ...overrides,
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness(options = {}) {
  const states = [];
  let index = 0;
  let doc = fixture(options.doc);
  const query = { data: vets, isLoading: false, error: null, refetch: async () => { refreshVets++; }, ...options.query };
  const mutations = [], notices = [];
  let refreshes = 0, refreshVets = 0;
  const auth = { membership: true, role: options.role || 'admin', session: { user: { id: 'auth-operator', email: 'operator@example.invalid', user_metadata: { full_name: 'Operador autenticado' } } } };
  const { ExamDocumentContent } = load('src/pages/ExamDocumentDetail.tsx', {
    react: {
      useState: initial => {
        const slot = index++;
        if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial;
        return [states[slot], value => { states[slot] = typeof value === 'function' ? value(states[slot]) : value; }];
      },
      useRef: initial => {
        const slot = index++;
        if (!(slot in states)) states[slot] = { current: initial };
        return states[slot];
      },
      useEffect: () => {},
    },
    'react/jsx-runtime': jsx,
    'react-router-dom': { Link: 'Link', useParams: () => ({}), useLocation: () => ({ state: null }), useSearchParams: () => [new URLSearchParams()] },
    '@/lib/fireworks': { triggerFireworksAt: () => {} },
    'lucide-react': new Proxy({}, { get: (_, name) => String(name) }),
    '@phosphor-icons/react/dist/csr/WhatsappLogo': { WhatsappLogo: 'WhatsappLogo' },
    sonner: { toast: { success: message => notices.push({ type: 'success', message }), error: message => notices.push({ type: 'error', message }) } },
    '@/contexts/exam-auth': { useExamAuth: () => auth },
    '@/hooks/useVets': { useVets: () => query },
    '@/hooks/useExamDocuments': {
      useExamDocument: () => ({ data: doc }),
      useDocumentAction: () => ({ isPending: false, mutateAsync: async entry => {
        mutations.push(entry);
        if (options.persist) await options.persist(entry);
        const vet = vets.find(item => item.id === entry.args.p_veterinarian_id);
        doc = { ...doc, version: doc.version + 1, responsible_vet_id: vet.id, responsible_vet_name: vet.nome, responsible_vet_avatar_url: vet.avatar_url, responsible_vet_source: 'manual' };
        return doc;
      } }),
    },
    '@/components/documents/DocumentDelete': { DocumentDelete: 'DocumentDelete' },
    '@/components/documents/DocumentControls': { DocumentCorrection: 'DocumentCorrection', DocumentGroupConfirmation: 'DocumentGroupConfirmation', DocumentProvenance: 'DocumentProvenance' },
    '@/components/documents/ExamDocumentPanels': { DocumentForm: 'DocumentForm', DocumentHistory: 'DocumentHistory', DocumentPreview: 'DocumentPreview', DocumentSteps: 'DocumentSteps' },
    '@/components/documents/ExamDetailSheet': { ExamDetailSheet: 'ExamDetailSheet' },
    // Version review has its own isolated tests; keep this harness focused on responsibility.
    '@/components/documents/DocumentVersionReview': { DocumentVersionReview: 'DocumentVersionReview' },
    '@/lib/document-status': load('src/lib/document-status.ts'),
    '@/lib/exam-detail-progress': load('src/lib/exam-detail-progress.ts'),
  });
  const render = () => {
    index = 0;
    return nodes(ExamDocumentContent({ doc, refresh: async () => { refreshes++; if (options.refresh) await options.refresh(); return { data: doc }; } }));
  };
  const open = () => {
    render().find(node => node.type === 'button' && node.props.className === 'exam-detail-responsible').props.onClick();
    return render();
  };
  const vetButton = (tree, name) => tree.find(node => node.type === 'button' && node.props.className?.startsWith('exam-detail-vet') && text(node).includes(name));
  return { render, open, vetButton, query, mutations, notices, get doc() { return doc; }, get refreshes() { return refreshes; }, get refreshVets() { return refreshVets; } };
}

test('every existing member can choose from active clinical vets without equating them to the logged-in account', () => {
  const h = harness({ role: 'reception' });
  const tree = h.open();
  assert.ok(h.vetButton(tree, vets[0].nome));
  assert.ok(h.vetButton(tree, vets[1].nome));
  assert.doesNotMatch(text(tree[0]), /Operador autenticado|Transferir para mim|Você/);
  assert.ok(nodes(h.vetButton(tree, vets[0].nome)).some(node => node.type === 'img' && node.props.src === vets[0].avatar_url));
  assert.equal(h.vetButton(tree, vets[0].nome).props.disabled, false);
  assert.equal(h.mutations.length, 0);
});

test('one tap persists the clinical ID and current version; duplicate taps and premature success are prevented', async () => {
  const pending = deferred();
  const h = harness({ persist: () => pending.promise });
  const before = h.open();
  const choose = h.vetButton(before, vets[1].nome).props.onClick;
  choose();
  choose();
  let tree = h.render();
  assert.equal(h.mutations.length, 1);
  assert.deepEqual(h.mutations[0], { name: 'set_exam_document_responsible_vet', args: { p_document_id: h.doc.id, p_veterinarian_id: vets[1].id, p_expected_version: 7 } });
  assert.equal(h.doc.assigned_to, null);
  assert.equal(h.doc.responsible_vet_id, null);
  assert.equal(h.refreshes, 0);
  assert.equal(h.notices.length, 0);
  assert.equal(tree.find(node => node.type === 'ExamDetailSheet').props.open, true);
  assert.ok(vets.every(vet => h.vetButton(tree, vet.nome).props.disabled));
  pending.resolve();
  await settle();
  tree = h.render();
  assert.equal(h.doc.responsible_vet_id, vets[1].id);
  assert.equal(h.refreshes, 1);
  assert.equal(tree.find(node => node.type === 'ExamDetailSheet').props.open, false);
  assert.equal(h.notices.filter(notice => notice.type === 'success').length, 1);
  assert.match(text(tree.find(node => node.props.className === 'exam-detail-responsible')), /Dr\. João Marcos/);
});

test('failed persistence keeps the old responsible and the picker open for an explicit retry', async () => {
  const h = harness({ doc: { responsible_vet_id: vets[0].id, responsible_vet_name: vets[0].nome, responsible_vet_source: 'pdf' }, persist: () => Promise.reject(new Error('Falha de conexão.')) });
  h.vetButton(h.open(), vets[1].nome).props.onClick();
  await settle();
  const tree = h.render();
  assert.equal(h.doc.responsible_vet_id, vets[0].id);
  assert.equal(tree.find(node => node.type === 'ExamDetailSheet').props.open, true);
  assert.equal(h.vetButton(tree, vets[1].nome).props.disabled, false);
  assert.equal(h.vetButton(tree, vets[0].nome).props['aria-pressed'], true);
  assert.equal(h.refreshes, 0);
  assert.equal(h.notices.filter(notice => notice.type === 'success').length, 0);
  assert.deepEqual(h.notices, [{ type: 'error', message: 'Falha de conexão.' }]);
});

test('clinical responsibility wins over legacy auth assignment and never gains a false Você badge', () => {
  const h = harness({ doc: { assigned_to: 'auth-operator', assigned_name: 'Nome do login', responsible_vet_id: vets[0].id, responsible_vet_name: vets[0].nome, responsible_vet_avatar_url: vets[0].avatar_url } });
  const tree = h.open();
  assert.match(text(tree.find(node => node.props.className === 'exam-detail-responsible')), /Dra\. Helena Beatriz/);
  assert.doesNotMatch(text(tree[0]), /Operador autenticado|Nome do login|Você/);
  assert.equal(h.vetButton(tree, vets[0].nome).props.disabled, true);
  assert.equal(h.vetButton(tree, vets[1].nome).props.disabled, false);
  assert.equal(h.mutations.length, 0);
});

test('conflicting evidence remains pending, and an unconfirmed name is never displayed as a selected vet', () => {
  const h = harness({ doc: { responsible_vet_source: 'conflict', responsible_vet_name: 'Nome sem confirmação' } });
  const tree = h.open();
  assert.match(text(tree[0]), /Responsável a conferir/);
  assert.doesNotMatch(text(tree[0]), /Nome sem confirmação/);
  assert.ok(vets.every(vet => h.vetButton(tree, vet.nome).props['aria-pressed'] === false));
});

test('the picker has distinct loading, failed/retry, and empty states without inventing staff', async () => {
  const loading = harness({ query: { data: undefined, isLoading: true } });
  assert.match(text(loading.open()[0]), /Carregando equipe/);
  assert.equal(loading.vetButton(loading.render(), vets[0].nome), undefined);
  const failed = harness({ query: { data: undefined, error: new Error('fixture') } });
  const errorTree = failed.open();
  assert.match(text(errorTree[0]), /Não foi possível carregar a equipe/);
  errorTree.find(node => node.type === 'button' && text(node) === 'Tentar novamente').props.onClick();
  await settle();
  assert.equal(failed.refreshVets, 1);
  const empty = harness({ query: { data: [] } });
  assert.match(text(empty.open()[0]), /Nenhuma veterinária ativa disponível/);
  assert.equal(empty.vetButton(empty.render(), vets[0].nome), undefined);
});

test('a completed request does not close a different panel opened while it was saving', async () => {
  const pending = deferred();
  const h = harness({ persist: () => pending.promise });
  h.vetButton(h.open(), vets[0].nome).props.onClick();
  let tree = h.render();
  tree.find(node => node.type === 'ExamDetailSheet').props.onOpenChange(false);
  tree = h.render();
  tree.find(node => node.type === 'button' && text(node) === 'Abrir PDF').props.onClick();
  pending.resolve();
  await settle();
  const sheet = h.render().find(node => node.type === 'ExamDetailSheet');
  assert.equal(sheet.props.open, true);
  assert.equal(sheet.props.title, 'PDF do exame');
});

test('identity and patient save callbacks dismiss their containing modal', () => {
  const h = harness();
  let tree = h.render();
  tree.find(node => node.type === 'button' && node.props['aria-label'] === 'Opções do exame').props.onClick();
  h.render().find(node => node.type === 'button' && text(node) === 'Conferir dados do exame').props.onClick();
  tree = h.render();
  assert.equal(tree.find(node => node.type === 'ExamDetailSheet').props.title, 'Dados do exame');
  tree.find(node => node.type === 'DocumentForm').props.onSaved();
  assert.equal(h.render().find(node => node.type === 'ExamDetailSheet').props.open, false);
  tree = h.render();
  tree.find(node => node.type === 'button' && text(node).includes('Adicionar exame ao cadastro')).props.onClick();
  h.render().find(node => node.type === 'DocumentForm').props.onSaved();
  assert.equal(h.render().find(node => node.type === 'ExamDetailSheet').props.open, false);
});

test('a late identity save does not dismiss a newer panel', () => {
  const h = harness();
  h.render().find(node => node.type === 'button' && node.props['aria-label'] === 'Opções do exame').props.onClick();
  h.render().find(node => node.type === 'button' && text(node) === 'Conferir dados do exame').props.onClick();
  const saved = h.render().find(node => node.type === 'DocumentForm').props.onSaved;
  h.render().find(node => node.type === 'ExamDetailSheet').props.onOpenChange(false);
  h.render().find(node => node.type === 'button' && text(node) === 'Abrir PDF').props.onClick();
  saved();
  const sheet = h.render().find(node => node.type === 'ExamDetailSheet');
  assert.equal(sheet.props.open, true);
  assert.equal(sheet.props.title, 'PDF do exame');
});

test('a persisted contact opens one centered confirmation even if its follow-up read fails', async () => {
  const h = harness({ doc: { pet_id: 'pet-fixture' }, refresh: () => Promise.reject(new Error('Read unavailable')) });
  h.render().find(node => node.type === 'button' && node.props['aria-label'] === 'Registrar contato com o tutor').props.onClick();
  await h.render().find(node => node.type === 'DocumentForm').props.onContactSaved();
  let tree = h.render();
  const sheet = tree.find(node => node.type === 'ExamDetailSheet');
  assert.equal(sheet.props.title, 'Contato registrado');
  assert.equal(sheet.props.centered, true);
  assert.equal(h.refreshes, 1);
  assert.deepEqual(h.notices, []);
  assert.match(text(tree[0]), /O contato foi salvo para os itens selecionados/);
  assert.doesNotMatch(text(tree[0]), /demais itens continuam pendentes/);
  tree.find(node => node.type === 'button' && text(node).includes('Voltar ao exame')).props.onClick();
  tree = h.render();
  assert.equal(tree.find(node => node.type === 'ExamDetailSheet').props.open, false);
});

test('the unassigned list excludes both clinical and legacy assignments', async () => {
  const calls = [];
  const query = {};
  for (const method of ['select', 'order', 'is', 'eq']) query[method] = (...args) => { calls.push([method, ...args]); return query; };
  query.range = async () => ({ data: [], count: 0, error: null });
  const hooks = load('src/hooks/useExamDocuments.ts', {
    '@tanstack/react-query': { useQuery: options => options },
    '@/lib/supabase': { supabase: { from: table => { calls.push(['from', table]); return query; } } },
    '@/contexts/exam-auth': { useExamAuth: () => ({ membership: true, session: { user: { id: 'auth-operator' } } }) },
    '@/lib/document-action-error': { DocumentActionError: Error, normalizeDocumentActionError: error => error },
  });
  await hooks.useExamDocuments('', 'unassigned', 0).queryFn();
  assert.ok(calls.some(call => call[0] === 'is' && call[1] === 'responsible_vet_id' && call[2] === null));
  assert.ok(calls.some(call => call[0] === 'is' && call[1] === 'assigned_to' && call[2] === null));
  assert.ok(calls.some(call => call[0] === 'eq' && call[1] === 'completed' && call[2] === false));
});

test('history presents the clinical responsible separately from the authenticated contact author', () => {
  const { DocumentProvenance } = load('src/components/documents/DocumentControls.tsx', {
    react: { useState: initial => [initial, () => {}] },
    'react/jsx-runtime': jsx,
    'react-router-dom': { Link: 'Link' },
    sonner: { toast: {} },
    '@/contexts/exam-auth': { useExamAuth: () => ({ session: { user: { id: 'auth-operator', email: 'operator@example.invalid' } } }) },
    '@/hooks/useExamDocuments': {},
    '@/lib/document-status': load('src/lib/document-status.ts'),
  });
  const tree = DocumentProvenance({ doc: fixture({
    assigned_to: 'auth-operator', responsible_vet_id: vets[0].id, responsible_vet_name: vets[0].nome,
    items: [{ exam_item_id: 'item', exam_type: 'Hemograma', contacted_at: '2026-10-18T12:30:00Z', contacted_by: 'auth-operator', contact_channel: 'whatsapp', contact_note: 'Registro sintético.' }],
  }) });
  assert.match(text(tree), /Responsável: Dra\. Helena Beatriz/);
  assert.match(text(tree), /Registro sintético/);
  assert.match(text(tree), /operator@example\.invalid/);
  assert.doesNotMatch(text(tree), /Responsável: operator/);
});

test('an inactive clinical vet gets a precise message without implying missing login access', () => {
  const { normalizeDocumentActionError } = load('src/lib/document-action-error.ts');
  const error = normalizeDocumentActionError({ code: '22023', message: 'Veterinária não encontrada ou inativa' });
  assert.match(error.message, /não está mais ativa/);
  assert.doesNotMatch(error.message, /não tem acesso|login|permissão/);
  assert.equal(error.code, '22023');
});
