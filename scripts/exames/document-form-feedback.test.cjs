// Run the real form with persistent hooks, without a browser, auth session or network.
// Focus on persistence boundaries: dismiss only after success and allow an empty note.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const ts = require('typescript')
const jsx = require('react/jsx-runtime')
const root = path.resolve(__dirname, '../..')
function load(file, mocks = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(name => {
    if (name in mocks) return mocks[name]
    throw new Error(`Unexpected offline dependency ${name}`)
  }, module, module.exports)
  return module.exports
}
const status = load('src/lib/document-status.ts')
let state = [], index = 0, behavior, current, role = 'admin'
const writes = [], notices = []
const candidate = { pet_id: 'fixture-pet', pet_name: 'Luna', client_name: 'Tutora fictícia', species: 'Cão', items: [] }
const { DocumentForm } = load('src/components/documents/ExamDocumentPanels.tsx', {
  react: {
    useState: initial => {
      const slot = index++
      if (!(slot in state)) state[slot] = typeof initial === 'function' ? initial() : initial
      return [state[slot], value => { state[slot] = typeof value === 'function' ? value(state[slot]) : value }]
    },
    useRef: initial => { const slot = index++; if (!(slot in state)) state[slot] = { current: initial }; return state[slot] },
    useEffect: () => {}, useDeferredValue: value => value,
  },
  'react/jsx-runtime': jsx, 'lucide-react': { Download: 'Download', ExternalLink: 'ExternalLink' },
  sonner: { toast: { success: message => notices.push(['success', message]), error: message => notices.push(['error', message]) } },
  '@/contexts/exam-auth': { useExamAuth: () => ({ role }) },
  '@/hooks/useExamDocuments': {
    // isPending deliberately stays false: local guards must cover the first frame
    // and the parent confirmation callback after React Query settles.
    useDocumentAction: () => ({ isPending: false, mutateAsync: async entry => { writes.push(entry); return behavior(entry) } }),
    useDocumentCandidates: () => ({ data: [candidate] }), useDocumentEvents: () => ({ data: [] }),
    callDocumentService: () => { throw new Error('Unexpected file request') },
  },
  '@/components/documents/DocumentBadge': { DocumentBadge: 'DocumentBadge' }, '@/lib/document-status': status,
})
function nodes(tree) {
  const all = []
  function walk(value) { if (Array.isArray(value)) return value.forEach(walk); if (!value || typeof value !== 'object') return; all.push(value); walk(value.props?.children) }
  walk(tree); return all
}
function words(value) { return Array.isArray(value) ? value.map(words).join('') : value && typeof value === 'object' ? words(value.props?.children) : value == null || value === false ? '' : String(value) }
const fixture = () => ({
  id: 'fixture-document', version: 1, file_status: 'saved', pet_id: 'fixture-pet', identification_status: 'confirmed',
  extracted_data: { pet_name: 'Luna', client_name: 'Tutora fictícia', exam_type: 'Hemograma', exam_date: '2026-10-16' },
  confirmed_data: {}, review_reason: null, previous_document_id: null, nexus_status: 'awaiting_link', contact_status: 'pending',
  items: [
    { exam_item_id: 'fixture-completed-item', exam_type: 'Exame anterior', contacted_at: '2026-10-16T12:00:00Z' },
    { exam_item_id: 'fixture-pending-item', exam_type: 'Hemograma', contacted_at: null },
  ], deliveries: [],
})
function reset(doc = fixture()) {
  current = doc; state = []; role = 'admin'; writes.length = 0; notices.length = 0
  behavior = async () => ({ document: { ...current, version: current.version + 1 } })
}
const render = (mode, props = {}) => { index = 0; return nodes(DocumentForm({ doc: current, mode, ...props })) }
const button = (tree, text) => tree.find(node => node.type === 'button' && words(node) === text)
const contactButton = tree => button(tree, 'Registrar contato realizado')
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
let checks = 0
const check = async (name, run) => { await run(); console.log(`ok ${++checks} - ${name}`) }

