// Exercise the real Home component with deferred writes and persistent hooks.
// No network, authentication session, patient record or WhatsApp action is used.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const ts = require('typescript')
const jsx = require('react/jsx-runtime')
const root = path.resolve(__dirname, '../..')
let slots = [], cursor = 0, current, behavior, fireworksBehavior
const writes = [], notices = [], fireworks = []
const fixture = () => ({
  id: 'fixture-document', pet_id: 'fixture-pet', contact_status: 'pending',
  extracted_data: { pet_name: 'Paciente fictício', client_name: 'Tutor fictício', exam_type: 'Hemograma' },
  confirmed_data: {}, oldest_group_sent_at: null,
  items: [{ exam_item_id: 'fixture-item-a' }, { item_id: 'fixture-item-b' }],
})
const hooks = {
  useState(initial) {
    const index = cursor++
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
    return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
  },
  useRef(initial) {
    const index = cursor++
    if (!(index in slots)) slots[index] = { current: initial }
    return slots[index]
  },
  useMemo: fn => fn(), useDeferredValue: value => value,
}
const mocks = {
  react: hooks, 'react/jsx-runtime': jsx,
  'react-router-dom': { Link: 'Link', useNavigate: () => () => {} },
  'lucide-react': { RefreshCw: 'RefreshCw', Search: 'Search', Check: 'Check', LoaderCircle: 'LoaderCircle' },
  '@phosphor-icons/react/dist/csr/WhatsappLogo': { WhatsappLogo: 'WhatsappLogo' },
  sonner: { toast: { success: text => notices.push(['success', text]), error: text => notices.push(['error', text]) } },
  '@/hooks/useExamDocuments': {
    useDocumentAction: () => ({ mutateAsync: entry => { writes.push(entry); return behavior(entry) } }),
    useExamDocuments: () => ({ data: { documents: [current], count: 1 }, refetch() {} }),
  },
  '@/hooks/useExamCards': { useExamCards: () => ({ data: [], refetch() {} }) },
  '@/lib/document-status': {
    documentLabel: (doc, key) => doc.extracted_data[key] || '', documentIsOverdue: () => false,
  },
  '@/lib/fireworks': { triggerFireworksAt: (x, y) => { fireworks.push([x, y]); fireworksBehavior() } },
  './cockpit.css': {},
}
const source = fs.readFileSync(path.join(root, 'src/components/dashboard/CockpitDashboard.tsx'), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
} }).outputText
const loaded = { exports: {} }
new Function('require', 'module', 'exports', code)(name => {
  if (Object.hasOwn(mocks, name)) return mocks[name]
  throw new Error('Unexpected offline dependency: ' + name)
}, loaded, loaded.exports)
const Component = loaded.exports.CockpitDashboard
function nodes(tree) {
  const found = []
  function walk(value) {
    if (Array.isArray(value)) return value.forEach(walk)
    if (!value || typeof value !== 'object') return
    found.push(value); walk(value.props?.children)
  }
  walk(tree); return found
}
const words = value => Array.isArray(value) ? value.map(words).join('')
  : value && typeof value === 'object' ? words(value.props?.children)
  : value == null || value === false ? '' : String(value)
const render = () => { cursor = 0; return nodes(Component({})) }
const button = tree => tree.find(node => node.type === 'button' && node.props.title === 'Marcar contato concluído')
const rows = tree => tree.filter(node => node.type === 'tr' && node.key === current.id
  || node.type === 'div' && node.key === current.id)
