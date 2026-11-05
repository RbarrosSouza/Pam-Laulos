import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contactReactionConfiguration, verifyContactReactionActor, prepareContactReactionTasks, verifyContactReactionGroup,
  inspectContactReactionMessages, inspectCurrentContactReactionState, classifyContactReactionEnsure, contactReactionDispatchPermission, classifyContactReactionSubmission, contactReactionDiagnostic } from './contact-reaction-runtime.mjs';

const doc = '10000000-0000-4000-8000-000000000001', delivery = '20000000-0000-4000-8000-000000000001';
const reservation = '30000000-0000-4000-8000-000000000001', token = '40000000-0000-4000-8000-000000000001', sha = 'a'.repeat(64);
const raw = { enabled: true, dryRun: false, serviceUrl: 'https://backend.example.invalid/functions/v1/exam-document-service',
  chatwootBaseUrl: 'https://support.example.invalid', accountId: 1, inboxId: 2, conversationId: 3, groupJid: '123456@g.us',
  expectedActorId: 1, emoji: '✅', maxMessagePages: 20, worker: 'synthetic-reaction', diagnosticTarget: null };
const cfg = verifyContactReactionActor({ id: 1, type: 'SuperAdmin', accounts: [{ id: 1 }] }, contactReactionConfiguration(raw, { id: 'run1' }));
const task = { reaction_id: reservation, lease_token: token, document_id: doc, delivery_id: delivery, sha256: sha,
  destination_key: cfg.destinationKey, external_message_id: '1498', actor_id: 1, emoji: '✅' };
const context = () => prepareContactReactionTasks({ tasks: [task] }, cfg)[0];
const original = () => ({ id: 1498, inbox_id: 2, conversation_id: 3, message_type: 1, private: false, status: 'delivered', source_id: 'original-wa-id',
  content: 'Exame sintético de teste', content_attributes: { pamvet_exam_document_id: doc, pamvet_exam_delivery_id: delivery, pamvet_exam_sha256: sha },
  attachments: [{ id: 901, file_type: 'file' }] });
const reaction = (extra = {}) => ({ id: 1510, inbox_id: 2, conversation_id: 3, message_type: 1, private: false, status: 'sent', source_id: 'reaction-wa-id',
  content: '✅', sender: { id: 1, type: 'user' }, content_attributes: { is_reaction: true, in_reply_to: 1498, in_reply_to_external_id: 'original-wa-id' }, attachments: [], ...extra });
const pages = (...messages) => [{ payload: messages }, { payload: [] }];

const providerState=(events=[],patch={})=>({contract:'pamvet_check_v1',complete:true,evidence_complete:true,actor_id:1,
 scope:{account_id:1,inbox_id:2,conversation_id:3,message_id:1498,group_jid:'123456@g.us'},
 original:{...original(),content:undefined,content_sha256:'b'.repeat(64),legacy_reference:null},own_reactions:events.map(e=>({parent_identity_valid:true,invalid_emoji:false,own_scope:e.sender?.id===1&&e.sender?.type==='user'?'actor':'other_support',same_account_echo:false,...e})),
 current_own_reaction_id:events.find(e=>e.content&&!e.content_attributes?.deleted)?.id??null,...patch});
const inspect = (messages, c = context(), after = false) => inspectContactReactionMessages(messages, c, cfg, after);

test('configuration, credential actor and worker identity are verified before a task can exist', () => {
  assert.equal(cfg.verifiedActorId, 1); assert.equal(context().scan_after, '1497');
  for (const patch of [{ enabled: false }, { expectedActorId: null }, { maxMessagePages: 21 }, { emoji: '👍' }, { chatwootBaseUrl: 'http://support.invalid' },
    { worker: 'a'.repeat(95) }, { diagnosticTarget: task }]) assert.throws(() => contactReactionConfiguration({ ...raw, ...patch }, { id: 'run' }));
  assert.throws(() => verifyContactReactionActor({ id: 2 }, cfg), /ACTOR_MISMATCH/);
  assert.throws(() => verifyContactReactionActor({ id: 1, accounts: [{ id: 4 }] }, cfg), /ACCOUNT_MISMATCH/);
  for (const patch of [{ actor_id: 2 }, { destination_key: 'other' }, { sha256: 'bad' }, { emoji: '👍' }, { external_message_id: '../x' }, { lease_token: null }])
    assert.throws(() => prepareContactReactionTasks({ tasks: [{ ...task, ...patch }] }, cfg));
  assert.throws(() => prepareContactReactionTasks({ tasks: [task, task] }, cfg), /TASK_LIMIT/);
  assert.equal(prepareContactReactionTasks({ tasks: [{ ...task, external_message_id: '9999999999999999999' }] }, cfg)[0].scan_after, '9999999999999999998');
});

