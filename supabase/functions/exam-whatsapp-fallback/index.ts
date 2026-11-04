import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.99.3';
import { selectExamSupabasePrivilegedKey } from '../exam-document-service/supabase-privileged-key.ts';
import { readOAuthDriveOriginal, oauthDriveReaderConfig } from '../exam-document-service/composio-original-reader.ts';
import { createChatwootClient } from './chatwoot.ts';
import { authenticateFallbackRequest } from './auth.ts';
import { collectWhatsappOrigins, inspectFallbackMessage, verifyFallbackSourceConversation, type CollectedOrigin, type CollectorConfig, type CollectorCursor, type CollectorResult } from './collector.ts';
import { processFallbackOrigin, fallbackRetrySeconds, groupTask, recordDelivery, safeError, sha256, type FallbackPorts } from './runner.ts';

type Json = Record<string, unknown>;
function obj(x: unknown): Json { if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error('fallback_response_invalid'); return x as Json; }
function str(x: unknown): string { if (typeof x !== 'string' || !x) throw new Error('fallback_configuration_invalid'); return x; }
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }
async function requestText(req: Request): Promise<string> {
  if (Number(req.headers.get('Content-Length') || 0) > 1024) throw new Error('body_too_large');
  const reader = req.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 1024) { await reader.cancel(); throw new Error('body_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
// Caller can trigger a configured run; cannot select recipients, source URLs or PDFs.
Deno.serve(async req => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const key = Deno.env.get('EXAM_FALLBACK_TRIGGER_KEY');
  if (!key) return json({ error: 'unauthorized' }, 401);
  let bodyText: string;
  try { bodyText = await requestText(req); } catch { return json({ error: 'invalid_body' }, 400); }
  if (!await authenticateFallbackRequest(req, key, bodyText)) return json({ error: 'unauthorized' }, 401);
  let runToken: string | null = null;
  let scan: Json = {};
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = selectExamSupabasePrivilegedKey(name => Deno.env.get(name));
  if (!url || !serviceKey) return json({ error: 'backend_not_configured' }, 503);
  let runRequestSignal: AbortSignal | undefined;
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: runRequestSignal ? AbortSignal.any([runRequestSignal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000) }) } });
  async function rpc(name: string, args: Json): Promise<Json> {
    const { data, error } = await service.rpc(name, args);
    if (error) throw new Error(['40001', 'PT409'].includes(error.code) ? 'fallback_fence_conflict' : error.code === '42501' ? 'fallback_scope_denied' : 'fallback_rpc_failed');
    return obj(data);
  }
  try {
    const body = obj(JSON.parse(bodyText));
    if (!['run', 'preflight'].includes(String(body.action)) || Object.keys(body).some(k => k !== 'action')) return json({ error: 'invalid_action' }, 400);
    if (!req.headers.has('Authorization')) {
      const consumed = await rpc('consume_exam_fallback_scheduler_trigger', {
        p_nonce: req.headers.get('x-exam-fallback-nonce'), p_timestamp: Number(req.headers.get('x-exam-fallback-timestamp')),
      });
      if (consumed.accepted !== true) return json({ error: 'expired_or_replayed_trigger' }, 401);
    }
    const { data: cfg, error: cfgError } = await service.from('exam_fallback_configuration').select('*').eq('singleton', true).single();
    if (cfgError || !cfg) throw new Error('fallback_schema_unavailable');
    if (!cfg.enabled && body.action === 'run') return json({ enabled: false, dispatched: 0 });
    const env = obj(JSON.parse(Deno.env.get('EXAM_FALLBACK_CONFIG') || '{}'));
    const apiAccessToken = Deno.env.get('EXAM_FALLBACK_CHATWOOT_API_TOKEN');
    if (!apiAccessToken) throw new Error('fallback_chatwoot_token_missing');
    const sourceAccount = /^chatwoot:([1-9]\d*):inbox:([1-9]\d*)$/.exec(str(cfg.source_account_id));
    if (!sourceAccount) throw new Error('fallback_source_scope_invalid');
    const { data: operational, error: opError } = await service.from('exam_document_configuration').select('group_destination_key,max_file_bytes').eq('singleton', true).single();
    if (opError || !operational) throw new Error('fallback_operational_config_unavailable');
    const dest = /^chatwoot:([1-9]\d*):([1-9]\d*):([1-9]\d*):([^:]+@g\.us)$/.exec(str(operational.group_destination_key));
    if (!dest || dest[1] !== sourceAccount[1] || dest[2] !== sourceAccount[2]) throw new Error('fallback_group_scope_invalid');
    if (!Array.isArray(env.authorizedSenders) || env.authorizedSenders.some(v => typeof v !== 'string')) throw new Error('fallback_sender_policy_missing');
    const maxBytes = Math.min(Number(operational.max_file_bytes), 20 * 1024 * 1024);
    const receivedFrom = new Date(str(cfg.received_from)).toISOString();
    const collectorConfig: CollectorConfig = { chatwootBaseUrl: str(env.chatwootBaseUrl), accountId: sourceAccount[1], inboxId: sourceAccount[2],
      knownConversationIds: [str(cfg.source_conversation_id)], authorizedSenders: env.authorizedSenders as string[], intakeCutoff: receivedFrom, maxBytes,
      allowBrazilLegacyMobileAlias: env.allowBrazilLegacyMobileAlias === true,
      allowedAttachmentOrigins: Array.isArray(env.allowedAttachmentOrigins) ? env.allowedAttachmentOrigins as string[] : [] };
    const transport = createChatwootClient({ baseUrl: collectorConfig.chatwootBaseUrl, apiAccessToken, accountId: sourceAccount[1], inboxId: sourceAccount[2],
      groupConversationId: dest[3], groupJid: dest[4], allowedAttachmentOrigins: collectorConfig.allowedAttachmentOrigins, maxBytes, timeoutMs: 15000,
      maxReconcilePages: 3, documentBaseUrl: str(env.documentBaseUrl) });
    if (body.action === 'preflight') {
      const access = await transport.preflightReadAccess(cfg.source_conversation_id);
      verifyFallbackSourceConversation(access.sourceConversation, collectorConfig);
      return json({ configured: true, enabled: cfg.enabled, scope: 'configured_conversation_only', fallbackRequiresChatwoot: true, dispatched: 0 });
    }
    const worker = 'fallback:' + crypto.randomUUID();
    const claim = await rpc('claim_exam_fallback_run', { p_worker: worker, p_max_seconds: 100 });
    if (claim.claimed !== true) return json({ claimed: false, reason: claim.reason || 'run_in_progress', dispatched: 0 });
    runToken = str(claim.run_token);
    scan = claim.scan && typeof claim.scan === 'object' ? obj(claim.scan) : {};
    const deadline = Date.now() + 80000;
    const runSignal = AbortSignal.timeout(70000);
    runRequestSignal = runSignal;
    const boundedTransport = {
      downloadPdf: (source: string, expected?: {sha256?: string; sizeBytes?: number}) => transport.downloadPdf(source, expected, runSignal),
      sendGroupOnce: (task: Parameters<typeof transport.sendGroupOnce>[0], pdf: Parameters<typeof transport.sendGroupOnce>[1], callbacks: Parameters<typeof transport.sendGroupOnce>[2]) => transport.sendGroupOnce(task, pdf, callbacks, runSignal),
      reconcileGroup: (task: Parameters<typeof transport.reconcileGroup>[0]) => transport.reconcileGroup(task, runSignal),
    };
    const ports: FallbackPorts = {
      rpc,
      groupState: async id => {
        const { data, error } = await service.from('exam_document_delivery').select('status,destination_key').eq('document_id', id).eq('destination', 'group');
        if (error) throw new Error('fallback_group_state_unavailable');
        const rows = (data || []).filter(r => ['default', operational.group_destination_key].includes(r.destination_key));
        return rows.find(r => r.status === 'sent')?.status ?? rows.find(r => r.status === 'uncertain' || r.status === 'submitted')?.status ?? rows[0]?.status ?? null;
      },
      upload: async (bucket, path, bytes) => {
        const { error } = await service.storage.from(bucket).upload(path, bytes, { contentType: 'application/pdf', upsert: false });
        // Conflict is accepted only after the separate full readback verifies the existing object.
        if (error && String(error.statusCode) !== '409') throw new Error('fallback_storage_upload_failed');
      },
      download: async (bucket, path) => {
        const { data, error } = await service.storage.from(bucket).download(path);
        if (error || !data || data.size > maxBytes) throw new Error('fallback_storage_read_failed');
        return new Uint8Array(await data.arrayBuffer());
      },
      readSavedOriginal: async doc => new Uint8Array(await readOAuthDriveOriginal({ fileId: doc.drive_file_id, folderId: doc.drive_folder_id, sha256: doc.sha256, sizeBytes: doc.size_bytes }, oauthDriveReaderConfig(name => Deno.env.get(name)), { timeoutMs: 5000, fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([runSignal, ...(init?.signal ? [init.signal] : [])]) }) })),
      refreshOrigin: async origin => {
        const conversationId = str(origin.source.metadata.chatwoot_conversation_id);
        if (conversationId !== cfg.source_conversation_id) throw new Error('fallback_source_scope_invalid');
        const conversation = await transport.getConversation(conversationId, runSignal);
        const before = (BigInt(origin.source.message_id) + 1n).toString();
        const rows = await transport.listMessages(conversationId, before, runSignal);
        const message = rows.find(r => String(r.id) === origin.source.message_id);
        if (!message) throw new Error('fallback_source_message_missing');
        const matches = inspectFallbackMessage(conversation, message, collectorConfig).filter(o => o.source.attachment_id === origin.source.attachment_id);
        if (matches.length !== 1) throw new Error('fallback_source_attachment_missing');
        return matches[0];
      },
      failure: async (id, code) => {
        if (!id) return;
        const { error } = await service.from('exam_document_event').insert({ document_id: id, event_type: 'fallback_failed', details: { code } });
        if (error) throw new Error('fallback_failure_record_unavailable');
      },
    };
    let reconciled = 0;
    const pending = await rpc('list_exam_fallback_group_reconciliation', { p_limit: 5 });
    const reconciliationSignal = AbortSignal.any([runSignal, AbortSignal.timeout(8000)]);
    for (const row of (Array.isArray(pending.tasks) ? pending.tasks : [])) {
      if (reconciliationSignal.aborted) break;
      const task = groupTask(obj(row));
      const outcome = await transport.reconcileGroup(task, reconciliationSignal);
      await recordDelivery(ports, task, outcome);
      reconciled++;
    }
    const io = { getConversation: (id: string, signal: AbortSignal) => transport.getConversation(id, AbortSignal.any([signal, runSignal])),
      getMessages: async (id: string, before: string | null, signal: AbortSignal) => ({ payload: await transport.listMessages(id, before ?? undefined, AbortSignal.any([signal, runSignal])) }) };
    const through = new Date(Date.now() - Number(cfg.minimum_age_seconds) * 1000).toISOString();
    const from = receivedFrom;
    if (Date.parse(through) <= Date.parse(from)) {
      runRequestSignal = undefined;
      await rpc('checkpoint_exam_fallback_run', { p_run_token: runToken, p_state: {}, p_completed: true, p_error_code: null });
      return json({ claimed: true, processed: 0, reconciled, dispatched: 0, waitingForGrace: true });
    }
    // Newest pages get priority every run, even while an old window needs recovery.
    const fast = await collectWhatsappOrigins(collectorConfig, io, { receivedFrom: from, receivedThrough: through, maxPages: 2, maxOrigins: 100, maxMillis: 12000 });
    const liveOrigins = new Map<string, CollectedOrigin>();
    const originKey = (source: { channel: unknown; account_id: unknown; message_id: unknown; attachment_id: unknown }) => JSON.stringify([source.channel, source.account_id, source.message_id, source.attachment_id]);
    let enqueued = 0;
    async function enqueue(result: CollectorResult): Promise<void> {
      for (const origin of result.origins) {
        if (runSignal.aborted) throw new Error('fallback_run_deadline');
        const source = { ...origin.source, metadata: { ...origin.source.metadata,
          attachment_url_sha256: origin.attachment.downloadUrl ? await sha256(new TextEncoder().encode(origin.attachment.downloadUrl)) : null } };
        await rpc('enqueue_exam_fallback_source', { p_source: source });
        // Already authorized media URLs live only for this run, never in the queue.
        liveOrigins.set(originKey(origin.source), origin);
        enqueued++;
      }
    }
    await enqueue(fast);
    let back: CollectorResult | null = null;
    if (Date.now() <= deadline - 40000) {
      const windowStart = typeof scan.window_start === 'string' ? scan.window_start : from;
      const windowEnd = typeof scan.window_end === 'string' ? scan.window_end : through;
      back = await collectWhatsappOrigins(collectorConfig, io, { receivedFrom: windowStart, receivedThrough: windowEnd,
        cursor: scan.cursor as CollectorCursor | undefined, maxPages: 2, maxOrigins: 100, maxMillis: 10000 });
      // Discovery advances after durable queueing. A poison PDF cannot stall discovery.
      await enqueue(back);
      scan = back.complete ? {} : { cursor: back.cursor, window_start: windowStart, window_end: windowEnd };
    }
    const results = [];
    for (let i = 0; i < 6 && Date.now() <= deadline - 30000 && !runSignal.aborted; i++) {
      const queue = await rpc('claim_exam_fallback_sources', { p_worker: worker, p_limit: 1 });
      const row = Array.isArray(queue.tasks) ? queue.tasks[0] : null;
      if (!row) break;
      const task = obj(row), source = obj(task.source), metadata = obj(source.metadata);
      const document = task.document && typeof task.document === 'object' ? obj(task.document) : {};
      const origin: CollectedOrigin = liveOrigins.get(originKey({channel: source.channel, account_id: source.account_id, message_id: source.message_id, attachment_id: source.attachment_id})) ?? {
        source: { channel: 'whatsapp', account_id: str(source.account_id), message_id: str(source.message_id), attachment_id: str(source.attachment_id),
          original_name: str(document.original_name), mime_type: 'application/pdf', received_at: str(source.received_at), metadata },
        attachment: { id: str(source.attachment_id), chatwootAttachmentId: str(metadata.chatwoot_attachment_id), name: str(document.original_name), contentType: 'application/pdf', size: null, downloadUrl: null },
        missing: true, pendingReason: 'fallback_source_media_unavailable',
      };
      const result = await processFallbackOrigin(origin, worker, ports, boundedTransport);
      results.push(result);
      const done = ['sent', 'submitted', 'uncertain', 'excluded'].includes(result.state);
      await rpc('finish_exam_fallback_source', { p_source_id: str(task.source_id), p_lease_token: str(task.lease_token),
        p_outcome: done ? 'done' : 'retry', p_error_code: done ? null : result.code || 'fallback_delivery_pending',
        p_retry_seconds: fallbackRetrySeconds(result, Number(task.attempts || 1)) });
    }
    const completed = Boolean(back?.complete && fast.reason !== 'source_error');
    const errorCode = fast.errorCode || back?.errorCode || null;
    runRequestSignal = undefined;
    await rpc('checkpoint_exam_fallback_run', { p_run_token: runToken, p_state: scan, p_completed: completed && !errorCode, p_error_code: errorCode });
    return json({ claimed: true, enqueued, processed: results.length, reconciled,
      counts: results.reduce<Record<string, number>>((a, r) => { a[r.state] = (a[r.state] || 0) + 1; return a; }, {}),
      complete: completed, coverageGuaranteed: false, scope: 'configured_conversation_only' });
  } catch (error) {
    const code = safeError(error);
    if (runToken) { try { runRequestSignal = undefined;
      await rpc('checkpoint_exam_fallback_run', { p_run_token: runToken, p_state: scan, p_completed: false, p_error_code: code }); } catch { /* expired lease cannot overwrite a newer run */ } }
    return json({ error: code, partial: Boolean(runToken), nextAction: 'reconcile_before_retry' }, 503);
  }
});
