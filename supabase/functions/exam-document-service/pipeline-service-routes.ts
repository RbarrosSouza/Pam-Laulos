type Json = Record<string, unknown>;
type Rpc = (name: string, args: Json) => Promise<unknown>;
type Helpers = { uuid: (value: unknown) => string; hash: (bytes: ArrayBuffer) => Promise<string> };
const stages = new Set(['processing', 'group', 'nexus', 'rename', 'reconcile']);
export const pipelineActions = new Set(['worker_acquire', 'worker_release', 'group_prepare', 'group_begin', 'group_reconcile', 'reserve_rename', 'rename_prepare', 'rename_result']);
function invalid(code: string): never { throw Object.assign(new Error(code), { status: 400 }); }
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('PIPELINE_OBJECT_REQUIRED');
  return value as Json;
}
function stage(value: unknown): string {
  if (typeof value !== 'string' || !stages.has(value)) invalid('PIPELINE_STAGE_INVALID');
  return value;
}
function worker(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) invalid('PIPELINE_WORKER_INVALID');
  return value;
}
export async function runPipelineAction(action: string, payload: Json, rpc: Rpc, helpers: Helpers) {
  const id = helpers.uuid;
  switch (action) {
    case 'worker_acquire': {
      const ttl = payload.lease_seconds ?? 660;
      if (!Number.isSafeInteger(ttl) || Number(ttl) < 60 || Number(ttl) > 900) invalid('PIPELINE_LEASE_INVALID');
      return rpc('acquire_exam_pipeline_worker', { p_stage: stage(payload.stage), p_worker: worker(payload.worker), p_lease_seconds: ttl });
    }
    case 'worker_release': return rpc('release_exam_pipeline_worker', { p_stage: stage(payload.stage), p_lease_token: id(payload.lease_token) });
    case 'group_prepare': return rpc('prepare_exam_group_dispatch', { p_delivery_id: id(payload.delivery_id), p_lease_token: id(payload.lease_token) });
    case 'group_begin': {
      if (typeof payload.presentation_revision !== 'string' || !/^[a-f0-9]{32}$/.test(payload.presentation_revision)) invalid('GROUP_PRESENTATION_REVISION_INVALID');
      // Hash the exact pending caption here. A worker-supplied hash cannot stand
      // in for the bytes whose submission the server is authorizing.
      if (typeof payload.content !== 'string' || !payload.content.trim() || payload.content.length > 12000 || payload.content.includes('\u0000')) invalid('GROUP_CONTENT_INVALID');
      return rpc('begin_exam_group_dispatch', { p_delivery_id: id(payload.delivery_id), p_lease_token: id(payload.lease_token),
        p_presentation_revision: payload.presentation_revision,
        p_content_sha256: await helpers.hash(new TextEncoder().encode(payload.content).buffer as ArrayBuffer) });
    }
    case 'group_reconcile': {
      const limit = payload.limit ?? 4;
      if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 4) invalid('PIPELINE_RECONCILE_LIMIT_INVALID');
      return rpc('list_exam_pipeline_group_reconciliation', { p_worker: worker(payload.worker), p_worker_lease_token: id(payload.worker_lease_token), p_limit: limit });
    }
    case 'reserve_rename': return rpc('reserve_exam_document_rename', { p_worker: worker(payload.worker), p_worker_lease_token: id(payload.worker_lease_token) });
    case 'rename_prepare': {
      if (!Number.isSafeInteger(payload.document_version) || Number(payload.document_version) < 1) invalid('RENAME_DOCUMENT_VERSION_INVALID');
      if (typeof payload.name !== 'string' || !payload.name.trim() || payload.name.length > 1024 || /[\u0000-\u001f\u007f]/.test(payload.name)) invalid('RENAME_NAME_INVALID');
      return rpc('prepare_exam_document_rename', { p_delivery_id: id(payload.delivery_id), p_lease_token: id(payload.lease_token), p_document_version: payload.document_version, p_name: payload.name });
    }
    case 'rename_result': return rpc('complete_exam_document_rename', { p_delivery_id: id(payload.delivery_id), p_lease_token: id(payload.lease_token), p_outcome: object(payload.outcome) });
    default: invalid('PIPELINE_ACTION_UNKNOWN');
  }
}

export function examPipelineWakeupStages(action: string, payload: Json, result: unknown): string[] {
  const value = result && typeof result === 'object' && !Array.isArray(result) ? result as Json : {};
  if (action === 'confirm_file') return ['processing'];
  if (action === 'extraction') return ['rename', 'nexus'];
  if (action === 'worker_release' && (payload.continue === true || value.has_more === true) && value.released === true && typeof payload.stage === 'string' && stages.has(payload.stage)) return [payload.stage];
  if (action === 'task_result') {
    const task = value.task && typeof value.task === 'object' ? value.task as Json : {};
    if (task.destination === 'processing' && task.status === 'completed') return ['group', 'nexus', 'rename'];
    if (task.destination === 'group' && ['submitted', 'uncertain'].includes(String(task.status)) && payload.reconciliation !== true) return ['reconcile'];
  }
  return [];
}

// The durable SQL task is the source of truth. These small, bounded requests
// only wake consumers after the preceding RPC committed. A lost wakeup leaves
// the task visible to the existing recovery schedules. Never send a PDF or
// patient fields in this notification, and never follow an auth-bearing redirect.
export async function dispatchExamPipelineWakeups(
  requested: string[], secret: string | undefined, rpc: Rpc,
  fetcher: typeof fetch = fetch,
): Promise<{ attempted: number; accepted: number }> {
  const targets = [...new Set(requested.filter(value => stages.has(value)))];
  if (!secret || !targets.length) return { attempted: 0, accepted: 0 };
  try {
    const config = object(await rpc('get_exam_pipeline_wakeup_configuration', {}));
    if (config.enabled !== true || typeof config.n8n_base_url !== 'string') return { attempted: 0, accepted: 0 };
    const base = new URL(config.n8n_base_url);
    // This installation has one authorized n8n recipient. A database setting
    // must not be able to forward the ingestion credential to arbitrary hosts.
    if (base.protocol !== 'https:' || base.hostname !== 'n8n.joaoai.com' || (base.port && base.port !== '443') || base.username || base.password || base.pathname !== '/' || base.search || base.hash) return { attempted: 0, accepted: 0 };
    const results = await Promise.all(targets.map(async destination => {
      try {
        const res = await fetcher(new URL('/webhook/pamvet-exam-' + destination + '-wakeup', base), {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2000),
          headers: { Authorization: secret, 'Content-Type': 'application/json' },
          body: JSON.stringify({ trigger: 'persisted-work', stage: destination }),
        });
        await res.body?.cancel();
        return res.ok;
      } catch { return false; }
    }));
    return { attempted: targets.length, accepted: results.filter(Boolean).length };
  } catch {
    // The queue remains durable during schema rollout or unavailable transport.
    // Preserve the successful clinical operation instead of converting it into
    // a failed callback that a source worker might repeat.
    return { attempted: 0, accepted: 0 };
  }
}
