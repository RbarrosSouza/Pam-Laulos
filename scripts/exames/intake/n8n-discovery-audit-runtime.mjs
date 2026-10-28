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
  const identityHash = auditHash([auditManifest(cfg), cfg.chatwootBaseUrl || null, cfg.serviceUrl]);
  if (state && (state.version !== 2 || state.identityHash !== identityHash || !Number.isSafeInteger(actual[0].revision)
    || state.revision !== actual[0].revision)) throw new Error('INTAKE_AUDIT_STATE_IDENTITY_INVALID');
  if (actual.length && !auditNumericId(actual[0].id)) throw new Error('INTAKE_AUDIT_STATE_ROW_ID_INVALID');
  if (state && state.phase !== 'done' && state.lease?.owner && state.lease.owner !== String(executionId) && state.lease.until > now) return { ...state, busy: true };
  if (!state || state.phase === 'done') state = { version: 2, identityHash, revision: actual[0]?.revision || 0, requestId: crypto.randomUUID(),
    receivedFrom: new Date(Math.max(Date.parse(cfg.intakeCutoff), now - cfg.auditLookbackSeconds * 1000)).toISOString(), receivedThrough: new Date(now - 1000).toISOString(), phase: 'begin', pageCount: 0, messageCount: 0,
    messageKeys: [], conversationIds: [], conversationIndex: 0, cursor: cfg.provider === 'gmail' ? null : 1,
    pendingEvents: [], messageQueue: [], messageIndex: 0, messagesAudited: 0, originsPending: 0, originsSaved: 0, lookupJobs: [], enumerationDone: false };
  if (Date.parse(state.receivedThrough) <= Date.parse(state.receivedFrom)) throw new Error('INTAKE_AUDIT_WINDOW_INVALID');
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

export function nextAuditOperation(input, cfg, now) {
  const state = auditClone(input);
  if (state.releaseLease) return { target: 'stop', state, result: state.finalResult };
  if (state.phase === 'done') return { target: 'stop', state, result: { ...state.finishResult, continuationRequired: false, auditOnly: true, monitoring: false,
    receivedFrom: state.receivedFrom, receivedThrough: state.receivedThrough, messagesAudited: state.messagesAudited, originsPending: state.originsPending, originsSaved: state.originsSaved } };
  if (state.halt || state.tick.actions >= cfg.maxActions || now - state.tick.startedAt > cfg.maxMillis) return { target: 'stop', state,
    result: { coverageComplete: false, scanFinished: false, checkpointAdvanced: false, continuationRequired: true,
      auditOnly: true, monitoring: false, receivedFrom: state.receivedFrom, receivedThrough: state.receivedThrough,
      lastError: state.lastError || null, messagesAudited: state.messagesAudited, originsPending: state.originsPending, originsSaved: state.originsSaved } };
  state.tick.actions++;
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
    + '&fields=' + encodeURIComponent('messages(id),nextPageToken') + '&q=' + encodeURIComponent(auditWindowQuery(state))
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

function auditMessageEvents(state, { partitionKey, messageId, receivedAt, origins, policyCode, lookupItems = [], unsupportedIds = [] }) {
  const events = [];
  if (receivedAt) events.push({ kind: 'message_discovered', partition_key: partitionKey, message_id: messageId, received_at: receivedAt });
  events.push({ kind: 'origins_declared', partition_key: partitionKey, message_id: messageId, origins,
    ...(origins.length ? {} : { policy_code: policyCode }) });
  for (const [index, origin] of origins.entries()) {
    const item = lookupItems[index];
    const unsupported = unsupportedIds.includes(origin.attachment_id), saved = item?.status === 'saved' && !unsupported;
    events.push({ kind: 'origin_outcome', partition_key: partitionKey, message_id: messageId,
      attachment_id: origin.attachment_id, disposition: saved ? 'saved' : 'pending',
      ...(saved ? { source_id: item.source_id, document_id: item.document_id }
        : { stage: 'review', code: unsupported ? 'unsupported_attachment_requires_review' : origin.artifact_kind === 'notice' ? 'audit_notice_requires_review' : item?.reason || 'audit_preservation_not_verified' }) });
    if (saved) state.originsSaved++; else state.originsPending++;
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
      || !['saved', 'pending', 'not_found'].includes(item.status) || !/^[a-z0-9_]{1,95}$/.test(item.reason || '')) throw new Error('INTAKE_AUDIT_LOOKUP_IDENTITY_INVALID');
    if (item.status === 'saved' && (item.match_kind !== 'exact_origin' || item.canonical_file_preserved !== true
      || !auditUuid(item.source_id) || !auditUuid(item.document_id) || item.source_document_id !== item.document_id || !/^[a-f0-9]{64}$/.test(item.sha256 || '')
      || !Number.isSafeInteger(item.size_bytes) || item.size_bytes <= 0 || item.file_status !== 'saved')) throw new Error('INTAKE_AUDIT_LOOKUP_SAVED_UNPROVEN');
  }
  return body.items.map(item => ({ message_id: item.message_id, attachment_id: item.attachment_id, status: item.status, reason: item.reason,
    ...(item.status === 'saved' ? { source_id: item.source_id, document_id: item.document_id } : {}) }));
}

