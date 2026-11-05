// Pure OP07 guards. New writes use the dedicated atomic ensure contract once;
// uncertain submissions are reconciled by GET and never sent again.
const REACTION_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const REACTION_SHA = /^[a-f0-9]{64}$/i;
function reactionObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function reactionFail(code) { throw new Error(code); }
function reactionBody(value) {
  const body = reactionObject(value?.body) ? value.body : value;
  if (!reactionObject(body) || body.error || body.success === false) reactionFail('REACTION_API_RESPONSE_INVALID');
  return body;
}
function contactReactionHttpBody(value) {
  if (!reactionObject(value)) reactionFail('REACTION_TRANSPORT_FAILED');
  if (value.error) {
    const message=String(value.error?.message || value.error || '');
    reactionFail(/timed?\s*out|timeout|ETIMEDOUT/i.test(message)?'REACTION_HTTP_TIMEOUT':'REACTION_TRANSPORT_FAILED');
  }
  const status=Number(value.statusCode || 0);
  if(status===429)reactionFail('REACTION_HTTP_429');
  if(status>=500)reactionFail('REACTION_HTTP_5XX');
  if(typeof value.body==='string'){
    try{value={...value,body:JSON.parse(value.body)};}catch{reactionFail('REACTION_API_RESPONSE_INVALID');}
    if(!reactionObject(value.body))reactionFail('REACTION_API_RESPONSE_INVALID');
  }
  if(status>=400 || status!==0 && (status<200 || status>=300)) {
    const body=reactionObject(value.body)?value.body:null;
    if(body?.contract==='pamvet_check_v1' && body.error_code==='PAMVET_CHECK_REMOVED_CHOICE')reactionFail('REACTION_PREVIOUS_SUPPORT_REMOVAL');
    if(body?.contract==='pamvet_check_v1' && body.error_code==='PAMVET_CHECK_EXISTING_CHOICE')reactionFail('REACTION_EXISTING_SUPPORT_CHOICE');
    reactionFail('REACTION_HTTP_4XX');
  }
  return reactionBody(value);
}
function reactionId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)) return value;
  reactionFail('REACTION_MESSAGE_ID_INVALID');
}
function compareReactionId(a, b) { return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0); }
function previousReactionId(value) {
  const digits = reactionId(value).split('');
  for (let index = digits.length - 1; index >= 0; index--) {
    if (digits[index] !== '0') { digits[index] = String(Number(digits[index]) - 1); break; }
    digits[index] = '9';
  }
  return digits.join('').replace(/^0+(?=[0-9])/, '');
}
function reactionOrigin(value) { return typeof value === 'string' && /^https:\/\/[a-z0-9]+(?:[.-][a-z0-9]+)*(?::443)?\/?$/i.test(value); }
function reactionOutcome(context, status, errorCode, verified = false) {
  return { ...context, postRequired: false, outcome: { status, external_message_id: context.external_message_id,
    emoji: '✅', actor_id: context.actor_id, document_id: context.document_id, delivery_id: context.delivery_id, destination_key: context.destination_key, sha256: context.sha256, ...(verified ? { own_reaction_verified: true } : {}), ...(errorCode ? { error_code: errorCode } : {}) } };
}

