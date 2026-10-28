import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGmailAdapter, createOutlookAdapter, paginatedDiscovery, discoverChatwoot } from './collector-adapters.mjs';

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);

async function rpcResult(rpc, name, parameters) {
  const result = await rpc(name, parameters);
  if (result?.error) throw new Error('intake_ledger_rpc_failed');
  return Object.hasOwn(result || {}, 'data') ? result.data : result;
}

function receivedIso(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return null;
}

export function createRpcDiscoveryLedger({ rpc, sweepId, runToken }) {
  if (typeof rpc !== 'function' || !uuid(sweepId) || !uuid(runToken)) throw new Error('intake_ledger_binding_invalid');
  const recordEvent = event => rpcResult(rpc, 'record_exam_intake_event', { p_sweep_id: sweepId, p_run_token: runToken, p_event: event });
  return {
    recordEvent,
    async recordDiscoveryPage(page) {
      await recordEvent({ kind: 'page_discovered', partition_key: page.partitionKey, page_key: page.pageKey,
        request_cursor_sha256: page.requestCursorHash, next_cursor_sha256: page.nextCursorHash, page_sha256: page.digest,
        message_ids: page.messageIds, is_terminal: page.isTerminal });
      if (page.recordKind !== 'partition') for (const message of page.records) {
        const receivedAt = receivedIso(message.receivedAt);
        if (receivedAt) await recordEvent({ kind: 'message_discovered', partition_key: page.partitionKey, message_id: message.id, received_at: receivedAt });
      }
    },
    async recordFailure(failure) {
      await recordEvent({ kind: 'failure', partition_key: failure.partitionKey || 'scope', stage: failure.stage || 'discovery', code: failure.code || 'discovery_failed' });
    },
  };
}

