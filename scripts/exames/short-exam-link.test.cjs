// Run: node scripts/exames/short-exam-link.test.cjs
// Exercise production TypeScript without starting Auth, a browser or the network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
let passed = 0;
const check = (name, fn) => { fn(); console.log(`ok ${++passed} - ${name}`); };
function load(relative, mocks = {}) {
  const output = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX},
  }).outputText;
  const module = {exports: {}};
  new Function('require', 'module', 'exports', output)(name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name === 'react/jsx-runtime') return require(name);
    throw new Error(`Unexpected dependency: ${name}`);
  }, module, module.exports);
  return module.exports;
}
const codec = load('src/lib/exam-document-short-link.ts');
const uuid = '10000000-0000-4000-8000-000000000001';
const shortId = 'EAAAAAAAQACAAAAAAAAAAQ';
const shortPath = '/e/' + shortId;
const Navigate = () => null, Link = () => null;
const page = token => load('src/pages/ExamShortLink.tsx', {
  'react-router-dom': {Link, Navigate, useParams: () => ({shortId: token})},
  '@/lib/exam-document-short-link': codec,
}).ExamShortLink();
check('known UUID vector matches standard base64url bytes without changing UUID byte order', () => {
  assert.equal(codec.encodeExamDocumentId(uuid), shortId);
  assert.equal(codec.decodeExamDocumentId(shortId), uuid);
  assert.equal(codec.encodeExamDocumentId('ffffffff-ffff-ffff-ffff-ffffffffffff'), '_____________________w');
  assert.equal(codec.decodeExamDocumentId('AAAAAAAAAAAAAAAAAAAAAA'), '00000000-0000-0000-0000-000000000000');
});
check('browser codec interoperates with the n8n Buffer encoding for real UUID values', () => {
  for (let index = 0; index < 128; index++) {
    const value = crypto.randomUUID();
    const expected = Buffer.from(value.replaceAll('-', ''), 'hex').toString('base64url');
    assert.equal(codec.encodeExamDocumentId(value.toUpperCase()), expected);
    assert.equal(codec.decodeExamDocumentId(expected), value);
  }
});
check('invalid IDs, URL syntax and noncanonical padding bits never resolve to a document', () => {
  for (const value of [undefined, null, '', shortId + 'A', shortId.slice(1), shortId + '==',
    'AAAAAAAAAAAAAAAAAAAAAB', '../' + shortId, '/' + shortId, shortId.replace('Q', '+'), '%2f', uuid]) {
    assert.equal(codec.decodeExamDocumentId(value), null, String(value));
  }
  for (const value of [null, undefined, '', uuid.replaceAll('-', ''), 'z' + uuid.slice(1), '../' + uuid]) {
    assert.throws(() => codec.encodeExamDocumentId(value), TypeError);
  }
});
check('short route replaces browser history with the existing document route', () => {
  const result = page(shortId);
  assert.equal(result.type, Navigate);
  assert.equal(result.props.to, '/novos-exames/' + uuid);
  assert.equal(result.props.replace, true);
});
check('invalid short route renders an explanation without a navigation or data request', () => {
  const result = page('invalid');
  assert.equal(result.type, 'section');
  assert.equal(result.props.role, 'alert');
  assert.match(JSON.stringify(result.props.children), /Link de exame inválido/);
});
check('the actual router nests the short route under the existing team access boundary', () => {
  const file = path.join(root, 'src/App.tsx');
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let shortRoute;
  function walk(node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'Route' &&
      node.attributes.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.getText(source) === 'path' && prop.initializer?.text === '/e/:shortId')) shortRoute = node;
    ts.forEachChild(node, walk);
  }
  walk(source); assert(shortRoute, 'The application route must exist');
  let protectedAncestor = false;
  for (let node = shortRoute.parent; node; node = node.parent) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'Route' &&
      node.openingElement.attributes.getText(source).includes('<RequireExamAccess>')) protectedAncestor = true;
  }
  assert(protectedAncestor, 'A short URL must not be a public document route');
});
check('existing auth boundary withholds content and preserves the short destination through sign-in', () => {
  const SignInSource = ts.createSourceFile('SignIn.tsx', fs.readFileSync(path.join(root, 'src/pages/SignIn.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const helper = SignInSource.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'safeSignInRedirect');
  const compiled = ts.transpileModule(ts.createPrinter().printNode(ts.EmitHint.Unspecified, helper, SignInSource), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
  }).outputText;
  const safeRedirect = new Function(compiled + '\nreturn safeSignInRedirect;')();
  const child = Symbol('private exam view');
  function access(auth) {
    return load('src/components/documents/RequireExamAccess.tsx', {
      react: {useRef: value => ({current: value}), useState: value => [value, () => {}]},
      'react-router-dom': {Link, useLocation: () => ({pathname: shortPath, search: '?tab=contact', hash: '#historico'}), useNavigate: () => () => {}},
      'lucide-react': {Loader2: () => null, LockKeyhole: () => null},
      '@/contexts/exam-auth': {useExamAuth: () => auth}, '@/lib/supabase': {supabase: {}},
      '@tanstack/react-query': {useQueryClient: () => ({})},
    }).RequireExamAccess({children: child});
  }
  function findLink(element) {
    if (!element || typeof element !== 'object') return null;
    if (element.type === Link) return element;
    for (const next of [element.props?.children].flat(Infinity)) { const result = findLink(next); if (result) return result; }
    return null;
  }
  const anonymous = access({session: null, membership: false, loading: false});
  assert.notEqual(anonymous, child);
  const login = findLink(anonymous); assert(login);
  const redirect = new URL(login.props.to, 'https://example.invalid').searchParams.get('redirect');
  assert.equal(safeRedirect(redirect), shortPath + '?tab=contact#historico');
  assert.notEqual(access({session: {user: {}}, membership: false, loading: false}), child);
  assert.notEqual(access({session: {user: {}}, membership: true, loading: true}), child);
  assert.equal(access({session: {user: {}}, membership: true, loading: false}), child);
  assert.equal(page(shortId).props.to, '/novos-exames/' + uuid);
});
console.log(`${passed} short exam link checks passed`);