test('new and reconciliation claims are disjoint; reconciliation has a separate token and never an old dispatch lease', () => {
  assert.throws(()=>prepareContactReactionTasks({tasks:[task],reconcile_tasks:[task]},cfg),/NEW_QUEUE/);
  for(const patch of [{reconcile_only:true},{submit_started_at:'2026-10-01T00:00:00Z'},{status:'submitted'},{status:'held'}])
    assert.throws(()=>prepareContactReactionTasks({tasks:[{...task,...patch}]},cfg),/RESERVATION_INVALID/);
  const rcfg={...cfg,lane:'reconcile'},rtask={...task,reconcile_token:token,reconcile_only:true};delete rtask.lease_token;
  assert.equal(prepareContactReactionTasks({tasks:[rtask]},rcfg)[0].reconcile_only,true);
  assert.throws(()=>prepareContactReactionTasks({tasks:[{...rtask,lease_token:token}]},rcfg),/RESERVATION_INVALID/);
});

test('complete targeted provider state retains mutable old rows and checks budget and lease before a new grant', () => {
 const c={...context(),lease_until:new Date(Date.now()+120000).toISOString()};
 const read=(state,ctx=c,now=Date.now())=>inspectCurrentContactReactionState(state,ctx,cfg,now);
 const clear=read(providerState());assert.equal(clear.postRequired,true);assert.equal(clear.providerStateVerified,true);
 assert.equal(clear.ensure_expected.content_sha256,'b'.repeat(64));assert.deepEqual(clear.ensure_expected.attachment_ids,[901]);
 assert.equal(read(providerState([reaction({id:1490})])).outcome.status,'already_present');
 const removed=reaction({id:1490,content:'',content_attributes:{...reaction().content_attributes,deleted:true}});
 assert.equal(read(providerState([removed])).postRequired,false);
 assert.equal(read(providerState([reaction({content:'👍'})])).postRequired,false);
 assert.equal(read(providerState([removed]),{...c,scan_after:'9999',dispatch_scan_state:{after:'9999'}}).postRequired,false);
 assert.equal(read(providerState(),c,cfg.tickStartedAt+50001).outcome.error_code,'REACTION_PREFLIGHT_BUDGET_EXHAUSTED');
 assert.equal(read(providerState(),{...c,lease_until:new Date(Date.now()+1000).toISOString()}).outcome.error_code,'REACTION_LEASE_TOO_SHORT');
 const own=read(providerState([reaction()]));assert.equal(own.outcome.evidence_complete,true);assert.equal(own.outcome.provider_contract,'pamvet_check_v1');
});

test('wrong contract, incomplete evidence or mismatched scope cannot confirm or authorize ensure',()=>{
 const c={...context(),lease_until:new Date(Date.now()+120000).toISOString()};
 for(const patch of [{contract:'legacy'},{complete:false},{evidence_complete:false},{actor_id:2},{scope:{...providerState().scope,message_id:999}},
 {scope:{...providerState().scope,group_jid:'other@g.us'}},{original:{...providerState().original,content_sha256:'bad'}},{own_reactions:{}}]){
  const r=inspectCurrentContactReactionState(providerState([reaction()],patch),c,cfg);assert.equal(r.postRequired,false);assert.equal(r.outcome.own_reaction_verified,undefined);
 }
 for(const value of [{error:'unavailable'},[],null,{statusCode:404,body:{}}]) assert.equal(inspectCurrentContactReactionState(value,c,cfg).postRequired,false);
 for(const patch of [{parent_identity_valid:false},{invalid_emoji:true}]){const r=inspectCurrentContactReactionState(providerState([reaction(patch),reaction({id:1511})]),c,cfg);assert.equal(r.outcome.own_reaction_verified,undefined);assert.equal(r.postRequired,false);}
 const wrongParent=reaction({content_attributes:{is_reaction:true,in_reply_to:999}});
 assert.equal(inspectCurrentContactReactionState(providerState([wrongParent]),c,cfg).outcome.error_code,'REACTION_PARENT_IDENTITY_MISMATCH');
});

