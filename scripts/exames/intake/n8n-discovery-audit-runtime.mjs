import crypto from 'node:crypto';

const auditHash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const auditClone = value => JSON.parse(JSON.stringify(value));
const auditObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const auditId = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\x00-\x1f\x7f]/.test(value);
const auditUuid = value => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
const auditNumericId = value => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));

export function validateAuditConfig(cfg, executionMode) {
  if (!cfg.enabled) throw new Error('INTAKE_AUDIT_DISABLED');
  if (!cfg.allowScheduled && !['test', 'manual'].includes(executionMode)) throw new Error('INTAKE_AUDIT_MANUAL_REVIEW_ONLY');
  if (!['gmail', 'chatwoot'].includes(cfg.provider) || !auditId(cfg.collectorId) || !/^[A-Za-z0-9_-]{8,80}$/.test(cfg.dataTableId)
    || !/^https:\/\/[a-z\d.-]+\/functions\/v1\/exam-document-service$/i.test(cfg.serviceUrl)
    || !Number.isFinite(Date.parse(cfg.intakeCutoff)) || !Number.isSafeInteger(cfg.maxActions) || cfg.maxActions < 1 || cfg.maxActions > 200
    || cfg.monitoring !== false || !Number.isSafeInteger(cfg.auditLookbackSeconds) || cfg.auditLookbackSeconds < 60 || cfg.auditLookbackSeconds > 86400
    || cfg.leaseMillis !== 900000 || cfg.maxMillis !== 180000) throw new Error('INTAKE_AUDIT_CONFIG_INVALID');
  if (cfg.provider === 'gmail' && (typeof cfg.mailbox !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(cfg.mailbox))) throw new Error('INTAKE_AUDIT_MAILBOX_INVALID');
  if (cfg.provider === 'chatwoot' && (!/^https:\/\/[a-z\d.-]+$/i.test(cfg.chatwootBaseUrl) || !auditNumericId(cfg.accountId) || !auditNumericId(cfg.inboxId))) throw new Error('INTAKE_AUDIT_CHATWOOT_INVALID');
  if (cfg.continuous === true && (cfg.provider !== 'gmail' || cfg.overlapSeconds !== 300 || cfg.maxRepeatedFailures !== 3 || cfg.notificationMode !== 'home_only')
    || cfg.allowScheduled && cfg.continuous !== true) throw new Error('INTAKE_AUDIT_CONTINUITY_POLICY_INVALID');
  if (cfg.recheckPending === true && cfg.provider !== 'gmail') throw new Error('INTAKE_AUDIT_RECHECK_POLICY_INVALID');
  if (cfg.prospective === true && (cfg.provider !== 'gmail' || cfg.continuous !== true || cfg.includeSpamTrash !== true
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cfg.intakeCutoff)
    || new Date(cfg.intakeCutoff).toISOString() !== cfg.intakeCutoff)) throw new Error('INTAKE_AUDIT_PROSPECTIVE_POLICY_INVALID');
  if (cfg.bridgeEnabled === true && (cfg.prospective !== true || cfg.recheckPending !== true
    || typeof cfg.bridgeWorkflowId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(cfg.bridgeWorkflowId))) throw new Error('INTAKE_AUDIT_BRIDGE_POLICY_INVALID');
  if (cfg.canary === true && (cfg.bridgeEnabled !== true || cfg.allowScheduled !== false || typeof cfg.canaryMessageId!=='string'
    || !/^[a-f\d]{8,64}$/i.test(cfg.canaryMessageId))) throw new Error('INTAKE_AUDIT_CANARY_POLICY_INVALID');
  if (cfg.canaryRecheckOnly === true && cfg.canary !== true) throw new Error('INTAKE_AUDIT_CANARY_RECHECK_POLICY_INVALID');
  return cfg;
}

export function auditManifest(cfg) {
  return { provider: cfg.provider, account_id: cfg.provider === 'gmail' ? 'gmail:' + cfg.mailbox : 'chatwoot:' + cfg.accountId + ':inbox:' + cfg.inboxId,
    scope_kind: cfg.provider === 'gmail' ? 'mailbox' : 'inbox:' + cfg.inboxId, policy_version: 'intake_v2', sender_policy: 'all',
    include_spam_trash: cfg.includeSpamTrash === true, include_deleted: false, initial_received_from: cfg.intakeCutoff, lookback_seconds: cfg.auditLookbackSeconds };
}

