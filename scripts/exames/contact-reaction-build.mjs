import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const runtime = (await fs.readFile(new URL('./contact-reaction-runtime.mjs', import.meta.url), 'utf8')).replace(/^export /gm, '');
const clone = value => JSON.parse(JSON.stringify(value));
const expression = value => '={{ ' + value + ' }}';
export const CONTACT_REACTION_CONFIG = Object.freeze({ enabled: false, dryRun: true,
  serviceUrl: 'https://PROJECT_REF.supabase.co/functions/v1/exam-document-service', chatwootBaseUrl: 'https://chatwoot.example.invalid',
  accountId: null, inboxId: null, conversationId: null, groupJid: '', expectedActorId: null,
  emoji: '✅', maxMessagePages: 20, worker: 'n8n-exames-reacao-contato', diagnosticTarget: null });
export const CONTACT_REACTION_CREDENTIALS = Object.freeze({
  worker: { id: 'SELECT_EXISTING_WORKER_HEADER', name: 'Select existing exam worker header' },
  chatwoot: { id: 'SELECT_EXISTING_CHATWOOT_CREDENTIAL', name: 'Select existing Chatwoot credential' },
});
function privateSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).some(key => !['config', 'credentials'].includes(key))) throw new Error('Use {config,credentials} only');
  const config = settings.config ?? {}, credentials = settings.credentials ?? {};
  for (const [value, allowed] of [[config, CONTACT_REACTION_CONFIG], [credentials, CONTACT_REACTION_CREDENTIALS]]) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(allowed, key))) throw new Error('Unknown reaction configuration field');
  }
  for (const reference of Object.values(credentials)) if (!reference || typeof reference !== 'object' || Array.isArray(reference)
    || Object.keys(reference).some(key => !['id', 'name'].includes(key)) || typeof reference.id !== 'string' || !reference.id || reference.id.length > 200
    || typeof reference.name !== 'string' || !reference.name || reference.name.length > 200 || /[\x00-\x1f\x7f]/.test(reference.id + reference.name)) throw new Error('Existing credential id/name references only; never secret values');
  const cfg = { ...clone(CONTACT_REACTION_CONFIG), ...clone(config) };
  if (typeof cfg.enabled !== 'boolean' || typeof cfg.dryRun !== 'boolean' || cfg.emoji !== '✅' || cfg.maxMessagePages !== 20) throw new Error('Invalid reaction configuration');
  if (cfg.diagnosticTarget != null && (typeof cfg.diagnosticTarget !== 'object' || Array.isArray(cfg.diagnosticTarget)
    || Object.keys(cfg.diagnosticTarget).some(key => !['document_id', 'delivery_id', 'sha256', 'external_message_id'].includes(key)))) throw new Error('Diagnostic target accepts canonical IDs/hash only');
  return { cfg, refs: { ...clone(CONTACT_REACTION_CREDENTIALS), ...clone(credentials) } };
}

