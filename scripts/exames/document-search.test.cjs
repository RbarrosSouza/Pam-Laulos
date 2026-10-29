const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const { test } = require('node:test')

// Query contract from the deployed v_exam_documents schema. An unknown column
// makes PostgREST reject the entire search, including otherwise matching pets.
const columns = new Set(['display_code', 'original_name', 'extracted_data', 'confirmed_data', 'responsible_vet_name'])
const documents = [
  { id: '11111111-1111-4111-8111-111111111111', original_name: 'Laudo.pdf', extracted_data: { pet_name: 'Luna', report_number: '8123' }, confirmed_data: {} },
  { id: '22222222-2222-4222-8222-222222222222', original_name: 'Outro.pdf', extracted_data: {}, confirmed_data: { pet_name: 'Bento', report_number: '8124', tutor_name: 'Ana', client_name: 'Ana' } },
]
function query() {
  return {
    rows: documents,
    select() { return this }, order() { return this },
    eq(field, value) { this.rows = this.rows.filter(d => d[field] === value); return this },
    or(expression) {
      const predicates = expression.split(',').map(clause => {
        const [field, pattern] = clause.split('.ilike.')
        const [column, key] = field.split('->>')
        assert.ok(columns.has(column), `Column absent from deployed view: ${column}`)
        const term = pattern.slice(1, -1).toLocaleLowerCase()
        return row => String(key ? row[column]?.[key] ?? '' : row[column] ?? '').toLocaleLowerCase().includes(term)
      })
      this.rows = this.rows.filter(row => predicates.some(matches => matches(row)))
      return this
    },
  }
}
const source = fs.readFileSync(path.resolve(__dirname, '../../src/hooks/useExamDocuments.ts'), 'utf8')
const compiled = ts.transpileModule(source.replace(/import\.meta\.env/g, '({})'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const moduleUnderTest = { exports: {} }
new Function('require', 'module', 'exports', compiled)(id => id === '@/lib/supabase' ? { supabase: { from: query } } : {}, moduleUnderTest, moduleUnderTest.exports)
const { buildExamDocumentsQuery } = moduleUnderTest.exports

test('name search succeeds against the deployed view schema', () => {
  assert.deepEqual(buildExamDocumentsQuery('Luna', 'all').rows.map(d => d.id), [documents[0].id])
})
test('confirmed pet and tutor names remain searchable', () => {
  for (const term of ['Bento', 'Ana']) assert.deepEqual(buildExamDocumentsQuery(term, 'all').rows.map(d => d.id), [documents[1].id])
})
test('requisition matches both extracted and confirmed report numbers', () => {
  for (const [term, document] of [['8123', documents[0]], ['8124', documents[1]]]) {
    assert.deepEqual(buildExamDocumentsQuery(term, 'all').rows.map(d => d.id), [document.id])
  }
})
test('original filenames and no-match results retain their behavior', () => {
  assert.deepEqual(buildExamDocumentsQuery('Outro.pdf', 'all').rows.map(d => d.id), [documents[1].id])
  assert.deepEqual(buildExamDocumentsQuery('Ausente', 'all').rows, [])
})
test('UUID lookup uses the exact document rather than a broad text search', () => {
  assert.deepEqual(buildExamDocumentsQuery(`EX-${documents[0].id}`, 'all').rows.map(d => d.id), [documents[0].id])
})
