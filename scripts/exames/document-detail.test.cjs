// Exercise the detail component with persisted hook state, without network or DOM.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const jsx = require('react/jsx-runtime');
const root = path.resolve(__dirname, '../..');
let states = [], index = 0, mutations = [], currentDocument;
const candidate = { pet_id: 'pet-1', pet_name: 'Nina', client_name: 'Maria Silva', client_code: '42', items: [] };
const notices = [];
const load = (file, mocks = {}) => {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => {
    if (name in mocks) return mocks[name];
    throw new Error('Unmocked dependency: ' + name);
  }, module, module.exports);
  return module.exports;
};
const status = load('src/lib/document-status.ts');
const hooks = {
  useDocumentAction: () => ({ isPending: false, mutateAsync: async entry => {
    mutations.push(entry);
    const saved = { ...currentDocument, version: currentDocument.version + 1, confirmed_data: entry.args.p_fields || entry.args.p_confirmed || currentDocument.confirmed_data, identification_status: entry.name === 'review_exam_document' ? 'suggested' : 'confirmed', pet_id: entry.args.p_pet_id || currentDocument.pet_id };
    currentDocument = saved;
    return saved;
  } }),
  useDocumentCandidates: () => ({ data: [candidate] }),
  useDocumentEvents: () => ({ data: [{ id: 1, event_type: 'link_auto_confirmed', created_at: '2026-10-16T12:00:00Z', actor_id: null }] }),
  useExamDocument: () => ({ data: currentDocument }),
  callDocumentService: () => { throw new Error('Unexpected PDF request'); },
};
const { ExamDocumentDetail } = load('src/pages/ExamDocumentDetail.tsx', {
  react: { useState: initial => {
    const slot = index++;
    if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial;
    return [states[slot], value => { states[slot] = typeof value === 'function' ? value(states[slot]) : value; }];
  }, useEffect: () => {}, useDeferredValue: value => value },
  'react/jsx-runtime': jsx,
  'react-router-dom': { Link: 'Link', useParams: () => ({ documentId: currentDocument.id }) },
  'lucide-react': { ArrowLeft: 'ArrowLeft', Download: 'Download', FileText: 'FileText', Loader2: 'Loader2' },
  sonner: { toast: { success: value => notices.push(value), error: value => notices.push(value) } },
  '@/contexts/exam-auth': { useExamAuth: () => ({ role: 'admin', session: { user: { id: 'user-1' } } }) },
  '@/hooks/useExamDocuments': hooks,
  '@/components/documents/DocumentBadge': { DocumentBadge: 'DocumentBadge' },
  '@/components/documents/DocumentControls': { DocumentCorrection: 'DocumentCorrection', DocumentGroupConfirmation: 'DocumentGroupConfirmation', DocumentProvenance: 'DocumentProvenance' },
  '@/lib/document-status': status,
});
function nodes(tree) { const result = []; const walk = value => { if (Array.isArray(value)) return value.forEach(walk); if (!value || typeof value !== 'object') return; result.push(value); walk(value.props?.children); }; walk(tree); return result; }
function text(value) { return Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value == null || value === false ? '' : String(value); }
const doc = () => ({ id: '10000000-0000-4000-8000-000000000001', version: 1, original_name: 'Exame.pdf', received_at: '2026-10-16T12:00:00Z', file_status: 'saved', identification_status: 'unidentified', extracted_data: { pet_name: 'Nina', exam_type: 'Hemograma', exam_date: '2026-10-16' }, confirmed_data: {}, pet_id: null, review_reason: null, previous_document_id: null, assigned_to: null, contact_status: 'pending', nexus_status: 'awaiting_link', group_status: 'pending', sources: [], items: [], deliveries: [] });
currentDocument = doc();
const page = nodes(ExamDocumentDetail());
const Work = page.find(node => node.type?.name === 'DocumentWork').type;
const History = page.find(node => node.type?.name === 'DocumentHistory').type;
const render = () => { index = 0; return nodes(Work({ doc: currentDocument })); };
const button = (tree, label) => tree.find(node => node.type === 'button' && text(node) === label);
const field = (tree, label) => nodes(tree.find(node => node.type === 'label' && text(node).startsWith(label))).find(node => node.type === 'input');
let checks = 0;
const check = (name, run) => { run(); checks++; console.log('ok ' + checks + ' - ' + name); };
(async () => {
  let tree = render();
  check('pending document offers manual selection without holding the group notification', () => {
    assert.match(text(tree[0]), /Pendente de seleção do cadastro/);
    assert.match(text(tree[0]), /aviso ao grupo é enviado automaticamente/);
    assert.equal(button(tree, 'Salvar identificação').props.disabled, false);
    assert.doesNotMatch(text(tree[0]), /Salvar e liberar aviso/);
  });
  field(tree, 'Tutor').props.onChange({ target: { value: 'Maria Silva' } });
  currentDocument = { ...currentDocument, version: 2, group_status: 'sent', assigned_to: 'user-2', deliveries: [{ id: 'group-1', destination: 'group', status: 'sent' }] };
  tree = render();
  check('background delivery and assignment preserve local edits and allow saving', () => {
    assert.equal(field(tree, 'Tutor').props.value, 'Maria Silva');
    assert.equal(button(tree, 'Salvar identificação').props.disabled, false);
    assert.doesNotMatch(text(tree[0]), /A identificação foi atualizada/);
  });
  button(tree, 'Salvar identificação').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  check('save keeps the database compare-and-swap on the latest version', () => {
    assert.equal(mutations[0].args.p_expected_version, 2);
    assert.equal(mutations[0].args.p_fields.client_name, 'Maria Silva');
    assert.equal(button(render(), 'Salvar identificação').props.disabled, false);
  });
  currentDocument = { ...currentDocument, version: 4, confirmed_data: { ...currentDocument.confirmed_data, client_name: 'Outro tutor' } };
  tree = render();
  check('concurrent identity change blocks confirmation without discarding local edits', () => {
    assert.equal(field(tree, 'Tutor').props.value, 'Maria Silva');
    assert.equal(button(tree, 'Salvar identificação').props.disabled, true);
    assert.match(text(tree[0]), /A identificação foi atualizada/);
  });
  button(tree, 'Recarregar identificação').props.onClick();
  tree = render();
  check('explicit reload accepts the current identity before another save', () => {
    assert.equal(field(tree, 'Tutor').props.value, 'Outro tutor');
    assert.equal(button(tree, 'Salvar identificação').props.disabled, false);
  });
  tree.find(node => node.type === 'input' && node.props.type === 'radio').props.onChange();
  tree = render();
  nodes(tree.find(node => node.type === 'label' && text(node).startsWith('Conferi o PDF'))).find(node => node.type === 'input').props.onChange({ target: { checked: true } });
  tree = render();
  button(tree, 'Confirmar cadastro e anexar').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  check('manual selection sends the selected pet, fields and current version for automatic attachment', () => {
    assert.equal(mutations[1].name, 'confirm_exam_document_link');
    assert.equal(mutations[1].args.p_pet_id, 'pet-1');
    assert.equal(mutations[1].args.p_expected_version, 4);
    assert.equal(mutations[1].args.p_confirmed.client_name, 'Maria Silva');
    assert.equal(mutations[1].args.p_confirmed.exam_date, '2026-10-16');
  });
  states = []; currentDocument = { ...doc(), pet_id: 'pet-1', identification_status: 'confirmed', nexus_status: 'completed', deliveries: [{ id: 'nexus-1', destination: 'nexus', status: 'completed' }] };
  tree = render();
  check('already attached document displays the actual state and locks identity changes', () => {
    assert.match(text(tree[0]), /Exame anexado ao cadastro no PAM Nexus/);
    assert.equal(tree.some(node => node.type === 'input' && node.props.type === 'radio'), false);
    assert.equal(button(tree, 'Salvar identificação').props.disabled, true);
  });
  check('automatic match history does not attribute the action to the team', () => {
    const history = History({ id: currentDocument.id });
    assert.match(text(history), /Cadastro identificado automaticamente/);
    assert.doesNotMatch(text(history), /ação registrada pela equipe/);
  });
  console.log(checks + ' document detail regression checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
