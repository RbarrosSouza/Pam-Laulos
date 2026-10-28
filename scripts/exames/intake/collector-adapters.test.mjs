import test from 'node:test';
import assert from 'node:assert/strict';
import { createGmailAdapter, createOutlookAdapter, createChatwootConversationsAdapter, createChatwootMessagesAdapter,
  paginatedDiscovery, discoverChatwoot } from './collector-adapters.mjs';

const config = { accountId: 'synthetic-mailbox', scopeKey: 'fixture-scope', credentialRef: 'existing-credential-reference',
  receivedFrom: '2026-10-27T00:00:00Z', receivedThrough: '2026-10-28T00:00:00Z' };
const chatwoot = { ...config, baseUrl: 'https://support.example.invalid', chatwootAccountId: 1, inboxId: 2 };
const response = body => ({ status: 200, body });
function harness(pages) {
  const state = new Map(), events = [], calls = [], failures = [];
  let writesPending = 0;
  return { state, events, calls, failures,
    http: async request => {
      assert.equal(writesPending, 0, 'previous page ledger write must finish before requesting another page');
      assert.equal(request.method, 'GET'); assert.equal(request.followRedirects, false);
      calls.push(request);
      const page = pages.shift();
      if (page instanceof Error) throw page;
      return typeof page === 'function' ? page(request) : response(page);
    },
    ledger: {
      recordDiscoveryPage: async page => {
        writesPending++;
        await Promise.resolve();
        events.push(structuredClone(page));
        writesPending--;
      },
      recordFailure: async failure => { failures.push(failure); },
    },
    continuationStore: {
      load: async key => state.has(key) ? structuredClone(state.get(key)) : null,
      save: async (key, value) => { state.set(key, structuredClone(value)); },
      clear: async key => { state.delete(key); },
    },
  };
}

test('Gmail discovers all IDs without filename, subject, read-status or attachment filters and persists every page', async () => {
  const fixture = harness([{ messages: [{ id: 'abcdef01' }, { id: 'abcdef02' }], nextPageToken: 'next-one' }, { messages: [{ id: 'abcdef03' }] }]);
  const result = await paginatedDiscovery({ adapter: createGmailAdapter(config), ...fixture, continuationKey: 'gmail-sweep' });
  assert.equal(result.coverageComplete, true);
  assert.equal(result.checkpointAdvanced, false);
  assert.deepEqual(result.messageIds, ['abcdef01', 'abcdef02', 'abcdef03']);
  assert.equal(fixture.events.length, 2);
  assert.deepEqual(fixture.events[0].messageIds, ['abcdef01', 'abcdef02']);
  const query = new URL(fixture.calls[0].url).searchParams.get('q');
  assert.match(query, /^after:\d+ before:\d+$/);
  assert(!/has:attachment|filename|subject|unread|from:/.test(query));
  assert.equal(new URL(fixture.calls[1].url).searchParams.get('pageToken'), 'next-one');
});

test('page budgets save continuation after entire pages and resume without slicing or claiming coverage', async () => {
  const fixture = harness([{ messages: [{ id: 'abcdef01' }, { id: 'abcdef02' }], nextPageToken: 'resume-token' }]);
  const adapter = createGmailAdapter(config);
  const partial = await paginatedDiscovery({ adapter, ...fixture, continuationKey: 'resume', budget: { maxPages: 1, maxRecords: 1 } });
  assert.equal(partial.coverageComplete, false);
  assert.equal(partial.checkpointAdvanced, false);
  assert.equal(partial.recordsThisCall, 2);
  assert.deepEqual(fixture.events[0].messageIds, ['abcdef01', 'abcdef02']);
  assert.equal(fixture.state.get('resume').cursor, 'resume-token');
  fixture.http = async request => { assert.equal(new URL(request.url).searchParams.get('pageToken'), 'resume-token'); return response({ messages: [{ id: 'abcdef03' }] }); };
  const completed = await paginatedDiscovery({ adapter, ...fixture, continuationKey: 'resume' });
  assert.equal(completed.coverageComplete, true);
  assert.equal(completed.pageCount, 2);
  assert.deepEqual(completed.messageIds, ['abcdef01', 'abcdef02', 'abcdef03']);
});