export function contactReactionConfiguration(raw, execution, now = Date.now()) {
  raw = { lane: 'new', providerContract: 'pamvet_check_v1', maxPreDispatchMs: 50000, minDispatchLeaseMs: 30000, ...raw };
  if (!reactionObject(raw) || raw.enabled !== true) reactionFail('EXAMES_REACAO_PAUSADA');
  if (typeof raw.dryRun !== 'boolean' || !reactionOrigin(raw.chatwootBaseUrl)
    || typeof raw.serviceUrl !== 'string' || !/^https:\/\/[a-z0-9]+(?:[.-][a-z0-9]+)*(?::443)?\/functions\/v1\/exam-document-service$/i.test(raw.serviceUrl)
    || ![raw.accountId, raw.inboxId, raw.conversationId, raw.expectedActorId].every(id => Number.isSafeInteger(id) && id > 0)
    || typeof raw.groupJid !== 'string' || !/^[0-9-]+@g\.us$/.test(raw.groupJid)
    || raw.emoji !== '✅' || raw.maxMessagePages !== 20 || typeof raw.worker !== 'string'
    || !/^[A-Za-z0-9_.:-]{1,96}$/.test(raw.worker) || !/^[A-Za-z0-9_.:-]{1,96}$/.test(String(execution?.id || ''))
    || (raw.worker + ':' + execution.id).length > 96 || !['new', 'reconcile'].includes(raw.lane)
    || raw.providerContract !== 'pamvet_check_v1' || raw.maxPreDispatchMs !== 50000 || raw.minDispatchLeaseMs !== 30000
    || !Number.isSafeInteger(now) || now <= 0) reactionFail('REACTION_CONFIGURATION_INVALID');
  if (raw.diagnosticTarget && !raw.dryRun) reactionFail('REACTION_DIAGNOSTIC_READ_ONLY');
  return { ...raw, tickStartedAt: now, worker: raw.worker + ':' + execution.id,
    destinationKey: `chatwoot:${raw.accountId}:${raw.inboxId}:${raw.conversationId}:${raw.groupJid}` };
}

export function verifyContactReactionActor(response, cfg) {
  const body = reactionBody(response);
  if (Number(body.id) !== cfg.expectedActorId) reactionFail('REACTION_CREDENTIAL_ACTOR_MISMATCH');
  if (Array.isArray(body.accounts) && !body.accounts.some(account => Number(account.id) === cfg.accountId)) reactionFail('REACTION_ACTOR_ACCOUNT_MISMATCH');
  return { ...cfg, verifiedActorId: cfg.expectedActorId };
}

export function prepareContactReactionTasks(response, cfg) {
  const body = reactionBody(response);
  if (!Array.isArray(body.tasks) || body.reconcile_tasks != null && !Array.isArray(body.reconcile_tasks)) reactionFail('REACTION_TASK_LIST_INVALID');
  if (cfg.lane === 'new' && body.reconcile_tasks?.length) reactionFail('REACTION_NEW_QUEUE_HAS_RECONCILIATIONS');
  let tasks = body.tasks;
  if (tasks.length > 1) reactionFail('REACTION_TASK_LIMIT_EXCEEDED');
  if (cfg.dryRun && cfg.diagnosticTarget) tasks = [{ ...cfg.diagnosticTarget, diagnostic_only: true, actor_id: cfg.verifiedActorId, destination_key: cfg.destinationKey }];
  const seen = new Set();
  return tasks.map(task => {
    const actor = task.actor_id ?? body.actor_id;
    if (!reactionObject(task) || task.destination_key !== cfg.destinationKey || Number(actor) !== cfg.verifiedActorId
      || !REACTION_UUID.test(task.document_id || '') || !REACTION_UUID.test(task.delivery_id || '') || !REACTION_SHA.test(task.sha256 || '')
      || task.emoji != null && task.emoji !== '✅') reactionFail('REACTION_TASK_IDENTITY_MISMATCH');
    const external = reactionId(task.external_message_id);
    if (seen.has(external)) reactionFail('REACTION_DUPLICATE_TARGET');
    seen.add(external);
    if (!cfg.dryRun && (!REACTION_UUID.test(task.reaction_id || '') || (cfg.lane === 'reconcile'
      ? !REACTION_UUID.test(task.reconcile_token || '') || task.lease_token != null || task.reconcile_only !== true
      : !REACTION_UUID.test(task.lease_token || '') || task.reconcile_only === true || task.submit_started_at != null
        || ['submitted', 'uncertain', 'held', 'confirmed'].includes(task.status)))) reactionFail('REACTION_RESERVATION_INVALID');
    return { ...task, external_message_id: external, actor_id: cfg.verifiedActorId, emoji: '✅', scan_after: previousReactionId(external),
      readOnly: cfg.dryRun, postRequired: false, reconcile_only: cfg.lane === 'reconcile', available: true };
  });
}

