const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const ts = require('typescript')
const jsx = require('react/jsx-runtime')
const root = path.resolve(__dirname, '../..')
let state = [], index = 0, calls = [], messages = [], navigation = [], invalidations = [], pendingChanges = [], cancellations = 0, request
const client = { removeQueries: query => invalidations.push(['remove', query]), invalidateQueries: query => invalidations.push(['invalidate', query]) }
const mocks = {
  react: { useState: initial => { const slot = index++; if (!(slot in state)) state[slot] = initial; return [state[slot], value => { state[slot] = value }] }, useRef: initial => { const slot = index++; if (!(slot in state)) state[slot] = { current: initial }; return state[slot] } },
  'react/jsx-runtime': jsx,
  'lucide-react': { Loader2: 'Loader2' },
  '@tanstack/react-query': { useQueryClient: () => client },
  'react-router-dom': { useNavigate: () => (...args) => navigation.push(args) },
  sonner: { toast: { success: message => messages.push(message) } },
  '@/hooks/useExamDocuments': { callDocumentService: (...args) => { calls.push(args); return request(...args) } },
}
const source = fs.readFileSync(path.join(root, 'src/components/documents/DocumentDelete.tsx'), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
const moduleObject = { exports: {} }
new Function('require', 'module', 'exports', code)(name => { if (name in mocks) return mocks[name]; throw Error('Unmocked dependency: ' + name) }, moduleObject, moduleObject.exports)
const { DocumentDelete } = moduleObject.exports
const doc = { id: 'document-1', version: 3 }
const props = { doc, backTarget: '/tracking', onCancel() { cancellations++ }, onPendingChange: value => pendingChanges.push(value) }
function nodes(tree) { const found = []; const walk = value => { if (Array.isArray(value)) return value.forEach(walk); if (!value || typeof value !== 'object') return; found.push(value); walk(value.props?.children) }; walk(tree); return found }
const render = () => { index = 0; return nodes(DocumentDelete(props)) }
const input = tree => tree.find(node => node.type === 'input')
const button = tree => tree.find(node => node.type === 'button' && node.props.className === 'exam-detail-delete-confirm')
const tick = () => new Promise(resolve => setImmediate(resolve))
;(async () => {
  let tree = render()
  assert.equal(button(tree).props.disabled, true)
  tree.find(node => node.type === 'button' && node.props.className === 'exam-detail-delete-cancel').props.onClick()
  assert.equal(cancellations, 1)
  assert.deepEqual(calls, [])
  input(tree).props.onChange({ target: { value: 'deletar' } })
  assert.equal(button(render()).props.disabled, true)
  input(render()).props.onChange({ target: { value: 'DELETAR ' } })
  assert.equal(button(render()).props.disabled, true)
  input(render()).props.onChange({ target: { value: 'DELETAR' } })
  assert.equal(button(render()).props.disabled, false)
  let resolve
  request = () => new Promise(r => { resolve = r })
  button(render()).props.onClick()
  button(render()).props.onClick()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['delete', { document_id: doc.id, confirmation: 'DELETAR', expected_version: 3 }])
  assert.equal(button(render()).props.disabled, true)
  assert.deepEqual(navigation, [])
  assert.deepEqual(messages, [])
  resolve({ state: 'deleted' })
  await tick()
  assert.deepEqual(navigation, [['/tracking', { replace: true }]])
  assert.deepEqual(messages, ['Ficha excluída.'])
  assert.ok(invalidations.some(([kind, query]) => kind === 'invalidate' && query.queryKey[0] === 'exam-documents'))
  assert.ok(invalidations.some(([kind, query]) => kind === 'invalidate' && query.queryKey[0] === 'intake-panel-v2'))
  assert.deepEqual(pendingChanges, [true, false])
  state = []; calls = []; messages = []; navigation = []; pendingChanges = []
  input(render()).props.onChange({ target: { value: 'DELETAR' } })
  request = async () => { throw new Error('Arquivo não pôde ser removido.') }
  button(render()).props.onClick()
  await tick()
  tree = render()
  assert.equal(tree.find(node => node.props?.role === 'alert').props.children, 'Arquivo não pôde ser removido.')
  assert.deepEqual(navigation, [])
  assert.deepEqual(messages, [])
  assert.equal(input(tree).props.value, 'DELETAR')
  assert.equal(button(tree).props.disabled, false)
  request = async () => ({ state: 'deleting' })
  button(render()).props.onClick()
  await tick()
  tree = render()
  assert.match(tree.find(node => node.props?.role === 'alert').props.children, /ainda não confirmada/)
  assert.deepEqual(navigation, [])
  assert.deepEqual(messages, [])
  state = []; calls = []; messages = []; navigation = []; pendingChanges = []
  input(render()).props.onChange({ target: { value: 'DELETAR' } })
  request = async action => {
    if (action === 'delete') throw Object.assign(new Error('Resposta não confirmada'), { code: 'DOCUMENT_SERVICE_TIMEOUT' })
    return { state: 'deleted' }
  }
  button(render()).props.onClick(); await tick(); await tick()
  assert.deepEqual(calls.map(args => args[0]), ['delete', 'delete_status'])
  assert.equal(messages.length, 1); assert.equal(navigation.length, 1)
  assert.ok(invalidations.some(([kind, query]) => kind === 'invalidate' && query.queryKey[0] === 'exam-intake-exam-failures-v1'))
  state = []; calls = []; messages = []; navigation = []; pendingChanges = []
  input(render()).props.onChange({ target: { value: 'DELETAR' } })
  request = async action => {
    if (action === 'delete') throw Object.assign(new Error('Resposta não confirmada'), { code: 'DOCUMENT_SERVICE_TIMEOUT' })
    return { state: 'deleting' }
  }
  button(render()).props.onClick(); await tick(); await tick()
  tree = render(); assert.match(tree.find(node => node.props?.role === 'alert').props.children, /ainda não terminou/)
  assert.equal(button(tree).props.disabled, false); assert.equal(navigation.length, 0); assert.equal(messages.length, 0)
  const checkButton = tree.find(node => node.type === 'button' && node.props.children === 'Conferir situação')
  checkButton.props.onClick(); await tick()
  assert.deepEqual(calls.map(args => args[0]), ['delete', 'delete_status', 'delete_status'])
  assert.equal(messages.length, 0)
  console.log('document-delete confirmation, pending, success and failure checks passed')
})().catch(error => { console.error(error); process.exitCode = 1 })