export function loadAuditState(rows, cfg, executionId, now) {
  const actual = rows.filter(row => row && row.collector_key !== undefined);
  if (actual.length > 1) throw new Error('INTAKE_AUDIT_DUPLICATE_STATE_ROWS');
  if (actual.length && actual[0].collector_key !== cfg.collectorId) throw new Error('INTAKE_AUDIT_STATE_COLLECTOR_MISMATCH');
  let state = actual.length ? JSON.parse(actual[0].state_json) : null;
  const identityParts=[auditManifest(cfg), cfg.chatwootBaseUrl || null, cfg.serviceUrl];
  // A paused canary and its precise fixture must never become an operational
  // bridge by changing configuration while retaining the same durable state.
  if(cfg.prospective===true) identityParts.push({prospective:true,bridgeEnabled:cfg.bridgeEnabled===true,
    bridgeWorkflowId:cfg.bridgeWorkflowId || null,canary:cfg.canary===true,canaryMessageId:cfg.canaryMessageId || null,canaryRecheckOnly:cfg.canaryRecheckOnly===true});
  const identityHash = auditHash(identityParts);
  if (state && (state.version !== 2 || state.identityHash !== identityHash || !Number.isSafeInteger(actual[0].revision)
    || state.revision !== actual[0].revision)) throw new Error('INTAKE_AUDIT_STATE_IDENTITY_INVALID');
  if (state?.canaryPaused === true) throw new Error('INTAKE_AUDIT_CANARY_PAUSED_AFTER_FAILURE');
  if (actual.length && !auditNumericId(actual[0].id)) throw new Error('INTAKE_AUDIT_STATE_ROW_ID_INVALID');
  if (state && state.phase !== 'done' && state.lease?.owner && state.lease.owner !== String(executionId) && state.lease.until > now) return { ...state, busy: true };
  if (!state || state.phase === 'done') {
    const previous = state;
    // A prospective collector must start at its activation boundary even if its
    // first execution is delayed for more than a day; never skip that interval.
    let from = cfg.prospective === true ? Date.parse(cfg.intakeCutoff) : Math.max(Date.parse(cfg.intakeCutoff), now - cfg.auditLookbackSeconds * 1000);
    let proof = previous?.coverageProof || (previous?.finishResult?.coverageComplete === true ? { sweepId: previous.sweepId, receivedThrough: previous.receivedThrough } : null);
    let through = now-1000, windowKind='current', gaps=[], progressThrough=null, hadGap=false;
    if (cfg.prospective === true && previous) {
      if (!Array.isArray(previous.coverageGaps) || previous.coverageGaps.length>5000 || !['current','retry'].includes(previous.windowKind)
        || !Number.isFinite(Date.parse(previous.receivedFrom)) || !Number.isFinite(Date.parse(previous.receivedThrough))) throw new Error('INTAKE_AUDIT_GAPS_STATE_INVALID');
      gaps=auditClone(previous.coverageGaps);progressThrough=previous.progressThrough || cfg.intakeCutoff;hadGap=previous.coverageHadGap===true;
      if (!Number.isFinite(Date.parse(progressThrough)) || Date.parse(progressThrough)<Date.parse(cfg.intakeCutoff)
        || Date.parse(progressThrough)>now || Date.parse(previous.receivedThrough)>now) throw new Error('INTAKE_AUDIT_PROGRESS_INVALID');
      const sameWindow=gap=>gap.from===previous.receivedFrom&&gap.through===previous.receivedThrough;
      if (previous.windowKind==='current') {
        if(Date.parse(previous.receivedThrough)>Date.parse(progressThrough))progressThrough=previous.receivedThrough;
        if(previous.finishResult?.coverageComplete!==true&&!gaps.some(sameWindow))gaps.push({from:previous.receivedFrom,through:previous.receivedThrough});
      } else {
        if(!gaps.some(sameWindow))throw new Error('INTAKE_AUDIT_RETRY_GAP_MISSING');
        gaps=gaps.filter(gap=>!sameWindow(gap));
        if(previous.finishResult?.coverageComplete!==true)gaps.push({from:previous.receivedFrom,through:previous.receivedThrough});
      }
      if(gaps.length>5000 || gaps.some(gap=>!gap||!Number.isFinite(Date.parse(gap.from))||!Number.isFinite(Date.parse(gap.through))
        ||Date.parse(gap.from)<Date.parse(cfg.intakeCutoff)||Date.parse(gap.through)<=Date.parse(gap.from)))throw new Error('INTAKE_AUDIT_GAPS_STATE_INVALID');
      if(gaps.length)hadGap=true;
      if(hadGap)proof=null;
      // Retry one outstanding interval only after a current interval; a
      // permanently broken old page cannot prevent new messages being scanned.
      if(previous.windowKind==='current'&&previous.finishResult?.coverageComplete===true&&gaps.length&&cfg.canary!==true){windowKind='retry';from=Date.parse(gaps[0].from);through=Date.parse(gaps[0].through);}
      else from=Math.max(Date.parse(cfg.intakeCutoff),Date.parse(progressThrough)-cfg.overlapSeconds*1000);
    } else if (cfg.continuous === true && previous) {
      if (proof) {
        if (!auditUuid(proof.sweepId) || !Number.isFinite(Date.parse(proof.receivedThrough)) || Date.parse(proof.receivedThrough) > now) throw new Error('INTAKE_AUDIT_COVERAGE_PROOF_INVALID');
        from = Math.max(Date.parse(cfg.intakeCutoff), Date.parse(proof.receivedThrough) - cfg.overlapSeconds * 1000);
      } else from = Math.max(Date.parse(cfg.intakeCutoff), Date.parse(previous.receivedFrom));
    }
    if(cfg.prospective===true&&windowKind==='current')through=Math.min(through,from+cfg.auditLookbackSeconds*1000);
    state = { version: 2, identityHash, revision: actual[0]?.revision || 0, requestId: crypto.randomUUID(),
      receivedFrom: new Date(from).toISOString(), receivedThrough: new Date(through).toISOString(), phase: 'begin', pageCount: 0, messageCount: 0,
      messageKeys: [], conversationIds: [], conversationIndex: 0, cursor: cfg.provider === 'gmail' ? null : 1,
      pendingEvents: [], messageQueue: [], messageIndex: 0, messagesAudited: 0, originsPending: 0, originsSaved: 0, originsExcluded: 0, lookupJobs: [], enumerationDone: false,
      ...(cfg.continuous === true ? { coverageProof: proof, notificationMode: 'home_only' } : {}),
      ...(cfg.prospective === true ? {windowKind,coverageGaps:gaps,progressThrough:progressThrough || cfg.intakeCutoff,coverageHadGap:hadGap} : {}),
      ...(cfg.canary === true ? { canary: true } : {}),
      ...(cfg.recheckPending === true ? { recheckCursor: previous?.recheckCursor ?? null } : {}) };
  } else if (cfg.continuous === true && state.halt === true && state.failureStreak?.count >= cfg.maxRepeatedFailures && state.sweepId) {
    // Close an unproven attempt; its next window starts from the last proved time and extends to the new now.
    // No temporal interval, receipt or clinical source is discarded or declared covered by this transition.
    state.abortIncomplete = true; state.phase = 'finish'; state.pendingEvents = [];
  }
  if (Date.parse(state.receivedThrough) <= Date.parse(state.receivedFrom)) throw new Error('INTAKE_AUDIT_WINDOW_INVALID');
  // A finish may have committed even when its ACK was lost. Replay finish first; never reopen a finished sweep.
  if (cfg.resumeFence === true && state.sweepId && (state.phase !== 'finish' || state.resumeRequest)) {
    if (!state.resumeRequest) state.resumeRequest = { resumeRequestId: crypto.randomUUID(), runToken: state.runToken };
    if (!auditUuid(state.resumeRequest.resumeRequestId) || !auditUuid(state.resumeRequest.runToken)) throw new Error('INTAKE_AUDIT_RESUME_STATE_INVALID');
  }
  state.tick = { executionId: String(executionId), actions: 0, startedAt: now };
  state.rowId = actual[0]?.id ?? null;
  state.lease = { owner: String(executionId), until: now + (cfg.leaseMillis || 900000) };
  state.busy = false;
  state.releaseLease = false;
  delete state.finalResult;
  state.halt = false;
  return state;
}

function auditEvents(state, events, afterPhase, haltAfter = false) {
  state.pendingEvents = events;
  state.afterEvents = afterPhase;
  state.haltAfterEvents = haltAfter;
  state.phase = 'events';
  return state;
}

function auditWindowQuery(state) {
  return 'after:' + (Math.floor(Date.parse(state.receivedFrom) / 1000) - 1) + ' before:' + (Math.ceil(Date.parse(state.receivedThrough) / 1000) + 1);
}

// The Gmail attachmentId is a volatile download locator. Send only pending
// immutable MIME part IDs (or the particular HopeLab link identity) to the child.
function auditBridgeTarget(identity) {
  if (typeof identity!=='string') return null;
  if (/^hopelab-link:[a-f0-9]{64}$/.test(identity)) return {kind:'hopelab_link',attachment_id:identity};
  if(!identity.startsWith('gmail-part:')) return null;
  let value;try{value=JSON.parse(identity.slice('gmail-part:'.length));}catch{return null;}
  if(!Array.isArray(value)||value.length!==2||typeof value[0]!=='string'||value[0].length>2048||/[\x00-\x1f\x7f]/.test(value[0])
    || !(value[1]===null||auditId(value[1])))return null;
  return {kind:'gmail_part',part_id:value[0]};
}
function auditBridgeTargets(origins,items,unsupportedIds=[]) {
  const unique=new Map();
  for(let i=0;i<origins.length;i++)if(items[i]?.status!=='saved'&&!unsupportedIds.includes(origins[i].attachment_id)){
    const target=auditBridgeTarget(origins[i].attachment_id);if(target)unique.set(JSON.stringify(target),target);
  }
  return [...unique.values()];
}
function auditBridgeIssues(context,response) {
  const codes=new Set(['source_reservation_unproven','original_storage_pending','intake_receipt_unproven','target_attachment_not_found','source_retry_unconfirmed','invalid_pdf_signature']);
  const provided=Array.isArray(response?.body?.issues)?response.body.issues.slice(0,200):[],out=[];
  for(const target of context.payload.targets){
    const issue=provided.find(item=>item&&item.message_id===context.payload.message_id&&codes.has(item.reason)
      && (item.reason==='target_attachment_not_found' || JSON.stringify(auditBridgeTarget(item.attachment_id))===JSON.stringify(target)));
    out.push({target,code:issue?.reason||'source_retry_unconfirmed'});
  }
  return out;
}

