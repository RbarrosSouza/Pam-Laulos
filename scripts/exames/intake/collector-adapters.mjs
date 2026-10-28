import crypto from 'node:crypto';

const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => { throw new Error(code); };
const opaqueId = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\x00-\x1f\x7f]/.test(value);
const numericId = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;

export class DiscoveryError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'DiscoveryError';
    this.code = code;
    this.details = details;
  }
}

function accountConfig(config) {
  if (!object(config) || !opaqueId(config.accountId) || !opaqueId(config.scopeKey) || !opaqueId(config.credentialRef)) fail('discovery_config_invalid');
  return config;
}

function timeWindow(config) {
  const start = Date.parse(config.receivedFrom), end = Date.parse(config.receivedThrough);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) fail('discovery_window_invalid');
  return { start, end, from: new Date(start).toISOString(), through: new Date(end).toISOString() };
}

function responseBody(response, provider) {
  if (!object(response) || response.status !== 200 || !object(response.body)) {
    throw new DiscoveryError('provider_page_unavailable', { provider, status: Number.isInteger(response?.status) ? response.status : null });
  }
  return response.body;
}

function request(url, config, headers = {}) {
  return { method: 'GET', url, headers: { Accept: 'application/json', ...headers }, credentialRef: config.credentialRef,
    followRedirects: false, timeoutMs: 30000 };
}

function parsedIds(rows, readId, maximum) {
  if (!Array.isArray(rows) || rows.length > maximum) fail('provider_page_shape_invalid');
  const ids = rows.map(readId);
  if (ids.some(value => !opaqueId(value) || value.length > 2048) || new Set(ids).size !== ids.length) fail('provider_page_ids_invalid');
  return ids;
}

export function createGmailAdapter(config) {
  accountConfig(config);
  const window = timeWindow(config);
  const base = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  base.searchParams.set('maxResults', '100');
  base.searchParams.set('includeSpamTrash', config.includeSpamTrash === true ? 'true' : 'false');
  base.searchParams.set('fields', 'messages(id,threadId),nextPageToken,resultSizeEstimate');
  base.searchParams.set('q', 'after:' + (Math.floor(window.start / 1000) - 1) + ' before:' + (Math.ceil(window.end / 1000) + 1));
  return {
    provider: 'gmail', scopeKey: config.scopeKey, partitionKey: 'mailbox', initialCursor: null,
    identity: { provider: 'gmail', accountId: config.accountId, scopeKey: config.scopeKey, receivedFrom: window.from,
      receivedThrough: window.through, includeSpamTrash: config.includeSpamTrash === true },
    buildRequest(cursor) {
      const url = new URL(base);
      if (cursor !== null) {
        if (!opaqueId(cursor)) fail('gmail_cursor_invalid');
        url.searchParams.set('pageToken', cursor);
      }
      return request(url.href, config);
    },
    parsePage(response) {
      const body = responseBody(response, 'gmail');
      const rows = body.messages === undefined ? [] : body.messages;
      const ids = parsedIds(rows, row => typeof row?.id === 'string' && /^[a-f\d]{8,64}$/i.test(row.id) ? row.id : null, 100);
      const nextCursor = body.nextPageToken ?? null;
      if (nextCursor !== null && !opaqueId(nextCursor)) fail('gmail_cursor_invalid');
      return { records: rows.map((row, index) => ({ id: ids[index], threadId: row.threadId || null })), nextCursor };
    },
  };
}

export function createOutlookAdapter(config) {
  accountConfig(config);
  const window = timeWindow(config);
  const user = config.userId ? 'users/' + encodeURIComponent(config.userId) : 'me';
  const base = new URL('https://graph.microsoft.com/v1.0/' + user + '/messages');
  base.searchParams.set('$top', '100');
  base.searchParams.set('$select', 'id,receivedDateTime,internetMessageId,hasAttachments,parentFolderId');
  base.searchParams.set('$filter', 'receivedDateTime ge ' + window.from + ' and receivedDateTime lt ' + window.through);
  const validateNext = value => {
    if (!opaqueId(value)) fail('outlook_next_link_invalid');
    const url = new URL(value);
    if (url.origin !== base.origin || url.pathname !== base.pathname || url.username || url.password || url.hash) fail('outlook_next_link_scope_invalid');
    return value;
  };
  return {
    provider: 'outlook', scopeKey: config.scopeKey, partitionKey: 'mailbox', initialCursor: null,
    identity: { provider: 'outlook', accountId: config.accountId, scopeKey: config.scopeKey, receivedFrom: window.from,
      receivedThrough: window.through, immutableIds: true, requestUser: user, folderScope: 'all_mailbox_messages' },
    buildRequest(cursor) {
      return request(cursor === null ? base.href : validateNext(cursor), config, { Prefer: 'IdType="ImmutableId"' });
    },
    parsePage(response) {
      const body = responseBody(response, 'outlook');
      const ids = parsedIds(body.value, row => row?.id, 100);
      const nextCursor = body['@odata.nextLink'] == null ? null : validateNext(body['@odata.nextLink']);
      return { records: body.value.map((row, index) => ({ id: ids[index], receivedAt: row.receivedDateTime || null,
        internetMessageId: row.internetMessageId || null, hasAttachments: row.hasAttachments ?? null, parentFolderId: row.parentFolderId || null })), nextCursor };
    },
  };
}

