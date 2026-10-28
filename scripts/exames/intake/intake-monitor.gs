/* Pam Laudos independent intake monitor. Configure Script Properties; no embedded credentials.
 * Installing a trigger and authorizing this script are separate operator actions.
 */
var PIM = Object.freeze({ stateKey: 'PIM_STATE_V1', jobPrefix: 'PIM_JOB_V1_', handler: 'intakeMonitorTick', maxPages: 10, maxPageSize: 100, maxReconciliations: 4, maxJobs: 150, maxCompleted: 20 });
var PIM_RUN_DEADLINE = 0;

function intakeMonitorTick() {
  PIM_RUN_DEADLINE = Date.now() + 180000;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { code: 'MONITOR_BUSY' };
  try {
    var cfg = pimConfig();
    if (!cfg.enabled) return { code: 'MONITOR_DISABLED' };
    var state = pimReadState();
    pimVerifyDestination(cfg);
    var status, health, reserved, issue = null;
    try {
      status = pimBackend(cfg, 'intake_status', {});
      issue = pimStatusIssue(cfg, status, null);
      cfg.scopeVerified = true;
    } catch (e) { issue = 'BACKEND_UNAVAILABLE'; }
    pimReconcileJobs(cfg);
    if (cfg.scopeVerified) {
      try {
        health = pimBackend(cfg, 'intake_health', {});
        if (!health || !Number.isSafeInteger(health.stale_collectors) || health.stale_collectors < 0) throw pimError('HEALTH_RESPONSE_INVALID');
        issue = pimStatusIssue(cfg, status, health);
        reserved = pimBackend(cfg, 'intake_alert_reserve', { worker: 'google-apps-script-intake-v1' });
        if (!reserved || typeof reserved.claimed !== 'boolean') throw pimError('ALERT_RESERVE_INVALID');
        if (!reserved.claimed && reserved.paused === true && (issue === 'COLLECTOR_STALE' || !issue && status.pending_alerts > 0)) issue = 'ALERT_WORKER_PAUSED';
      } catch (e) { issue = 'BACKEND_UNAVAILABLE'; }
    }
    if (issue) {
      if (!state.unhealthy) { state.episode = Utilities.getUuid(); state.startedAt = new Date().toISOString(); }
      state.unhealthy = true;
      state.code = issue;
      pimSaveState(state);
      if (issue === 'BACKEND_UNAVAILABLE' || issue === 'COLLECTOR_CONFIGURATION_INVALID' || issue === 'ALERT_WORKER_PAUSED') {
        pimEnsureLocalJob(state, issue, status && status.open_incidents);
      }
    } else if (state.unhealthy) {
      pimEnsureLocalJob(state, 'RECOVERY', status.open_incidents);
      state.unhealthy = false;
      state.code = 'COLLECTORS_CURRENT';
    } else { state.code = 'COLLECTORS_CURRENT'; }
    state.checkedAt = new Date().toISOString();
    pimSaveState(state);
    var pendingLocal = pimJobs().filter(function (job) { return job.kind === 'local' && job.status === 'planned'; })[0];
    if (pendingLocal) pimDispatch(cfg, pendingLocal);
    if (reserved && reserved.claimed) pimDispatch(cfg, pimReserveJob(cfg, reserved));
    pimPruneCompleted();
    pimRunResult('MONITOR_CHECKED', { health: state.code, unconfirmedAlerts: pimJobs().filter(function (j) { return j.status !== 'sent'; }).length });
    return { code: 'MONITOR_CHECKED', health: state.code };
  } catch (e) {
    var code = e && /^PIM_[A-Z0-9_]+$/.test(e.message || '') ? e.message.slice(4) : 'MONITOR_ERROR';
    pimRunResult(code, {});
    return { code: code };
  } finally { lock.releaseLock(); }
}