export function verifyContactReactionGroup(response, context, cfg) {
  const body = reactionBody(response), sender = body.meta?.sender || body.contact || {};
  const jid = sender.identifier || body.contact_inbox?.source_id || sender.additional_attributes?.jid;
  if (Number(body.id) !== cfg.conversationId || Number(body.inbox_id) !== cfg.inboxId || jid !== cfg.groupJid
    || context.destination_key !== cfg.destinationKey || context.actor_id !== cfg.verifiedActorId) reactionFail('REACTION_GROUP_IDENTITY_MISMATCH');
  return context;
}
export function prepareContactReactionGroup(response,context,cfg) {
  try {return {...verifyContactReactionGroup(contactReactionHttpBody(response),context,cfg),verifiedGroup:true};}
  catch(error) {
    const code=error instanceof Error && /^REACTION_[A-Z0-9_]+$/.test(error.message)?error.message:'REACTION_GET_FAILED';
    return reactionOutcome(context,context.reconcile_only?'uncertain':'failed',code);
  }
}

function canonicalContactReactionMessages(pages, context, cfg) {
  if (!Array.isArray(pages) || !pages.length || pages.length > cfg.maxMessagePages) reactionFail('REACTION_MESSAGE_SCAN_INCOMPLETE');
  const list = [], seen = new Set(); let last = context.scan_after, complete = false;
  for (const page of pages) {
    const body = reactionBody(page), messages = body.payload || body.messages;
    if (!Array.isArray(messages) || complete) reactionFail('REACTION_MESSAGE_PAGE_INVALID');
    if (!messages.length) { complete = true; continue; }
    for (const message of messages) {
      if (!reactionObject(message)) reactionFail('REACTION_MESSAGE_INVALID');
      const id = reactionId(message.id);
      if (seen.has(id) || compareReactionId(id, last) <= 0) reactionFail('REACTION_MESSAGE_ORDER_INVALID');
      seen.add(id); last = id;
      if (message.inbox_id != null && Number(message.inbox_id) !== cfg.inboxId
        || message.conversation_id != null && Number(message.conversation_id) !== cfg.conversationId
        || message.account_id != null && Number(message.account_id) !== cfg.accountId) reactionFail('REACTION_MESSAGE_DESTINATION_MISMATCH');
      list.push(message);
    }
  }
  if (!complete) reactionFail('REACTION_MESSAGE_SCAN_INCOMPLETE');
  return list;
}

