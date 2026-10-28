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
const {isVersionReviewData,buildVersionReviewSubmission,hasVersionReviewNotice,DocumentVersionReviewView}=module.exports;

test('only an explicitly confirmed vet/admin decision can produce a release request bound to the observed SHA',()=>{
 const data=versionReviewPreviewFixture();assert(isVersionReviewData(data));
 for(const role of ['staff','reader',null])assert.equal(buildVersionReviewSubmission(data,role,'clinical_correction_confirmed',true),null);
 assert.equal(buildVersionReviewSubmission(data,'vet','clinical_correction_confirmed',false),null);
 assert.equal(buildVersionReviewSubmission(data,'vet','arbitrary_release',true),null);
 assert.deepEqual(buildVersionReviewSubmission(data,'vet','clinical_complement_confirmed',true),{p_document_id:data.document_id,p_expected_sha256:data.current.sha256,p_reason_code:'clinical_complement_confirmed'});
 const released={...data,hold:{...data.hold,state:'released'}};assert.equal(buildVersionReviewSubmission(released,'admin','clinical_correction_confirmed',true),null);
});
test('missing previous evidence blocks clinical propagation but permits an explicit inconclusive decision',()=>{
 const data=versionReviewPreviewFixture(true);
 assert.equal(buildVersionReviewSubmission(data,'admin','clinical_correction_confirmed',true),null);
 assert.equal(buildVersionReviewSubmission(data,'vet','clinical_complement_confirmed',true),null);
 assert.equal(buildVersionReviewSubmission(data,'vet','inconclusive',true).p_reason_code,'inconclusive');
 const same=versionReviewPreviewFixture();same.previous.sha256=same.current.sha256;assert.equal(buildVersionReviewSubmission(same,'vet','clinical_correction_confirmed',true),null);
});
test('version UI exposes both originals, preserves uncertain deliveries and does not enable a default decision',()=>{
 const markup=renderToStaticMarkup(createElement(DocumentVersionReviewView,{data:versionReviewPreviewFixture(),role:'vet',onSubmit:()=>{throw new Error('SSR must not mutate')}}));
 assert.match(markup,/Original anterior/);assert.match(markup,/Original atual/);assert.match(markup,/Complemento clínico/);assert.match(markup,/Inconclusivo/);assert.match(markup,/não repete o envio/);assert.match(markup,/disabled=""[^>]*>Registrar revisão e liberar versão/);
 assert(!markup.includes('checked=""'));assert.match(markup,/\/novos-exames\/44444444-4444-4444-8444-444444444444\?panel=pdf/);
 const denied=renderToStaticMarkup(createElement(DocumentVersionReviewView,{data:versionReviewPreviewFixture(),role:'staff',onSubmit:()=>{}}));assert(!denied.includes('type="radio"'));assert.match(denied,/veterinária ou pela administração/);
 const source=readFileSync(file,'utf8');assert(!/supabase|useExamAuth|fetch\(/.test(source));
});
test('malformed identities and unrelated current metadata cannot become review data',()=>{
 const bad=versionReviewPreviewFixture();bad.previous.document_id='javascript:alert(1)';assert(!isVersionReviewData(bad));
 const changed=versionReviewPreviewFixture();changed.current.document_id='55555555-5555-4555-8555-555555555555';assert(!isVersionReviewData(changed));
 const wrongPrevious=versionReviewPreviewFixture();wrongPrevious.hold.previous_document_id='55555555-5555-4555-8555-555555555555';assert(!isVersionReviewData(wrongPrevious));
 const firstOriginal=versionReviewPreviewFixture();firstOriginal.hold={...firstOriginal.hold,state:'released',reason:'first_original'};assert.equal(hasVersionReviewNotice(firstOriginal),false);assert.equal(hasVersionReviewNotice(versionReviewPreviewFixture()),true);
});
