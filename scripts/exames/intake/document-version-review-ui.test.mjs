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
 assert.match(markup,/Original anterior/);assert.match(markup,/Original atual/);assert.match(markup,/Complemento clínico/);assert.match(markup,/Inconclusivo/);assert.match(markup,/não repete o envio/);assert.match(markup,/disabled=""[^>]*>Registrar relação entre versões/);
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
test('two confirmed sends lead with delivery success and keep clinical classification optional and collapsed',()=>{
 const data=versionReviewPreviewFixture();data.current.group_status='sent';
 const markup=renderToStaticMarkup(createElement(DocumentVersionReviewView,{data,role:'vet',onSubmit:()=>{throw new Error('render must not send')}}));
 assert.match(markup,/Os dois originais foram enviados ao grupo/);
 assert.match(markup,/Classificar como complemento ou correção \(opcional\)/);
 assert.match(markup,/<details class=/);assert(!markup.includes('<details open'));
 assert(!markup.includes('Revisão da versão pendente'));assert(!markup.includes('O conteúdo do resultado mudou'));
 assert.equal((markup.match(/Enviado ao grupo/g)||[]).length,2);
 assert(!markup.includes('Complemento clínico confirmado'));
});
test('pending, failed, uncertain or absent previous sends never claim both originals were sent',()=>{
 for(const status of ['pending','failed','uncertain','submitted','reserved','not_queued'])for(const side of ['current','previous']){
  const data=versionReviewPreviewFixture();data.current.group_status='sent';data[side].group_status=status;
  const markup=renderToStaticMarkup(createElement(DocumentVersionReviewView,{data,role:'vet',onSubmit:()=>{}}));
  assert(!markup.includes('Os dois originais foram enviados ao grupo'),`${side}:${status}`);
  assert.match(markup,/Envio dos originais ao grupo/);
 }
 const data=versionReviewPreviewFixture();data.previous=null;data.current.group_status='sent';
 const markup=renderToStaticMarkup(createElement(DocumentVersionReviewView,{data,role:'vet',onSubmit:()=>{}}));
 assert(!markup.includes('Os dois originais foram enviados ao grupo'));
});
test('recorded clinical decisions stay available and a submission completion remains visible',()=>{
 const data=versionReviewPreviewFixture();data.hold.state='released';data.decision={reason_code:'clinical_complement_confirmed',reviewed_at:'2026-10-29T18:00:00Z'};
 const markup=renderToStaticMarkup(createElement(DocumentVersionReviewView,{data,role:'vet',completion:'Relação registrada.',onSubmit:()=>{}}));
 assert.match(markup,/Complemento clínico confirmado · Ver classificação/);
 assert.match(markup,/<details open=""/);assert.match(markup,/Relação registrada\./);
 const failed=renderToStaticMarkup(createElement(DocumentVersionReviewView,{data:versionReviewPreviewFixture(),role:'vet',error:'Falha simulada ao registrar.',onSubmit:()=>{}}));
 assert.match(failed,/<details open=""/);assert.match(failed,/role="alert"[^>]*>Falha simulada ao registrar\./);
});