export function inspectContactReactionMessages(pages, context, cfg, afterPost = false) {
  try {
    const list = canonicalContactReactionMessages(pages, context, cfg);
    const message = list.find(item => reactionId(item.id) === context.external_message_id);
    if (!message || message.private !== false || ![1, 'outgoing'].includes(message.message_type)
      || typeof message.source_id !== 'string' || !message.source_id.trim() || !['sent', 'delivered', 'read'].includes(message.status)
      || !Array.isArray(message.attachments) || !message.attachments.some(item => item.file_type === 'file')) reactionFail('REACTION_ORIGINAL_MESSAGE_UNPROVEN');
    const attributes = message.content_attributes || {};
    const tagged = attributes.pamvet_exam_document_id === context.document_id && attributes.pamvet_exam_delivery_id === context.delivery_id
      && attributes.pamvet_exam_sha256 === context.sha256;
    const anyTag = ['pamvet_exam_document_id', 'pamvet_exam_delivery_id', 'pamvet_exam_sha256'].some(key => Object.hasOwn(attributes, key));
    const legacy = !anyTag && typeof message.content === 'string'
      && message.content.trim().endsWith(`[EXAM:${context.document_id}:DELIVERY:${context.delivery_id}]`);
    if (!tagged && !legacy || attributes.deleted === true || attributes.is_reaction === true) reactionFail('REACTION_ORIGINAL_CORRELATION_MISMATCH');
    if (afterPost && (context.originalContent !== message.content
      || JSON.stringify(context.originalAttachmentIds) !== JSON.stringify(message.attachments.map(item => reactionId(item.id))))) reactionFail('REACTION_ORIGINAL_CHANGED');
    let own = null, unsafe = false, previousRemoval = false, ownProviderStatus = null;
    for (const event of list) {
      const fields = event.content_attributes || {};
      if (fields.is_reaction !== true) continue;
      const internal = fields.in_reply_to != null && String(fields.in_reply_to) === context.external_message_id;
      const external = fields.in_reply_to_external_id != null && typeof message.source_id === 'string' && fields.in_reply_to_external_id === message.source_id;
      if (!internal && !external) continue;
      if (fields.in_reply_to != null && !internal || fields.in_reply_to_external_id != null && !external) reactionFail('REACTION_PARENT_IDENTITY_MISMATCH');
      const outgoing = [1, 'outgoing'].includes(event.message_type);
      if (!outgoing) continue; // A participant's reaction is not the authenticated support user's choice.
      // Removed reactions are mutable rows, not absent history. Never resurrect a manual removal.
      if (fields.deleted === true) { unsafe = true; previousRemoval = true; continue; }
      const sender = event.sender;
      if (!reactionObject(sender) || Number(sender.id) !== context.actor_id || String(sender.type).toLowerCase() !== 'user') { unsafe = true; continue; }
      const emoji = typeof event.content === 'string' ? event.content.normalize('NFC').replace(/\ufe0f/g, '').trim() : '';
      if (!emoji || own !== null) { unsafe = true; continue; }
      own = emoji;
      ownProviderStatus = event.status;
      if (typeof event.source_id !== 'string' || !event.source_id.trim() || !['sent', 'delivered', 'read'].includes(event.status)) unsafe = true;
    }
    if (unsafe || own !== null && own !== '✅') return reactionOutcome(context, 'uncertain', previousRemoval ? 'REACTION_PREVIOUS_SUPPORT_REMOVAL' : 'REACTION_EXISTING_SUPPORT_CHOICE');
    if (own === '✅') return { ...reactionOutcome(context, afterPost ? 'confirmed' : 'already_present', null, true), observedProviderStatus: ownProviderStatus };
    if (afterPost || context.reconcile_only) return reactionOutcome(context, 'uncertain', 'REACTION_NOT_OBSERVED_NO_RETRY');
    return { ...context, postRequired: !context.readOnly, verifiedOriginal: true, ownReactionAbsent: true,
      originalContent: typeof message.content === 'string' ? message.content : null,
      originalAttachmentIds: message.attachments.map(item => reactionId(item.id)), inspection: 'no_own_reaction' };
  } catch (error) {
    const code = error instanceof Error && /^REACTION_[A-Z0-9_]+$/.test(error.message) ? error.message : 'REACTION_READ_FAILED';
    return reactionOutcome(context, 'uncertain', code);
  }
}

