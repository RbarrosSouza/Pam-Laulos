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
const {isIntakePanel,intakeDocumentHref,intakeCollectorStatus,intakeSnapshotStatus,IntakeReceiptsView}=module.exports;

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
 assert.equal((empty.match(/data-intake-provider=/g)||[]).length,3);for(const provider of ['Gmail','Outlook','WhatsApp'])assert.match(empty,new RegExp(`Sem prova de cobertura de ${provider}`));
 const partial=renderToStaticMarkup(createElement(IntakeReceiptsView,{data:intakePreviewFixture('pending')}));assert.match(partial,/Conferência incompleta/);assert.match(partial,/Entrega ao grupo incerta/);assert.match(partial,/Histórico anterior ao corte/);assert.match(partial,/Exibindo 1 de 3/);
 assert(!partial.includes('Avisos de erro pendentes'));assert(!partial.includes('Aviso aguardando ativação'));
 const source=readFileSync(file,'utf8');assert(!/supabase|useExamAuth|fetch\(/.test(source));
});
test('scheduled audit mode is stated without assuming its scheduling, and stale progress loses recent proof',()=>{
 const panel=intakePreviewFixture('empty'),collector=panel.collectors[0];collector.monitored=false;
 assert.equal(intakeCollectorStatus(collector,panel.as_of,Date.parse(panel.as_of)),'Conferência em modo auditoria');
 const fresh=renderToStaticMarkup(createElement(IntakeReceiptsView,{data:panel,now:Date.parse(panel.as_of)}));assert.match(fresh,/Conferência em modo auditoria/);assert.match(fresh,/Último progresso/);assert(!fresh.includes('sem monitoramento automático'));
 collector.stale_after_seconds=3600;collector.progress_at='2026-10-27T20:44:59Z';
 assert.equal(intakeCollectorStatus(collector,panel.as_of,Date.parse(panel.as_of)),'Conferência desatualizada');
 assert.match(renderToStaticMarkup(createElement(IntakeReceiptsView,{data:panel,now:Date.parse(panel.as_of)})),/não comprova os recebimentos mais recentes/);
});
test('cached as_of cannot freeze freshness and paused refresh cannot imply current collector coverage',()=>{
 const panel=intakePreviewFixture('empty'),then=Date.parse(panel.as_of),collector=panel.collectors[0];
 assert.equal(intakeSnapshotStatus(panel.as_of,then+120001),'stale');assert.equal(intakeCollectorStatus(collector,panel.as_of,then+120001),'Consulta antiga');
 const html=renderToStaticMarkup(createElement(IntakeReceiptsView,{data:panel,now:then+120001,onRefresh:()=>{}}));assert.match(html,/Consulta antiga/);assert.match(html,/contagens abaixo pertencem a essa consulta/);assert(!html.includes('Coleta com atividade recente'));
 assert.equal(intakeCollectorStatus(collector,panel.as_of,then,true),'Atualização pausada');assert.equal(intakeSnapshotStatus(new Date(then+600000).toISOString(),then),'invalid');
});
test('all collectors remain visible inside their fixed channel and newer coverage does not resolve older queues',()=>{
 const panel=intakePreviewFixture('pending');panel.collectors.push({...panel.collectors[0],collector_id:'auditoria-anterior-incompleta',latest_sweep:{...panel.collectors[0].latest_sweep,scanFinished:false,allPreserved:false}});
 const html=renderToStaticMarkup(createElement(IntakeReceiptsView,{data:panel}));assert.equal((html.match(/data-intake-provider=/g)||[]).length,3);assert.match(html,/auditoria-anterior-incompleta/);assert.match(html,/Conferência concluída/);assert.match(html,/Conferência incompleta/);assert.match(html,/Pendências anteriores continuam nas filas/);assert.match(html,/Ocorrências em acompanhamento/);assert.match(html,/Falha informada/);
});