export function nextAuditOperation(input, cfg, now) {
  const state = auditClone(input);
  if (state.releaseLease) return { target: 'stop', state, result: state.finalResult };
  if (state.phase === 'done') return { target: 'stop', state, result: { ...state.finishResult, continuationRequired: false, auditOnly: true, monitoring: false,
    receivedFrom: state.receivedFrom, receivedThrough: state.receivedThrough, messagesAudited: state.messagesAudited, originsPending: state.originsPending, originsSaved: state.originsSaved,
    notificationMode: cfg.notificationMode || 'home_only', auditCoverageThrough: state.coverageProof?.receivedThrough || null,
    incompleteAttemptClosed: state.abortIncomplete === true, lastError: state.lastError || null } };
  if (state.halt || state.tick.actions >= cfg.maxActions || now - state.tick.startedAt > cfg.maxMillis) return { target: 'stop', state,
    result: { coverageComplete: false, scanFinished: false, checkpointAdvanced: false, continuationRequired: true,
      auditOnly: true, monitoring: false, receivedFrom: state.receivedFrom, receivedThrough: state.receivedThrough,
      lastError: state.lastError || null, messagesAudited: state.messagesAudited, originsPending: state.originsPending, originsSaved: state.originsSaved } };
  state.tick.actions++;
  if (state.resumeRequest) return { target: 'backend', state, action: 'intake_resume', payload: { collector_id: cfg.collectorId, scope_key: auditHash(auditManifest(cfg)),
    request_id: state.requestId, sweep_id: state.sweepId, run_token: state.resumeRequest.runToken, resume_request_id: state.resumeRequest.resumeRequestId, ttl_seconds: 3600 } };
  if (state.phase === 'recheck_list') return { target: 'backend', state, action: 'intake_list_pending_sources', payload: {
    collector_id: cfg.collectorId, after_receipt_id: state.recheckCursor ?? null, limit: 50 } };
  if (state.phase === 'recheck_lookup') return { target: 'backend', state, action: 'intake_lookup_source', payload: {
    collector_id: cfg.collectorId, identities: state.recheckItems.map(item => ({ account_id: item.account_id,
      partition_key: item.partition_key, message_id: item.message_id, attachment_id: item.attachment_id })) } };
  if (state.phase === 'bridge') {
    // In-flight older recheck state has only message IDs, not a proven per-part
    // selection. Re-run lookup instead of dispatching all attachments.
    if(state.bridgeMode==='recheck' && typeof state.recheckBridgeQueue?.[0]==='string'){
      delete state.recheckBridgeQueue;delete state.bridgeMessageId;delete state.bridgeMode;delete state.recheckBridgeAttempted;
      state.phase='recheck_lookup';return nextAuditOperation(state,cfg,now);
    }
    const targets=state.bridgeMode==='new' ? auditBridgeTargets(state.bridgeJob.origins,state.bridgeJob.lookupItems,state.bridgeJob.unsupportedIds)
      : state.recheckBridgeQueue?.[0]?.targets;
    if(!Array.isArray(targets)||!targets.length)throw new Error('INTAKE_AUDIT_BRIDGE_TARGETS_MISSING');
    return { target: 'bridge', state, payload: { message_id: state.bridgeMessageId,
      account_id: auditManifest(cfg).account_id, collector_id: cfg.collectorId, cutoff: cfg.intakeCutoff, targets } };
  }
  if (state.phase === 'recheck_resolve') {
    if (!state.recheckResolutions.length) {
      state.recheckCursor = state.recheckNextCursor; delete state.recheckItems; delete state.recheckResolutions; delete state.recheckNextCursor;
      state.phase = 'gmail_list'; return nextAuditOperation(state, cfg, now);
    }
    const item = state.recheckResolutions[0];
    return { target: 'backend', state, action: 'intake_resolve_receipt_saved', payload: {
      receipt_id: item.receipt_id, source_id: item.source_id, document_id: item.document_id } };
  }
  if (state.phase === 'events') {
    if (!state.pendingEvents.length) {
      state.phase = state.afterEvents;
      state.halt = state.haltAfterEvents;
      return nextAuditOperation(state, cfg, now);
    }
    return { target: 'backend', state, action: 'intake_event', payload: { sweep_id: state.sweepId, run_token: state.runToken, event: state.pendingEvents[0] } };
  }
  if (state.phase === 'begin') return { target: 'backend', state, action: 'intake_begin', payload: { collector_id: cfg.collectorId,
    scope_key: auditHash(auditManifest(cfg)), scope_manifest: auditManifest(cfg), received_from: state.receivedFrom,
    received_through: state.receivedThrough, request_id: state.requestId, mode: 'audit', ttl_seconds: 3600 } };
  if (state.phase === 'enumeration') return { target: 'backend', state, action: 'intake_event', payload: { sweep_id: state.sweepId,
    run_token: state.runToken, event: { kind: 'enumeration_complete', expected_message_count: state.messageCount, page_count: state.pageCount } } };
  if (state.phase === 'finish') return { target: 'backend', state, action: 'intake_finish', payload: { sweep_id: state.sweepId, run_token: state.runToken } };
  if (state.phase === 'lookup') {
    const job = state.lookupJobs[0];
    if (!job) { state.phase = state.afterLookup; return nextAuditOperation(state, cfg, now); }
    if (!job.origins.length) {
      state.lookupJobs.shift();
      return nextAuditOperation(auditEvents(state, auditMessageEvents(state, job), 'lookup'), cfg, now);
    }
    const identities = job.origins.slice(job.lookupOffset || 0, (job.lookupOffset || 0) + 100).map(origin => ({
      account_id: auditManifest(cfg).account_id, partition_key: job.partitionKey, message_id: job.messageId, attachment_id: origin.attachment_id }));
    return { target: 'backend', state, action: 'intake_lookup_source', payload: { collector_id: cfg.collectorId, identities } };
  }
  if (state.phase === 'gmail_list') return { target: 'gmail', state, url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100&includeSpamTrash=' + (cfg.includeSpamTrash === true)
    + '&fields=' + encodeURIComponent('messages(id),nextPageToken,resultSizeEstimate') + '&q=' + encodeURIComponent(auditWindowQuery(state))
    + (state.cursor ? '&pageToken=' + encodeURIComponent(state.cursor) : '') };
  if (state.phase === 'gmail_metadata') {
    if (state.messageIndex >= state.messageQueue.length) {
      state.messageQueue = [];
      state.phase = state.cursor === null ? 'enumeration' : 'gmail_list';
      return nextAuditOperation(state, cfg, now);
    }
    const message = state.messageQueue[state.messageIndex];
    return { target: 'gmail', state, url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + encodeURIComponent(message.id)
      + '?format=full&fields=' + encodeURIComponent(cfg.gmailMetadataFields) };
  }
  if (state.phase === 'gmail_notice_body') return { target: 'gmail', state, url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + encodeURIComponent(state.noticeMessage.id)
    + '?format=full&fields=' + encodeURIComponent(cfg.gmailNoticeFields) };
  const base = cfg.chatwootBaseUrl + '/api/v1/accounts/' + cfg.accountId;
  if (state.phase === 'chatwoot_conversations') return { target: 'chatwoot', state, url: base + '/conversations?status=all&assignee_type=all&inbox_id=' + cfg.inboxId + '&page=' + state.cursor };
  if (state.phase === 'chatwoot_messages') {
    if (state.conversationIndex >= state.conversationIds.length) {
      state.phase = 'enumeration';
      return nextAuditOperation(state, cfg, now);
    }
    return { target: 'chatwoot', state, url: base + '/conversations/' + state.conversationIds[state.conversationIndex] + '/messages' + (state.cursor === null ? '' : '?before=' + state.cursor) };
  }
  throw new Error('INTAKE_AUDIT_PHASE_INVALID');
}

