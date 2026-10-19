// Offline contracts for the Home queue. Executes the real TypeScript helper
// and server-renders the presentation with no auth, database or network access.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const repo = path.resolve(__dirname, '../..')

function load(file, mocks = {}) {
  const source = ts.transpileModule(fs.readFileSync(path.join(repo, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', source)((id) => {
    if (id in mocks) return mocks[id]
    if (id.endsWith('.css')) return {}
    throw new Error(`Unexpected dependency in offline Home test: ${id}`)
  }, module, module.exports)
  return module.exports
}

const helpers = load('src/components/dashboard/home-display.ts')
const { contactComplete, homeGroupHours, needsHomeAttention, homeQueueCards, homeTimeLabel } = helpers
const now = Date.parse('2026-10-19T15:00:00Z')
const ago = (hours) => new Date(now - hours * 3_600_000).toISOString()
const card = (id, extra = {}) => ({
  id, status: 'no_grupo', alert_level: 'critical', group_sent_at: ago(30),
  pet_name: id, client_name: 'Tutora Sobrenome Completo', vet_name: 'Dra. Nome Completo',
  items: [{ id: `${id}-item`, exam_type: 'Hemograma', result_received: true, contacted: false }],
  created_at: ago(100), hours_elapsed: 100, items_total: 1, items_ready: 1, ...extra,
})
let count = 0
function check(label, run) { run(); count++; console.log(`ok ${count} - ${label}`) }

check('queue counts cards, not result items', () => {
  const one = card('one', { items: [1, 2, 3].map(id => ({ id, result_received: true, contacted: false })), items_total: 3, items_ready: 3 })
  assert.equal(homeQueueCards([one, card('two')], 'no_grupo', false, now).length, 2)
})
check('exactly 24h is not over 24h; one millisecond later is', () => {
  assert.equal(needsHomeAttention(card('exact', { group_sent_at: ago(24) }), now), false)
  assert.equal(needsHomeAttention(card('over', { group_sent_at: new Date(now - 24 * 3_600_000 - 1).toISOString() }), now), true)
})
check('backend critical flag remains required for attention', () => {
  for (const alert_level of ['normal', 'warning']) assert.equal(needsHomeAttention(card('old', { alert_level, group_sent_at: ago(90) }), now), false)
})
check('missing, invalid and future group timestamps never invent elapsed time', () => {
  for (const group_sent_at of [null, '', 'invalid-date', new Date(now + 1).toISOString()]) {
    const value = card('unknown', { group_sent_at })
    assert.equal(homeGroupHours(value, now), null)
    assert.equal(needsHomeAttention(value, now), false)
    assert.equal(homeTimeLabel(value, now), 'Envio sem data')
  }
})
check('old creation cannot substitute a missing confirmed group date', () => {
  const value = card('created-long-ago', { created_at: ago(500), hours_elapsed: 500, group_sent_at: null })
  assert.equal(homeGroupHours(value, now), null)
  assert.equal(homeTimeLabel(value, now), 'Envio sem data')
})
check('fresh group timestamp wins over old card creation', () => {
  const value = card('fresh-share', { group_sent_at: ago(2.5), created_at: ago(500), hours_elapsed: 500 })
  assert.equal(homeGroupHours(value, now), 2.5)
  assert.equal(homeTimeLabel(value, now), 'Há 2h no grupo')
  assert.equal(needsHomeAttention(value, now), false)
})
check('completed card is outside attention and never displays a clock', () => {
  const value = card('done', { status: 'contato_realizado' })
  assert.equal(contactComplete(value), true)
  assert.equal(homeGroupHours(value, now), null)
  assert.equal(needsHomeAttention(value, now), false)
  assert.equal(homeTimeLabel(value, now), null)
  assert.deepEqual(homeQueueCards([value], 'no_grupo', true, now), [])
})
check('all contacted items suppress the clock even while a stale status says group', () => {
  const value = card('item-complete', { items: [{ id: 'a', contacted: true }, { id: 'b', contacted: true }] })
  assert.equal(contactComplete(value), true)
  assert.equal(homeTimeLabel(value, now), null)
  assert.equal(needsHomeAttention(value, now), false)
})
check('empty or partially contacted items do not claim completion', () => {
  assert.equal(contactComplete(card('empty', { items: [] })), false)
  assert.equal(contactComplete(card('partial', { items: [{ contacted: true }, { contacted: false }] })), false)
})
check('lab and ready stages have no group clock and cannot be attention', () => {
  for (const status of ['aguardando_lab', 'exame_pronto']) {
    const value = card('not-group', { status })
    assert.equal(homeGroupHours(value, now), null)
    assert.equal(homeTimeLabel(value, now), null)
    assert.equal(needsHomeAttention(value, now), false)
  }
})
check('queue scope excludes other stages; sorting never mutates source order', () => {
  const values = Object.freeze([
    Object.freeze(card('recent', { group_sent_at: ago(1) })),
    Object.freeze(card('ready', { status: 'exame_pronto' })),
    Object.freeze(card('unknown', { group_sent_at: null })),
    Object.freeze(card('oldest', { group_sent_at: ago(80) })),
  ])
  assert.deepEqual(homeQueueCards(values, 'no_grupo', false, now).map(value => value.id), ['oldest', 'recent', 'unknown'])
  assert.deepEqual(values.map(value => value.id), ['recent', 'ready', 'unknown', 'oldest'])
  assert.deepEqual(homeQueueCards(values, 'no_grupo', true, now).map(value => value.id), ['oldest'])
})
check('non-group stage retains its original query order even when attention filter is stale', () => {
  const values = [card('first', { status: 'exame_pronto' }), card('other'), card('second', { status: 'exame_pronto' })]
  assert.deepEqual(homeQueueCards(values, 'exame_pronto', true, now).map(value => value.id), ['first', 'second'])
})

const Icon = () => React.createElement('svg', { 'aria-hidden': true })
const { DashboardView } = load('src/components/dashboard/DashboardView.tsx', {
  react: React, 'react/jsx-runtime': require('react/jsx-runtime'),
  'react-router-dom': { Link: ({ to, children, ...props }) => React.createElement('a', { href: to, ...props }, children) },
  'lucide-react': new Proxy({}, { get: () => Icon }),
  '@/lib/utils': { cn: (...values) => values.filter(Boolean).join(' ') },
  './home-display': helpers,
})
const queue = (cards = [], extra = {}) => ({ cards, loading: false, error: null, refreshing: false, ...extra })
const props = (extra = {}) => ({
  stats: undefined, summaryLoading: false, summaryError: null,
  queues: { no_grupo: queue(), exame_pronto: queue(), aguardando_lab: queue() },
  refreshing: false, onRefresh: () => {}, onOpenCard: () => {}, ...extra,
})
const render = (value) => renderToStaticMarkup(React.createElement(DashboardView, value))
check('missing summary totals are unavailable, not fabricated zeroes', () => {
  const html = render(props())
  assert.match(html, /Total de contatos indisponível/)
  assert.equal((html.match(/<strong>—<\/strong>/g) || []).length, 3)
})
check('loading does not masquerade as an empty work queue', () => {
  const html = render(props({ summaryLoading: true, queues: { no_grupo: queue([], { loading: true }), exame_pronto: queue(), aguardando_lab: queue() } }))
  assert.match(html, /Carregando fichas/)
  assert.doesNotMatch(html, /Nenhuma ficha nesta etapa/)
})
check('failed empty query reports unavailable data without a false empty state', () => {
  const html = render(props({ queues: { no_grupo: queue([], { error: new Error('offline') }), exame_pronto: queue(), aguardando_lab: queue() } }))
  assert.match(html, /Consulta indisponível/)
  assert.match(html, /Não foi possível carregar esta lista/)
  assert.doesNotMatch(html, /Nenhuma ficha nesta etapa/)
})
check('stale successful data stays visible with a query error', () => {
  const html = render(props({ queues: { no_grupo: queue([card('VisiblePet')], { error: new Error('offline') }), exame_pronto: queue(), aguardando_lab: queue() } }))
  assert.match(html, /VisiblePet/)
  assert.match(html, /Exibindo a última consulta/)
  assert.match(html, /Tutora Sobrenome Completo/)
  assert.match(html, /Dra\. Nome Completo/)
})
check('global summary and loaded queue count remain explicitly distinct', () => {
  const html = render(props({ stats: { total_no_grupo: 70, total_exame_pronto: 5, total_aguardando_lab: 4, total_contato_realizado: 100 }, queues: { no_grupo: queue([card('OnlyLoaded')]), exame_pronto: queue(), aguardando_lab: queue() } }))
  assert.match(html, /<strong>70<\/strong>/)
  assert.match(html, /1 ficha nesta lista/)
  assert.match(html, /Total no rastreamento/)
  assert.doesNotMatch(html, /hoje|Todos em dia|Tudo em dia/)
})
check('read-only queue exposes a native named button and preserves tracking route', () => {
  const html = render(props({ queues: { no_grupo: queue([card('Pet')]), exame_pronto: queue(), aguardando_lab: queue() } }))
  assert.match(html, /<button[^>]+aria-label="Abrir ficha de Pet, tutor Tutora Sobrenome Completo"/)
  assert.match(html, /href="\/tracking"/)
  assert.doesNotMatch(html, /href="\/tracking\?status=/)
})

// Execute the adapter's callbacks using deterministic read-query doubles. Its
// public surface does not expose any clinical write or status-change callback.
let selected = null
let selectionWrites = 0
const opener = { current: null }
const refreshed = []
let realtimeSubscriptions = 0
const read = (name, data) => ({ data, isLoading: false, error: null, isFetching: false, refetch: () => { refreshed.push(name) } })
const readQueries = {
  exame_pronto: read('ready', []),
  no_grupo: read('group', [card('Current')]),
  aguardando_lab: read('lab', []),
}
const summary = read('summary', { total_no_grupo: 50 })
const { Dashboard } = load('src/pages/Dashboard.tsx', {
  react: {
    useState: () => [selected, (value) => { selected = value; selectionWrites++ }],
    useRef: () => opener, useMemo: (run) => run(),
  },
  'react/jsx-runtime': require('react/jsx-runtime'),
  'framer-motion': { AnimatePresence: 'AnimatePresence' },
  '@/components/dashboard/DashboardView': { DashboardView: 'DashboardView' },
  '@/components/tracking/TrackingDetail': { TrackingDetail: 'TrackingDetail' },
  '@/hooks/useExamCards': { useExamCards: ({ status }) => readQueries[status[0]] },
  '@/hooks/useExamCardStats': { useExamCardStats: () => summary },
  '@/hooks/useRealtimeExams': { useRealtimeExams: () => { realtimeSubscriptions++ } },
  '@/hooks/useVets': { useVets: () => ({ data: [{ nome: 'Dra. Nome Completo', avatar_url: '/fixture-avatar.png' }] }) },
})
function nodes(value) {
  const values = []
  function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return
    values.push(node)
    walk(node.props?.children)
  }
  walk(value)
  return values
}
const adapter = () => nodes(Dashboard())
const viewNode = (values) => values.find(node => node.type === 'DashboardView')
const detailNode = (values) => values.find(node => node.type === 'TrackingDetail')

check('adapter refreshes all read queries without exposing mutations', () => {
  const view = viewNode(adapter())
  view.props.onRefresh()
  assert.deepEqual(refreshed, ['summary', 'ready', 'group', 'lab'])
  assert.equal(Object.keys(view.props).some(key => /submit|save|contact|move|delete/i.test(key)), false)
  assert.ok(realtimeSubscriptions > 0)
})
check('detail selection uses latest query record, not the clicked snapshot', () => {
  const first = viewNode(adapter())
  first.props.onOpenCard(first.props.queues.no_grupo.cards[0], { isConnected: false })
  readQueries.no_grupo.data = [card('Current', { client_name: 'Tutora Atualizada', vet_name: 'Dra. Atualizada' })]
  const detail = detailNode(adapter())
  assert.equal(detail.props.card.client_name, 'Tutora Atualizada')
  assert.equal(detail.props.card.vet_name, 'Dra. Atualizada')
})
check('selection follows its card into another active queue', () => {
  readQueries.no_grupo.data = []
  readQueries.exame_pronto.data = [card('Current', { status: 'exame_pronto' })]
  assert.equal(detailNode(adapter()).props.card.status, 'exame_pronto')
})
check('successful queue removal invalidates ID once so later arrivals do not reopen it', () => {
  readQueries.exame_pronto.data = []
  const before = selectionWrites
  assert.equal(detailNode(adapter()), undefined)
  assert.equal(selected, null)
  adapter()
  assert.equal(selectionWrites, before + 1)
  readQueries.no_grupo.data = [card('Current')]
  assert.equal(detailNode(adapter()), undefined)
})
check('query failure cannot falsely invalidate the selected ID', () => {
  selected = 'MissingDuringError'
  readQueries.no_grupo.error = new Error('offline')
  adapter()
  assert.equal(selected, 'MissingDuringError')
  readQueries.no_grupo.error = null
  adapter()
  assert.equal(selected, null)
})
check('manual detail close restores the connected opener and clears selection', () => {
  let focusOptions
  const first = viewNode(adapter())
  first.props.onOpenCard(first.props.queues.no_grupo.cards[0], { isConnected: true, focus: (options) => { focusOptions = options } })
  detailNode(adapter()).props.onClose()
  assert.equal(selected, null)
  assert.deepEqual(focusOptions, { preventScroll: true })
})
console.log(`${count} Home offline checks passed`)