export function createFileContinuationStore(directory) {
  const root = path.resolve(directory);
  const filename = key => path.join(root, digest(key) + '.json');
  return {
    async load(key) {
      try { return JSON.parse(await fs.readFile(filename(key), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async save(key, value) {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const target = filename(key), temporary = target + '.' + crypto.randomUUID() + '.tmp';
      await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, target);
    },
    async clear(key) { await fs.rm(filename(key), { force: true }); },
  };
}

function manifestFor(scope) {
  if (!['gmail', 'outlook', 'chatwoot'].includes(scope.provider) || typeof scope.accountId !== 'string' || !scope.accountId
    || typeof scope.collectorId !== 'string' || !/^[A-Za-z0-9_.:-]{1,96}$/.test(scope.collectorId) || !uuid(scope.requestId)) throw new Error('intake_worker_scope_invalid');
  if (!['audit', 'operational'].includes(scope.mode || 'audit')) throw new Error('intake_worker_mode_invalid');
  if (!Number.isFinite(Date.parse(scope.receivedFrom)) || !Number.isFinite(Date.parse(scope.receivedThrough))
    || Date.parse(scope.receivedFrom) >= Date.parse(scope.receivedThrough)
    || !Number.isFinite(Date.parse(scope.initialReceivedFrom))) throw new Error('intake_worker_window_invalid');
  return { provider: scope.provider, account_id: scope.accountId,
    scope_kind: scope.provider === 'chatwoot' ? 'inbox:' + scope.inboxId : 'mailbox', policy_version: 'intake_v2', sender_policy: 'all',
    include_spam_trash: scope.provider === 'gmail' && scope.includeSpamTrash === true,
    include_deleted: scope.provider === 'outlook', initial_received_from: scope.initialReceivedFrom || scope.receivedFrom,
    lookback_seconds: scope.lookbackSeconds ?? 0 };
}

export async function runIntakeDiscoveryWorker({ scope, http, rpc, continuationStore, processMessages, budget, clock = Date.now }) {
  if (typeof http !== 'function' || typeof rpc !== 'function' || typeof processMessages !== 'function' || !continuationStore) throw new Error('intake_worker_dependencies_invalid');
  const manifest = manifestFor(scope), scopeKey = digest(manifest);
  const key = 'worker:' + scope.collectorId + ':' + scope.requestId;
  const descriptorHash = digest([manifest, scope.receivedFrom, scope.receivedThrough, scope.mode || 'audit',
    scope.userId || 'me', scope.baseUrl || null, scope.chatwootAccountId || null, scope.inboxId || null]);
  let state = await continuationStore.load(key);
  if (state && state.descriptorHash !== descriptorHash) throw new Error('intake_worker_resume_scope_mismatch');
  if (state?.finished) return { ...state.result, replayed: true };
  if (!state) {
    const started = await rpcResult(rpc, 'begin_exam_intake_sweep', { p_collector_id: scope.collectorId, p_scope_key: scopeKey,
      p_scope_manifest: manifest, p_received_from: scope.receivedFrom, p_received_through: scope.receivedThrough,
      p_request_id: scope.requestId, p_mode: scope.mode || 'audit', p_ttl_seconds: scope.ttlSeconds ?? 900 });
    if (!uuid(started?.sweep_id) || !uuid(started?.run_token)) throw new Error('intake_worker_begin_unproven');
    state = { descriptorHash, sweepId: started.sweep_id, runToken: started.run_token, finished: false };
    await continuationStore.save(key, state);
  }
  const ledger = createRpcDiscoveryLedger({ rpc, sweepId: state.sweepId, runToken: state.runToken });
  const config = { ...scope, scopeKey };
  try {
    await ledger.recordEvent({ kind: 'heartbeat' });
    let discovery;
    if (scope.provider === 'chatwoot') discovery = await discoverChatwoot({ config, http, ledger, continuationStore, budget, clock, sweepKey: state.sweepId });
    else {
      const adapter = scope.provider === 'gmail' ? createGmailAdapter(config) : createOutlookAdapter(config);
      const result = await paginatedDiscovery({ adapter, http, ledger, continuationStore, budget, clock, continuationKey: state.sweepId + ':mailbox' });
      discovery = { ...result, expectedMessageCount: result.messageIds.length };
    }
    if (!discovery.coverageComplete) return { sweepId: state.sweepId, coverageComplete: false, scanFinished: false,
      checkpointAdvanced: false, continuationRequired: true, reason: discovery.reason, discovery };
    await ledger.recordEvent({ kind: 'enumeration_complete', expected_message_count: discovery.expectedMessageCount, page_count: discovery.pageCount });
    const processing = await processMessages({ scope: config, sweepId: state.sweepId, runToken: state.runToken,
      mode: scope.mode || 'audit', ledger, rpc, budget });
    if (processing?.complete !== true) return { sweepId: state.sweepId, coverageComplete: false, discoveryComplete: true,
      scanFinished: false, checkpointAdvanced: false, continuationRequired: true, reason: 'message_processing_pending' };
    const result = await rpcResult(rpc, 'finish_exam_intake_sweep', { p_sweep_id: state.sweepId, p_run_token: state.runToken });
    if (typeof result?.scanFinished !== 'boolean' || typeof result?.coverageComplete !== 'boolean') throw new Error('intake_worker_finish_unproven');
    state.finished = true;
    state.result = { ...result, sweepId: state.sweepId, continuationRequired: false };
    await continuationStore.save(key, state);
    return state.result;
  } catch (error) {
    let failureRecorded = false;
    try { await ledger.recordFailure({ stage: 'worker', code: 'intake_worker_incomplete' }); failureRecorded = true; } catch { }
    return { sweepId: state.sweepId, coverageComplete: false, scanFinished: false, checkpointAdvanced: false,
      continuationRequired: true, reason: error.code || 'intake_worker_failed', failureRecorded };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), readArgument = key => { const index = args.indexOf(key); return index < 0 ? null : args[index + 1]; };
  const configuration = readArgument('--config'), wiring = readArgument('--wiring');
  if (!configuration || !wiring) throw new Error('Use --config <private-scope.json> --wiring <authorized-runtime.mjs>');
  const scope = JSON.parse(await fs.readFile(path.resolve(configuration), 'utf8'));
  const dependencies = await import(pathToFileURL(path.resolve(wiring)).href);
  const result = await runIntakeDiscoveryWorker({ ...dependencies, scope });
  process.stdout.write(JSON.stringify({ sweepId: result.sweepId, coverageComplete: result.coverageComplete, scanFinished: result.scanFinished,
    checkpointAdvanced: result.checkpointAdvanced ?? false, continuationRequired: result.continuationRequired, reason: result.reason ?? null }) + '\n');
  if (!result.scanFinished) process.exitCode = 2;
}