;(async () => {
  reset()
  let saved = 0
  const onSaved = () => { saved++ }
  let request = deferred()
  behavior = () => request.promise
  let tree = render('identity', { onSaved })
  tree.find(node => node.type === 'input' && node.props['aria-label'] === 'Tutor').props.onChange({ target: { value: 'Nome completo fictício' } })
  const save = button(render('identity', { onSaved }), 'Salvar identificação')
  save.props.onClick(); save.props.onClick()
  await check('two clicks before a rerender submit one identity write and never dismiss early', () => {
    assert.equal(writes.length, 1); assert.equal(saved, 0); assert.equal(notices.length, 0)
    assert.equal(button(render('identity', { onSaved }), 'Salvar identificação').props.disabled, true)
  })
  request.reject(new Error('Falha fictícia ao salvar.')); await tick()
  await check('failed save keeps the identity draft, allows retry and does not dismiss', () => {
    tree = render('identity', { onSaved })
    assert.equal(saved, 0)
    assert.equal(tree.find(node => node.type === 'input' && node.props['aria-label'] === 'Tutor').props.value, 'Nome completo fictício')
    assert.equal(button(tree, 'Salvar identificação').props.disabled, false)
    assert.deepEqual(notices, [['error', 'Falha fictícia ao salvar.']])
  })
  behavior = async entry => ({ document: { ...current, version: 2, confirmed_data: entry.args.p_fields } })
  button(tree, 'Salvar identificação').props.onClick(); await tick()
  await check('successful identity persistence invokes dismissal once after the saved response', () => {
    assert.equal(saved, 1); assert.equal(writes.length, 2)
    assert.equal(writes.at(-1).args.p_fields.client_name, 'Nome completo fictício')
    assert.deepEqual(notices.at(-1), ['success', 'Conferência salva.'])
  })

  reset({ ...fixture(), pet_id: null, identification_status: 'unidentified' })
  saved = 0; request = deferred(); behavior = () => request.promise
  tree = render('patient', { onSaved })
  tree.find(node => node.type === 'input' && node.props.type === 'radio').props.onChange()
  tree = render('patient', { onSaved })
  const confirmation = tree.find(node => node.type === 'label' && words(node).startsWith('Conferi o PDF'))
  nodes(confirmation).find(node => node.type === 'input').props.onChange({ target: { checked: true } })
  button(render('patient', { onSaved }), 'Confirmar cadastro e anexar').props.onClick()
  await check('patient confirmation waits for persistence before requesting parent dismissal', () => {
    assert.equal(saved, 0); assert.equal(writes.length, 1)
    assert.equal(writes[0].name, 'confirm_exam_document_link')
    assert.equal(writes[0].args.p_pet_id, 'fixture-pet')
  })
  request.resolve({ document: { ...current, pet_id: 'fixture-pet', version: 2 } }); await tick()
  await check('successful patient confirmation dismisses the parent once', () => { assert.equal(saved, 1) })

  // New regression checks: bottom button unifies confirmation, and missing exam_type highlights in red
  reset({ ...fixture(), pet_id: null, identification_status: 'unidentified' })
  saved = 0; request = deferred(); behavior = () => request.promise
  tree = render('patient', { onSaved })
  tree.find(node => node.type === 'input' && node.props.type === 'radio').props.onChange()
  tree = render('patient', { onSaved })
  const confLabel = tree.find(node => node.type === 'label' && words(node).startsWith('Conferi o PDF'))
  nodes(confLabel).find(node => node.type === 'input').props.onChange({ target: { checked: true } })
  const bottomConfirmBtn = tree.filter(node => node.type === 'button' && words(node) === 'Confirmar cadastro e anexar').at(-1)
  assert.ok(bottomConfirmBtn, 'Bottom button should switch to "Confirmar cadastro e anexar" when patient is confirmed')
  bottomConfirmBtn.props.onClick()
  await check('bottom button in patient mode confirms link when patient is confirmed', () => {
    assert.equal(saved, 0); assert.equal(writes.length, 1)
    assert.equal(writes[0].name, 'confirm_exam_document_link')
    assert.equal(writes[0].args.p_pet_id, 'fixture-pet')
  })
  request.resolve({ document: { ...current, pet_id: 'fixture-pet', version: 2 } }); await tick()
  await check('bottom confirmation dismisses the parent once after link', () => { assert.equal(saved, 1) })

  // Missing exam_type highlights input in red and keeps save disabled
  reset({ ...fixture(), pet_id: null, extracted_data: { pet_name: 'Luna', exam_type: '' }, confirmed_data: { exam_type: '' } })
  tree = render('patient')
  const examTypeInput = tree.find(node => node.type === 'input' && node.props['aria-label'] === 'Tipo do exame')
  await check('missing exam type highlights input in red', () => {
    assert.match(examTypeInput.props.className, /border-red-500/)
    assert.match(words(tree[0]), /Preenchimento obrigatório para salvar e anexar/)
  })

  // Patient mode saving identity without confirmation does not prematurely dismiss parent
  reset({ ...fixture(), pet_id: null, identification_status: 'unidentified' })
  saved = 0; behavior = async () => ({ document: { ...current, version: 2 } })
  tree = render('patient', { onSaved })
  tree.find(node => node.type === 'input' && node.props.type === 'radio').props.onChange()
  const saveIdentityBtn = button(render('patient', { onSaved }), 'Salvar identificação')
  assert.ok(saveIdentityBtn, 'Button remains "Salvar identificação" when patient is selected but not confirmed')
  saveIdentityBtn.props.onClick(); await tick()
  await check('patient mode saving identity without confirmation does not prematurely dismiss parent', () => {
    assert.equal(saved, 0)
    assert.equal(writes.at(-1).name, 'review_exam_document')
  })

  for (const blank of ['', '   \n ']) {
    reset()
    tree = render('contact')
    tree.find(node => node.type === 'textarea').props.onChange({ target: { value: blank } })
    tree = render('contact')
    await check(`empty${blank ? '/whitespace' : ''} observation is optional and preserves contact safeguards`, () => {
      assert.match(words(tree[0]), /Observação \(opcional\)/)
      assert.equal(contactButton(tree).props.disabled, false)
      const checkboxes = tree.filter(node => node.type === 'input' && node.props.type === 'checkbox')
      assert.equal(checkboxes[0].props.disabled, true); assert.equal(checkboxes[0].props.checked, true)
      assert.equal(checkboxes[1].props.disabled, false)
    })
    contactButton(tree).props.onClick(); await tick()
    await check(`empty${blank ? '/whitespace' : ''} observation is sent as null without inventing content`, () => {
      assert.equal(writes.length, 1); assert.equal(writes[0].args.p_note, null)
      assert.deepEqual(writes[0].args.p_item_ids, ['fixture-pending-item'])
      assert.equal(writes[0].args.p_channel, 'whatsapp')
      assert.deepEqual(notices, [['success', 'Contato registrado.']])
    })
  }

  reset(); request = deferred(); const callback = deferred(); let contactSaved = 0; saved = 0
  behavior = () => request.promise
  const onContactSaved = async () => { contactSaved++; await callback.promise }
  tree = render('contact', { onContactSaved, onSaved })
  tree.find(node => node.type === 'textarea').props.onChange({ target: { value: '  Retorno combinado.  ' } })
  tree.find(node => node.type === 'select').props.onChange({ target: { value: 'phone' } })
  const conclude = contactButton(render('contact', { onContactSaved, onSaved }))
  conclude.props.onClick(); conclude.props.onClick()
  await check('contact submits once per click burst and freezes every editable field while saving', () => {
    assert.equal(writes.length, 1); assert.equal(contactSaved, 0)
    assert.equal(writes[0].args.p_note, 'Retorno combinado.'); assert.equal(writes[0].args.p_channel, 'phone')
    const pending = render('contact', { onContactSaved, onSaved })
    for (const input of pending.filter(node => ['input', 'textarea', 'select', 'button'].includes(node.type))) assert.equal(input.props.disabled, true)
  })
  request.resolve({ document: { ...current, version: 2 } }); await tick()
  await check('parent contact confirmation replaces the duplicate toast and keeps lock through callback', () => {
    assert.equal(contactSaved, 1); assert.equal(saved, 0); assert.deepEqual(notices, [])
    assert.equal(contactButton(render('contact', { onContactSaved, onSaved })).props.disabled, true)
    conclude.props.onClick(); assert.equal(writes.length, 1)
  })
  callback.resolve(); await tick()
  await check('contact fields unlock after confirmation work finishes', () => {
    assert.equal(contactButton(render('contact', { onContactSaved, onSaved })).props.disabled, false)
  })

  reset(); contactSaved = 0
  behavior = async () => { throw new Error('Falha fictícia de contato.') }
  tree = render('contact', { onContactSaved: async () => { contactSaved++ } })
  tree.find(node => node.type === 'textarea').props.onChange({ target: { value: 'Rascunho de observação.' } })
  contactButton(render('contact', { onContactSaved: async () => { contactSaved++ } })).props.onClick(); await tick()
  await check('contact failure keeps optional draft and never opens the success panel', () => {
    assert.equal(contactSaved, 0); assert.equal(writes.length, 1)
    assert.deepEqual(notices, [['error', 'Falha fictícia de contato.']])
    const failed = render('contact')
    assert.equal(failed.find(node => node.type === 'textarea').props.value, 'Rascunho de observação.')
    assert.equal(contactButton(failed).props.disabled, false)
  })

  await check('optional observation does not waive permission, saved-file, patient or selected-item guards', () => {
    reset(); role = 'reception'; assert.equal(contactButton(render('contact')).props.disabled, true)
    reset({ ...fixture(), file_status: 'pending' }); assert.equal(contactButton(render('contact')).props.disabled, true)
    reset({ ...fixture(), pet_id: null }); assert.equal(contactButton(render('contact')), undefined)
    reset(); tree = render('contact'); tree.filter(node => node.type === 'input' && node.props.type === 'checkbox')[1].props.onChange()
    assert.equal(contactButton(render('contact')).props.disabled, true)
    assert.equal(writes.length, 0)
  })
  await check('failed Nexus attachment can be retried from the patient panel without marking it completed', async () => {
    reset({ ...fixture(), confirmed_data: { ...fixture().extracted_data }, nexus_status: 'failed', deliveries: [{ id: 'nexus-task', destination: 'nexus', status: 'failed' }] })
    const wait = deferred(); behavior = () => wait.promise
    const retry = button(render('patient'), 'Tentar anexar novamente')
    assert.equal(retry.props.disabled, false)
    retry.props.onClick(); retry.props.onClick()
    assert.equal(writes.length, 1); assert.equal(writes[0].name, 'retry_exam_document_delivery')
    assert.equal(writes[0].args.p_delivery_id, 'nexus-task'); assert.equal(current.nexus_status, 'failed')
    assert.equal(notices.length, 0)
    wait.resolve({ status: 'pending' }); await tick()
    assert.match(notices[0][1], /cadastro será confirmado após salvar e verificar/)
    reset({ ...fixture(), confirmed_data: { ...fixture().extracted_data }, nexus_status: 'completed', deliveries: [{ id: 'nexus-task', destination: 'nexus', status: 'completed' }] })
    assert.equal(button(render('patient'), 'Tentar anexar novamente'), undefined)
  })
  console.log(`${checks} form feedback checks passed`)
})().catch(error => { console.error(error); process.exitCode = 1 })
