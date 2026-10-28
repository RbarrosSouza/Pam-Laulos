import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {intakePreviewFixture} from '../../../dev/intake-preview.fixture.mjs';

const require=createRequire(import.meta.url),file=fileURLToPath(new URL('../../../src/components/intake/IntakeReceiptsView.tsx',import.meta.url));
const compiled=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
const module={exports:{}};new Function('require','module','exports',compiled)(require,module,module.exports);
const {isIntakePanel,intakeDocumentHref,IntakeReceiptsView}=module.exports;

test('missing coverage and mismatched/truncated counts never become an accepted zero-pending panel',()=>{
 assert(isIntakePanel(intakePreviewFixture('pending')));assert(isIntakePanel(intakePreviewFixture('none')));assert(isIntakePanel(intakePreviewFixture('empty')));
 const missing=intakePreviewFixture('none');delete missing.historical;assert(!isIntakePanel(missing));
 const wrong=intakePreviewFixture('pending');wrong.summary.unresolved_origin_total=0;assert(!isIntakePanel(wrong));
 const truncated=intakePreviewFixture('pending');truncated.entries_without_document_has_more=false;assert(!isIntakePanel(truncated));
});
test('only validated document UUIDs become local document links',()=>{
 for(const invalid of ['javascript:alert(1)','../../admin','https://example.com','not-an-id',null,{},'11111111-1111-4111-8111-111111111111?admin=true'])assert.equal(intakeDocumentHref(invalid),null);
 assert.equal(intakeDocumentHref('11111111-1111-4111-8111-111111111111'),'/novos-exames/11111111-1111-4111-8111-111111111111');
});
test('zero queues, partial collections and history retain visible proof limits without any data client',()=>{
 const empty=renderToStaticMarkup(createElement(IntakeReceiptsView,{data:intakePreviewFixture('none')}));assert.match(empty,/Nenhuma varredura registrada/);assert.match(empty,/Zero pendências não comprova todo o histórico/);
 const partial=renderToStaticMarkup(createElement(IntakeReceiptsView,{data:intakePreviewFixture('pending')}));assert.match(partial,/Conferência incompleta/);assert.match(partial,/Entrega ao grupo incerta/);assert.match(partial,/Histórico anterior ao corte/);assert.match(partial,/Exibindo 1 de 3/);
 const source=readFileSync(file,'utf8');assert(!/supabase|useExamAuth|fetch\(/.test(source));
});