export async function buildContactReactionWorkflows(settings = {}) {
  const { cfg, refs } = privateSettings(settings);
  const build = preview => {
    const w = { name: preview ? 'OPERACIONAL 07 — Diagnóstico de reação (somente leitura)' : 'OPERACIONAL 07 — Contato concluído no grupo',
      active: false, nodes: [], connections: {}, settings: { executionOrder: 'v1', timezone: 'America/Sao_Paulo', saveDataSuccessExecution: 'none',
        saveDataErrorExecution: 'none', saveManualExecutions: false, saveExecutionProgress: false, executionTimeout: 900 }, pinData: {} };
    const add = (name, type, version, x, y, parameters, extra = {}) => {
      const hash = crypto.createHash('sha256').update('pamvet-contact-reaction-v1:' + preview + ':' + name).digest('hex');
      w.nodes.push({ id: hash.slice(0, 8) + '-' + hash.slice(8, 12) + '-5' + hash.slice(13, 16) + '-a' + hash.slice(17, 20) + '-' + hash.slice(20, 32),
        name, type: 'n8n-nodes-base.' + type, typeVersion: version, position: [x, y], parameters, ...extra });
    };
    const connect = (from, outputs) => { w.connections[from] = { main: outputs.map(branch => branch.map(node => ({ node, type: 'main', index: 0 }))) }; };
    const code = (name, x, y, jsCode) => add(name, 'code', 2, x, y, { jsCode: runtime + '\n' + jsCode });
    const options = { timeout: 30000, redirect: { redirect: { followRedirects: false } }, response: { response: { responseFormat: 'json' } } };
    const worker = (name, x, y, body) => add(name, 'httpRequest', 4.2, x, y, { method: 'POST',
      url: expression("$('Configuração').first().json.serviceUrl"), authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
      sendBody: true, specifyBody: 'json', jsonBody: expression('JSON.stringify( ' + body + ' )'), options: clone(options),
    }, { credentials: { httpHeaderAuth: clone(refs.worker) }, retryOnFail: false });
    const groupBase = "$('Configuração').first().json.chatwootBaseUrl.replace(/\\/$/, '') + '/api/v1/accounts/' + $('Configuração').first().json.accountId + '/conversations/' + $('Configuração').first().json.conversationId";
    const get = (name, x, y, url, extras = {}) => add(name, 'httpRequest', 4.2, x, y, { method: 'GET', url: expression(url),
      authentication: 'predefinedCredentialType', nodeCredentialType: 'chatwootApi', options: clone(options), ...extras,
    }, { credentials: { chatwootApi: clone(refs.chatwoot) }, retryOnFail: true, maxTries: 3, waitBetweenTries: 1000 });
    const condition = (name, x, y, value) => add(name, 'if', 2.2, x, y, { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{ id: 'check', leftValue: expression(value), rightValue: true, operator: { type: 'boolean', operation: 'equals' } }], combinator: 'and' }, options: {} });
    const messages = (name, x, y) => get(name, x, y, groupBase + " + '/messages'", {
      sendQuery: true, queryParameters: { parameters: [{ name: 'after', value: expression('$json.scan_after') }] },
      options: { ...clone(options), pagination: { pagination: { paginationMode: 'updateAParameterInEachRequest',
        parameters: { parameters: [{ type: 'qs', name: 'after', value: expression("($response.body.payload || $response.body.messages || []).map(m => String(m.id)).sort((a,b) => a.length-b.length || a.localeCompare(b)).at(-1) || '0'") }] },
        paginationCompleteWhen: 'other', completeExpression: expression('!($response.body.payload || $response.body.messages || []).length'),
        limitPagesFetched: true, maxRequests: 20, requestInterval: 250,
      } } },
    });
    const resultBody = '{ action: "reaction_result", payload: { reaction_id: $json.reaction_id, lease_token: $json.lease_token, outcome: $json.outcome } }';

    add('Executar manualmente', 'manualTrigger', 1, -1200, preview ? 0 : 180, {});
    if (!preview) add('A cada minuto', 'scheduleTrigger', 1.2, -1200, -40, { rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] } });
    code('Configuração', -960, 0, `const cfg=${JSON.stringify({ ...cfg, ...(preview ? { dryRun: true } : {}) }, null, 2)};\nreturn [{json:contactReactionConfiguration(cfg,$execution)}];`);
    get('Chatwoot - conferir usuário da credencial', -720, 0, "$('Configuração').first().json.chatwootBaseUrl.replace(/\\/$/, '') + '/api/v1/profile'");
    code('Confirmar ator autenticado', -480, 0, "return [{json:verifyContactReactionActor($json,$('Configuração').first().json)}];");
    worker('Consultar ou reservar reações', -240, 0, '{ action: $("Configuração").first().json.dryRun ? "reaction_preview" : "reaction_reserve_tasks", payload: { worker: $("Confirmar ator autenticado").first().json.worker, limit: 1 } }');
    code('Preparar alvos originais', 0, 0, "const tasks=prepareContactReactionTasks($json,$('Confirmar ator autenticado').first().json);return tasks.length?tasks.map(json=>({json})):[{json:{available:false,readOnly:true}}];");
    add('Uma reação por vez', 'splitInBatches', 3, 240, 0, { batchSize: 1, options: {} });
    condition('Alvo disponível', 480, 0, '$json.available === true');
    code('Sem contato elegível', 720, 220, "return [{json:{post_permitted:false,eligible_targets:0}}];");
    get('Chatwoot - conferir grupo original', 720, -40, groupBase);
    code('Conferir identidade do grupo', 960, -40, "return [{json:verifyContactReactionGroup($json,$('Uma reação por vez').item.json,$('Confirmar ator autenticado').first().json)}];");
    messages('Chatwoot - ler original e todas as reações', 1200, -40);
    code('Conferir reação sem alterar mensagem', 1440, -40, "return [{json:inspectContactReactionMessages($input.all().map(item=>item.json),$('Conferir identidade do grupo').item.json,$('Confirmar ator autenticado').first().json)}];");
    code('Próximo alvo', 1680, 340, "return [{json:{checked:true}}];");
    connect('Executar manualmente', [['Configuração']]); if (!preview) connect('A cada minuto', [['Configuração']]);
    connect('Configuração', [['Chatwoot - conferir usuário da credencial']]); connect('Chatwoot - conferir usuário da credencial', [['Confirmar ator autenticado']]);
    connect('Confirmar ator autenticado', [['Consultar ou reservar reações']]); connect('Consultar ou reservar reações', [['Preparar alvos originais']]);
    connect('Preparar alvos originais', [['Uma reação por vez']]); connect('Uma reação por vez', [[], ['Alvo disponível']]);
    connect('Alvo disponível', [['Chatwoot - conferir grupo original'], ['Sem contato elegível']]);
    connect('Chatwoot - conferir grupo original', [['Conferir identidade do grupo']]); connect('Conferir identidade do grupo', [['Chatwoot - ler original e todas as reações']]);
    connect('Chatwoot - ler original e todas as reações', [['Conferir reação sem alterar mensagem']]);
    connect('Próximo alvo', [['Uma reação por vez']]);
    code('Diagnóstico sem reação', 1680, -260, 'return [{json:contactReactionDiagnostic($json)}];');
    connect('Diagnóstico sem reação', [['Próximo alvo']]);
    if (preview) {
      connect('Conferir reação sem alterar mensagem', [['Diagnóstico sem reação']]);
      return w;
    }
    condition('Somente diagnóstico', 1680, -40, '$json.readOnly === true');
    condition('Precisa aplicar reação nova', 1680, -40, '$json.postRequired === true');
    worker('Registrar reação já observada ou HOLD', 1920, 220, resultBody);
    connect('Conferir reação sem alterar mensagem', [['Somente diagnóstico']]);
    connect('Somente diagnóstico', [['Diagnóstico sem reação'], ['Precisa aplicar reação nova']]);
    connect('Precisa aplicar reação nova', [['Persistir início antes do toggle'], ['Registrar reação já observada ou HOLD']]);
    connect('Registrar reação já observada ou HOLD', [['Próximo alvo']]);
    worker('Persistir início antes do toggle', 1920, -40, '{ action: "reaction_begin", payload: { reaction_id: $json.reaction_id, lease_token: $json.lease_token, destination_key: $json.destination_key, external_message_id: $json.external_message_id, emoji: "✅", actor_id: $json.actor_id } }');
    code('Conferir autorização única', 2160, -40, "return [{json:contactReactionDispatchPermission($json,$('Conferir reação sem alterar mensagem').item.json,$('Confirmar ator autenticado').first().json)}];");
    condition('Pode fazer um único toggle', 2400, -40, '$json.dispatch_allowed === true && $json.postRequired === true');
    connect('Persistir início antes do toggle', [['Conferir autorização única']]); connect('Conferir autorização única', [['Pode fazer um único toggle']]);
    connect('Pode fazer um único toggle', [['Chatwoot - reagir uma única vez'], ['Próximo alvo']]);
    add('Chatwoot - reagir uma única vez', 'httpRequest', 4.2, 2640, -40, { method: 'POST',
      url: expression(groupBase + " + '/messages/' + $json.external_message_id + '/reactions'"), authentication: 'predefinedCredentialType', nodeCredentialType: 'chatwootApi',
      sendBody: true, specifyBody: 'json', jsonBody: expression('JSON.stringify( { emoji: "✅" } )'),
      options: { ...clone(options), response: { response: { responseFormat: 'json', fullResponse: true, neverError: true } } },
    }, { credentials: { chatwootApi: clone(refs.chatwoot) }, retryOnFail: false, onError: 'continueRegularOutput' });
    code('Registrar submissão sem repetir toggle', 2880, -40, "return [{json:classifyContactReactionSubmission($json,$('Conferir autorização única').item.json)}];");
    worker('Salvar tentativa da reação', 3120, -40, resultBody);
    code('Restaurar contexto para conferir', 3360, -40, "return [{json:$('Registrar submissão sem repetir toggle').item.json}];");
    messages('Chatwoot - conferir reação após tentativa', 3600, -40);
    code('Provar reação e preservar original', 3840, -40, "return [{json:inspectContactReactionMessages($input.all().map(item=>item.json),$('Restaurar contexto para conferir').item.json,$('Confirmar ator autenticado').first().json,true)}];");
    worker('Salvar confirmação ou incerteza', 4080, -40, resultBody);
    connect('Chatwoot - reagir uma única vez', [['Registrar submissão sem repetir toggle']]); connect('Registrar submissão sem repetir toggle', [['Salvar tentativa da reação']]);
    connect('Salvar tentativa da reação', [['Restaurar contexto para conferir']]); connect('Restaurar contexto para conferir', [['Chatwoot - conferir reação após tentativa']]);
    connect('Chatwoot - conferir reação após tentativa', [['Provar reação e preservar original']]); connect('Provar reação e preservar original', [['Salvar confirmação ou incerteza']]);
    connect('Salvar confirmação ou incerteza', [['Próximo alvo']]);
    return w;
  };
  return { worker: build(false), preview: build(true) };
}