test('an uncommitted discovery page blocks the next provider request and leaves its cursor recoverable', async () => {
  const fixture = harness([{ messages: [{ id: 'abcdef01' }], nextPageToken: 'next' }, { messages: [{ id: 'abcdef02' }] }]);
  fixture.ledger.recordDiscoveryPage = async () => { throw new Error('transaction failed'); };
  await assert.rejects(paginatedDiscovery({ adapter: createGmailAdapter(config), ...fixture, continuationKey: 'failed' }), /discovery_failed/);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.state.has('failed'), false);
  assert.equal(fixture.failures.length, 1);
});

test('provider failures and repeated pagination tokens produce explicit global failures without advancing', async () => {
  const fixture = harness([{ messages: [{ id: 'abcdef01' }], nextPageToken: 'same' }, { messages: [{ id: 'abcdef02' }], nextPageToken: 'same' }]);
  await assert.rejects(paginatedDiscovery({ adapter: createGmailAdapter(config), ...fixture, continuationKey: 'cyclic' }), /pagination_cycle/);
  assert.equal(fixture.events.length, 1);
  assert.equal(fixture.state.get('cyclic').cursor, 'same');
  const limited = harness([() => ({ status: 429, body: { error: 'limited' } })]);
  await assert.rejects(paginatedDiscovery({ adapter: createGmailAdapter(config), ...limited, continuationKey: 'limited' }), /provider_page_unavailable/);
  assert.equal(limited.failures[0].status, 429);
});

test('Outlook keeps opaque case-sensitive immutable IDs and the full nextLink, including on every subsequent request', async () => {
  const next = 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=opaque%2FCase%3D&$select=id';
  const fixture = harness([{ value: [{ id: 'CaseSensitive+One=', hasAttachments: false }], '@odata.nextLink': next }, { value: [{ id: 'casesensitive+One=' }] }]);
  const result = await paginatedDiscovery({ adapter: createOutlookAdapter(config), ...fixture, continuationKey: 'outlook' });
  assert.deepEqual(result.messageIds, ['CaseSensitive+One=', 'casesensitive+One=']);
  assert.equal(fixture.calls[1].url, next);
  for (const request of fixture.calls) assert.equal(request.headers.Prefer, 'IdType="ImmutableId"');
  assert(!new URL(fixture.calls[0].url).searchParams.get('$filter').includes('hasAttachments'));
  assert.equal(fixture.events[0].records[0].hasAttachments, false);
});

test('Outlook refuses next links outside its configured account and Graph origin', () => {
  const adapter = createOutlookAdapter(config);
  for (const next of ['https://evil.example.invalid/collect', 'https://graph.microsoft.com/v1.0/users/other/messages?$skip=10',
    'https://user:secret@graph.microsoft.com/v1.0/me/messages']) {
    assert.throws(() => adapter.parsePage(response({ value: [], '@odata.nextLink': next })), /scope_invalid/);
  }
});

test('Chatwoot discovers all message IDs including notes, outgoing and missing attachments and paginates 21-message responses', async () => {
  const adapter = createChatwootMessagesAdapter(chatwoot, 300);
  const messages = Array.from({ length: 21 }, (_, index) => ({ id: 100 - index, conversation_id: 300, inbox_id: 2,
    message_type: index % 2, private: index % 3 === 0 }));
  const fixture = harness([{ payload: messages }, { payload: [] }]);
  const result = await paginatedDiscovery({ adapter, ...fixture, continuationKey: 'messages' });
  assert.equal(result.messageIds.length, 21);
  assert.equal(fixture.events[0].messageIds.length, 21);
  assert.match(fixture.calls[1].url, /messages\?before=80$/);
  assert.equal(result.coverageComplete, true);
});