function auditPage(state, partitionKey, records, requestCursor, nextCursor, afterPhase) {
  const ids = records.map(row => row.id);
  if (ids.some(id => !auditId(id)) || new Set(ids).size !== ids.length || ids.length > 100) throw new Error('INTAKE_AUDIT_PAGE_IDS_INVALID');
  const requestHash = auditHash([partitionKey, requestCursor]), nextHash = nextCursor === null ? null : auditHash([partitionKey, nextCursor]);
  const seen = state.cursorHashes || [];
  if (seen.includes(requestHash) || nextHash === requestHash || nextHash !== null && seen.includes(nextHash)) throw new Error('INTAKE_AUDIT_PAGINATION_CYCLE');
  state.cursorHashes = [...seen, requestHash];
  const event = { kind: 'page_discovered', partition_key: partitionKey, page_key: auditHash([partitionKey, requestHash]),
    request_cursor_sha256: requestHash, next_cursor_sha256: nextHash, page_sha256: auditHash(ids), message_ids: ids, is_terminal: nextCursor === null };
  for (const id of ids) {
    const key = JSON.stringify([partitionKey, id]);
    if (!state.messageKeys.includes(key)) { state.messageKeys.push(key); state.messageCount++; }
  }
  state.pageCount++;
  return auditEvents(state, [event], afterPhase);
}

function auditMessageEvents(state, { partitionKey, messageId, receivedAt, origins, policyCode, lookupItems = [], unsupportedIds = [], attachmentDetails = [] }) {
  const events = [];
  if (receivedAt) events.push({ kind: 'message_discovered', partition_key: partitionKey, message_id: messageId, received_at: receivedAt });
  events.push({ kind: 'origins_declared', partition_key: partitionKey, message_id: messageId, origins,
    ...(origins.length ? {} : { policy_code: policyCode }) });
  for(const detail of attachmentDetails) events.push({kind:'attachment_details',partition_key:partitionKey,message_id:messageId,received_at:receivedAt,...detail});
  for (const [index, origin] of origins.entries()) {
    const item = lookupItems[index];
    const unsupported = unsupportedIds.includes(origin.attachment_id), saved = item?.status === 'saved' && !unsupported;
    const excluded = item?.status === 'excluded' && item.reason === 'user_deleted';
    events.push({ kind: 'origin_outcome', partition_key: partitionKey, message_id: messageId,
      attachment_id: origin.attachment_id, disposition: excluded ? 'excluded' : saved ? 'saved' : 'pending',
      ...(saved ? { source_id: item.source_id, document_id: item.document_id }
        : { stage: 'review', code: excluded ? 'user_deleted' : unsupported ? 'unsupported_attachment_requires_review' : origin.artifact_kind === 'notice' ? 'audit_notice_requires_review' : item?.reason || 'audit_preservation_not_verified' }) });
    if (excluded) state.originsExcluded = (state.originsExcluded || 0) + 1; else if (saved) state.originsSaved++; else state.originsPending++;
  }
  state.messagesAudited++;
  return events;
}

function auditLookupJobs(state, jobs, afterPhase) {
  state.lookupJobs = jobs;
  state.afterLookup = afterPhase;
  state.phase = 'lookup';
  return state;
}

function validateAuditLookup(body, requested) {
  if (body.contract !== 'exam_intake_source_lookup_v1' || !Array.isArray(body.items) || body.items.length !== requested.length) throw new Error('INTAKE_AUDIT_LOOKUP_ACK_INVALID');
  for (const [index, item] of body.items.entries()) {
    if (!auditObject(item) || item.message_id !== requested[index].message_id || item.attachment_id !== requested[index].attachment_id
      || !['saved', 'pending', 'not_found', 'excluded'].includes(item.status) || !/^[a-z0-9_]{1,95}$/.test(item.reason || '')
      || item.status === 'excluded' && item.reason !== 'user_deleted') throw new Error('INTAKE_AUDIT_LOOKUP_IDENTITY_INVALID');
    if (item.status === 'saved' && (!['exact_origin','gmail_part_origin'].includes(item.match_kind)
      || item.match_kind==='gmail_part_origin' && (!requested[index].account_id.startsWith('gmail:') || !requested[index].attachment_id.startsWith('gmail-part:'))
      || item.canonical_file_preserved !== true
      || !auditUuid(item.source_id) || !auditUuid(item.document_id) || item.source_document_id !== item.document_id || !/^[a-f0-9]{64}$/.test(item.sha256 || '')
      || !Number.isSafeInteger(item.size_bytes) || item.size_bytes <= 0 || item.file_status !== 'saved')) throw new Error('INTAKE_AUDIT_LOOKUP_SAVED_UNPROVEN');
  }
  return body.items.map(item => ({ message_id: item.message_id, attachment_id: item.attachment_id, status: item.status, reason: item.reason,
    ...(item.status === 'saved' ? { source_id: item.source_id, document_id: item.document_id } : {}) }));
}

