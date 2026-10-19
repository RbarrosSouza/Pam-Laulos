const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

const filename = path.resolve(__dirname, '../../src/components/tracking/tracking-dnd.ts')
const loaded = new Module(filename, module)
loaded.paths = Module._nodeModulePaths(path.dirname(filename))
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename)
const detect = loaded.exports.trackingCollisionDetection
const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height })
const targets = [
  ['hidden-column', rect(0, 0, 0, 0)],
  ['aguardando_lab', rect(0, 130, 320, 600)],
  ['stage-no_grupo', rect(0, 0, 150, 55)],
  ['stage-exame_pronto', rect(160, 0, 150, 55)],
]
const run = (collisionRect, pointerCoordinates = null, entries = targets) => detect({ collisionRect, pointerCoordinates, droppableContainers: entries.map(([id]) => ({ id })), droppableRects: new Map(entries) })
let count = 0
const check = (name, callback) => { callback(); count++; console.log('✓ ' + name) }
check('hidden zero-area columns cannot win a keyboard collision near the origin', () => {
  const hits = run(rect(0, 0, 5, 5)); assert.notEqual(hits[0]?.id, 'hidden-column'); assert(!hits.some(hit => hit.id === 'hidden-column'))
})
check('pointer stage wins even when the long card center is closer to its original column', () => {
  assert.equal(run(rect(0, 200, 320, 400), { x: 70, y: 20 })[0].id, 'stage-no_grupo')
})
check('empty stage remains a usable target with valid geometry', () => {
  assert.equal(run(rect(0, 200, 320, 400), { x: 200, y: 20 })[0].id, 'stage-exame_pronto')
})
check('keyboard keeps the visible column destination without a pointer', () => {
  assert.equal(run(rect(0, 200, 300, 400))[0].id, 'aguardando_lab')
})
check('hidden stage buttons cannot override a visible column', () => {
  const entries = [['stage-no_grupo', rect(0, 0, 0, 0)], ['no_grupo', rect(0, 0, 300, 500)]]
  assert.equal(run(rect(0, 0, 5, 5), { x: 0, y: 0 }, entries)[0].id, 'no_grupo')
})
check('no visible target produces no destination', () => {
  assert.deepEqual(run(rect(0, 0, 5, 5), { x: 0, y: 0 }, targets.slice(0, 1)), [])
})
console.log(`${count} tracking collision checks passed`)