test('reconciliation only hands a never-started held target back after complete current absence',()=>{
 const c={...context(),reconcile_only:true,status:'held',submit_started_at:null};
 const r=inspectCurrentContactReactionState(providerState(),c,cfg);assert.equal(r.outcome.status,'pre_dispatch_ready');assert.equal(r.postRequired,false);
 for(const key of ['document_id','delivery_id','destination_key','sha256'])assert.equal(r.outcome[key],c[key]);
 assert.equal(r.outcome.own_reaction_absent,true);assert.equal(r.outcome.provider_state,'absent');
 for(const patch of [{status:'submitted'},{submit_started_at:'2026-10-01T00:00:00Z'},{submit_started_at:undefined}])
  assert.notEqual(inspectCurrentContactReactionState(providerState(),{...c,...patch},cfg).outcome.status,'pre_dispatch_ready');
 for(const event of [reaction({content:'👍'}),reaction({source_id:null}),reaction({content:'',content_attributes:{...reaction().content_attributes,deleted:true}})])
  assert.notEqual(inspectCurrentContactReactionState(providerState([event]),c,cfg).outcome.status,'pre_dispatch_ready');
});

test('dedicated atomic ensure treats a racing check as no-op, other choice as held and unknown acknowledgments as uncertain',()=>{
 const c={...context(),lease_until:new Date(Date.now()+120000).toISOString()};
 const pre=inspectCurrentContactReactionState(providerState(),c,cfg);
 const grant=contactReactionDispatchPermission({dispatch_allowed:true,reaction_id:reservation},pre,cfg);
 const ensure=(action,code,events,performed)=>classifyContactReactionEnsure({statusCode:code,body:providerState(events,{action,dispatch_performed:performed})},grant,cfg);
 assert.equal(ensure('created',201,[reaction({source_id:null})],true).outcome.status,'submitted');
 assert.equal(ensure('already_present',200,[reaction()],false).outcome.status,'already_present');
 assert.equal(ensure('held',409,[reaction({content:'👍'})],false).outcome.status,'uncertain');
 assert.equal(ensure('already_present',200,[reaction({source_id:null})],false).outcome.status,'uncertain');
 for(const response of [{error:'lost ACK'},{statusCode:404,body:{}},{statusCode:200,body:'not JSON'}])
  assert.equal(classifyContactReactionEnsure(response,grant,cfg).outcome.status,'uncertain');
 assert.throws(()=>classifyContactReactionEnsure({statusCode:201}, {...grant,reconcile_only:true},cfg),/WITHOUT_PERMISSION/);
});

test('only the complete provider-scoped own-number echo is equivalent to the authenticated actor',()=>{
 const c={...context(),reconcile_only:true};
 const echo=reaction({sender:null,same_account_echo:true,own_scope:'same_account_echo'});
 const verified=inspectCurrentContactReactionState(providerState([echo]),c,cfg);
 assert.equal(verified.outcome.status,'already_present');assert.equal(verified.outcome.own_reaction_verified,true);
 for(const patch of [{same_account_echo:false},{own_scope:'other_support'},{sender:{id:2,type:'user'}},{source_id:null},{status:'pending'},{parent_identity_valid:false}]){
  const held=inspectCurrentContactReactionState(providerState([{...echo,...patch}]),c,cfg);assert.equal(held.postRequired,false);assert.equal(held.outcome.own_reaction_verified,undefined);
 }
 const other=reaction({sender:{id:2,type:'user'},own_scope:'other_support',same_account_echo:false,content:'👍'});
 assert.equal(inspectCurrentContactReactionState(providerState([other]),c,cfg).outcome.error_code,'REACTION_EXISTING_SUPPORT_CHOICE');
});