// Explicit preflight: GET destination + backend status. No message POST or trigger installation.
function intakeMonitorValidate() {
  PIM_RUN_DEADLINE = Date.now() + 120000;
  var cfg = pimConfig(true);
  pimVerifyDestination(cfg);
  var status = pimBackend(cfg, 'intake_status', {});
  var issue = pimStatusIssue(cfg, status, null);
  return { code: issue || 'PREFLIGHT_OK', expectedCollectors: cfg.collectors.length, registeredCollectors: status.collectors.length, sends: 0 };
}

// Call only after deployment approval, Script Properties, and successful preflight.
function intakeMonitorInstallFiveMinuteTrigger() {
  var check = intakeMonitorValidate();
  if (check.code !== 'PREFLIGHT_OK') throw pimError('PREFLIGHT_REQUIRED');
  if (!pimConfig().enabled) throw pimError('MONITOR_DISABLED');
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === PIM.handler) ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger(PIM.handler).timeBased().everyMinutes(5).create();
  return { code: 'TRIGGER_INSTALLED', intervalMinutes: 5 };
}

function pimError(code) { return new Error('PIM_' + code); }
function pimConfig(validateWhileDisabled) {
  var p = PropertiesService.getScriptProperties();
  var enabled = p.getProperty('ENABLED') === 'true';
  if (!enabled && !validateWhileDisabled) return { enabled: false };
  var required = function (key) { var v = p.getProperty(key); if (!v || /[\r\n]/.test(v)) throw pimError('CONFIG_INVALID'); return v; };
  var cfg = { enabled: enabled, backend: required('BACKEND_URL'), authorization: required('BACKEND_AUTHORIZATION'), apiKey: p.getProperty('BACKEND_APIKEY') || '', chatwoot: required('RELAY_BASE_URL'), token: required('RELAY_CAPABILITY_TOKEN'), account: required('CHATWOOT_ACCOUNT_ID'), inbox: required('CHATWOOT_INBOX_ID'), conversation: required('CHATWOOT_CONVERSATION_ID'), phone: required('EXPECTED_DESTINATION_PHONE'), channel: required('EXPECTED_CHATWOOT_CHANNEL'), destinationKey: required('DESTINATION_KEY') };
  var url = /^https:\/\/[A-Za-z0-9.-]+(?::443)?(?:\/[A-Za-z0-9_./~-]*)?$/;
  if (!url.test(cfg.backend) || !url.test(cfg.chatwoot) || /\/$/.test(cfg.chatwoot) || !/^\+[1-9][0-9]{9,14}$/.test(cfg.phone) || !/^[A-Za-z0-9_.:-]{1,96}$/.test(cfg.destinationKey) || !/^Channel::[A-Za-z]+$/.test(cfg.channel) || ![cfg.account,cfg.inbox,cfg.conversation].every(function (v) { return /^[1-9][0-9]{0,14}$/.test(v); }) || cfg.token.length < 32 || cfg.authorization.length < 32 || /[\r\n]/.test(cfg.apiKey)) throw pimError('CONFIG_INVALID');
  try { cfg.collectors = JSON.parse(required('EXPECTED_COLLECTOR_IDS')); } catch (e) { throw pimError('COLLECTOR_CONFIG_INVALID'); }
  if (!Array.isArray(cfg.collectors) || cfg.collectors.length < 3 || cfg.collectors.length > 20 || new Set(cfg.collectors).size !== cfg.collectors.length || !cfg.collectors.every(function (id) { return typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,96}$/.test(id); })) throw pimError('COLLECTOR_CONFIG_INVALID');
  return cfg;
}

