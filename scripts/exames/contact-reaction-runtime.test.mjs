import test from 'node:test';
import assert from 'node:assert/strict';
import { contactReactionConfiguration, verifyContactReactionActor, prepareContactReactionTasks, verifyContactReactionGroup,
  inspectContactReactionMessages, contactReactionDispatchPermission, classifyContactReactionSubmission, contactReactionDiagnostic } from './contact-reaction-runtime.mjs';

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
const inspect = (messages, c = context(), after = false) => inspectContactReactionMessages(messages, c, cfg, after);

test('configuration, credential actor and worker identity are verified before a task can exist', () => {
  assert.equal(cfg.verifiedActorId, 1); assert.equal(context().scan_after, '1497');
  for (const patch of [{ enabled: false }, { expectedActorId: null }, { maxMessagePages: 21 }, { emoji: '👍' }, { chatwootBaseUrl: 'http://support.invalid' },
    { worker: 'a'.repeat(95) }, { diagnosticTarget: task }]) assert.throws(() => contactReactionConfiguration({ ...raw, ...patch }, { id: 'run' }));
  assert.throws(() => verifyContactReactionActor({ id: 2 }, cfg), /ACTOR_MISMATCH/);
  assert.throws(() => verifyContactReactionActor({ id: 1, accounts: [{ id: 4 }] }, cfg), /ACCOUNT_MISMATCH/);
  for (const patch of [{ actor_id: 2 }, { destination_key: 'other' }, { sha256: 'bad' }, { emoji: '👍' }, { external_message_id: '../x' }, { lease_token: null }])
    assert.throws(() => prepareContactReactionTasks({ tasks: [{ ...task, ...patch }] }, cfg));
  assert.throws(() => prepareContactReactionTasks({ tasks: [task, task] }, cfg), /DUPLICATE_TARGET/);
  assert.equal(prepareContactReactionTasks({ tasks: [{ ...task, external_message_id: '9999999999999999999' }] }, cfg)[0].scan_after, '9999999999999999998');
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
  const before = inspect(pages(original()));
  const granted = contactReactionDispatchPermission({ dispatch_allowed: true, reaction_id: reservation, external_message_id: '1498' }, before, cfg);
  assert.equal(granted.dispatch_allowed, true);
  assert.equal(contactReactionDispatchPermission({ dispatch_allowed: false }, before, cfg).postRequired, false);
  assert.throws(() => contactReactionDispatchPermission({ dispatch_allowed: true, reaction_id: reservation }, { ...before, reconcile_only: true }, cfg));
  assert.throws(() => classifyContactReactionSubmission({ statusCode: 200 }, before), /WITHOUT_PERMISSION/);
  assert.equal(classifyContactReactionSubmission({ statusCode: 200 }, granted).outcome.status, 'submitted');
  assert.equal(classifyContactReactionSubmission({ error: 'lost response' }, granted).outcome.status, 'uncertain');
  assert.equal(inspect(pages(original(), reaction({ status: 'delivered' })), granted, true).outcome.status, 'confirmed');
  assert.equal(contactReactionDiagnostic(inspect(pages(original(), reaction()), granted, true)).inspection, 'confirmed');
  for (const patch of [{ content: 'changed' }, { attachments: [{ id: 902, file_type: 'file' }] }])
    assert.equal(inspect(pages({ ...original(), ...patch }, reaction()), granted, true).outcome.error_code, 'REACTION_ORIGINAL_CHANGED');
  assert.equal(inspect(pages(original()), granted, true).outcome.error_code, 'REACTION_NOT_OBSERVED_NO_RETRY');
});