test('the real Ruby serializer contract maps actor and own-number checks while preserving another operator and removal',()=>{
 const bundle=JSON.parse(readFileSync(new URL('./chatwoot-reaction-guard/contract-fixtures.json',import.meta.url),'utf8'));
 assert.equal(bundle.synthetic_only,true);assert.equal(bundle.contract,'pamvet_check_v1');
 for(const fixture of bundle.fixtures){
  const scope=fixture.body.scope;
  const currentCfg=verifyContactReactionActor({id:1,accounts:[{id:1}]},contactReactionConfiguration({...raw,groupJid:scope.group_jid},{id:'ruby-adapter'}));
  const current={...context(),...fixture.context,destination_key:currentCfg.destinationKey,reconcile_only:true};
  const result=inspectCurrentContactReactionState({statusCode:fixture.http_status,body:JSON.stringify(fixture.body)},current,currentCfg);
  assert.equal(result.postRequired,false,fixture.name);
  if(fixture.expected_consumer==='own_check_proven'){
   assert.equal(result.outcome.status,'already_present',fixture.name);assert.equal(result.outcome.own_reaction_verified,true,fixture.name);
  }else{
   assert.equal(result.outcome.status,'uncertain',fixture.name);assert.equal(result.outcome.own_reaction_verified,undefined,fixture.name);
   assert.equal(result.outcome.error_code,fixture.name==='removed_check'?'REACTION_PREVIOUS_SUPPORT_REMOVAL':'REACTION_EXISTING_SUPPORT_CHOICE',fixture.name);
  }
 }
});

test('group identity requires the actual exact conversation, inbox, JID and authenticated actor', () => {
  const group = { id: 3, inbox_id: 2, meta: { sender: { identifier: '123456@g.us' } } };
  assert.equal(verifyContactReactionGroup(group, context(), cfg).document_id, doc);
  for (const patch of [{ id: 4 }, { inbox_id: 5 }, { meta: { sender: { identifier: '999@g.us' } } }]) assert.throws(() => verifyContactReactionGroup({ ...group, ...patch }, context(), cfg));
});

test('complete forward scan proves the original before allowing a new toggle; a short page is not completion', () => {
  const result = inspect(pages(original())); assert.equal(result.postRequired, true); assert.equal(result.verifiedOriginal, true);
  assert.equal(inspect([{ payload: [original()] }]).postRequired, false);
  assert.equal(inspect([{ payload: [original()] }]).outcome.error_code, 'REACTION_MESSAGE_SCAN_INCOMPLETE');
  const late = inspect([{ payload: [original()] }, { payload: [reaction()] }, { payload: [] }]);
  assert.equal(late.postRequired, false); assert.equal(late.outcome.status, 'already_present');
  assert.equal(late.outcome.own_reaction_verified, true); assert.equal(late.observedProviderStatus, 'sent');
});

test('missing original proof, wrong correlation, deleted rows or another destination hold without POST', () => {
  for (const patch of [{ private: true }, { message_type: 0 }, { source_id: '' }, { status: 'failed' }, { status: 'pending' }, { attachments: [] },
    { inbox_id: 9 }, { content_attributes: { pamvet_exam_document_id: doc } }, { content_attributes: { ...original().content_attributes, deleted: true } },
    { content_attributes: { ...original().content_attributes, is_reaction: true } }]) {
    const result = inspect(pages({ ...original(), ...patch })); assert.equal(result.postRequired, false); assert.equal(result.outcome.status, 'uncertain');
  }
  const legacy = original(); legacy.content_attributes = {}; legacy.content += `\n[EXAM:${doc}:DELIVERY:${delivery}]`;
  assert.equal(inspect(pages(legacy)).postRequired, true);
  legacy.content += ' trailing'; assert.equal(inspect(pages(legacy)).postRequired, false);
});

test('pagination fails closed for repeated/reversed IDs, more than twenty pages, missing terminal empty or pages after completion', () => {
  for (const list of [pages(original(), original()), pages(reaction(), original()), [{ payload: [] }, { payload: [original()] }],
    [{ payload: [original()] }, ...Array.from({ length: 20 }, () => ({ payload: [] }))]]) {
    const result = inspect(list); assert.equal(result.postRequired, false); assert.equal(result.outcome.status, 'uncertain');
  }
});

