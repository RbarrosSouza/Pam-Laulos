// Execute the actual form with persistent hook state. Reproduces the sequence
// emitted by native date inputs while the year 2026 is typed, without a service.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const ts = require('typescript')
const jsx = require('react/jsx-runtime')
const root = path.resolve(__dirname, '../..')
function load(file, mocks = {}) {
  const source = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', source)(name => { if (name in mocks) return mocks[name]; throw new Error(`Unexpected offline dependency ${name}`) }, module, module.exports)
  return module.exports
}
const status = load('src/lib/document-status.ts')
let state = [], index = 0, pending = false, behavior, current, candidates = []
const writes = [], notices = []
const { DocumentForm } = load('src/components/documents/ExamDocumentPanels.tsx', {
  react: { useState: initial => { const slot = index++; if (!(slot in state)) state[slot] = typeof initial === 'function' ? initial() : initial; return [state[slot], value => { state[slot] = typeof value === 'function' ? value(state[slot]) : value }] }, useRef: initial => { const slot = index++; if (!(slot in state)) state[slot] = { current: initial }; return state[slot] }, useEffect: () => {}, useDeferredValue: value => value },
  'react/jsx-runtime': jsx, 'lucide-react': { Download: 'Download', ExternalLink: 'ExternalLink' },
  sonner: { toast: { success: message => notices.push(['success', message]), error: message => notices.push(['error', message]) } },
  '@/contexts/exam-auth': { useExamAuth: () => ({ role: 'admin', session: { user: { id: 'fixture-user' } } }) },
  '@/hooks/useExamDocuments': {
    useDocumentAction: () => ({ isPending: pending, mutateAsync: async entry => { writes.push(entry); pending = true; try { return await behavior(entry) } finally { pending = false } } }),
    useDocumentCandidates: () => ({ data: candidates }), useDocumentEvents: () => ({ data: [] }), callDocumentService: () => { throw new Error('Unexpected file request') },
  },
  '@/components/documents/DocumentBadge': { DocumentBadge: 'DocumentBadge' }, '@/lib/document-status': status,
})
function nodes(tree) { const all = []; function walk(value) { if (Array.isArray(value)) return value.forEach(walk); if (!value || typeof value !== 'object') return; all.push(value); walk(value.props?.children) } walk(tree); return all }
function words(value) { return Array.isArray(value) ? value.map(words).join('') : value && typeof value === 'object' ? words(value.props?.children) : value == null || value === false ? '' : String(value) }
const fixture = () => ({ id: 'date-fixture', version: 1, original_name: 'Exame fictício.pdf', received_at: '2026-10-16T12:00:00Z', pet_id: 'pet-fixture', identification_status: 'confirmed', file_status: 'saved', extracted_data: { pet_name: 'Luna', client_name: 'Pessoa fictícia', exam_type: 'Hemograma' }, confirmed_data: { pet_name: 'Luna', client_name: 'Pessoa fictícia', exam_type: 'Hemograma' }, review_reason: null, previous_document_id: null, nexus_status: 'awaiting_link', items: [], deliveries: [] })
const reset = value => { current = value || fixture(); state = []; pending = false; candidates = []; writes.length = 0; notices.length = 0 }
const render = (mode = 'patient') => { index = 0; return nodes(DocumentForm({ doc: current, mode })) }
const date = tree => tree.find(node => node.type === 'input' && node.props.type === 'date')
const details = tree => tree.find(node => node.type === 'details')
const button = (tree, text) => tree.find(node => node.type === 'button' && words(node) === text)
const changeDate = value => date(render()).props.onChange({ target: { value } })
let checks = 0
const check = async (name, run) => { await run(); console.log(`ok ${++checks} - ${name}`) }
const tick = () => new Promise(resolve => setImmediate(resolve))

