// Exercise the detail component with persisted hook state, without network or DOM.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const jsx = require('react/jsx-runtime');
const root = path.resolve(__dirname, '../..');
let states = [], index = 0, mutations = [], currentDocument, mutateBehavior;
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
    if (mutateBehavior) return mutateBehavior(entry);
    const saved = { ...currentDocument, version: currentDocument.version + 1, confirmed_data: entry.args.p_fields || entry.args.p_confirmed || currentDocument.confirmed_data, identification_status: entry.name === 'review_exam_document' ? 'suggested' : 'confirmed', pet_id: entry.args.p_pet_id || currentDocument.pet_id };
    currentDocument = saved;
    return saved;
  } }),
  useDocumentCandidates: () => ({ data: [candidate] }),
  useDocumentEvents: () => ({ data: [{ id: 1, event_type: 'link_auto_confirmed', created_at: '2026-10-16T12:00:00Z', actor_id: null }] }),
  useExamDocument: () => ({ data: currentDocument }),
  callDocumentService: () => { throw new Error('Unexpected PDF request'); },
};
const { DocumentForm, DocumentHistory } = load('src/components/documents/ExamDocumentPanels.tsx', {
  react: { useState: initial => {
    const slot = index++;
    if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial;
    return [states[slot], value => { states[slot] = typeof value === 'function' ? value(states[slot]) : value; }];
  }, useRef: initial => { const slot = index++; if (!(slot in states)) states[slot] = { current: initial }; return states[slot]; }, useEffect: () => {}, useDeferredValue: value => value },
  'react/jsx-runtime': jsx,
  'lucide-react': { Download: 'Download', ExternalLink: 'ExternalLink' },
  sonner: { toast: { success: value => notices.push(value), error: value => notices.push(value) } },
  '@/contexts/exam-auth': { useExamAuth: () => ({ role: 'admin', session: { user: { id: 'user-1' } } }) },
  '@/hooks/useExamDocuments': hooks,
  '@/components/documents/DocumentBadge': { DocumentBadge: 'DocumentBadge' },
  '@/lib/document-status': status,
});
function nodes(tree) { const result = []; const walk = value => { if (Array.isArray(value)) return value.forEach(walk); if (!value || typeof value !== 'object') return; result.push(value); walk(value.props?.children); }; walk(tree); return result; }
function text(value) { return Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value == null || value === false ? '' : String(value); }
const doc = () => ({ id: '10000000-0000-4000-8000-000000000001', version: 1, original_name: 'Exame.pdf', received_at: '2026-10-16T12:00:00Z', file_status: 'saved', identification_status: 'unidentified', extracted_data: { pet_name: 'Nina', exam_type: 'Hemograma', exam_date: '2026-10-16' }, confirmed_data: {}, pet_id: null, review_reason: null, previous_document_id: null, assigned_to: null, contact_status: 'pending', nexus_status: 'awaiting_link', group_status: 'pending', sources: [], items: [], deliveries: [] });
currentDocument = doc();
const render = (props = {}) => { index = 0; return nodes(DocumentForm({ doc: currentDocument, mode: 'patient', ...props })); };
const button = (tree, label) => tree.find(node => node.type === 'button' && text(node) === label);
const field = (tree, label) => nodes(tree.find(node => node.type === 'label' && text(node).startsWith(label))).find(node => node.type === 'input');
let checks = 0;
const check = (name, run) => { run(); checks++; console.log('ok ' + checks + ' - ' + name); };
(async () => {
  let tree = render();
  check('pending document offers manual selection without holding the group notification', () => {
    assert.match(text(tree[0]), /Selecionar paciente/);
    assert.match(text(tree[0]), /Busque o pet ou tutor e confira no PDF/);
    assert.equal(button(tree, 'Salvar identificação').props.disabled, false);
    assert.doesNotMatch(text(tree[0]), /Salvar e liberar aviso/);
    assert.equal(mutations.length, 0);
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
  check('changing the patient search clears the previous selection and confirmation', () => {
    const search = tree.find(node => node.type === 'input' && node.props.placeholder === 'Nome do tutor ou pet (mínimo 2 letras)');
    search.props.onChange({ target: { value: 'Outro nome' } });
    const searched = render();
    assert.equal(searched.find(node => node.type === 'input' && node.props.type === 'radio').props.checked, false);
    assert.equal(button(searched, 'Confirmar cadastro e anexar'), undefined);
  });
  tree = render();
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
    const history = DocumentHistory({ id: currentDocument.id });
    assert.match(text(history), /Cadastro identificado automaticamente/);
    assert.doesNotMatch(text(history), /ação registrada pela equipe/);
  });

  const contactDoc = () => ({
    ...doc(), pet_id: 'pet-1', identification_status: 'confirmed', assigned_to: 'user-2',
    nexus_status: 'completed', deliveries: [{ id: 'nexus-1', destination: 'nexus', status: 'completed' }],
    items: [
      { exam_item_id: 'already-contacted', exam_type: 'Exame anterior', contacted_at: '2026-10-16T12:30:00Z' },
      { exam_item_id: 'pending-item', exam_type: 'Hemograma', contacted_at: null },
    ],
  });
  states = []; currentDocument = contactDoc();
  tree = render({ mode: 'contact' });
  check('contact form preserves previously completed items and accepts an optional note', () => {
    const inputs = tree.filter(node => node.type === 'input' && node.props.type === 'checkbox');
    assert.equal(inputs.length, 2);
    assert.equal(inputs[0].props.checked, true);
    assert.equal(inputs[0].props.disabled, true);
    assert.equal(inputs[1].props.checked, true);
    assert.equal(Boolean(inputs[1].props.disabled), false);
    assert.equal(button(tree, 'Registrar contato realizado').props.disabled, false);
  });

  let resolveWrite;
  const pendingWrite = new Promise(resolve => { resolveWrite = resolve; });
  const order = [];
  let successCallbacks = 0;
  mutateBehavior = async () => { order.push('write-started'); const saved = await pendingWrite; order.push('write-resolved'); return saved; };
  const onContactSaved = async () => { successCallbacks++; order.push('success-callback'); };
  tree.find(node => node.type === 'textarea').props.onChange({ target: { value: 'Tutor orientado sobre o resultado e retorno.' } });
  tree.find(node => node.type === 'select').props.onChange({ target: { value: 'phone' } });
  tree = render({ mode: 'contact', onContactSaved });
  const noticesBeforeSuccess = notices.length;
  const mutationsBeforeSuccess = mutations.length;
  button(tree, 'Registrar contato realizado').props.onClick();
  check('contact success is withheld while the persistence request is unresolved', () => {
    assert.equal(button(tree, 'Registrar contato realizado').props.disabled, false);
    assert.equal(successCallbacks, 0);
    assert.equal(notices.length, noticesBeforeSuccess);
    assert.deepEqual(order, ['write-started']);
    assert.equal(mutations.length, mutationsBeforeSuccess + 1);
  });
  resolveWrite({ document: { ...currentDocument, version: 2 } });
  await new Promise(resolve => setImmediate(resolve));
  check('contact callback runs once after persistence and keeps the actual item and channel payload', () => {
    assert.deepEqual(order, ['write-started', 'write-resolved', 'success-callback']);
    assert.equal(successCallbacks, 1);
    const entry = mutations.at(-1);
    assert.equal(entry.name, 'record_exam_document_contact');
    assert.equal(entry.args.p_document_id, currentDocument.id);
    assert.deepEqual(entry.args.p_item_ids, ['pending-item']);
    assert.equal(entry.args.p_channel, 'phone');
    assert.equal(entry.args.p_note, 'Tutor orientado sobre o resultado e retorno.');
    assert.ok(Number.isFinite(Date.parse(entry.args.p_contacted_at)));
    assert.equal(Object.hasOwn(entry.args, 'p_contacted_by'), false);
    assert.equal(notices.length, noticesBeforeSuccess, 'The parent success panel replaces the contact toast.');
  });

  states = []; currentDocument = contactDoc();
  let failedCallbacks = 0;
  mutateBehavior = async () => { throw new Error('Não foi possível persistir o contato.'); };
  const failedCallback = async () => { failedCallbacks++; };
  tree = render({ mode: 'contact', onContactSaved: failedCallback });
  tree.find(node => node.type === 'textarea').props.onChange({ target: { value: 'Contato real ainda não salvo.' } });
  tree = render({ mode: 'contact', onContactSaved: failedCallback });
  const failedMutationsBefore = mutations.length;
  const noticesBeforeFailure = notices.length;
  button(tree, 'Registrar contato realizado').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  check('contact persistence failure never opens success, retries the write or erases the note', () => {
    assert.equal(failedCallbacks, 0);
    assert.equal(mutations.length, failedMutationsBefore + 1);
    assert.deepEqual(notices.slice(noticesBeforeFailure), ['Não foi possível persistir o contato.']);
    assert.equal(render({ mode: 'contact', onContactSaved: failedCallback }).find(node => node.type === 'textarea').props.value, 'Contato real ainda não salvo.');
  });
  mutateBehavior = undefined;
  // The compact workspace keeps the same write contract with one primary action.
  states = []; currentDocument = doc();
  const compactRender = () => render({ compact: true });
  tree = compactRender();
  check('compact form starts with a disabled single confirmation and no redundant search instruction', () => {
    assert.equal(button(tree, 'Confirmar cadastro e anexar').props.disabled, true);
    assert.doesNotMatch(text(tree[0]), /Busque o pet ou tutor e confira no PDF/);
    assert.equal(button(tree, 'Salvar identificação'), undefined);
  });
  tree.find(node => node.type === 'button' && node.props.className === 'candidate').props.onClick();
  tree = compactRender();
  tree.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } });
  tree = compactRender();
  check('choosing and verifying a patient enables compact attachment', () => assert.equal(button(tree, 'Confirmar cadastro e anexar').props.disabled, false));
  field(tree, 'Data do exame').props.onChange({ target: { value: '' } });
  tree = compactRender();
  check('blank date disables attachment instead of silently substituting the received date', () => {
    assert.equal(button(tree, 'Confirmar cadastro e anexar').props.disabled, true);
    assert.equal(tree.find(node => node.type === 'input' && node.props.type === 'checkbox').props.checked, false);
  });
  field(tree, 'Data do exame').props.onChange({ target: { value: '2026-10-29' } });
  tree = compactRender();
  tree.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } });
  tree = compactRender();
  button(tree, 'Confirmar cadastro e anexar').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  check('compact attachment sends verified fields and the selected patient', () => {
    const last = mutations.at(-1);
    assert.equal(last.name, 'confirm_exam_document_link');
    assert.equal(last.args.p_confirmed.exam_date, '2026-10-29');
    assert.equal(last.args.p_pet_id, candidate.pet_id);
  });
  for (const status of ['review', 'not_exam']) {
    states = []; currentDocument = { ...doc(), identification_status: status, review_reason: 'Identificação pendente' };
    const before = mutations.length;
    const version = currentDocument.version;
    tree = compactRender();
    check(`${status} opens without a classification control or automatic write`, () => {
      assert.equal(tree.some(node => ['select', 'textarea'].includes(node.type)), false);
      assert.doesNotMatch(text(tree[0]), /Tipo de documento|Motivo da classificação|É um exame/);
      assert.equal(mutations.length, before);
      assert.equal(button(tree, 'Confirmar cadastro e anexar').props.disabled, true);
    });
    tree.find(node => node.type === 'button' && node.props.className === 'candidate').props.onClick();
    tree = compactRender();
    tree.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } });
    tree = compactRender();
    assert.equal(button(tree, 'Confirmar cadastro e anexar').props.disabled, false);
    button(tree, 'Confirmar cadastro e anexar').props.onClick();
    await new Promise(resolve => setImmediate(resolve));
    check(`${status} links directly after patient verification without a classification step`, () => {
      assert.equal(mutations.length, before + 1);
      assert.equal(mutations.at(-1).name, 'confirm_exam_document_link');
      assert.equal(mutations.at(-1).args.p_pet_id, candidate.pet_id);
      assert.equal(mutations.at(-1).args.p_expected_version, version);
      assert.equal(mutations.at(-1).args.p_confirmed.exam_type, 'Hemograma');
    });
  }
  states = []; currentDocument = { ...contactDoc(), confirmed_data: { pet_name: 'Nina', client_name: 'Maria', exam_date: '2026-10-29' } };
  tree = compactRender();
  check('attached compact form displays a read-only summary without editable controls', () => {
    assert.match(text(tree[0]), /Exame anexado ao cadastro/);
    assert.equal(tree.some(node => ['input', 'select', 'textarea'].includes(node.type)), false);
    assert.match(text(tree[0]), /correção exige uma nova versão/);
  });
  console.log(checks + ' document detail regression checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
