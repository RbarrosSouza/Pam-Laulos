import type { CollectedOrigin } from './collector.ts';
import type { GroupTask, VerifiedPdf, DeliveryOutcome, DispatchCallbacks } from './chatwoot.ts';

type Json = Record<string, unknown>;
export interface FallbackPorts {
  rpc(name: string, args: Json): Promise<Json>;
  groupState(documentId: string): Promise<string | null>;
  upload(bucket: string, path: string, bytes: Uint8Array): Promise<void>;
  download(bucket: string, path: string): Promise<Uint8Array>;
  failure(documentId: string | null, code: string): Promise<void>;
  readSavedOriginal?(document: Json): Promise<Uint8Array>;
  refreshOrigin?(origin: CollectedOrigin): Promise<CollectedOrigin>;
}
export interface FallbackTransport {
  downloadPdf(url: string, expected?: { sha256?: string; sizeBytes?: number }): Promise<VerifiedPdf>;
  sendGroupOnce(task: GroupTask, pdf: VerifiedPdf, callbacks: DispatchCallbacks): Promise<DeliveryOutcome>;
  reconcileGroup(task: GroupTask): Promise<DeliveryOutcome>;
}
export interface OriginResult { state: 'sent' | 'submitted' | 'uncertain' | 'preserved' | 'excluded' | 'failed'; durable: boolean; attempted?: boolean; documentId?: string; code?: string }
function object(value: unknown): Json { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('fallback_response_invalid'); return value as Json; }
function uuid(value: unknown): string { if (typeof value !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value)) throw new Error('fallback_identity_invalid'); return value; }
export async function sha256(bytes: Uint8Array): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)), b => b.toString(16).padStart(2, '0')).join(''); }
export function safeError(error: unknown): string { const code = error instanceof Error ? error.message : ''; return /^[a-z][a-z0-9_]{0,95}$/.test(code) ? code : 'fallback_operation_failed'; }
function field(value: unknown): string { if (typeof value !== 'string' || !value) throw new Error('fallback_response_invalid'); return value; }
export function groupTask(row: Json): GroupTask {
  const doc = object(row.document);
  if (!['reserved', 'submitted', 'uncertain', 'sent'].includes(String(row.status))) throw new Error('fallback_group_status_invalid');
  return { documentId: uuid(doc.id), deliveryId: uuid(row.id), leaseToken: uuid(row.lease_token), sha256: field(doc.sha256), sizeBytes: Number(doc.size_bytes),
    originalName: field(doc.original_name), receivedAt: field(doc.received_at), createdAt: field(row.created_at),
    status: row.status as GroupTask['status'], externalId: row.external_id == null ? null : String(row.external_id), configuredDestination: field(row.configured_destination ?? row.destination_key) };
}
export async function recordDelivery(ports: FallbackPorts, task: GroupTask, outcome: DeliveryOutcome): Promise<void> {
  await ports.rpc('complete_exam_document_delivery', { p_delivery_id: task.deliveryId, p_lease_token: task.leaseToken, p_outcome: {
    status: outcome.status, external_id: outcome.external_id ?? null, external_status: outcome.external_status, error: outcome.error ?? null,
  } });
}
/** One origin, one durable group identity. Storage verification never means Drive completed. */
export async function processFallbackOrigin(origin: CollectedOrigin, worker: string, ports: FallbackPorts, transport: FallbackTransport): Promise<OriginResult> {
  let documentId: string | null = null;
  let attempted = false;
  try {
    const source = { ...origin.source, metadata: { ...origin.source.metadata,
      attachment_url_sha256: origin.attachment.downloadUrl ? await sha256(new TextEncoder().encode(origin.attachment.downloadUrl)) : null } };
    const reserved = await ports.rpc('reserve_exam_intake_source', { p_source: source });
    if (reserved.excluded === true) return { state: 'excluded', durable: true };
    documentId = uuid(reserved.document_id);
    const document = object(reserved.document);
    if (document.deletion_state || document.identification_status === 'not_exam') return { state: 'excluded', durable: true, documentId };
    const group = await ports.groupState(documentId);
    if (group === 'sent' || group === 'waived') return { state: group === 'sent' ? 'sent' : 'excluded', durable: true, documentId };
    if (group === 'submitted' || group === 'uncertain') return { state: group, durable: true, documentId };
    attempted = true;
    let pdf: VerifiedPdf | null = null;
    // A preserved fallback remains useful even after the provider media URL expires.
    if (typeof document.sha256 === 'string' && Number(document.size_bytes) > 0) {
      let stored: Uint8Array | null = null;
      if (document.staging_bucket === 'exam_documents_staging' && document.staging_path === documentId + '/original.pdf') {
        try { stored = await ports.download('exam_documents_staging', documentId + '/original.pdf'); } catch { /* source may still recover a temporarily unreadable object */ }
      }
      if (!stored && document.file_status === 'saved' && ports.readSavedOriginal) {
        try { stored = await ports.readSavedOriginal(document); } catch { /* Drive may be the unavailable dependency */ }
      }
      if (stored) {
        if (stored.byteLength !== Number(document.size_bytes) || await sha256(stored) !== document.sha256) throw new Error('fallback_existing_original_mismatch');
        pdf = { bytes: stored, sha256: document.sha256, sizeBytes: stored.byteLength };
      }
    }
    if (!pdf) {
      if ((origin.missing || !origin.attachment.downloadUrl) && ports.refreshOrigin) {
        const fresh = await ports.refreshOrigin(origin);
        for (const key of ['channel', 'account_id', 'message_id', 'attachment_id'] as const) {
          if (fresh.source[key] !== origin.source[key]) throw new Error('fallback_refreshed_source_mismatch');
        }
        origin = fresh;
      }
      if (origin.missing || !origin.attachment.downloadUrl) throw new Error(origin.pendingReason || 'fallback_source_media_unavailable');
      pdf = await transport.downloadPdf(origin.attachment.downloadUrl, {
        ...(typeof document.sha256 === 'string' ? { sha256: document.sha256 } : {}),
        ...(document.size_bytes != null ? { sizeBytes: Number(document.size_bytes) } : origin.attachment.size != null ? { sizeBytes: origin.attachment.size } : {}),
      });
    }
    const staged = await ports.rpc('reserve_exam_fallback_original', { p_document_id: documentId, p_sha256: pdf.sha256, p_size_bytes: pdf.sizeBytes, p_worker: worker });
    if (staged.excluded === true) return { state: 'excluded', durable: true, documentId };
    documentId = uuid(staged.document_id);
    const canonical = object(staged.document);
    if (canonical.sha256 !== pdf.sha256 || Number(canonical.size_bytes) !== pdf.sizeBytes) throw new Error('fallback_canonical_bytes_mismatch');
    if (staged.already_saved !== true) {
      if (staged.claimed !== true && staged.already_verified !== true) throw new Error('fallback_original_reserved_elsewhere');
      const bucket = field(staged.bucket), path = field(staged.path);
      if (bucket !== 'exam_documents_staging' || path !== documentId + '/original.pdf') throw new Error('fallback_storage_path_invalid');
      if (staged.claimed === true) await ports.upload(bucket, path, pdf.bytes);
      const stored = await ports.download(bucket, path);
      if (stored.byteLength !== pdf.sizeBytes || await sha256(stored) !== pdf.sha256) throw new Error('fallback_storage_readback_mismatch');
      if (staged.claimed === true) {
        const proof = await ports.rpc('confirm_exam_fallback_original', { p_document_id: documentId, p_lease_token: uuid(staged.lease_token), p_sha256: pdf.sha256, p_size_bytes: pdf.sizeBytes });
        if (proof.verified !== true || proof.document_id !== documentId) throw new Error('fallback_storage_confirmation_unproven');
      }
    }
    const claim = await ports.rpc('reserve_exam_fallback_group', { p_document_id: documentId, p_worker: worker, p_min_age_seconds: 120 });
    if (claim.claimed !== true) return { state: 'preserved', durable: true, attempted, documentId, code: typeof claim.reason === 'string' ? claim.reason : 'group_not_claimed' };
    const task = groupTask(object(claim.task));
    if (task.documentId !== documentId || task.sha256 !== pdf.sha256 || task.sizeBytes !== pdf.sizeBytes) throw new Error('fallback_group_bytes_mismatch');
    const outcome = await transport.sendGroupOnce(task, pdf, { beginDispatch: async input => {
      const result = await ports.rpc('begin_exam_fallback_group_dispatch', { p_delivery_id: input.deliveryId, p_lease_token: input.leaseToken, p_content_sha256: input.contentSha256 });
      return { dispatch_allowed: result.dispatch_allowed === true };
    } });
    await recordDelivery(ports, task, outcome);
    return { state: outcome.status === 'failed' ? 'preserved' : outcome.status, durable: true, attempted, documentId, ...(outcome.error ? { code: outcome.error } : {}) };
  } catch (error) {
    const code = safeError(error);
    // Keep the source in the window for a later attempt. Never repeat a POST here.
    await ports.failure(documentId, code);
    return { state: 'failed', durable: false, attempted, ...(documentId ? { documentId } : {}), code };
  }
}
