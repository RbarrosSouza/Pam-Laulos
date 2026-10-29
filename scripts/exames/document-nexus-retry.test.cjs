const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const ts = require('typescript')
const jsx = require('react/jsx-runtime')
const { test } = require('node:test')

function harness(extra = {}) {
  const state = [], writes = []
  let index = 0, reviewCalls = 0, persist = async () => ({ status: 'pending' })
  let doc = { id: 'fixture', nexus_status: 'failed', file_status: 'saved', pet_id: 'fixture-pet', identification_status: 'confirmed',
    confirmed_data: { exam_date: '2026-10-23' }, contact_status: 'completed',
    deliveries: [{ id: 'nexus-fixture', destination: 'nexus', status: 'failed', attempts: 5, updated_at: '2026-10-26T12:00:00Z' }], ...extra }
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/components/documents/DocumentNexusRetry.tsx'), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', compiled)(name => {
    if (name === 'react/jsx-runtime') return jsx
    if (name === 'react') return {
      useRef: initial => { const slot = index++; return state[slot] ||= { current: initial } },
      useState: initial => { const slot = index++; if (!(slot in state)) state[slot] = initial; return [state[slot], value => { state[slot] = value }] },
    }
    if (name === '@/hooks/useExamDocuments') return { useDocumentAction: () => ({ isPending: false, mutateAsync: async write => { writes.push(write); return persist(write) } }) }
    throw new Error(`Unexpected dependency: ${name}`)
  }, loaded, loaded.exports)
  return { writes, get doc() { return doc }, set doc(value) { doc = value }, set persist(value) { persist = value }, get reviewCalls() { return reviewCalls },
    render() { index = 0; return loaded.exports.DocumentNexusRetry({ doc, onReview: () => { reviewCalls++ } }) } }
}
function nodes(tree) { if (!tree || typeof tree !== 'object') return []; return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)] }
function words(tree) { return Array.isArray(tree) ? tree.map(words).join('') : tree && typeof tree === 'object' ? words(tree.props?.children) : tree == null || tree === false ? '' : String(tree) }
function button(tree, label) { return nodes(tree).find(n => n.type === 'button' && words(n) === label) }
const tick = () => new Promise(resolve => setImmediate(resolve))

test('a failed attachment is actionable even after contact has been completed', () => {
  const h = harness(), tree = h.render()
  assert.equal(tree.props.role, 'alert')
  assert.equal(button(tree, 'Tentar anexar novamente').props.disabled, false)
  assert.equal(h.writes.length, 0)
})
test('two clicks submit one retry for the failed Nexus task and never mark registration complete', async () => {
  const h = harness()
  let finish
  h.persist = () => new Promise(resolve => { finish = resolve })
  const retry = button(h.render(), 'Tentar anexar novamente')
  retry.props.onClick(); retry.props.onClick()
  assert.equal(h.writes.length, 1)
  assert.equal(h.writes[0].name, 'retry_exam_document_delivery')
  assert.equal(h.writes[0].args.p_delivery_id, 'nexus-fixture')
  assert.ok(h.writes[0].args.p_reason)
  assert.equal(button(h.render(), 'Solicitando…').props.disabled, true)
  finish({ status: 'pending' }); await tick()
  assert.match(words(h.render()), /em andamento/)
  assert.equal(button(h.render(), 'Tentar anexar novamente'), undefined)
  assert.equal(h.doc.nexus_status, 'failed')
  assert.equal(h.doc.contact_status, 'completed')
})
test('queued work shows progress; only persisted completion removes the notice', () => {
  const h = harness({ nexus_status: 'pending', deliveries: [{ id: 'task', destination: 'nexus', status: 'reserved' }] })
  assert.equal(h.render().props.role, 'status')
  assert.equal(button(h.render(), 'Tentar anexar novamente'), undefined)
  h.doc = { ...h.doc, nexus_status: 'completed' }
  assert.equal(h.render(), null)
})
test('a later confirmed failure can be retried after a successful retry request', async () => {
  const h = harness()
  button(h.render(), 'Tentar anexar novamente').props.onClick(); await tick()
  h.doc = { ...h.doc, deliveries: [{ ...h.doc.deliveries[0], updated_at: '2026-10-29T14:00:00Z' }] }
  assert.equal(button(h.render(), 'Tentar anexar novamente').props.disabled, false)
})
test('missing patient, confirmation, date or saved original opens review instead of dispatching', () => {
  for (const extra of [{ pet_id: null }, { identification_status: 'review' }, { confirmed_data: {} }, { file_status: 'pending' }]) {
    const h = harness(extra)
    assert.equal(button(h.render(), 'Tentar anexar novamente'), undefined)
    button(h.render(), 'Conferir cadastro').props.onClick()
    assert.equal(h.reviewCalls, 1)
    assert.equal(h.writes.length, 0)
  }
})
test('request failure is visible and allows an explicit later retry', async () => {
  const h = harness()
  h.persist = async () => { throw new Error('Falha fictícia de conexão.') }
  button(h.render(), 'Tentar anexar novamente').props.onClick(); await tick()
  assert.match(words(h.render()), /Falha fictícia de conexão/)
  assert.equal(button(h.render(), 'Tentar anexar novamente').props.disabled, false)
})
test('other destinations, uncertain deliveries and completed attachments never offer a new send', () => {
  for (const delivery of [{ destination: 'group', status: 'failed' }, { destination: 'nexus', status: 'uncertain' }, { destination: 'nexus', status: 'completed' }]) {
    const h = harness({ deliveries: [{ id: 'task', ...delivery }] })
    assert.equal(h.render(), null)
    assert.equal(h.writes.length, 0)
  }
})