function auditSafeMetadata(value,max) {
  return typeof value==='string' && value.length>0 && value.length<=max && !/[\x00-\x1f\x7f]/.test(value) && !value.includes('://') ? value : null;
}
function auditGmailSender(body) {
  const headers=body.payload?.headers;if(!Array.isArray(headers))return null;
  const entries=headers.filter(h=>typeof h?.name==='string'&&h.name.toLowerCase()==='from');if(entries.length!==1||typeof entries[0].value!=='string')return null;
  const from=entries[0].value.trim(),address=(from.match(/<([^<>\s]+@[^<>\s]+)>\s*$/)?.[1]||from).toLowerCase();
  return /^[^@\s<>;,]+@[^@\s<>;,]+$/.test(address)?auditSafeMetadata(address,200):null;
}
function auditGmailOrigins(body, allowBodyData = false, allowOpaque = false, captureDetails = false) {
  const origins = [], unsupportedIds = [], seen = new Set(), attachmentDetails=[]; let hasPdf = false;
  const sender=captureDetails?auditGmailSender(body):null;
  let count = 0;
  const visit = (part, depth) => {
    if (!auditObject(part) || depth > 8 || ++count > 1000 || typeof part.partId !== 'string' || typeof part.mimeType !== 'string'
      || !allowBodyData && part.body?.data !== undefined || part.parts !== undefined && !Array.isArray(part.parts)
      || part.body !== undefined && !auditObject(part.body) || part.filename !== undefined && typeof part.filename !== 'string') throw new Error('INTAKE_AUDIT_MIME_INCOMPLETE');
    if (seen.has(part.partId)) throw new Error('INTAKE_AUDIT_MIME_PART_DUPLICATE');
    seen.add(part.partId);
    const pdf = part.mimeType.toLowerCase() === 'application/pdf' || /\.pdf$/i.test(part.filename || '');
    const opaque = allowOpaque && part.mimeType.toLowerCase() === 'application/octet-stream' && !(part.filename || '') && Number.isSafeInteger(part.body?.size) && part.body.size > 0;
    if (pdf || opaque || part.body?.attachmentId !== undefined || typeof part.filename === 'string' && part.filename.length > 0) {
      const attachment = part.body?.attachmentId ?? null;
      if (attachment !== null && !auditId(attachment)) throw new Error('INTAKE_AUDIT_ATTACHMENT_INVALID');
      const key = 'gmail-part:' + JSON.stringify([part.partId, attachment]);
      origins.push({ attachment_id: key, artifact_kind: 'attachment' });
      if(captureDetails)attachmentDetails.push({attachment_id:key,position:origins.length,display_name:auditSafeMetadata(part.filename,200),mime_type:auditSafeMetadata(part.mimeType,100),sender});
      if (pdf) hasPdf = true; else if (!opaque) unsupportedIds.push(key);
    }
    for (const child of part.parts || []) visit(child, depth + 1);
  };
  visit(body.payload, 0);
  if (origins.length > 200) throw new Error('INTAKE_AUDIT_ORIGIN_LIMIT_REVIEW_REQUIRED');
  return { origins, hasPdf, unsupportedIds, attachmentDetails };
}

function auditGmailNoticeIdentity(body) {
  const headers = body.payload?.headers || [];
  if (!Array.isArray(headers)) throw new Error('INTAKE_AUDIT_NOTICE_HEADERS_INVALID');
  const get = name => {
    const matches = headers.filter(header => String(header?.name).toLowerCase() === name);
    if (matches.length > 1 || matches.some(header => typeof header.value !== 'string' || header.value.length > 8192 || /[\r\n\x00]/.test(header.value))) throw new Error('INTAKE_AUDIT_NOTICE_HEADERS_INVALID');
    return matches[0]?.value || '';
  };
  const from = get('from').trim(), sender = (from.match(/<([^<>\s]+@[^<>\s]+)>\s*$/)?.[1] || from).toLowerCase();
  const subject = get('subject');
  return { candidate: sender === 'hopelab@exames.vet.br' && /^Exame finalizado(?:\s|:|$)/i.test(subject.trim()),
    identityHash: auditHash([body.id, body.internalDate, from, subject, get('message-id')]) };
}