// The dedicated provider contract is complete for one target and reads mutable rows now.
// Old routes/servers, partial state, unknown identities and removed choices fail closed.
function contactProviderState(response, context, cfg) {
  const body = contactReactionHttpBody(response), scope = body.scope, original = body.original;
  if (body.contract !== 'pamvet_check_v1' || body.complete !== true || body.evidence_complete !== true
    || Number(body.actor_id) !== cfg.verifiedActorId || !reactionObject(scope) || !reactionObject(original)
    || Number(scope.account_id) !== cfg.accountId || Number(scope.inbox_id) !== cfg.inboxId
    || Number(scope.conversation_id) !== cfg.conversationId || reactionId(scope.message_id) !== context.external_message_id
    || scope.group_jid !== cfg.groupJid || reactionId(original.id) !== context.external_message_id
    || !REACTION_SHA.test(original.content_sha256 || '') || !Array.isArray(body.own_reactions)
    || body.own_reactions.length > 100 || !Object.hasOwn(body,'current_own_reaction_id')) reactionFail('REACTION_PROVIDER_CONTRACT_INVALID');
  const reference = `[EXAM:${context.document_id}:DELIVERY:${context.delivery_id}]`;
  const target = {...original, content:original.legacy_reference===reference?reference:''};
  const proof=inspectContactReactionMessages([{payload:[target]},{payload:[]}],{...context,scan_after:'0',readOnly:true,reconcile_only:false},cfg);
  if (proof.verifiedOriginal!==true) reactionFail(proof.outcome?.error_code || 'REACTION_ORIGINAL_MESSAGE_UNPROVEN');
  const events=[];
  for (const event of body.own_reactions) {
    if (!reactionObject(event) || event.private !== false || event.invalid_emoji !== false) reactionFail('REACTION_PROVIDER_CONTRACT_INVALID');
    if(event.parent_identity_valid !== true)reactionFail('REACTION_PARENT_IDENTITY_MISMATCH');
    const f=event.content_attributes || {}, internal=f.in_reply_to!=null && String(f.in_reply_to)===context.external_message_id;
    const external=f.in_reply_to_external_id!=null && f.in_reply_to_external_id===original.source_id;
    if (f.is_reaction!==true || (!internal&&!external) || f.in_reply_to!=null&&!internal || f.in_reply_to_external_id!=null&&!external)
      reactionFail('REACTION_PARENT_IDENTITY_MISMATCH');
    if(!['actor','same_account_echo','other_support'].includes(event.own_scope))reactionFail('REACTION_PROVIDER_CONTRACT_INVALID');
    const actor=reactionObject(event.sender) && Number(event.sender.id)===cfg.verifiedActorId && String(event.sender.type).toLowerCase()==='user';
    if(event.own_scope==='actor' && (!actor || event.same_account_echo!==false)
      || event.own_scope==='other_support' && (actor || event.same_account_echo!==false))reactionFail('REACTION_PROVIDER_CONTRACT_INVALID');
    const echo=event.own_scope==='same_account_echo' && event.same_account_echo===true && event.sender==null && [1,'outgoing'].includes(event.message_type);
    if(event.own_scope==='same_account_echo'&&!echo)reactionFail('REACTION_PROVIDER_CONTRACT_INVALID');
    events.push(echo && typeof event.source_id==='string' && event.source_id.trim() && ['sent','delivered','read'].includes(event.status)
      ? {...event,sender:{id:cfg.verifiedActorId,type:'user'}} : event);
  }
  if (body.current_own_reaction_id!==null && !body.own_reactions.some(e=>reactionId(e.id)===reactionId(body.current_own_reaction_id)))
    reactionFail('REACTION_PROVIDER_CONTRACT_INVALID');
  const sorted=[target,...events].sort((a,b)=>compareReactionId(reactionId(a.id),reactionId(b.id)));
  return {body,target,sorted};
}

function contactProviderEvidence(context,status,errorCode,verified=false) {
  const result=reactionOutcome(context,status,errorCode,verified);
  result.outcome.provider_contract='pamvet_check_v1';result.outcome.evidence_complete=true;
  return result;
}

export function inspectCurrentContactReactionState(response,context,cfg,now=Date.now()) {
  try {
    const {body,target,sorted}=contactProviderState(response,context,cfg);
    const result=inspectContactReactionMessages([{payload:sorted},{payload:[]}],{...context,scan_after:'0'},cfg);
    if (result.outcome?.own_reaction_verified===true) {
      result.outcome.provider_contract='pamvet_check_v1';result.outcome.evidence_complete=true;return result;
    }
    if (context.reconcile_only && result.outcome?.error_code==='REACTION_NOT_OBSERVED_NO_RETRY'
      && context.status==='held' && Object.hasOwn(context,'submit_started_at') && context.submit_started_at===null
      && body.own_reactions.length===0) {
      const handoff=contactProviderEvidence(context,'pre_dispatch_ready',null);
      handoff.outcome.own_reaction_absent=true;handoff.outcome.provider_state='absent';return handoff;
    }
    if (!result.postRequired) return result;
    if (now-cfg.tickStartedAt>cfg.maxPreDispatchMs || now<cfg.tickStartedAt)
      return reactionOutcome(context,'failed','REACTION_PREFLIGHT_BUDGET_EXHAUSTED');
    const lease=Date.parse(context.lease_until);
    if (!Number.isFinite(lease) || lease-now<cfg.minDispatchLeaseMs) return reactionOutcome(context,'failed','REACTION_LEASE_TOO_SHORT');
    return {...result,providerStateVerified:true,provider_contract:'pamvet_check_v1',ensure_expected:{
      account_id:cfg.accountId,inbox_id:cfg.inboxId,conversation_id:cfg.conversationId,message_id:body.scope.message_id,
      actor_id:cfg.verifiedActorId,group_jid:cfg.groupJid,document_id:context.document_id,delivery_id:context.delivery_id,sha256:context.sha256,
      source_id:target.source_id,content_sha256:target.content_sha256,attachment_ids:target.attachments.map(a=>a.id)}};
  } catch(error) {
    const code=error instanceof Error && /^REACTION_[A-Z0-9_]+$/.test(error.message)?error.message:'REACTION_GET_FAILED';
    return reactionOutcome(context,context.reconcile_only?'uncertain':'failed',code);
  }
}