function auditGmailOrigins(body, allowBodyData = false) {
  const origins = [], unsupportedIds = [], seen = new Set(); let hasPdf = false;
  let count = 0;
  const visit = (part, depth) => {
    if (!auditObject(part) || depth > 8 || ++count > 1000 || typeof part.partId !== 'string' || typeof part.mimeType !== 'string'
      || !allowBodyData && part.body?.data !== undefined || part.parts !== undefined && !Array.isArray(part.parts)
      || part.body !== undefined && !auditObject(part.body) || part.filename !== undefined && typeof part.filename !== 'string') throw new Error('INTAKE_AUDIT_MIME_INCOMPLETE');
    if (seen.has(part.partId)) throw new Error('INTAKE_AUDIT_MIME_PART_DUPLICATE');
    seen.add(part.partId);
    const pdf = part.mimeType.toLowerCase() === 'application/pdf' || /\.pdf$/i.test(part.filename || '');
    if (pdf || part.body?.attachmentId !== undefined || typeof part.filename === 'string' && part.filename.length > 0) {
      const attachment = part.body?.attachmentId ?? null;
      if (attachment !== null && !auditId(attachment)) throw new Error('INTAKE_AUDIT_ATTACHMENT_INVALID');
      const key = 'gmail-part:' + JSON.stringify([part.partId, attachment]);
      origins.push({ attachment_id: key, artifact_kind: 'attachment' });
      if (pdf) hasPdf = true; else unsupportedIds.push(key);
    }
    for (const child of part.parts || []) visit(child, depth + 1);
  };
  visit(body.payload, 0);
  if (origins.length > 200) throw new Error('INTAKE_AUDIT_ORIGIN_LIMIT_REVIEW_REQUIRED');
  return { origins, hasPdf, unsupportedIds };
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
  const status = response?.statusCode, body = response?.body;
  if (status !== 200 || !auditObject(body)) {
    return applyAuditFailure(context, 'AUDIT_PROVIDER_OR_BACKEND_UNAVAILABLE', now);
  }
  if (context.target === 'backend') {
    if (context.action === 'intake_begin') {
      if (!auditUuid(body.sweep_id) || !auditUuid(body.run_token) || body.mode !== 'audit') throw new Error('INTAKE_AUDIT_BEGIN_ACK_INVALID');
      state.sweepId = body.sweep_id; state.runToken = body.run_token;
      state.phase = cfg.provider === 'gmail' ? 'gmail_list' : 'chatwoot_conversations';
    } else if (context.action === 'intake_event') {
      if (body.recorded !== true || body.sweep_id !== state.sweepId) throw new Error('INTAKE_AUDIT_EVENT_ACK_INVALID');
      if (state.phase === 'enumeration') { state.enumerationDone = true; state.phase = 'finish'; }
      else state.pendingEvents.shift();
    } else if (context.action === 'intake_finish') {
      if (typeof body.coverageComplete !== 'boolean' || typeof body.scanFinished !== 'boolean' || body.checkpointAdvanced !== false) throw new Error('INTAKE_AUDIT_FINISH_ACK_INVALID');
      state.phase = 'done'; state.finishResult = body;
    } else if (context.action === 'intake_lookup_source') {
      const items = validateAuditLookup(body, context.payload.identities), job = state.lookupJobs[0];
      job.lookupItems = [...(job.lookupItems || []), ...items];
      job.lookupOffset = (job.lookupOffset || 0) + items.length;
      if (job.lookupOffset >= job.origins.length) {
        state.lookupJobs.shift();
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
    const inventory = inWindow ? auditGmailOrigins(body) : { origins: [], hasPdf: false, unsupportedIds: [] };
    const notice = inWindow && !inventory.hasPdf ? auditGmailNoticeIdentity(body) : null;
    if (notice?.candidate) {
      state.noticeMessage = { id: expected, internalDate: body.internalDate, identityHash: notice.identityHash,
        origins: inventory.origins, unsupportedIds: inventory.unsupportedIds };
      state.phase = 'gmail_notice_body';
      return state;
    }
    const origins = inventory.origins.length || !inWindow ? inventory.origins : [{ attachment_id: 'audit-notice:metadata-only', artifact_kind: 'notice' }];
    state.messageIndex++;
    return auditLookupJobs(state, [{ partitionKey: 'mailbox', messageId: expected, receivedAt, origins, unsupportedIds: inventory.unsupportedIds, policyCode: 'outside_received_window' }], 'gmail_metadata');
  }
  if (state.phase === 'gmail_notice_body') {
    const expected = state.noticeMessage, identity = auditGmailNoticeIdentity(body);
    if (body.id !== expected.id || body.internalDate !== expected.internalDate || !identity.candidate || identity.identityHash !== expected.identityHash) throw new Error('INTAKE_AUDIT_NOTICE_IDENTITY_CHANGED');
    const inventory = auditGmailOrigins(body, true);
    if (inventory.hasPdf || auditHash(inventory.origins) !== auditHash(expected.origins)) throw new Error('INTAKE_AUDIT_NOTICE_MIME_CHANGED');
    const origins = [...expected.origins, ...auditGmailNoticeOrigins(body)], receivedAt = new Date(Number(body.internalDate)).toISOString();
    if (origins.length > 200) throw new Error('INTAKE_AUDIT_ORIGIN_LIMIT_REVIEW_REQUIRED');
    state.messageIndex++; delete state.noticeMessage;
    return auditLookupJobs(state, [{ partitionKey: 'mailbox', messageId: expected.id, receivedAt, origins, unsupportedIds: expected.unsupportedIds }], 'gmail_metadata');
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

export function applyAuditFailure(context, errorCode, now) {
  const state = auditClone(context.state);
  const code = typeof errorCode === 'string' && /^[A-Z0-9_]{1,95}$/.test(errorCode) ? errorCode.toLowerCase() : 'audit_operation_failed';
  state.lastError = { stage: context.target, code, at: new Date(now).toISOString() };
  if (context.target === 'backend' || !state.sweepId) { state.halt = true; return state; }
  if (['gmail_metadata', 'gmail_notice_body'].includes(state.phase)) {
    const id = state.messageQueue[state.messageIndex].id;
    const known = state.noticeMessage?.origins || [], unsupportedIds = state.noticeMessage?.unsupportedIds || [];
    state.messageIndex++;
    delete state.noticeMessage;
    if (known.length >= 200) return auditEvents(state, [...auditMessageEvents(state, { partitionKey: 'mailbox', messageId: id, origins: known, unsupportedIds }),
      { kind: 'failure', stage: 'metadata', code }], 'gmail_metadata');
    const origins = [...known, { attachment_id: 'audit-notice:metadata-failed', artifact_kind: 'notice' }];
    const events = auditMessageEvents(state, { partitionKey: 'mailbox', messageId: id, origins, unsupportedIds });
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