function pimFetch(url, options, code) {
  var response;
  var remaining = PIM_RUN_DEADLINE ? Math.floor((PIM_RUN_DEADLINE - Date.now()) / 1000) : 20;
  if (remaining < 2) throw pimError('RUNTIME_BUDGET_EXHAUSTED');
  try { response = UrlFetchApp.fetch(url, Object.assign({ muteHttpExceptions: true, followRedirects: false, timeoutSeconds: Math.min(20, remaining) }, options)); }
  catch (e) { throw pimError(code + '_UNAVAILABLE'); }
  var status = response.getResponseCode();
  if (status < 200 || status >= 300) throw pimError(code + '_HTTP_' + status);
  var body = response.getContentText();
  if (body.length > 1000000) throw pimError(code + '_RESPONSE_TOO_LARGE');
  try { var parsed = JSON.parse(body); if (!parsed || typeof parsed !== 'object') throw new Error(); return parsed; }
  catch (e) { throw pimError(code + '_JSON_INVALID'); }
}

function pimBackend(cfg, action, payload) {
  if (action !== 'intake_status' && cfg.scopeVerified !== true) throw pimError('MONITOR_SCOPE_UNPROVEN');
  var headers = { Authorization: cfg.authorization, 'X-Exam-Intake-Monitor': '1' };
  if (cfg.apiKey) headers.apikey = cfg.apiKey;
  return pimFetch(cfg.backend, { method: 'post', contentType: 'application/json', headers: headers, payload: JSON.stringify({ action: action, payload: payload }) }, 'BACKEND');
}
function pimChatwoot(cfg, path, options) {
  return pimFetch(cfg.chatwoot + '/api/v1/accounts/' + cfg.account + '/conversations/' + cfg.conversation + path, Object.assign({ method: 'get', headers: { Authorization: 'Bearer ' + cfg.token } }, options || {}), 'CHATWOOT');
}
function pimVerifyDestination(cfg) {
  var conversation = pimChatwoot(cfg, '');
  var meta = conversation.meta || {}, sender = meta.sender || {}, attrs = sender.additional_attributes || {}, custom = sender.custom_attributes || {};
  var raw = String(sender.phone_number || '');
  var phone = /^[+0-9 ()-]+$/.test(raw) ? '+' + raw.replace(/[^0-9]/g, '') : '';
  var channel = meta.channel || conversation.channel;
  if (conversation.relay_contract !== 'exam_intake_relay_v1' || String(conversation.id) !== cfg.conversation || String(conversation.inbox_id) !== cfg.inbox || (conversation.account_id != null && String(conversation.account_id) !== cfg.account) || phone !== cfg.phone || channel !== cfg.channel || /@g\.us/i.test(String(sender.identifier || '')) || sender.group_id || attrs.is_group === true || custom.is_group === true || conversation.group_id) throw pimError('DESTINATION_MISMATCH');
  return true;
}

function pimStatusIssue(cfg, status, health) {
  var now = Date.now();
  if (!status || status.contract !== 'exam_intake_monitor_v1' || status.authorization_scope !== 'intake_monitor' || !Array.isArray(status.collectors) || !Number.isSafeInteger(status.open_incidents) || status.open_incidents < 0 || !Number.isSafeInteger(status.pending_alerts) || status.pending_alerts < 0 || !Number.isFinite(Date.parse(status.as_of)) || Math.abs(now - Date.parse(status.as_of)) > 600000) throw pimError('STATUS_INVALID');
  var seen = {}, stale = false, providers = {};
  status.collectors.forEach(function (h) {
    if (!h || typeof h.collector_id !== 'string' || seen[h.collector_id]) throw pimError('STATUS_INVALID');
    seen[h.collector_id] = h;
  });
  for (var i = 0; i < cfg.collectors.length; i++) {
    var h = seen[cfg.collectors[i]];
    if (!h || h.monitored !== true) return 'COLLECTOR_CONFIGURATION_INVALID';
    providers[h.provider] = true;
    if (!Number.isSafeInteger(h.stale_after_seconds) || h.stale_after_seconds < 60 || h.stale_after_seconds > 86400) throw pimError('STATUS_INVALID');
    if (![h.heartbeat_at, h.progress_at].every(function (v) { var t = Date.parse(v); return typeof v === 'string' && Number.isFinite(t) && t <= now + 120000 && now - t <= h.stale_after_seconds * 1000; })) stale = true;
  }
  if (!providers.gmail || !providers.outlook || !providers.chatwoot) return 'COLLECTOR_CONFIGURATION_INVALID';
  return stale || health && health.stale_collectors > 0 ? 'COLLECTOR_STALE' : null;
}

