import test from 'node:test';
import assert from 'node:assert/strict';
import { hopelabNoticeKey, assessHopelabRevision } from './hopelab-revisions.mjs';

test('separate notices using the same laboratory link remain separate receipts', () => {
  const first = hopelabNoticeKey('exam@example.invalid', 'first', 'https://example.invalid/result');
  const second = hopelabNoticeKey('exam@example.invalid', 'second', 'https://example.invalid/result');
  assert.notEqual(first.message_id, second.message_id);
  assert.equal(first.attachment_id, second.attachment_id);
  assert.deepEqual(first, hopelabNoticeKey('exam@example.invalid', 'first', 'https://example.invalid/result'));
});

test('identical bytes reuse the original; changed bytes remain visible for review', () => {
  const original = { sha256: 'a'.repeat(64), sizeBytes: 100 };
  assert.equal(assessHopelabRevision(null, original), 'first_version');
  assert.equal(assessHopelabRevision(original, { ...original }), 'same_bytes');
  assert.equal(assessHopelabRevision(original, { sha256: 'b'.repeat(64), sizeBytes: 100 }), 'preserve_and_review');
  assert.equal(assessHopelabRevision(original, { ...original, sizeBytes: 101 }), 'preserve_and_review');
  assert.throws(() => assessHopelabRevision(original, { sha256: '', sizeBytes: 0 }), /unproven/);
});