function auditGmailNoticeOrigins(body) {
  const links = new Set(); let totalBytes = 0, count = 0;
  const addLink = value => {
    const match = value.replace(/&amp;|&#38;|&#x26;/gi, '&').match(/^https:\/\/hopelab\.exames\.vet\.br(\/laudos\/download\/\d{1,10}\/\d{1,10}\/[a-f\d]{32}\/[a-f\d]{32})(?:\?utm_source=email)?$/i);
    if (match) links.add('https://hopelab.exames.vet.br' + match[1].toLowerCase());
  };
  const visit = (part, depth) => {
    if (!auditObject(part) || depth > 8 || ++count > 1000 || typeof part.partId !== 'string' || typeof part.mimeType !== 'string'
      || part.parts !== undefined && !Array.isArray(part.parts)) throw new Error('INTAKE_AUDIT_NOTICE_MIME_INCOMPLETE');
    if (part.mimeType.toLowerCase() === 'application/pdf' || /\.pdf$/i.test(part.filename || '')) throw new Error('INTAKE_AUDIT_NOTICE_CHANGED_TO_ATTACHMENT');
    if (['text/plain', 'text/html'].includes(part.mimeType.toLowerCase()) && part.body?.data !== undefined) {
      const encoded = part.body.data;
      if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(encoded) || encoded.length > 1400000) throw new Error('INTAKE_AUDIT_NOTICE_ENCODING_INVALID');
      const bytes = Buffer.from(encoded.replace(/=+$/, ''), 'base64url'), decoded = bytes.toString('utf8');
      if (bytes.toString('base64url') !== encoded.replace(/=+$/, '') || part.body.size !== bytes.length || !Buffer.from(decoded, 'utf8').equals(bytes)) throw new Error('INTAKE_AUDIT_NOTICE_SIZE_OR_UTF8_INVALID');
      totalBytes += bytes.length;
      if (totalBytes > 1048576) throw new Error('INTAKE_AUDIT_NOTICE_TEXT_LIMIT');
      let visible = decoded;
      if (part.mimeType.toLowerCase() === 'text/html') {
        const safeHtml = decoded.replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ').replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');
        for (const anchor of safeHtml.matchAll(/<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
          const hrefs = [...anchor[1].matchAll(/(?:^|\s)([A-Za-z_:][A-Za-z0-9_:.-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)]
            .filter(attribute => attribute[1].toLowerCase() === 'href');
          if (hrefs.length > 1) throw new Error('INTAKE_AUDIT_NOTICE_ANCHOR_AMBIGUOUS');
          if (hrefs.length) addLink(hrefs[0][2] ?? hrefs[0][3] ?? hrefs[0][4] ?? '');
        }
        visible = safeHtml.replace(/<[^>]*>/g, ' ').replace(/&amp;/gi, '&');
      }
      for (const value of visible.match(/https?:\/\/[^\s<>"']+/gi) || []) addLink(value);
    }
    for (const child of part.parts || []) visit(child, depth + 1);
  };
  visit(body.payload, 0);
  if (links.size > 200) throw new Error('INTAKE_AUDIT_ORIGIN_LIMIT_REVIEW_REQUIRED');
  return links.size ? [...links].map(url => { const digest = crypto.createHash('sha256').update(url).digest('hex');
    return { attachment_id: 'hopelab-link:' + digest, artifact_kind: 'download_link', relation_sha256: digest }; })
    : [{ attachment_id: 'hopelab-link:missing', artifact_kind: 'notice' }];
}

export function applyAuditResponse(context, response, cfg, now) {
  let state = auditClone(context.state);
  if (context.target === 'bridge') {
    // Child acknowledgement never proves preservation. Even an uncertain child
    // response goes to a new read-only lookup before any saved outcome is written.
    const failed = response?.statusCode !== 200 || response?.body?.completed !== true;
    const issues=cfg.captureAttachmentDetails===true ? auditBridgeIssues(context,response) : [];
    if (state.bridgeMode === 'recheck') {
      state.recheckIssues=[...(state.recheckIssues||[]),...issues.map(issue=>({...issue,message_id:context.payload.message_id}))];
      state.recheckBridgeQueue.shift();
      if (state.recheckBridgeQueue.length) state.bridgeMessageId = state.recheckBridgeQueue[0].message_id;
      else { delete state.bridgeMessageId; delete state.recheckBridgeQueue; delete state.bridgeMode; state.phase = 'recheck_lookup'; state.recheckBridgeAttempted = true; }
    } else {
      const job = state.bridgeJob; delete state.bridgeJob; delete state.bridgeMessageId; delete state.bridgeMode;
      state.lookupJobs = [{ ...job, lookupItems: [], lookupOffset: 0, bridgeRechecked: true, bridgeIssues:issues }]; state.afterLookup = 'gmail_metadata'; state.phase = 'lookup';
    }
    if (failed) state.lastError = { stage: 'bridge', code: 'audit_bridge_response_uncertain', at: new Date(now).toISOString() };
    if (failed && state.canary === true) { state.canaryPaused=true;state.halt=true; }
    return state;
  }
  const status = response?.statusCode, body = response?.body;
  if (status !== 200 || !auditObject(body)) {
    return applyAuditFailure(context, 'AUDIT_PROVIDER_OR_BACKEND_UNAVAILABLE', now);
  }
  if (state.failureStreak?.operationKey === auditOperationKey(context)) state.failureStreak = null;
  if (context.target === 'backend') {
    if (context.action === 'intake_resume') {
      if (!state.resumeRequest || body.sweep_id !== state.sweepId || !auditUuid(body.run_token) || body.run_token === state.resumeRequest.runToken
        || body.mode !== 'audit' || body.resumed !== true || typeof body.replayed !== 'boolean' || !Number.isFinite(Date.parse(body.expires_at)) || Date.parse(body.expires_at) <= now
        || body.collector_id !== cfg.collectorId || body.scope_key !== auditHash(auditManifest(cfg)) || body.request_id !== state.requestId
        || Date.parse(body.received_from) !== Date.parse(state.receivedFrom) || Date.parse(body.received_through) !== Date.parse(state.receivedThrough)) throw new Error('INTAKE_AUDIT_RESUME_ACK_INVALID');
      state.runToken = body.run_token; delete state.resumeRequest;
      if (state.lastError?.stage === 'backend') state.lastError = null;
    } else if (context.action === 'intake_begin') {
      if (!auditUuid(body.sweep_id) || !auditUuid(body.run_token) || body.mode !== 'audit') throw new Error('INTAKE_AUDIT_BEGIN_ACK_INVALID');
      state.sweepId = body.sweep_id; state.runToken = body.run_token;
      state.phase = cfg.provider === 'gmail' ? cfg.recheckPending === true ? 'recheck_list' : 'gmail_list' : 'chatwoot_conversations';
      if (cfg.resumeFence === true && body.replayed === true) state.resumeRequest = { resumeRequestId: crypto.randomUUID(), runToken: state.runToken };
    } else if (context.action === 'intake_event') {
      if (body.recorded !== true || body.sweep_id !== state.sweepId) throw new Error('INTAKE_AUDIT_EVENT_ACK_INVALID');
      if (state.phase === 'enumeration') { state.enumerationDone = true; state.phase = 'finish'; }
      else state.pendingEvents.shift();
    } else if (context.action === 'intake_finish') {
      if (typeof body.coverageComplete !== 'boolean' || typeof body.scanFinished !== 'boolean' || body.checkpointAdvanced !== false) throw new Error('INTAKE_AUDIT_FINISH_ACK_INVALID');
      state.phase = 'done'; state.finishResult = body;
      if (cfg.continuous === true && body.coverageComplete === true && (cfg.prospective!==true || !state.coverageHadGap && !state.coverageGaps.length)) state.coverageProof = { sweepId: state.sweepId, receivedThrough: state.receivedThrough };
    } else if (context.action === 'intake_list_pending_sources') {
      if (body.contract !== 'exam_intake_pending_source_page_v1' || body.collector_id !== cfg.collectorId || !Array.isArray(body.items) || body.items.length > 50
        || body.next_cursor !== null && !auditUuid(body.next_cursor)) throw new Error('INTAKE_AUDIT_RECHECK_PAGE_INVALID');
      let last = state.recheckCursor ?? null;
      for (const item of body.items) {
        if (!auditObject(item) || !auditUuid(item.receipt_id) || last !== null && item.receipt_id <= last
          || item.account_id !== auditManifest(cfg).account_id || !auditId(item.partition_key) || !auditId(item.message_id) || !auditId(item.attachment_id)
          || !['attachment','download_link','notice'].includes(item.artifact_kind)) throw new Error('INTAKE_AUDIT_RECHECK_IDENTITY_INVALID');
        last = item.receipt_id;
      }
      if (body.next_cursor !== null && (body.items.length === 0 || body.next_cursor !== last)) throw new Error('INTAKE_AUDIT_RECHECK_CURSOR_INVALID');
      state.recheckItems = body.items; state.recheckNextCursor = body.next_cursor;
      if (body.items.length) state.phase = 'recheck_lookup';
      else { state.recheckCursor = null; delete state.recheckItems; delete state.recheckNextCursor; state.phase = 'gmail_list'; }
    } else if (context.action === 'intake_resolve_receipt_saved') {
      const expected = state.recheckResolutions[0];
      if (!expected || body.contract !== 'exam_intake_receipt_resolution_v1' || body.disposition !== 'saved'
        || body.receipt_id !== expected.receipt_id || body.source_id !== expected.source_id || body.document_id !== expected.document_id
        || body.sha256 !== expected.sha256 || body.size_bytes !== expected.size_bytes || typeof body.already_saved !== 'boolean') throw new Error('INTAKE_AUDIT_RECHECK_RESOLUTION_INVALID');
      state.recheckResolutions.shift();
    } else if (context.action === 'intake_lookup_source' && state.phase === 'recheck_lookup') {
      const items = validateAuditLookup(body, context.payload.identities);
      if (cfg.bridgeEnabled === true && cfg.canaryRecheckOnly!==true && !state.recheckBridgeAttempted) {
        const byMessage=new Map();
        for(let index=0;index<state.recheckItems.length;index++){
          const receipt=state.recheckItems[index];
          if((cfg.canary===true && receipt.message_id!==cfg.canaryMessageId)||items[index].status==='saved'||!['attachment','download_link'].includes(receipt.artifact_kind))continue;
          const target=auditBridgeTarget(receipt.attachment_id);if(!target)continue;
          if(!byMessage.has(receipt.message_id))byMessage.set(receipt.message_id,new Map());
          byMessage.get(receipt.message_id).set(JSON.stringify(target),target);
        }
        const queue=[...byMessage].map(([message_id,targets])=>({message_id,targets:[...targets.values()]}));
        if (queue.length) { state.recheckBridgeQueue=queue; state.bridgeMessageId=queue[0].message_id; state.bridgeMode='recheck'; state.phase='bridge'; return state; }
      }
      delete state.recheckBridgeAttempted;
      state.recheckResolutions = items.flatMap((item, index) => item.status === 'saved' ? [{ receipt_id: state.recheckItems[index].receipt_id,
        source_id: item.source_id, document_id: item.document_id, sha256: body.items[index].sha256, size_bytes: body.items[index].size_bytes }] : []);
      const failures=state.recheckItems.flatMap((receipt,index)=>{
        if(items[index].status==='saved')return [];
        const target=auditBridgeTarget(receipt.attachment_id),issue=(state.recheckIssues||[]).find(value=>value.message_id===receipt.message_id&&JSON.stringify(value.target)===JSON.stringify(target));
        return issue?[{kind:'attachment_retry_failed',partition_key:receipt.partition_key,message_id:receipt.message_id,attachment_id:receipt.attachment_id,code:issue.code}]:[];
      });
      delete state.recheckIssues;
      if(failures.length)return auditEvents(state,failures,'recheck_resolve');
      state.phase = 'recheck_resolve';
    } else if (context.action === 'intake_lookup_source') {
      const items = validateAuditLookup(body, context.payload.identities), job = state.lookupJobs[0];
      job.lookupItems = [...(job.lookupItems || []), ...items];
      job.lookupOffset = (job.lookupOffset || 0) + items.length;
      if (job.lookupOffset >= job.origins.length) {
        state.lookupJobs.shift();
        if (job.bridgeRechecked) {
          const events=job.origins.flatMap((origin,index)=>{
            if(job.lookupItems[index]?.status==='saved' && !job.unsupportedIds.includes(origin.attachment_id))return [{kind:'origin_outcome',partition_key:job.partitionKey,message_id:job.messageId,attachment_id:origin.attachment_id,
              disposition:'saved',source_id:job.lookupItems[index].source_id,document_id:job.lookupItems[index].document_id}];
            const target=auditBridgeTarget(origin.attachment_id),issue=(job.bridgeIssues||[]).find(value=>JSON.stringify(value.target)===JSON.stringify(target));
            return issue?[{kind:'attachment_retry_failed',partition_key:job.partitionKey,message_id:job.messageId,attachment_id:origin.attachment_id,code:issue.code}]:[];
          });
          const incomplete=cfg.canary===true && job.origins.some((origin,index)=>['attachment','download_link'].includes(origin.artifact_kind)
            && !job.unsupportedIds.includes(origin.attachment_id) && !['saved','excluded'].includes(job.lookupItems[index]?.status));
          if(incomplete){state.canaryPaused=true;state.lastError={stage:'bridge',code:'audit_bridge_saved_unproven',at:new Date(now).toISOString()};}
          return auditEvents(state, events, 'lookup', incomplete);
        }
        const bridgeable=cfg.bridgeEnabled===true && (cfg.canary!==true || job.messageId===cfg.canaryMessageId)
          && auditBridgeTargets(job.origins,job.lookupItems,job.unsupportedIds).length>0;
        if (bridgeable && cfg.canaryRecheckOnly===true) {state.canaryPaused=true;
          state.lastError={stage:'bridge',code:'audit_recheck_saved_unproven',at:new Date(now).toISOString()};
          return auditEvents(state,auditMessageEvents(state,job),'lookup',true);}
        if (bridgeable) { state.bridgeJob=job;state.bridgeMessageId=job.messageId;state.bridgeMode='new';
          return auditEvents(state,auditMessageEvents(state,job),'bridge'); }
        return auditEvents(state, auditMessageEvents(state, job), 'lookup');
      }
    } else {
      throw new Error('INTAKE_AUDIT_BACKEND_ACTION_INVALID');
    }
    return state;
  }
  if (state.phase === 'gmail_list') {
    const rows = body.messages ?? [];
    if (!Array.isArray(rows) || rows.length > 100 || rows.some(row => !/^[a-f\d]{8,64}$/i.test(row?.id || ''))) throw new Error('INTAKE_AUDIT_GMAIL_PAGE_INVALID');
    const cursor = body.nextPageToken || null;
    if (cursor !== null && !auditId(cursor)) throw new Error('INTAKE_AUDIT_GMAIL_CURSOR_INVALID');
    // A missing/empty provider response is not evidence of an empty page.
    if (!rows.length && cursor === null && body.resultSizeEstimate !== 0) throw new Error('INTAKE_AUDIT_GMAIL_EMPTY_UNPROVEN');
    state.messageQueue = rows.map(row => ({ id: row.id })); state.messageIndex = 0;
    const result = auditPage(state, 'mailbox', state.messageQueue, state.cursor, cursor, 'gmail_metadata');
    result.cursor = cursor;
    return result;
  }
  if (state.phase === 'gmail_metadata') {
    const expected = state.messageQueue[state.messageIndex].id;
    if (body.id !== expected || typeof body.internalDate !== 'string' || !/^\d{1,16}$/.test(body.internalDate)) throw new Error('INTAKE_AUDIT_GMAIL_METADATA_ID_INVALID');
    const received = Number(body.internalDate), receivedAt = new Date(received).toISOString();
    const inWindow = received >= Date.parse(state.receivedFrom) && received < Date.parse(state.receivedThrough);
    const inventory = inWindow ? auditGmailOrigins(body, false, cfg.bridgeEnabled === true, cfg.captureAttachmentDetails === true) : { origins: [], hasPdf: false, unsupportedIds: [], attachmentDetails:[] };
    const notice = inWindow && !inventory.hasPdf ? auditGmailNoticeIdentity(body) : null;
    if (notice?.candidate) {
      state.noticeMessage = { id: expected, internalDate: body.internalDate, identityHash: notice.identityHash,
        origins: inventory.origins, unsupportedIds: inventory.unsupportedIds, attachmentDetails:inventory.attachmentDetails };
      state.phase = 'gmail_notice_body';
      return state;
    }
    const origins = inventory.origins.length || !inWindow ? inventory.origins : [{ attachment_id: 'audit-notice:metadata-only', artifact_kind: 'notice' }];
    state.messageIndex++;
    return auditLookupJobs(state, [{ partitionKey: 'mailbox', messageId: expected, receivedAt, origins, unsupportedIds: inventory.unsupportedIds, attachmentDetails:inventory.attachmentDetails, policyCode: 'outside_received_window' }], 'gmail_metadata');
  }
  if (state.phase === 'gmail_notice_body') {
    const expected = state.noticeMessage, identity = auditGmailNoticeIdentity(body);
    if (body.id !== expected.id || body.internalDate !== expected.internalDate || !identity.candidate || identity.identityHash !== expected.identityHash) throw new Error('INTAKE_AUDIT_NOTICE_IDENTITY_CHANGED');
    const inventory = auditGmailOrigins(body, true, cfg.bridgeEnabled === true, cfg.captureAttachmentDetails === true);
    if (inventory.hasPdf || auditHash(inventory.origins) !== auditHash(expected.origins)) throw new Error('INTAKE_AUDIT_NOTICE_MIME_CHANGED');
    const origins = [...expected.origins, ...auditGmailNoticeOrigins(body)], receivedAt = new Date(Number(body.internalDate)).toISOString();
    if (origins.length > 200) throw new Error('INTAKE_AUDIT_ORIGIN_LIMIT_REVIEW_REQUIRED');
    const attachmentDetails=[...(expected.attachmentDetails||[])];
    if(cfg.captureAttachmentDetails===true)for(let i=expected.origins.length;i<origins.length;i++)if(origins[i].artifact_kind==='download_link')
      attachmentDetails.push({attachment_id:origins[i].attachment_id,position:i+1,display_name:null,mime_type:null,sender:auditGmailSender(body)});
    state.messageIndex++; delete state.noticeMessage;
    return auditLookupJobs(state, [{ partitionKey: 'mailbox', messageId: expected.id, receivedAt, origins, unsupportedIds: expected.unsupportedIds, attachmentDetails }], 'gmail_metadata');
  }
  if (state.phase === 'chatwoot_conversations') {
    const rows = body.data?.payload;
    if (!Array.isArray(rows) || rows.length > 100 || rows.some(row => !auditNumericId(row?.id) || String(row.inbox_id) !== String(cfg.inboxId)
      || row.account_id != null && String(row.account_id) !== String(cfg.accountId))) throw new Error('INTAKE_AUDIT_CONVERSATION_PAGE_INVALID');
    for (const row of rows) {
      if (state.conversationIds.includes(String(row.id))) throw new Error('INTAKE_AUDIT_CONVERSATION_CYCLE');
      state.conversationIds.push(String(row.id));
    }
    const next = rows.length ? Number(state.cursor) + 1 : null;
    const result = auditPage(state, 'inbox-conversations', [], state.cursor, next, rows.length ? 'chatwoot_conversations' : 'chatwoot_messages');
    result.cursor = next;
    return result;
  }
  if (state.phase === 'chatwoot_messages') {
    const conversation = state.conversationIds[state.conversationIndex], rows = body.payload;
    if (!Array.isArray(rows) || rows.length > 100 || rows.some(row => !auditNumericId(row?.id)
      || row.conversation_id != null && String(row.conversation_id) !== conversation
      || row.inbox_id != null && String(row.inbox_id) !== String(cfg.inboxId)
      || row.account_id != null && String(row.account_id) !== String(cfg.accountId)
      || state.cursor !== null && Number(row.id) >= Number(state.cursor))) throw new Error('INTAKE_AUDIT_MESSAGE_PAGE_INVALID');
    const records = rows.map(row => ({ id: String(row.id) }));
    const next = rows.length ? String(Math.min(...records.map(row => Number(row.id)))) : null;
    const result = auditPage(state, 'conversation:' + conversation, records, state.cursor, next, 'chatwoot_messages');
    const jobs = [];
    for (const row of rows) {
      const time = typeof row.created_at === 'number' ? row.created_at * 1000 : Date.parse(row.created_at);
      if (!Number.isFinite(time)) throw new Error('INTAKE_AUDIT_MESSAGE_TIME_INVALID');
      const inWindow = time >= Date.parse(state.receivedFrom) && time < Date.parse(state.receivedThrough);
      const incoming = [0, 'incoming'].includes(row.message_type) && row.private === false;
      const origins = [];
      if (inWindow && incoming) {
        if (row.attachments !== undefined && (!Array.isArray(row.attachments) || row.attachments.length > 200)) throw new Error('INTAKE_AUDIT_ATTACHMENTS_INVALID');
        for (const attachment of row.attachments || []) {
          if (!auditNumericId(attachment?.id)) throw new Error('INTAKE_AUDIT_ATTACHMENT_ID_INVALID');
          origins.push({ attachment_id: 'chatwoot-attachment:' + attachment.id, artifact_kind: 'attachment' });
        }
        if (new Set(origins.map(origin => origin.attachment_id)).size !== origins.length) throw new Error('INTAKE_AUDIT_ATTACHMENT_ID_DUPLICATE');
        if (!origins.length) origins.push({ attachment_id: 'audit-notice:metadata-only', artifact_kind: 'notice' });
      }
      jobs.push({ partitionKey: 'conversation:' + conversation, messageId: String(row.id), receivedAt: new Date(time).toISOString(), origins,
        policyCode: inWindow ? 'not_external_incoming_message' : 'outside_received_window' });
    }
    result.cursor = next;
    if (next === null) result.conversationIndex++;
    result.lookupJobs = jobs; result.afterLookup = 'chatwoot_messages'; result.afterEvents = 'lookup';
    return result;
  }
  throw new Error('INTAKE_AUDIT_RESPONSE_PHASE_INVALID');
}

function auditOperationKey(context) {
  const payload = auditClone(context.payload || {});
  delete payload.run_token; delete payload.resume_request_id;
  return auditHash([context.target, context.action || null, context.url || null, payload]);
}

export function applyAuditFailure(context, errorCode, now) {
  const state = auditClone(context.state);
  const code = typeof errorCode === 'string' && /^[A-Z0-9_]{1,95}$/.test(errorCode) ? errorCode.toLowerCase() : 'audit_operation_failed';
  state.lastError = { stage: context.target, code, at: new Date(now).toISOString() };
  const operationKey = auditOperationKey(context);
  state.failureStreak = { operationKey, count: state.failureStreak?.operationKey === operationKey ? state.failureStreak.count + 1 : 1 };
  if (state.canary === true) { state.canaryPaused=true;state.halt=true;return state; }
  if (context.target === 'backend' || !state.sweepId) { state.halt = true; return state; }
  if (['gmail_metadata', 'gmail_notice_body'].includes(state.phase)) {
    const id = state.messageQueue[state.messageIndex].id;
    const known = state.noticeMessage?.origins || [], unsupportedIds = state.noticeMessage?.unsupportedIds || [];
    const attachmentDetails=state.noticeMessage?.attachmentDetails||[],receivedAt=state.noticeMessage?.internalDate?new Date(Number(state.noticeMessage.internalDate)).toISOString():null;
    state.messageIndex++;
    delete state.noticeMessage;
    if (known.length >= 200) return auditEvents(state, [...auditMessageEvents(state, { partitionKey: 'mailbox', messageId: id, receivedAt, origins: known, unsupportedIds, attachmentDetails }),
      { kind: 'failure', stage: 'metadata', code }], 'gmail_metadata');
    const origins = [...known, { attachment_id: 'audit-notice:metadata-failed', artifact_kind: 'notice' }];
    const events = auditMessageEvents(state, { partitionKey: 'mailbox', messageId: id, receivedAt, origins, unsupportedIds, attachmentDetails });
    const last = events[events.length - 1]; last.disposition = 'failed'; last.stage = 'metadata'; last.code = code;
    return auditEvents(state, events, 'gmail_metadata');
  }
  return auditEvents(state, [{ kind: 'failure', stage: context.target, code }], state.phase, true);
}

export function auditPersistenceRow(state, cfg, now = Date.now()) {
  const next = auditClone(state);
  if (next.busy || next.lease?.owner !== String(next.tick?.executionId) && !next.releaseLease) throw new Error('INTAKE_AUDIT_STATE_LEASE_NOT_OWNED');
  next.lease = next.releaseLease ? { owner: null, until: 0 } : { owner: String(next.tick.executionId), until: now + (cfg.leaseMillis || 900000) };
  next.revision++;
  const serialized = JSON.stringify(next);
  if (serialized.length > 1500000) throw new Error('INTAKE_AUDIT_STATE_CAPACITY_REVIEW_REQUIRED');
  return { collector_key: cfg.collectorId, state_json: serialized, revision: next.revision,
    row_id: state.rowId ?? null, expected_revision: state.revision };
}

export function verifyAuditPersistence(rows, expected) {
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0].collector_key !== expected.collector_key
    || rows[0].revision !== expected.revision || rows[0].state_json !== expected.state_json || !auditNumericId(rows[0].id)
    || expected.row_id !== null && String(rows[0].id) !== String(expected.row_id)) throw new Error('INTAKE_AUDIT_STATE_WRITE_UNPROVEN');
  return { ...JSON.parse(rows[0].state_json), rowId: rows[0].id };
}