test('only our explicit sent checkmark is already present; contact reactions are preserved but do not impersonate us', () => {
  const own = inspect(pages(original(), reaction())); assert.equal(own.outcome.status, 'already_present'); assert.equal(own.postRequired, false);
  const participant = reaction({ message_type: 0, sender: { id: 1, type: 'contact' } });
  assert.equal(inspect(pages(original(), participant)).postRequired, true);
  for (const patch of [{ sender: null }, { sender: { id: 2, type: 'user' } }, { content: '👍' }, { content: '' }, { status: 'failed' }, { status: 'pending' }, { source_id: null }]) {
    const r = inspect(pages(original(), reaction(patch))); assert.equal(r.postRequired, false); assert.equal(r.outcome.status, 'uncertain'); assert.equal(r.outcome.own_reaction_verified, undefined);
  }
  assert.equal(inspect(pages(original(), reaction(), reaction({ id: 1511 }))).postRequired, false);
});

test('internal and provider parent identities are supported; contradictory parents cannot authorize a toggle', () => {
  for (const fields of [{ is_reaction: true, in_reply_to: 1498 }, { is_reaction: true, in_reply_to_external_id: 'original-wa-id' }])
    assert.equal(inspect(pages(original(), reaction({ content_attributes: fields }))).outcome.status, 'already_present');
  const r = inspect(pages(original(), reaction({ content_attributes: { is_reaction: true, in_reply_to: 999, in_reply_to_external_id: 'original-wa-id' } })));
  assert.equal(r.outcome.error_code, 'REACTION_PARENT_IDENTITY_MISMATCH'); assert.equal(r.postRequired, false);
});

test('read-only diagnostics and reconciliation never authorize a POST even when our check is absent', () => {
  const read = inspect(pages(original()), { ...context(), readOnly: true }); assert.equal(read.postRequired, false);
  const safe = contactReactionDiagnostic(read); assert.equal(safe.target_verified, true); assert.equal(safe.post_permitted, false); assert.equal(safe.content, undefined);
  const reconciled = inspect(pages(original()), { ...context(), reconcile_only: true }); assert.equal(reconciled.postRequired, false);
  assert.equal(reconciled.outcome.error_code, 'REACTION_NOT_OBSERVED_NO_RETRY');
});

test('a durable unique grant is required, HTTP 2xx is only submitted, canonical GET confirms provider evidence without changing original', () => {
  const before = inspectCurrentContactReactionState(providerState(),{...context(),lease_until:new Date(Date.now()+120000).toISOString()},cfg);
  const granted = contactReactionDispatchPermission({ dispatch_allowed: true, reaction_id: reservation, external_message_id: '1498' }, before, cfg);
  assert.equal(granted.dispatch_allowed, true);
  assert.equal(contactReactionDispatchPermission({ dispatch_allowed: false }, before, cfg).postRequired, false);
  assert.throws(() => contactReactionDispatchPermission({ dispatch_allowed: true, reaction_id: reservation }, { ...before, reconcile_only: true }, cfg));
  assert.throws(() => classifyContactReactionSubmission({ statusCode: 200 }, before), /WITHOUT_PERMISSION/);
  assert.equal(classifyContactReactionSubmission({ statusCode: 200 }, granted).outcome.status, 'submitted');
  assert.equal(classifyContactReactionSubmission({ error: 'lost response' }, granted).outcome.status, 'uncertain');
  const originalState=()=>providerState([reaction()]);
  assert.equal(inspectCurrentContactReactionState(originalState(),{...granted,reconcile_only:true},cfg).outcome.status,'already_present');
  const changed=originalState();changed.original.content_sha256='c'.repeat(64);
  assert.equal(classifyContactReactionEnsure({statusCode:201,body:{...changed,action:'created',dispatch_performed:true}},granted,cfg).outcome.status,'uncertain');
  const removed=originalState();removed.original.attachments=[];
  assert.equal(inspectCurrentContactReactionState(removed,{...granted,reconcile_only:true},cfg).outcome.own_reaction_verified,undefined);
  assert.equal(inspectCurrentContactReactionState(providerState(),{...granted,reconcile_only:true},cfg).outcome.error_code,'REACTION_NOT_OBSERVED_NO_RETRY');
});
