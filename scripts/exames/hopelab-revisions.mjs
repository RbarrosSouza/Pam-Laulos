import { createHash } from 'node:crypto';

// One notice is one receipt, even when the laboratory reuses its download URL.
export function hopelabNoticeKey(mailbox, messageId, canonicalUrl) {
  if (![mailbox, messageId, canonicalUrl].every(value => typeof value === 'string' && value.trim())) {
    throw new Error('hopelab_notice_identity_invalid');
  }
  const urlHash = createHash('sha256').update(canonicalUrl).digest('hex');
  return { channel: 'email', account_id: `gmail:${mailbox}`, message_id: messageId,
    attachment_id: `hopelab-link:${urlHash}` };
}

// Different bytes are retained for review; they alone cannot prove a clinical change.
export function assessHopelabRevision(previous, current) {
  const valid = value => value && /^[a-f0-9]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.sizeBytes) && value.sizeBytes > 0;
  if (!valid(current) || (previous != null && !valid(previous))) throw new Error('hopelab_revision_unproven');
  if (!previous) return 'first_version';
  return previous.sha256 === current.sha256 && previous.sizeBytes === current.sizeBytes
    ? 'same_bytes' : 'preserve_and_review';
}
