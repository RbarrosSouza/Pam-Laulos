import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {buildJevObserver,prepareJevObservation,classifyJevObservation,JEV_DECISIONS_URL} from './jev-observer-build.mjs';
const workflow=buildJevObserver(),node=name=>workflow.nodes.find(item=>item.name===name);
test('observer is paused, isolated, bounded to one claim and one explicit provider call',async()=>{
 assert.equal(workflow.active,false);assert.equal(workflow.settings.executionTimeout,120);assert.equal(workflow.settings.saveDataSuccessExecution,'none');assert.equal(workflow.settings.saveDataErrorExecution,'none');
 assert.equal(workflow.nodes.filter(n=>n.type.endsWith('manualTrigger')).length,1);assert.equal(workflow.nodes.filter(n=>n.type.endsWith('scheduleTrigger')).length,1);
 assert.equal(node('A cada 5 minutos').parameters.rule.interval[0].minutesInterval,5);
 assert.equal(workflow.nodes.some(n=>n.type.endsWith('webhook')||n.type.endsWith('executeWorkflow')),false);
 const config=await new vm.Script('(async function(){'+node('Configuração').parameters.jsCode+'})()').runInNewContext({$execution:{id:'synthetic'}});assert.equal(config.length,0);
 const names=new Set(workflow.nodes.map(n=>n.name));for(const [name,c]of Object.entries(workflow.connections)){assert(names.has(name));for(const branch of c.main)for(const edge of branch)assert(names.has(edge.node));}
 for(const n of workflow.nodes){if(n.type.endsWith('code'))new vm.Script('(async function(){'+n.parameters.jsCode+'})');if(n.type.endsWith('httpRequest'))assert.equal(n.retryOnFail,false);if(n.parameters.jsonBody)assert.equal(n.parameters.jsonBody.indexOf('}}'),n.parameters.jsonBody.length-2,n.name+' has an early n8n expression terminator');}
 const model=node('OpenRouter - decisão JEV');assert.equal(model.parameters.url,JEV_DECISIONS_URL);assert.equal(model.parameters.options.timeout,2000);assert.equal(model.parameters.options.redirect.redirect.followRedirects,false);
 assert.equal(node('Extrair texto limitado').parameters.options.maxPages,5);
 const graph=JSON.stringify(workflow);assert(!/action:["'](?:task_result|extraction|attach_nexus|reserve_tasks|group_begin)/.test(graph));
 if(process.env.OPERACIONAL_PARSER_PACKAGE){
  const require=createRequire(process.env.OPERACIONAL_PARSER_PACKAGE),{Expression}=require('n8n-workflow');const renderer=new Expression('America/Sao_Paulo');
  const fixture={worker:'synthetic',id:'synthetic',lease_token:'synthetic',document:{id:'synthetic'}};
  for(const n of workflow.nodes)if(n.parameters.url?.includes('serviceUrl')){
   const result=renderer.renderExpression(n.parameters.jsonBody.slice(1),{$json:fixture,$:()=>({first:()=>({json:fixture}),item:{json:fixture}})});
   assert(result&&typeof result.action==='string',n.name+' did not render a request object in n8n');
  }
 }
 assert.equal(workflow.connections['Observação autorizada'].main[1].length,0);assert.equal(workflow.connections['Registrar somente observação'],undefined);
 assert.deepEqual(JSON.parse(await fs.readFile(new URL('../../n8n/exames/OBSERVACAO-JEV.json',import.meta.url),'utf8')),workflow);
});
test('page metadata is required, consistent and cannot hide truncation or vision',()=>{
 for(const input of [{text:['page']},{text:['page'],numpages:0},{text:['page'],numpages:true},{text:['page'],numpages:'1'},{text:['page'],numPages:99},{text:['page'],numpages:1,numPages:99},{text:['page'],numpages:5},{text:['page'],numpages:2}])assert.equal(prepareJevObservation(input).request,null);
 assert.equal(prepareJevObservation({text:['page'],numpages:1,numPages:1}).request.model,'typesafe/jev-1.14');
 assert.equal(prepareJevObservation({text:[' '],numpages:1}).request,null);
});
test('HTTP, provider schema and timeout failures are terminal observations without decisions',()=>{
 for(const [response,status]of [[{error:'timeout'},'uncertain'],[{statusCode:429,body:{error:'rate limit'}},'failed'],[{statusCode:200,body:{}},'failed']]){
  const result=classifyJevObservation(response,100,200);assert.equal(result.status,status);assert.equal(result.route,undefined);assert.equal(result.duration_ms,100);
 }
 const result=classifyJevObservation({statusCode:200,body:{model:'typesafe/jev-1.14',answers:{extraction_route:{type:'choice',choice:'general_extraction',confidence:0.9}},usage:{cost:0.001}}},100,200);
 assert.deepEqual(result,{status:'completed',route:'general_extraction',confidence:0.9,cost_usd:0.001,model:'typesafe/jev-1.14',duration_ms:100});
 const body={model:'typesafe/jev-1.14',answers:{extraction_route:{type:'choice',choice:'general_extraction',confidence:0.9}}};
 for(const statusCode of ['invalid','200',{},NaN,200.5,undefined])assert.equal(classifyJevObservation({statusCode,body},100,200).status,'uncertain');
});
test('only existing credential references and unambiguous service URLs can be bound',()=>{
 const bound=buildJevObserver({credentials:{openrouter:{type:'httpHeaderAuth',id:'EXISTING',name:'Existing OpenRouter header'}}});
 assert.equal(bound.nodes.find(n=>n.name==='OpenRouter - decisão JEV').credentials.httpHeaderAuth.id,'EXISTING');
 assert.throws(()=>buildJevObserver({credentials:{openrouter:{type:'openRouterApi',id:'x',name:'x',apiKey:'secret'}}}),/references only/);
 assert.throws(()=>buildJevObserver({config:{serviceUrl:'https://trusted.example@attacker.example/functions/v1/exam-document-service'}}),/service URL/);
});