const inRoot = value => { const r = path.relative(ROOT, path.resolve(value)); return r === '' || r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
export async function writeContactReactionWorkflows(out = path.join(ROOT, 'n8n/exames'), settings = {}) {
  if (Object.keys(settings).length && inRoot(out)) throw new Error('Bound output must remain outside the public repository');
  const workflows = await buildContactReactionWorkflows(settings); await fs.mkdir(out, { recursive: true }); const result = [];
  for (const [key, workflow] of Object.entries(workflows)) {
    const file = path.join(out, key === 'worker' ? 'OPERACIONAL-07.json' : 'OPERACIONAL-07-PREVIEW.json'), text = JSON.stringify(workflow, null, 2) + '\n';
    await fs.writeFile(file, text, { mode: 0o600 }); if (Object.keys(settings).length) await fs.chmod(file, 0o600);
    result.push({ path: file, nodes: workflow.nodes.length, sha256: crypto.createHash('sha256').update(text).digest('hex') });
  }
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), get = key => { const at = args.indexOf(key); return at < 0 ? null : args[at + 1]; };
  const file = get('--config'), out = get('--out') || path.join(ROOT, 'n8n/exames');
  if (file && (inRoot(file) || inRoot(out))) throw new Error('Private configuration and bound output must remain outside the public repository');
  console.log(JSON.stringify(await writeContactReactionWorkflows(out, file ? JSON.parse(await fs.readFile(path.resolve(file), 'utf8')) : {}), null, 2));
}
