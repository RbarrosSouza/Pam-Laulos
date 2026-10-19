import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const sources = await Promise.all(['pending-group-summary.mjs', 'pending-summary-runtime.mjs'].map(file => fs.readFile(new URL(file, import.meta.url), 'utf8')));
const bundle = sources.map(source => source.replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '')).join('\n');
const clone = value => JSON.parse(JSON.stringify(value));
export const PENDING_SUMMARY_CONFIG = Object.freeze({
  enabled: false, dryRun: true,
  serviceUrl: 'https://PROJECT_REF.supabase.co/functions/v1/exam-document-service',
  chatwootBaseUrl: 'https://chatwoot.example.invalid', accountId: null, inboxId: null, conversationId: null,
  groupJid: '', pamLaudosBaseUrl: 'https://pamlaudos.example.invalid',
  worker: 'n8n-exames-resumo-diario', maxCharacters: 12000, maxMessagePages: 20,
});
export const PENDING_SUMMARY_CREDENTIALS = Object.freeze({
  worker: { id: 'SELECT_EXISTING_WORKER_HEADER', name: 'Select existing exam worker header' },
  chatwoot: { id: 'SELECT_EXISTING_CHATWOOT_CREDENTIAL', name: 'Select existing Chatwoot credential' },
});
function settingsValues(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).some(key => !['config', 'credentials'].includes(key))) throw new Error('Use {config,credentials} only');
  const config = settings.config ?? {}, credentials = settings.credentials ?? {};
  for (const [value, allowed] of [[config, PENDING_SUMMARY_CONFIG], [credentials, PENDING_SUMMARY_CREDENTIALS]]) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(allowed, key))) throw new Error('Unknown summary configuration field');
  }
  for (const reference of Object.values(credentials)) {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference) || Object.keys(reference).some(key => !['id', 'name'].includes(key))
      || typeof reference.id !== 'string' || !reference.id || reference.id.length > 200 || typeof reference.name !== 'string' || !reference.name || reference.name.length > 200
      || /[\x00-\x1f\x7f]/.test(reference.id + reference.name)) throw new Error('Use credential id/name references only; never secret values');
  }
  const merged = { ...clone(PENDING_SUMMARY_CONFIG), ...clone(config) };
  if (typeof merged.enabled !== 'boolean' || typeof merged.dryRun !== 'boolean' || merged.maxCharacters !== 12000 || merged.maxMessagePages !== 20) throw new Error('Invalid summary configuration types or limits');
  return { cfg: merged, refs: { ...clone(PENDING_SUMMARY_CREDENTIALS), ...clone(credentials) } };
}
const expression = value => '={{ ' + value + ' }}';

