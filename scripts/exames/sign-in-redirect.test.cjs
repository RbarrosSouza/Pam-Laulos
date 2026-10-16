// Run: node scripts/exames/sign-in-redirect.test.cjs
// Extract the real private helper with TypeScript's AST so the application need
// not expose a test-only export or initialize authentication/router providers.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');

const file = path.resolve(__dirname, '../../src/pages/SignIn.tsx');
const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const helper = source.statements.find(statement =>
  ts.isFunctionDeclaration(statement) && statement.name?.text === 'safeSignInRedirect',
);
assert.ok(helper, 'The production sign-in redirect validator must exist');
const helperSource = ts.createPrinter().printNode(ts.EmitHint.Unspecified, helper, source);
const compiled = ts.transpileModule(helperSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const safeSignInRedirect = new Function(`${compiled}\nreturn safeSignInRedirect;`)();

const fallback = '/novos-exames';
const documentRoute = '/novos-exames/10000000-0000-4000-8000-000000000001';
const shortRoute = '/e/' + Buffer.from('10000000000040008000000000000001', 'hex').toString('base64url');
const cases = [
  ['missing redirect', null, fallback],
  ['empty redirect', '', fallback],
  ['dashboard route', '/', '/'],
  ['tracking route', '/tracking', '/tracking'],
  ['sample shipment route', '/ship', '/ship'],
  ['shipment history route', '/shipments', '/shipments'],
  ['overdue route', '/late', '/late'],
  ['settings route', '/settings', '/settings'],
  ['new exams list', '/novos-exames', '/novos-exames'],
  ['document route preserves query and fragment', `${documentRoute}?tab=contact#historico`, `${documentRoute}?tab=contact#historico`],
  ['short document route survives login', shortRoute, shortRoute],
  ['short route preserves query and fragment', `${shortRoute}?tab=contact#historico`, `${shortRoute}?tab=contact#historico`],
  ['invalid short route length', `${shortRoute}A`, fallback],
  ['invalid short route padding bits', '/e/AAAAAAAAAAAAAAAAAAAAAB', fallback],
  ['invalid short route alphabet', '/e/AAAAAAAAAAAAAAAAAAAAA+', fallback],
  ['absolute external URL', 'https://outside.invalid/tracking', fallback],
  ['protocol-relative external URL', '//outside.invalid/tracking', fallback],
  ['relative path', 'tracking', fallback],
  ['backslash host confusion', '/\\outside.invalid/tracking', fallback],
  ['newline in destination', '/tracking\n', fallback],
  ['DEL control character', '/tracking\x7f', fallback],
  ['unknown app route', '/unknown', fallback],
  ['sign-in loop', '/entrar', fallback],
  ['malformed document id', '/novos-exames/not-a-uuid', fallback],
  ['encoded external-like destination', '/%2f%2foutside.invalid', fallback],
];

for (const [index, [name, input, expected]] of cases.entries()) {
  assert.equal(safeSignInRedirect(input), expected, name);
  console.log(`ok ${index + 1} - ${name}`);
}
console.log(`${cases.length} sign-in redirect regression checks passed`);