test('Chatwoot inbox enumeration uses all statuses and records conversation discovery before its next page', async () => {
  const fixture = harness([{ data: { payload: [{ id: 300, inbox_id: 2 }] } }, { data: { payload: [] } }]);
  const result = await paginatedDiscovery({ adapter: createChatwootConversationsAdapter(chatwoot), ...fixture, continuationKey: 'conversations' });
  assert.deepEqual(result.messageIds, ['300']);
  assert.equal(fixture.events[0].recordKind, 'partition');
  assert.deepEqual(fixture.events[0].messageIds, []);
  assert.match(fixture.calls[0].url, /status=all&assignee_type=all&inbox_id=2&page=1$/);
  assert.match(fixture.calls[1].url, /page=2$/);
});

test('Chatwoot hierarchy resumes budgets across conversations without repeating completed partitions', async () => {
  const fixture = harness([{ data: { payload: [{ id: 300, inbox_id: 2 }, { id: 301, inbox_id: 2 }] } }, { data: { payload: [] } }]);
  const partial = await discoverChatwoot({ config: chatwoot, ...fixture, sweepKey: 'hierarchy', budget: { maxPages: 2 } });
  assert.equal(partial.coverageComplete, false);
  assert.equal(fixture.calls.length, 2);
  const messagePages = [{ payload: [{ id: 10, conversation_id: 300 }] }, { payload: [] }, { payload: [{ id: 20, conversation_id: 301 }] }, { payload: [] }];
  fixture.http = async request => { fixture.calls.push(request); return response(messagePages.shift()); };
  const completed = await discoverChatwoot({ config: chatwoot, ...fixture, sweepKey: 'hierarchy', budget: { maxPages: 4 } });
  assert.equal(completed.coverageComplete, true);
  assert.equal(completed.expectedMessageCount, 2);
  assert.equal(completed.pageCount, 6);
  assert.equal(fixture.calls.length, 6);
});

test('continuations cannot be reused for a different account, window or mailbox scope', async () => {
  const fixture = harness([{ messages: [{ id: 'abcdef01' }], nextPageToken: 'next' }]);
  await paginatedDiscovery({ adapter: createGmailAdapter(config), ...fixture, continuationKey: 'bound', budget: { maxPages: 1 } });
  await assert.rejects(paginatedDiscovery({ adapter: createGmailAdapter({ ...config, accountId: 'another-mailbox' }), ...fixture, continuationKey: 'bound' }), /continuation_mismatch/);
});

test('unexpected oversized provider pages fail explicitly before any inventory can be truncated', async () => {
  const messages = Array.from({ length: 101 }, (_, index) => ({ id: (0xabcdef00 + index).toString(16) }));
  const testFixture = harness([{ messages, nextPageToken: 'next' }]);
  await assert.rejects(paginatedDiscovery({ adapter: createGmailAdapter(config), ...testFixture, continuationKey: 'oversized' }), /provider_page_shape_invalid/);
  assert.equal(testFixture.events.length, 0); assert.equal(testFixture.calls.length, 1);
  assert.equal(testFixture.failures[0].code, 'provider_page_shape_invalid');
});

test('private continuations bind the real Graph request user and Chatwoot instance as well as account labels', async () => {
  const graph = harness([{ value: [{ id: 'message-one' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=next' }]);
  await paginatedDiscovery({ adapter: createOutlookAdapter(config), ...graph, continuationKey: 'graph-user', budget: { maxPages: 1 } });
  await assert.rejects(paginatedDiscovery({ adapter: createOutlookAdapter({ ...config, userId: 'different-user' }), ...graph, continuationKey: 'graph-user' }), /continuation_mismatch/);
  const support = harness([{ data: { payload: [{ id: 300, inbox_id: 2 }] } }]);
  await paginatedDiscovery({ adapter: createChatwootConversationsAdapter(chatwoot), ...support, continuationKey: 'support-instance', budget: { maxPages: 1 } });
  await assert.rejects(paginatedDiscovery({ adapter: createChatwootConversationsAdapter({ ...chatwoot, baseUrl: 'https://different.example.invalid' }),
    ...support, continuationKey: 'support-instance' }), /continuation_mismatch/);
});