function chatwootBase(config) {
  accountConfig(config);
  if (!numericId(config.chatwootAccountId) || !numericId(config.inboxId)) fail('chatwoot_scope_invalid');
  const base = new URL(config.baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname)) fail('chatwoot_base_invalid');
  return base.origin + '/api/v1/accounts/' + config.chatwootAccountId;
}

export function createChatwootConversationsAdapter(config) {
  const base = chatwootBase(config);
  return {
    provider: 'chatwoot', scopeKey: config.scopeKey, partitionKey: 'inbox-conversations', recordKind: 'partition', initialCursor: 1,
    identity: { provider: 'chatwoot', accountId: config.accountId, scopeKey: config.scopeKey,
      instance: hash([base, String(config.chatwootAccountId)]), inboxId: String(config.inboxId) },
    buildRequest(cursor) {
      if (!Number.isSafeInteger(cursor) || cursor < 1) fail('chatwoot_page_invalid');
      return request(base + '/conversations?status=all&assignee_type=all&inbox_id=' + config.inboxId + '&page=' + cursor, config);
    },
    parsePage(response, cursor) {
      const body = responseBody(response, 'chatwoot');
      const ids = parsedIds(body.data?.payload, row => numericId(row?.id) ? String(row.id) : null, 100);
      if (body.data.payload.some(row => String(row.inbox_id) !== String(config.inboxId)
        || (row.account_id != null && String(row.account_id) !== String(config.chatwootAccountId)))) fail('chatwoot_conversation_scope_mismatch');
      return { records: ids.map(id => ({ id })), nextCursor: ids.length ? cursor + 1 : null };
    },
  };
}

export function createChatwootMessagesAdapter(config, conversationId) {
  const base = chatwootBase(config);
  if (!numericId(conversationId)) fail('chatwoot_conversation_invalid');
  return {
    provider: 'chatwoot', scopeKey: config.scopeKey, partitionKey: 'conversation:' + conversationId, initialCursor: null,
    identity: { provider: 'chatwoot', accountId: config.accountId, scopeKey: config.scopeKey,
      instance: hash([base, String(config.chatwootAccountId)]), inboxId: String(config.inboxId), conversationId: String(conversationId) },
    buildRequest(cursor) {
      if (cursor !== null && !numericId(cursor)) fail('chatwoot_message_cursor_invalid');
      return request(base + '/conversations/' + conversationId + '/messages' + (cursor === null ? '' : '?before=' + cursor), config);
    },
    parsePage(response, cursor) {
      const body = responseBody(response, 'chatwoot');
      const ids = parsedIds(body.payload, row => numericId(row?.id) ? String(row.id) : null, 100);
      if (body.payload.some(row => (row.conversation_id != null && String(row.conversation_id) !== String(conversationId))
        || (row.inbox_id != null && String(row.inbox_id) !== String(config.inboxId))
        || (row.account_id != null && String(row.account_id) !== String(config.chatwootAccountId)))) fail('chatwoot_message_scope_mismatch');
      if (cursor !== null && ids.some(id => Number(id) >= Number(cursor))) fail('chatwoot_cursor_not_progressing');
      return { records: body.payload.map((row, index) => ({ id: ids[index], receivedAt: row.created_at ?? null,
        conversationId: String(conversationId), messageType: row.message_type ?? null, private: row.private ?? null })),
      nextCursor: ids.length ? String(Math.min(...ids.map(Number))) : null };
    },
  };
}