function pimReadState() {
  var value = PropertiesService.getScriptProperties().getProperty(PIM.stateKey);
  if (!value) return { version: 1, unhealthy: false, episode: null };
  try { var state = JSON.parse(value); if (state.version !== 1 || typeof state.unhealthy !== 'boolean') throw new Error(); return state; }
  catch (e) { throw pimError('STATE_INVALID'); }
}
function pimSaveState(state) { PropertiesService.getScriptProperties().setProperty(PIM.stateKey, JSON.stringify(state)); }
function pimRunResult(code, details) { PropertiesService.getScriptProperties().setProperty('PIM_LAST_RUN_V1', JSON.stringify(Object.assign({ code: code, checkedAt: new Date().toISOString() }, details))); }
function pimHash(value) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8).map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join(''); }
function pimJobKey(id) { return PIM.jobPrefix + pimHash(id); }
function pimSaveJob(job) {
  var serialized = JSON.stringify(job);
  if (serialized.length > 3000) throw pimError('JOB_TOO_LARGE');
  PropertiesService.getScriptProperties().setProperty(pimJobKey(job.id), serialized);
}
function pimJobs() {
  var all = PropertiesService.getScriptProperties().getProperties();
  return Object.keys(all).filter(function (k) { return k.indexOf(PIM.jobPrefix) === 0; }).map(function (k) {
    try { var j = JSON.parse(all[k]); if (!j.id || !j.content || !j.correlation || !['planned','started','submitted','uncertain','sent'].includes(j.status) || pimJobKey(j.id) !== k) throw new Error(); return j; }
    catch (e) { throw pimError('JOB_STATE_INVALID'); }
  }).sort(function (a, b) { return String(a.checkedAt || a.createdAt).localeCompare(String(b.checkedAt || b.createdAt)); });
}
function pimNewJob(id, kind, text) {
  if (pimJobs().length >= PIM.maxJobs) throw pimError('JOB_CAPACITY_REVIEW_REQUIRED');
  var correlation = 'pim-' + Utilities.getUuid();
  var content = text + '\n[PAM-INTAKE:' + correlation + ']';
  return { id: id, kind: kind, correlation: correlation, content: content, contentSha256: pimHash(content), status: 'planned', createdAt: new Date().toISOString() };
}
function pimEnsureLocalJob(state, code, openIncidents) {
  var id = 'local:' + state.episode + ':' + code;
  var old = PropertiesService.getScriptProperties().getProperty(pimJobKey(id));
  if (old) return JSON.parse(old);
  var text = code === 'RECOVERY' ? 'Pam Laudos: serviço de conferência e coletores voltaram a responder. Incidentes ainda em aberto: ' + Number(openIncidents) + '.' : code === 'COLLECTOR_CONFIGURATION_INVALID' ? 'Pam Laudos: configuração incompleta de recebimentos. Um coletor esperado está ausente ou desativado; a cobertura de Gmail, Outlook e WhatsApp não está comprovada.' : code === 'ALERT_WORKER_PAUSED' ? 'Pam Laudos: há falha nos coletores e a fila de alertas do backend está pausada. A cobertura de recebimentos exige atenção.' : 'Pam Laudos: o backend da conferência está indisponível. Não foi possível comprovar a cobertura de recebimentos de Gmail, Outlook e WhatsApp.';
  var job = pimNewJob(id, 'local', text + '\nCódigo: ' + code + '. Início: ' + state.startedAt + '.');
  job.episode = state.episode;
  pimSaveJob(job);
  return job;
}
function pimReserveJob(cfg, reservation) {
  var alert = reservation.alert || {}, incident = reservation.incident || {};
  var uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!uuid.test(alert.id) || !uuid.test(alert.lease_token) || alert.destination_key !== cfg.destinationKey || !/^[A-Za-z0-9_.:-]{1,96}$/.test(incident.code || '') || !/^[A-Za-z0-9_.:-]{1,96}$/.test(incident.stage || '')) throw pimError('ALERT_RESERVATION_MISMATCH');
  var existing = PropertiesService.getScriptProperties().getProperty(pimJobKey('backend:' + alert.id));
  var job = existing ? JSON.parse(existing) : pimNewJob('backend:' + alert.id, 'backend', 'Pam Laudos: foi identificada uma pendência no recebimento de exames.\nEtapa: ' + incident.stage + '. Código: ' + incident.code + '.\nConfira o painel de recebimentos para tratar a pendência.');
  if (job.status !== 'planned') throw pimError('ALERT_ALREADY_ATTEMPTED');
  job.alertId = alert.id; job.leaseToken = alert.lease_token; job.destinationKey = alert.destination_key;
  pimSaveJob(job);
  return job;
}
function pimDispatch(cfg, job) {
  if (job.status !== 'planned') return;
  pimVerifyDestination(cfg);
  if (job.kind === 'backend') {
    try {
      var begin = pimBackend(cfg, 'intake_alert_begin', { alert_id: job.alertId, lease_token: job.leaseToken, destination_key: cfg.destinationKey, content: job.content });
      if (!begin || begin.dispatch_allowed !== true || begin.alert_id !== job.alertId || begin.destination_key !== cfg.destinationKey || begin.content_sha256 !== job.contentSha256) throw pimError('ALERT_BEGIN_INVALID');
    } catch (e) { job.status = 'uncertain'; job.errorCode = 'BACKEND_BEGIN_UNCONFIRMED'; pimSaveJob(job); pimReport(cfg, job); return; }
  }
  // The durable fence precedes the only message POST. Started/uncertain jobs never re-enter it.
  job.status = 'started'; job.startedAt = new Date().toISOString(); pimSaveJob(job);
  try {
    var receipt = pimChatwoot(cfg, '/messages', { method: 'post', contentType: 'application/json', payload: JSON.stringify({ content: job.content, message_type: 'outgoing', private: false, content_attributes: { pam_intake_correlation: job.correlation } }) });
    if (!Number.isSafeInteger(Number(receipt.id)) || Number(receipt.id) <= 0) throw pimError('PROVIDER_ACK_INVALID');
    job.externalId = String(receipt.id); job.status = 'submitted'; job.observed = 'created';
  } catch (e) { job.status = 'uncertain'; job.errorCode = 'PROVIDER_ACK_UNCONFIRMED'; }
  pimSaveJob(job);
  pimReport(cfg, job);
}
function pimReport(cfg, job) {
  if (job.kind !== 'backend') return;
  var observed = job.status === 'sent' ? job.observed : job.externalId ? 'created' : 'uncertain';
  var outcome = { status: observed, content_sha256: job.contentSha256 };
  if (job.externalId) outcome.external_id = job.externalId;
  if (observed === 'uncertain') outcome.error_code = job.errorCode || 'PROVIDER_CONFIRMATION_PENDING';
  try {
    var result = pimBackend(cfg, 'intake_alert_result', { alert_id: job.alertId, lease_token: job.leaseToken, outcome: outcome });
    job.backendResultPending = !result || result.alert_id !== job.alertId || !['submitted','sent','uncertain'].includes(result.status);
  } catch (e) { job.backendResultPending = true; }
  pimSaveJob(job);
}