export async function buildPendingSummaryWorkflows(settings = {}) {
  const { cfg, refs } = settingsValues(settings);
  function workflow(preview) {
    const config = { ...cfg, ...(preview ? { dryRun: true } : {}) };
    const w = { name: preview ? 'OPERACIONAL 06 — Prévia do resumo (somente leitura)' : 'OPERACIONAL 06 — Pendências no grupo às 08h', active: false,
      nodes: [], connections: {}, settings: { executionOrder: 'v1', timezone: 'America/Sao_Paulo',
        saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none', saveManualExecutions: false, saveExecutionProgress: false, executionTimeout: 900 }, pinData: {} };
    const add = (name, type, version, x, y, parameters, extra = {}) => {
      const hash = crypto.createHash('sha256').update('pamvet-pending-summary:' + preview + ':' + name).digest('hex');
      w.nodes.push({ id: hash.slice(0, 8) + '-' + hash.slice(8, 12) + '-5' + hash.slice(13, 16) + '-a' + hash.slice(17, 20) + '-' + hash.slice(20, 32),
        name, type: 'n8n-nodes-base.' + type, typeVersion: version, position: [x, y], parameters, ...extra });
    };
    const connect = (from, outputs) => { w.connections[from] = { main: outputs.map(branch => branch.map(node => ({ node, type: 'main', index: 0 }))) }; };
    const code = (name, x, y, source) => add(name, 'code', 2, x, y, { jsCode: bundle + '\n' + source });
    const options = { timeout: 30000, redirect: { redirect: { followRedirects: false } }, response: { response: { responseFormat: 'json' } } };
    const backend = (name, x, y, body) => add(name, 'httpRequest', 4.2, x, y, {
      method: 'POST', url: expression("$('Configuração').first().json.serviceUrl"), authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
      sendBody: true, specifyBody: 'json', jsonBody: expression('JSON.stringify( ' + body + ' )'), options: clone(options),
    }, { credentials: { httpHeaderAuth: clone(refs.worker) }, retryOnFail: false });
    const chatwoot = (name, x, y, suffix, extraOptions = {}) => add(name, 'httpRequest', 4.2, x, y, {
      method: 'GET', url: expression("$('Configuração').first().json.chatwootBaseUrl.replace(/\\/$/, '') + '/api/v1/accounts/' + $('Configuração').first().json.accountId + '/conversations/' + $('Configuração').first().json.conversationId" + suffix),
      authentication: 'predefinedCredentialType', nodeCredentialType: 'chatwootApi', options: { ...clone(options), ...extraOptions },
    }, { credentials: { chatwootApi: clone(refs.chatwoot) }, retryOnFail: true, maxTries: 3, waitBetweenTries: 1000 });
    const condition = (name, x, y, value) => add(name, 'if', 2.2, x, y, { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{ id: 'check', leftValue: expression(value), rightValue: true, operator: { type: 'boolean', operation: 'equals' } }], combinator: 'and' }, options: {} });

    add('Executar manualmente', 'manualTrigger', 1, -1000, preview ? 0 : 180, {});
    if (!preview) add('Todos os dias às 08h', 'scheduleTrigger', 1.2, -1000, -40, { rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * *' }] } });
    code('Configuração', -760, 0, `const cfg=${JSON.stringify(config, null, 2)};\nreturn [{json:pendingSummaryConfiguration(cfg,$execution)}];`);
    backend('Consultar ou reservar resumo', -520, 0,
      `{ action: $('Configuração').first().json.dryRun ? "pending_summary_preview" : "pending_summary_reserve", payload: { worker: $('Configuração').first().json.worker } }`);
    code('Preparar resumo completo', -280, 0, "return [{json:preparePendingSummary($json,$('Configuração').first().json)}];");
    connect('Executar manualmente', [['Configuração']]);
    connect('Configuração', [['Consultar ou reservar resumo']]);
    connect('Consultar ou reservar resumo', [['Preparar resumo completo']]);
    if (preview) connect('Preparar resumo completo', [['Chatwoot - conferir grupo']]);
    else {
      connect('Todos os dias às 08h', [['Configuração']]);
      condition('Resumo reservado para envio', -40, 0, '$json.sendRequired === true');
      code('Encerramento sem envio', 200, 240, "return [{json:{...$json,post_permitted:false}}];");
      connect('Preparar resumo completo', [['Resumo reservado para envio']]);
      connect('Resumo reservado para envio', [['Chatwoot - conferir grupo'], ['Encerramento sem envio']]);
    }
    chatwoot('Chatwoot - conferir grupo', 200, -40, '');
    code('Confirmar grupo de destino', 440, -40, "return [{json:verifyPendingSummaryConversation($json,$('Preparar resumo completo').first().json,$('Configuração').first().json)}];");
    connect('Chatwoot - conferir grupo', [['Confirmar grupo de destino']]);
    chatwoot('Chatwoot - procurar resumo existente', 680, -40, " + '/messages'", { pagination: { pagination: {
      paginationMode: 'updateAParameterInEachRequest', parameters: { parameters: [{ type: 'qs', name: 'before',
        value: expression('Math.min(...($response.body.payload || $response.body.messages || []).map(m => Number(m.id)))') }] },
      paginationCompleteWhen: 'other', completeExpression: expression("!($response.body.payload || $response.body.messages || []).length || ($response.body.payload || $response.body.messages || []).some(m => (typeof m.created_at === 'number' ? m.created_at * 1000 : Date.parse(m.created_at)) < Date.parse($json.as_of) - 86400000)"),
      limitPagesFetched: true, maxRequests: 20, requestInterval: 250,
    } } });
    connect('Confirmar grupo de destino', [['Chatwoot - procurar resumo existente']]);
    code('Conferir ausência sem reenviar', 920, -40, "return [{json:verifyPendingSummaryRecentMessages($input.all().map(item=>item.json),$('Confirmar grupo de destino').first().json,$('Configuração').first().json)}];");
    connect('Chatwoot - procurar resumo existente', [['Conferir ausência sem reenviar']]);
    if (preview) {
      code('Prévia conferida sem envio', 1160, -40, "return [{json:{read_only:true,post_permitted:false,group_verified:true,history_scan_complete:$json.recentScanComplete,existing_summary_messages:$json.existingSummaryMessages,total:$json.total,characters:$json.characters,as_of:$json.as_of,local_day:$json.day}}];");
      connect('Conferir ausência sem reenviar', [['Prévia conferida sem envio']]);
      return w;
    }
    backend('Registrar início antes do POST', 1160, -40, '{ action: "pending_summary_begin", payload: { summary_id: $json.summary_id, lease_token: $json.lease_token, destination_key: $json.destination_key, content: $json.content } }');
    connect('Conferir ausência sem reenviar', [['Registrar início antes do POST']]);
    code('Permissão de envio confirmada', 1400, -40, "return [{json:pendingSummaryDispatchPermission($json,$('Conferir ausência sem reenviar').first().json,$('Configuração').first().json)}];");
    connect('Registrar início antes do POST', [['Permissão de envio confirmada']]);
    condition('Pode fazer um único POST', 1640, -40, '$json.dispatch_allowed === true && $json.sendRequired === true');
    connect('Permissão de envio confirmada', [['Pode fazer um único POST']]);
    connect('Pode fazer um único POST', [['Chatwoot - enviar resumo único'], ['Encerramento sem envio']]);
    add('Chatwoot - enviar resumo único', 'httpRequest', 4.2, 1880, -40, {
      method: 'POST', url: expression("$('Configuração').first().json.chatwootBaseUrl.replace(/\\/$/, '') + '/api/v1/accounts/' + $('Configuração').first().json.accountId + '/conversations/' + $('Configuração').first().json.conversationId + '/messages'"),
      authentication: 'predefinedCredentialType', nodeCredentialType: 'chatwootApi', sendBody: true, specifyBody: 'json',
      jsonBody: expression("JSON.stringify( { content: $json.content, message_type: 'outgoing', private: false, content_attributes: $json.contentAttributes } )"),
      options: { ...clone(options), response: { response: { responseFormat: 'json', fullResponse: true, neverError: true } } },
    }, { credentials: { chatwootApi: clone(refs.chatwoot) }, retryOnFail: false, onError: 'continueRegularOutput' });
    code('Classificar sem novo POST', 2120, -40, "return [{json:classifyPendingSummarySubmission($json,$('Permissão de envio confirmada').first().json)}];");
    connect('Chatwoot - enviar resumo único', [['Classificar sem novo POST']]);
    backend('Salvar resultado do resumo', 2360, -40, '{ action: "pending_summary_result", payload: { summary_id: $json.summary_id, lease_token: $json.lease_token, outcome: $json.outcome } }');
    connect('Classificar sem novo POST', [['Salvar resultado do resumo']]);
    return w;
  }
  return { daily: workflow(false), preview: workflow(true) };
}

const inRoot = value => { const relative = path.relative(ROOT, path.resolve(value)); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
export async function writePendingSummaryWorkflows(out = path.join(ROOT, 'n8n/exames'), settings = {}) {
  if (Object.keys(settings).length && inRoot(out)) throw new Error('Bound output must remain outside the public repository');
  const workflows = await buildPendingSummaryWorkflows(settings);
  await fs.mkdir(out, { recursive: true });
  const result = [];
  for (const [key, workflow] of Object.entries(workflows)) {
    const file = path.join(out, key === 'daily' ? 'OPERACIONAL-06.json' : 'OPERACIONAL-06-PREVIEW.json');
    const text = JSON.stringify(workflow, null, 2) + '\n';
    await fs.writeFile(file, text, { mode: 0o600 });
    if (Object.keys(settings).length) await fs.chmod(file, 0o600);
    result.push({ path: file, nodes: workflow.nodes.length, sha256: crypto.createHash('sha256').update(text).digest('hex') });
  }
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), get = key => { const at = args.indexOf(key); return at < 0 ? null : args[at + 1]; };
  const configFile = get('--config'), out = get('--out') || path.join(ROOT, 'n8n/exames');
  if (configFile && (inRoot(configFile) || inRoot(out))) throw new Error('Private configuration and bound output must remain outside the public repository');
  const settings = configFile ? JSON.parse(await fs.readFile(path.resolve(configFile), 'utf8')) : {};
  console.log(JSON.stringify(await writePendingSummaryWorkflows(out, settings), null, 2));
}
