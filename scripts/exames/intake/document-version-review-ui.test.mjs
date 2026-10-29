import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {versionReviewPreviewFixture} from '../../../dev/version-review-preview.fixture.mjs';
const require=createRequire(import.meta.url),file=fileURLToPath(new URL('../../../src/components/documents/DocumentVersionReviewView.tsx',import.meta.url));
const output=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
const module={exports:{}};new Function('require','module','exports',output)(require,module,module.exports);
const {isVersionReviewData,hasVersionReviewNotice,DocumentVersionReviewView}=module.exports;
const render=data=>renderToStaticMarkup(createElement(DocumentVersionReviewView,{data}));

test('originals and their independent delivery receipts remain visible without classification controls',()=>{
 const data=versionReviewPreviewFixture();assert(isVersionReviewData(data));
 const markup=render(data);
 assert.match(markup,/Original anterior/);assert.match(markup,/Original atual/);
 assert.match(markup,/Enviado ao grupo/);assert.match(markup,/Envio em conferência/);
 assert.match(markup,/\/novos-exames\/44444444-4444-4444-8444-444444444444\?panel=pdf/);
 assert.match(markup,/\/novos-exames\/33333333-3333-4333-8333-333333333333\?panel=pdf/);
 assert(!/<input|<button|<fieldset|<details|<summary/.test(markup));
 assert(!/classifica|relação clínica|Complemento clínico|Inconclusivo|Registrar relação/i.test(markup));
});
test('old clinical decisions and unresolved holds cannot restore classification actions',()=>{
 for(const state of ['held','released'])for(const code of [null,'clinical_complement_confirmed','clinical_correction_confirmed','inconclusive']){
  const data=versionReviewPreviewFixture();data.hold.state=state;
  data.decision=code?{reason_code:code,reviewed_at:'2026-10-29T18:00:00Z'}:null;
  const markup=render(data);
  assert(!/<input|<button|<fieldset|<details|<summary/.test(markup));
  assert(!/classifica|relação clínica|Complemento clínico|Inconclusivo/i.test(markup));
 }
 const container=readFileSync(new URL('../../../src/components/documents/DocumentVersionReview.tsx',import.meta.url),'utf8');
 assert(!/useDocumentAction|useMutation|mutateAsync|release_exam_intake_hold|onSubmit/.test(container));
 assert.match(container,/get_exam_intake_version_review/);
});
test('missing previous evidence retains current delivery status without requesting a decision',()=>{
 const data=versionReviewPreviewFixture(true);
 const markup=render(data);
 assert.match(markup,/Original ainda sem preservação comprovada/);
 assert.match(markup,/Envio em conferência/);
 assert(!markup.includes('Classificar'));assert(!markup.includes('type="radio"'));
});
test('malformed identities and unrelated current metadata cannot become original data',()=>{
 const bad=versionReviewPreviewFixture();bad.previous.document_id='javascript:alert(1)';assert(!isVersionReviewData(bad));
 const changed=versionReviewPreviewFixture();changed.current.document_id='55555555-5555-4555-8555-555555555555';assert(!isVersionReviewData(changed));
 const wrongPrevious=versionReviewPreviewFixture();wrongPrevious.hold.previous_document_id='55555555-5555-4555-8555-555555555555';assert(!isVersionReviewData(wrongPrevious));
 const firstOriginal=versionReviewPreviewFixture();firstOriginal.hold={...firstOriginal.hold,state:'released',reason:'first_original'};assert.equal(hasVersionReviewNotice(firstOriginal),false);assert.equal(hasVersionReviewNotice(versionReviewPreviewFixture()),true);
});
test('two confirmed sends lead with delivery success',()=>{
 const data=versionReviewPreviewFixture();data.current.group_status='sent';
 const markup=render(data);
 assert.match(markup,/Os dois originais foram enviados ao grupo/);
 assert.equal((markup.match(/Enviado ao grupo/g)||[]).length,2);
});
test('pending, failed, uncertain or absent previous sends never claim both originals were sent',()=>{
 for(const status of ['pending','failed','uncertain','submitted','reserved','not_queued'])for(const side of ['current','previous']){
  const data=versionReviewPreviewFixture();data.current.group_status='sent';data[side].group_status=status;
  const markup=render(data);
  assert(!markup.includes('Os dois originais foram enviados ao grupo'),`${side}:${status}`);
  assert.match(markup,/Envio dos originais ao grupo/);
 }
 const data=versionReviewPreviewFixture();data.previous=null;data.current.group_status='sent';
 const markup=render(data);
 assert(!markup.includes('Os dois originais foram enviados ao grupo'));
});