export async function paginatedDiscovery({ adapter, http, ledger, continuationStore, continuationKey, budget = {}, clock = Date.now }) {
  if (typeof http !== 'function' || typeof ledger?.recordDiscoveryPage !== 'function' || typeof continuationStore?.load !== 'function'
    || typeof continuationStore?.save !== 'function' || typeof continuationStore?.clear !== 'function' || !opaqueId(continuationKey)) fail('discovery_dependencies_invalid');
  const limits = { maxPages: budget.maxPages ?? 10, maxRecords: budget.maxRecords ?? 1000, maxMillis: budget.maxMillis ?? 20000 };
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)) fail('discovery_budget_invalid');
  const identityHash = hash(adapter.identity);
  let state = await continuationStore.load(continuationKey);
  if (state === null || state === undefined) state = { version: 1, identityHash, cursor: adapter.initialCursor,
    seenCursorHashes: [], discoveredIds: [], pageCount: 0, complete: false };
  if (!object(state) || state.version !== 1 || state.identityHash !== identityHash || !Array.isArray(state.seenCursorHashes)
    || !Array.isArray(state.discoveredIds) || !Number.isSafeInteger(state.pageCount)) fail('discovery_continuation_mismatch');
  state = clone(state);
  if (state.complete) return { coverageComplete: true, checkpointAdvanced: false, pageCount: state.pageCount, messageIds: state.discoveredIds, continuation: null };
  const started = clock();
  let pagesThisCall = 0, recordsThisCall = 0;
  try {
    while (pagesThisCall < limits.maxPages && recordsThisCall < limits.maxRecords && clock() - started < limits.maxMillis) {
      const requestCursorHash = hash(state.cursor);
      if (state.seenCursorHashes.includes(requestCursorHash)) throw new DiscoveryError('discovery_pagination_cycle');
      const page = adapter.parsePage(await http(adapter.buildRequest(state.cursor)), state.cursor);
      if (!Array.isArray(page.records) || page.records.some(record => !opaqueId(record?.id))) throw new DiscoveryError('discovery_page_invalid');
      const nextCursorHash = page.nextCursor === null ? null : hash(page.nextCursor);
      if (nextCursorHash === requestCursorHash || (nextCursorHash !== null && state.seenCursorHashes.includes(nextCursorHash))) throw new DiscoveryError('discovery_pagination_cycle');
      const ids = page.records.map(record => record.id);
      const pageKey = hash([identityHash, adapter.partitionKey, requestCursorHash, ids, nextCursorHash]);
      await ledger.recordDiscoveryPage({ provider: adapter.provider, scopeKey: adapter.scopeKey, partitionKey: adapter.partitionKey,
        recordKind: adapter.recordKind || 'message', pageKey, requestCursorHash, nextCursorHash, isTerminal: page.nextCursor === null,
        messageIds: adapter.recordKind === 'partition' ? [] : ids, records: page.records, digest: hash(page.records) });
      state.seenCursorHashes.push(requestCursorHash);
      state.discoveredIds = [...new Set([...state.discoveredIds, ...ids])];
      state.pageCount++;
      state.cursor = page.nextCursor;
      state.complete = page.nextCursor === null;
      await continuationStore.save(continuationKey, clone(state));
      pagesThisCall++;
      recordsThisCall += ids.length;
      if (state.complete) return { coverageComplete: true, checkpointAdvanced: false, pageCount: state.pageCount, messageIds: state.discoveredIds,
        pagesThisCall, recordsThisCall, continuation: null };
    }
    return { coverageComplete: false, checkpointAdvanced: false, pageCount: state.pageCount, messageIds: state.discoveredIds,
      pagesThisCall, recordsThisCall, continuation: { key: continuationKey, identityHash }, reason: 'execution_budget_reached' };
  } catch (error) {
    const failure = { provider: adapter.provider, scopeKey: adapter.scopeKey, partitionKey: adapter.partitionKey,
      stage: 'discovery', code: error instanceof DiscoveryError ? error.code : /^[a-z][a-z0-9_]{0,95}$/.test(error?.message || '') ? error.message : 'discovery_failed', requestCursorHash: hash(state.cursor),
      status: error instanceof DiscoveryError ? error.details.status ?? null : null };
    if (typeof ledger.recordFailure === 'function') await ledger.recordFailure(failure);
    throw new DiscoveryError(failure.code, failure);
  }
}

export async function discoverChatwoot({ config, http, ledger, continuationStore, budget, sweepKey, clock = Date.now }) {
  const started = clock();
  const maxPages = budget?.maxPages ?? 10, maxRecords = budget?.maxRecords ?? 1000, maxMillis = budget?.maxMillis ?? 20000;
  let pages = 0, records = 0;
  const remaining = () => ({ maxPages: Math.max(1, maxPages - pages), maxRecords: Math.max(1, maxRecords - records), maxMillis: Math.max(1, maxMillis - (clock() - started)) });
  const run = async (adapter, key) => {
    const result = await paginatedDiscovery({ adapter, http, ledger, continuationStore, budget: remaining(), continuationKey: key, clock });
    pages += result.pagesThisCall || 0; records += result.recordsThisCall || 0;
    return result;
  };
  const conversations = await run(createChatwootConversationsAdapter(config), sweepKey + ':conversations');
  if (!conversations.coverageComplete) return { coverageComplete: false, checkpointAdvanced: false, reason: conversations.reason, pagesThisCall: pages, recordsThisCall: records };
  const allMessages = new Set();
  let pageCount = conversations.pageCount;
  for (const conversationId of conversations.messageIds) {
    const key = sweepKey + ':conversation:' + conversationId;
    const cached = await continuationStore.load(key);
    if (!cached?.complete && (pages >= maxPages || records >= maxRecords || clock() - started >= maxMillis)) {
      return { coverageComplete: false, checkpointAdvanced: false, reason: 'execution_budget_reached', pagesThisCall: pages, recordsThisCall: records };
    }
    const result = await run(createChatwootMessagesAdapter(config, conversationId), key);
    result.messageIds.forEach(id => allMessages.add(JSON.stringify([String(conversationId), id])));
    pageCount += result.pageCount;
    if (!result.coverageComplete) return { coverageComplete: false, checkpointAdvanced: false, reason: result.reason, pagesThisCall: pages, recordsThisCall: records };
  }
  return { coverageComplete: true, checkpointAdvanced: false, expectedMessageCount: allMessages.size, pageCount,
    pagesThisCall: pages, recordsThisCall: records };
}