;(async () => {
  reset()
  await check('missing saved date opens the editor without claiming automatic attachment', () => {
    const tree = render()
    assert.equal(details(tree).props.open, true)
    assert.match(words(tree[0]), /(?:Confira|Preencha) a data do exame e salve/)
    assert.doesNotMatch(words(tree[0]), /Dados salvos|será feita automaticamente/)
  })
  await check('incremental native year input never collapses, loses its field or writes early', () => {
    for (const value of ['0002-10-15', '0020-10-15', '0202-10-15', '2026-10-15']) {
      changeDate(value)
      const tree = render()
      assert.equal(details(tree).props.open, true, value)
      assert.equal(date(tree).props.value, value)
      assert.ok(tree.find(node => node.type === 'label' && node.key === 'exam_date'))
      assert.match(words(tree[0]), /Há alterações não salvas/)
      assert.doesNotMatch(words(tree[0]), /Dados salvos|será feita automaticamente/)
      assert.equal(writes.length, 0)
    }
  })
  await check('summary cannot dismiss a dirty editor; explicit cancel restores saved data', () => {
    let prevented = false
    render().find(node => node.type === 'summary').props.onClick({ preventDefault: () => { prevented = true } })
    assert.equal(prevented, true); assert.equal(details(render()).props.open, true)
    button(render(), 'Cancelar edição').props.onClick()
    assert.equal(details(render()).props.open, false)
    assert.equal(date(render()).props.value, '')
    assert.equal(writes.length, 0)
  })
  await check('explicit reopening stays open across the complete modern year', () => {
    render().find(node => node.type === 'summary').props.onClick({ preventDefault: () => {} })
    for (const value of ['0002-10-15', '0020-10-15', '0202-10-15', '2026-10-15']) {
      changeDate(value); assert.equal(details(render()).props.open, true)
    }
  })
  let rejectWrite
  behavior = () => new Promise((resolve, reject) => { rejectWrite = reject })
  button(render(), 'Salvar identificação').props.onClick()
  await check('pending save keeps disclosure open and locks edits and cancel', () => {
    const tree = render()
    assert.equal(details(tree).props.open, true)
    assert.equal(date(tree).props.disabled, true)
    assert.equal(button(tree, 'Cancelar edição').props.disabled, true)
    assert.equal(button(tree, 'Salvar identificação').props.disabled, true)
    assert.equal(writes[0].args.p_fields.exam_date, '2026-10-15')
  })
  rejectWrite(new Error('Falha fictícia sem gravação.')); await tick()
  await check('failure preserves final year, open editor and unsaved message without retry', () => {
    const tree = render()
    assert.equal(date(tree).props.value, '2026-10-15')
    assert.equal(details(tree).props.open, true)
    assert.match(words(tree[0]), /Há alterações não salvas/)
    assert.deepEqual(notices, [['error', 'Falha fictícia sem gravação.']])
    assert.equal(writes.length, 1)
  })
  behavior = async entry => { current = { ...current, version: current.version + 1, confirmed_data: { ...entry.args.p_fields } }; return { document: current } }
  button(render(), 'Salvar identificação').props.onClick(); await tick()
  await check('successful explicit save persists only completed 2026 date and then closes', () => {
    assert.equal(writes.length, 2)
    assert.equal(writes[1].args.p_fields.exam_date, '2026-10-15')
    assert.equal(writes[1].args.p_expected_version, 1)
    const tree = render()
    assert.equal(current.confirmed_data.exam_date, '2026-10-15')
    assert.equal(details(tree).props.open, false)
    assert.match(words(tree[0]), /Dados salvos/)
    assert.doesNotMatch(words(tree[0]), /Há alterações não salvas/)
  })
  await check('changing a previously saved date is clearly a draft and cancel restores it', () => {
    render().find(node => node.type === 'summary').props.onClick({ preventDefault: () => {} })
    changeDate('2025-10-15')
    assert.match(words(render()[0]), /Há alterações não salvas/)
    assert.equal(current.confirmed_data.exam_date, '2026-10-15')
    button(render(), 'Cancelar edição').props.onClick()
    assert.equal(date(render()).props.value, '2026-10-15')
    assert.equal(current.confirmed_data.exam_date, '2026-10-15')
  })
  await check('legitimate historical dates are not rejected by an invented year cutoff', () => {
    render().find(node => node.type === 'summary').props.onClick({ preventDefault: () => {} })
    changeDate('1899-12-31')
    assert.equal(date(render()).props.value, '1899-12-31')
    assert.equal(date(render()).props.min, undefined)
    assert.equal(button(render(), 'Salvar identificação').props.disabled, false)
  })
  await check('concurrent persisted identity change still blocks save without discarding draft', () => {
    current = { ...current, version: 3, confirmed_data: { ...current.confirmed_data, exam_date: '2026-10-14' } }
    const tree = render()
    assert.equal(details(tree).props.open, true)
    assert.equal(date(tree).props.value, '1899-12-31')
    assert.equal(button(tree, 'Salvar identificação').props.disabled, true)
    assert.match(words(tree[0]), /A identificação foi atualizada/)
    button(tree, 'Recarregar identificação').props.onClick()
    assert.equal(date(render()).props.value, '2026-10-14')
    assert.equal(details(render()).props.open, true)
  })
  let canonicalSaved
  await check('identity save accepts the canonical response as the new clean baseline', async () => {
    changeDate('2026-10-13')
    behavior = async entry => {
      canonicalSaved = { ...current, version: current.version + 1, confirmed_data: { ...entry.args.p_fields }, identification_status: 'confirmed', review_reason: null }
      return { document: canonicalSaved }
    }
    button(render(), 'Salvar identificação').props.onClick(); await tick()
    assert.equal(writes.at(-1).args.p_classification, 'exam')
    assert.equal(writes.at(-1).args.p_reason, null)
    const tree = render()
    assert.equal(tree.some(node => ['select', 'textarea'].includes(node.type)), false)
    assert.equal(details(tree).props.open, false)
    assert.doesNotMatch(words(tree[0]), /Há alterações não salvas|Alterações não salvas/)
  })
  await check('canonical refetch stays clean and cancelling a new edit restores the saved date', () => {
    current = canonicalSaved
    assert.doesNotMatch(words(render()[0]), /Há alterações não salvas|A identificação foi atualizada/)
    render().find(node => node.type === 'summary').props.onClick({ preventDefault: () => {} })
    changeDate('2026-10-12')
    button(render(), 'Cancelar edição').props.onClick()
    assert.equal(date(render()).props.value, '2026-10-13')
    assert.doesNotMatch(words(render()[0]), /Há alterações não salvas/)
  })
  await check('identity-only entry remains independent of the patient disclosure', () => {
    assert.equal(details(render('identity')), undefined)
    assert.ok(date(render('identity')))
  })
  reset({ ...fixture(), pet_id: null, identification_status: 'unidentified', confirmed_data: {} })
  candidates = [
    { pet_id: 'pet-a', pet_name: 'Luna A', client_name: 'Tutora A', client_code: 'A', items: [{ id: 'item-a', exam_type: 'Hemograma' }] },
    { pet_id: 'pet-b', pet_name: 'Luna B', client_name: 'Tutora B', client_code: 'B', items: [] },
  ]
  render().find(node => node.type === 'input' && node.props.type === 'radio').props.onChange()
  changeDate('2026-10-15')
  let resolveIdentity
  behavior = entry => new Promise(resolve => { resolveIdentity = () => { current = { ...current, version: 2, confirmed_data: entry.args.p_fields, identification_status: 'suggested' }; resolve({ document: current }) } })
  button(render(), 'Salvar identificação').props.onClick()
  await check('identity save also locks patient search, candidates, item checks and link confirmation', () => {
    const tree = render()
    const search = tree.find(node => node.type === 'input' && node.props.placeholder === 'Nome do tutor ou pet (mínimo 2 letras)')
    assert.equal(search.props.disabled, true)
    for (const input of tree.filter(node => node.type === 'input' && ['radio', 'checkbox'].includes(node.props.type))) assert.equal(input.props.disabled, true)
    assert.equal(tree.filter(node => node.type === 'input' && node.props.type === 'radio').length, 2)
    assert.equal(button(tree, 'Confirmar cadastro e anexar').props.disabled, true)
  })
  resolveIdentity(); await tick()
  await check('canonical response preserves the selected patient and fields as one consistent choice', () => {
    const tree = render()
    assert.equal(tree.find(node => node.type === 'input' && node.props.type === 'radio').props.checked, true)
    assert.equal(current.confirmed_data.pet_name, 'Luna A')
    assert.equal(current.confirmed_data.client_name, 'Tutora A')
    assert.equal(date(tree).props.value, '2026-10-15')
    tree.filter(node => node.type === 'input' && node.props.type === 'radio')[1].props.onChange()
    const changed = render()
    assert.equal(changed.filter(node => node.type === 'input' && node.props.type === 'radio')[1].props.checked, true)
    assert.equal(changed.find(node => node.type === 'input' && node.props['aria-label'] === 'Pet').props.value, 'Luna B')
  })
  console.log(`${checks} document date editing checks passed`)
})().catch(error => { console.error(error); process.exitCode = 1 })