const exiting = tree => rows(tree).filter(node => node.props.className.includes('row-completing-exit'))
const event = () => ({ stopPropagation() {}, currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 20, width: 24, height: 24 }) } })
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function reset(doc = fixture()) {
  current = doc; slots = []; writes.length = 0; notices.length = 0; fireworks.length = 0
  behavior = async () => ({ document_id: current.id, document: { id: current.id } })
  fireworksBehavior = () => {}
}
let count = 0
async function check(label, run) { await run(); console.log(`ok ${++count} - ${label}`) }
;(async () => {
  reset()
  const request = deferred(); behavior = () => request.promise
  const first = button(render())
  first.props.onClick(event()); first.props.onClick(event())
  await check('double click before rerender makes one RPC and keeps both layouts visible while saving', () => {
    const tree = render()
    assert.equal(writes.length, 1)
    assert.equal(writes[0].name, 'record_exam_document_contact')
    assert.deepEqual(writes[0].args.p_item_ids, ['fixture-item-a', 'fixture-item-b'])
    assert.equal(writes[0].args.p_document_id, current.id)
    assert.equal(writes[0].args.p_channel, 'whatsapp')
    assert.equal(writes[0].args.p_note, null)
    assert(Number.isFinite(Date.parse(writes[0].args.p_contacted_at)))
    assert.equal(rows(tree).length, 2)
    assert.equal(exiting(tree).length, 0)
    const pending = tree.filter(node => node.type === 'button' && node.props['aria-busy'] === true)
    assert.equal(pending.length, 2)
    assert(pending.every(node => node.props.disabled === true))
    assert.equal(notices.length, 0); assert.equal(fireworks.length, 0)
  })
  request.resolve({ document_id: current.id, document: { id: current.id } }); await tick()
  await check('only an acknowledged write shows success, celebration and row exit; a stale handler cannot write again', async () => {
    const tree = render()
    assert.equal(exiting(tree).length, 2)
    assert.equal(tree.filter(node => node.type === 'button' && node.props.title === 'Contato concluído' && node.props.disabled).length, 2)
    assert.deepEqual(notices, [['success', '🎉 Contato registrado com sucesso.']])
    assert.deepEqual(fireworks, [[22, 32]])
    first.props.onClick(event()); await tick()
    assert.equal(writes.length, 1)
    assert.equal(notices.length, 1)
  })

  reset()
  const failure = deferred(); behavior = () => failure.promise
  button(render()).props.onClick(event())
  failure.reject(new Error('Não foi possível salvar o contato. Confira sua conexão.')); await tick()
  await check('rejected RPC keeps both rows, reports error and releases the local lock without retrying automatically', () => {
    const tree = render()
    assert.equal(rows(tree).length, 2); assert.equal(exiting(tree).length, 0)
    assert.equal(writes.length, 1); assert.equal(fireworks.length, 0)
    assert.deepEqual(notices, [['error', 'Não foi possível salvar o contato. Confira sua conexão.']])
    assert.equal(button(tree).props.disabled, false)
    assert.equal(tree.some(node => node.props?.['aria-busy'] === true), false)
  })
  behavior = async () => ({ document_id: current.id, document: { id: current.id } })
  button(render()).props.onClick(event()); await tick()
  await check('explicit retry after a failed save succeeds once', () => {
    assert.equal(writes.length, 2); assert.equal(fireworks.length, 1)
    assert.equal(notices.filter(([kind]) => kind === 'success').length, 1)
    assert.equal(exiting(render()).length, 2)
  })

  for (const [label, doc] of [
    ['missing patient', { ...fixture(), pet_id: null }],
    ['missing items', { ...fixture(), items: [] }],
    ['partly invalid item list', { ...fixture(), items: [{ exam_item_id: 'fixture-item-a' }, {}] }],
  ]) {
    reset(doc); button(render()).props.onClick(event()); await tick()
    await check(`${label} cannot disappear or claim success without making a write`, () => {
      assert.equal(writes.length, 0); assert.equal(exiting(render()).length, 0)
      assert.equal(fireworks.length, 0)
      assert.deepEqual(notices, [['error', 'Confira o cadastro e os itens do exame antes de concluir o contato.']])
      assert.equal(button(render()).props.disabled, false)
    })
  }

  reset()
  let tree = render()
  tree.find(node => node.type === 'button' && words(node).includes('Falta cadastro')).props.onClick()
  button(render()).props.onClick(event()); await tick()
  await check('saving contact in another queue does not hide an outstanding registration/group problem', () => {
    tree = render(); assert.equal(writes.length, 1); assert.equal(rows(tree).length, 2)
    assert.equal(exiting(tree).length, 0)
    assert.equal(notices[0][1], '🎉 Contato registrado com sucesso.')
  })

  reset({ ...fixture(), contact_status: 'completed' })
  await check('already completed contacts are not offered as a new write', () => {
    const tree = render()
    assert.equal(button(tree), undefined)
    assert.equal(tree.filter(node => node.type === 'button' && node.props.title === 'Contato concluído' && node.props.disabled).length, 2)
    assert.equal(writes.length, 0)
  })

  reset(); fireworksBehavior = () => { throw new Error('Synthetic canvas error') }
  const retained = button(render()); retained.props.onClick(event()); await tick()
  retained.props.onClick(event()); await tick()
  await check('animation failure cannot turn a saved contact into a retry or false persistence error', () => {
    assert.equal(writes.length, 1)
    assert.deepEqual(notices, [['success', '🎉 Contato registrado com sucesso.']])
    assert.equal(exiting(render()).length, 2)
  })
  console.log(`${count} Home contact persistence checks passed`)
})().catch(error => { console.error(error); process.exitCode = 1 })