function pimReconcileJobs(cfg) {
  var jobs = pimJobs().filter(function (j) { return ['started','submitted','uncertain'].includes(j.status) || j.backendResultPending; }).slice(0, PIM.maxReconciliations);
  var deadline = Date.now() + 45000;
  jobs.forEach(function (job) {
    if (Date.now() >= deadline) return;
    if (job.status !== 'sent') {
      try {
        var match = pimFindMessage(cfg, job, deadline);
        if (match) {
          if (job.externalId && job.externalId !== String(match.id)) throw pimError('PROVIDER_ID_CHANGED');
          job.externalId = String(match.id);
          job.observed = match.status;
          job.status = ['delivered','read'].includes(match.status) ? 'sent' : 'submitted';
          delete job.errorCode;
        } else { job.status = 'uncertain'; job.errorCode = 'PROVIDER_CONFIRMATION_NOT_FOUND'; }
      } catch (e) { job.status = 'uncertain'; job.errorCode = 'PROVIDER_CONFIRMATION_INCOMPLETE'; }
    }
    job.checkedAt = new Date().toISOString();
    pimSaveJob(job);
    pimReport(cfg, job);
  });
}
function pimMessageTime(value) {
  var n = typeof value === 'number' ? value * 1000 : Date.parse(value);
  if (!Number.isFinite(n)) throw pimError('MESSAGE_TIME_INVALID');
  return n;
}
function pimFindMessage(cfg, job, deadline) {
  var before = null, seen = {}, matches = [], previousTime = Infinity;
  var since = Date.parse(job.startedAt || job.createdAt) - 60000;
  for (var page = 0; page < PIM.maxPages; page++) {
    if (deadline && Date.now() >= deadline) throw pimError('CONFIRMATION_BUDGET_EXHAUSTED');
    var response = pimChatwoot(cfg, '/messages' + (before ? '?before=' + before : ''));
    var payload = response.payload;
    if (!Array.isArray(payload) || payload.length > PIM.maxPageSize) throw pimError('MESSAGE_PAGE_INVALID');
    if (!payload.length) return pimUniqueMessage(matches);
    var ordered = payload.slice().sort(function (a, b) { return Number(b.id) - Number(a.id); });
    ordered.forEach(function (message) {
      var id = Number(message.id), time = pimMessageTime(message.created_at);
      if (!Number.isSafeInteger(id) || id <= 0 || seen[id] || before && id >= before || time > previousTime || time > Date.now() + 120000) throw pimError('MESSAGE_PAGINATION_INVALID');
      seen[id] = true; previousTime = time;
      var footer = '[PAM-INTAKE:' + job.correlation + ']';
      var attrs = message.content_attributes || {};
      if ((message.message_type === 1 || message.message_type === 'outgoing') && message.private !== true && message.content === job.content && message.content.indexOf(footer) !== -1 && (!attrs.pam_intake_correlation || attrs.pam_intake_correlation === job.correlation)) matches.push(message);
    });
    before = Number(ordered[ordered.length - 1].id);
    if (previousTime < since) return pimUniqueMessage(matches);
  }
  throw pimError('MESSAGE_PAGINATION_INCOMPLETE');
}
function pimUniqueMessage(matches) {
  if (matches.length > 1) throw pimError('DUPLICATE_CORRELATION_REVIEW_REQUIRED');
  if (matches.length && !['created','sent','delivered','read'].includes(matches[0].status)) throw pimError('PROVIDER_STATUS_UNCONFIRMED');
  return matches[0] || null;
}
function pimPruneCompleted() {
  var episode = pimReadState().episode;
  var completed = pimJobs().filter(function (job) { return job.status === 'sent' && !job.backendResultPending && !(job.kind === 'local' && job.episode === episode); }).sort(function (a, b) { return String(b.checkedAt || b.createdAt).localeCompare(String(a.checkedAt || a.createdAt)); });
  completed.slice(PIM.maxCompleted).forEach(function (job) { PropertiesService.getScriptProperties().deleteProperty(pimJobKey(job.id)); });
}