export function classifyContactReactionEnsure(response,context,cfg) {
  if (!context.dispatch_allowed || context.readOnly || context.reconcile_only || !context.providerStateVerified)
    reactionFail('REACTION_POST_WITHOUT_PERMISSION');
  try {
    const status=Number(response?.statusCode || 0);
    const payload=typeof response?.body==='string'?JSON.parse(response.body):response?.body;
    if(status===409 && payload?.contract==='pamvet_check_v1' && payload.action==='held' && payload.dispatch_performed===false)
      return reactionOutcome(context,'uncertain',payload.error_code==='PAMVET_CHECK_REMOVED_CHOICE'?'REACTION_PREVIOUS_SUPPORT_REMOVAL':payload.error_code==='PAMVET_CHECK_EXISTING_CHOICE'?'REACTION_EXISTING_SUPPORT_CHOICE':'REACTION_PROVIDER_HELD');
    const {body}=contactProviderState(payload,context,cfg);
    if (body.action==='created' && body.dispatch_performed===true && status===201)
      return body.original.source_id===context.ensure_expected.source_id && body.original.content_sha256===context.ensure_expected.content_sha256
        && JSON.stringify(body.original.attachments.map(a=>String(a.id)))===JSON.stringify(context.ensure_expected.attachment_ids.map(String))
        ? reactionOutcome(context,'submitted',null) : reactionOutcome(context,'uncertain','REACTION_ENSURE_RESPONSE_INVALID');
    if (body.action==='already_present' && body.dispatch_performed===false && status===200) {
      const result=inspectCurrentContactReactionState(body,{...context,reconcile_only:true},cfg);
      if (result.outcome?.own_reaction_verified===true) return result;
      return contactProviderEvidence(context,'uncertain','REACTION_PROVIDER_PRESENT_UNPROVEN');
    }
    reactionFail('REACTION_ENSURE_RESPONSE_INVALID');
  } catch { return reactionOutcome(context,'uncertain','REACTION_ENSURE_UNCERTAIN'); }
}

export function contactReactionDispatchPermission(response, context, cfg) {
  const body = reactionBody(response);
  if (body.dispatch_allowed !== true) return { ...context, postRequired: false, dispatch_allowed: false, inspection: 'dispatch_not_granted' };
  if (context.readOnly || context.reconcile_only || !context.verifiedOriginal || context.postRequired !== true
    || context.providerStateVerified !== true || context.provider_contract !== 'pamvet_check_v1'
    || body.reaction_id !== context.reaction_id || body.external_message_id != null && String(body.external_message_id) !== context.external_message_id
    || context.actor_id !== cfg.verifiedActorId) reactionFail('REACTION_DISPATCH_PERMISSION_INVALID');
  return { ...context, dispatch_allowed: true, postRequired: true };
}

export function classifyContactReactionSubmission(response, context) {
  if (!context.dispatch_allowed || context.readOnly || context.reconcile_only) reactionFail('REACTION_POST_WITHOUT_PERMISSION');
  const status = Number(response?.statusCode || 0);
  return reactionOutcome(context, status >= 200 && status < 300 ? 'submitted' : 'uncertain', status >= 200 && status < 300 ? null : 'REACTION_POST_UNCERTAIN');
}

export function contactReactionDiagnostic(context) {
  return { read_only: true, post_permitted: false, diagnostic_only: !!context.diagnostic_only, target_verified: context.verifiedOriginal === true || context.outcome?.own_reaction_verified === true,
    own_check_present: context.outcome?.own_reaction_verified === true, provider_status: context.observedProviderStatus || null,
    inspection: context.outcome?.error_code || context.outcome?.status || context.inspection || 'empty' };
}
