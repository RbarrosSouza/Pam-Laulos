import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';import vm from 'node:vm';
import {createRequire} from 'node:module';const require=createRequire(import.meta.url);
import {buildWhatsappWorkflow} from '../whatsapp-intake-build.mjs';
import {canonicalChatwootEvent,inspectChatwootMessage} from '../whatsapp-intake-runtime.mjs';
import {buildProspectiveWhatsappChild,whatsappProspectiveCollectorId} from './whatsapp-prospective-child-build.mjs';
const cutoff='2026-10-28T10:00:00.000Z',collector='chatwoot_prospective_'+crypto.createHash('sha256').update(cutoff).digest('hex').slice(0,16);
const testConfig={enabled:true,accountId:'1',inboxId:'2',chatwootBaseUrl:'https://chat.example.invalid',serviceUrl:'https://api.example.invalid/functions/v1/exam-document-service',authorizedSenders:['5511999999999'],allowedAttachmentOrigins:[],intakeCutoff:'2026-10-01T00:00:00.000Z'};
const source=await buildWhatsappWorkflow({config:testConfig});
const child=buildProspectiveWhatsappChild(source,cutoff,collector);
const script=new vm.Script('(async()=>{'+child.nodes.find(n=>n.name==='Configuração').parameters.jsCode+'})()');
const invoke=payload=>script.runInNewContext({$input:{all:()=>[{json:{payload}}]},$execution:{id:'fixture'},require,Buffer,URL,Set,Date});
const bridge={collector_id:collector,account_id:'chatwoot:1:inbox:2',cutoff,conversation_id:'3',message_id:'4',attachment_ids:['chatwoot-attachment:6']};
const sender={id:5,type:'contact',phone_number:'+55 11 99999-9999'};
const conversation={id:3,account_id:1,inbox_id:2,meta:{sender},contact_inbox:{source_id:'5511999999999'}};
const message={id:4,conversation_id:3,account_id:1,inbox_id:2,message_type:'incoming',private:false,created_at:'2026-10-28T10:01:00.000Z',sender,attachments:[{id:6,content_type:'application/pdf',data_url:'https://chat.example.invalid/files/fake.pdf',file_size:100}]};

test('child has only a parent trigger and directly constructs a bounded reread request',async()=>{
  assert.equal(child.active,false);assert.equal(child.nodes.filter(n=>n.type.endsWith('.executeWorkflowTrigger')).length,1);
  assert(!child.nodes.some(n=>/\.(?:webhook|manualTrigger|scheduleTrigger)$/.test(n.type)));
  assert(!child.nodes.some(n=>['Chatwoot - listar conversas da caixa','Conferência agendada','Reconciliar reservas vencidas'].includes(n.name)));
  assert.equal(child.connections['Validar pasta privada'].main[0][0].node,'Chatwoot - conferir conversa de origem');
  const out=await invoke(bridge),cfg=out[0].json;assert.equal(cfg.intakeCutoff,cutoff);assert.equal(cfg.polling,false);assert.equal(cfg.request.beforeMessageId,'5');
  assert.deepEqual(JSON.parse(JSON.stringify(cfg.request)),{accountId:'1',inboxId:'2',conversationId:'3',messageId:'4',beforeMessageId:'5',attachmentIds:['chatwoot-attachment:6']});
  assert.deepEqual(JSON.parse(JSON.stringify(cfg.authorizedSenders)),testConfig.authorizedSenders);assert(!Object.hasOwn(cfg,'webhookPath'));
  for(const bad of [{...bridge,cutoff:'2026-10-27T10:00:00.000Z'},{...bridge,account_id:'chatwoot:1:inbox:999'}, {...bridge,conversation_id:'x'}, {...bridge,message_id:'9007199254740991'}, {...bridge,collector_id:'other'}, {...bridge,extra:true}])await assert.rejects(invoke(bad));
});
test('child selects only requested attachment and accepts generic MIME for byte inspection',async()=>{
 const cfg=(await invoke(bridge))[0].json;
 const js=child.nodes.find(n=>n.name==='Conferir remetente e todos os PDFs').parameters.jsCode;
 const selected={...message,attachments:[null,{id:6,content_type:'application/octet-stream',data_url:'https://chat.example.invalid/files/opaque',file_size:100},{id:7,content_type:'application/pdf',data_url:'https://chat.example.invalid/files/other.pdf',file_size:100}]};
 const run=new vm.Script('(async()=>{'+js+'})()');const out=await run.runInNewContext({require,Buffer,URL,Set,Date,$json:{payload:[selected]},$:(name)=>({first:()=>({json:name==='Configuração'?cfg:conversation})})});
 assert.equal(out.length,1);assert.equal(out[0].json.source.attachment_id,'chatwoot-attachment:6');assert.equal(out[0].json.missing,false);
});
test('canonical API reread enforces cutoff, sender authorization, individual conversation and inbox',async()=>{
  const cfg=(await invoke(bridge))[0].json;
  const inspect=(c,m)=>inspectChatwootMessage(canonicalChatwootEvent(cfg.request,c,{payload:[m]},cfg),cfg);
  const valid=inspect(conversation,message);assert.equal(valid.excluded,false);assert.equal(valid.origins[0].source.attachment_id,'chatwoot-attachment:6');
  assert.equal(inspect(conversation,{...message,created_at:'2026-10-28T09:59:59.000Z'}).reason,'before_intake_cutoff');
  assert.throws(()=>inspect({...conversation,inbox_id:9},message),/mismatch/);
  assert.throws(()=>inspect({...conversation,additional_attributes:{is_group:true}},message),/group_or_broadcast/);
  const stranger={id:8,type:'contact',phone_number:'+55 11 98888-8888'};
  assert.equal(inspect({...conversation,meta:{sender:stranger},contact_inbox:{source_id:'5511988888888'}},{...message,sender:stranger}).reason,'sender_not_authorized');
  assert.throws(()=>inspect(conversation,{...message,id:99}),/not_unique/);
});
test('builder rejects mismatched collector or a stale workflow missing authorization guards',()=>{
  assert.throws(()=>buildProspectiveWhatsappChild(source,cutoff,'wrong'),/Collector and cutoff/);
  const stale=structuredClone(source);stale.nodes.find(n=>n.name==='Conferir remetente e todos os PDFs').parameters.jsCode='';
  assert.throws(()=>buildProspectiveWhatsappChild(stale,cutoff,collector),/canonical reread/);
});
test('canary has a separate collector identity and cannot process other messages',async()=>{
 const id=whatsappProspectiveCollectorId(cutoff,'3','4');assert.notEqual(id,collector);
 const limited=buildProspectiveWhatsappChild(source,cutoff,id,{canaryConversationId:'3',canaryMessageId:'4'});
 const code=limited.nodes.find(n=>n.name==='Configuração').parameters.jsCode,s=new vm.Script('(async()=>{'+code+'})()');
 const call=payload=>s.runInNewContext({$input:{all:()=>[{json:{payload}}]},$execution:{id:'fixture'},require,Buffer,URL,Set,Date});
 await call({...bridge,collector_id:id});await assert.rejects(call({...bridge,collector_id:id,message_id:'9'}),/BRIDGE_INPUT_IDENTITY_INVALID/);
});
