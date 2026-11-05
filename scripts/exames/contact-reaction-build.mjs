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
  emoji: '✅', maxMessagePages: 20, worker: 'n8n-exames-reacao-contato', diagnosticTarget: null,
  lane: 'new', providerContract: 'pamvet_check_v1', maxPreDispatchMs: 50000, minDispatchLeaseMs: 30000 });
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
  const build = (preview, reconcile = false) => {
    const w = { name: preview ? 'OPERACIONAL 07 — Diagnóstico de reação (somente leitura)' : reconcile ? 'OPERACIONAL 07R — Conferir reações sem repetir envio' : 'OPERACIONAL 07 — Contato concluído no grupo',
      active: false, nodes: [], connections: {}, settings: { executionOrder: 'v1', timezone: 'America/Sao_Paulo', saveDataSuccessExecution: 'none',
        saveDataErrorExecution: 'none', saveManualExecutions: false, saveExecutionProgress: false, executionTimeout: 120 }, pinData: {} };
    const add = (name, type, version, x, y, parameters, extra = {}) => {
      const hash = crypto.createHash('sha256').update('pamvet-contact-reaction-v2:' + preview + ':' + reconcile + ':' + name).digest('hex');
      w.nodes.push({ id: hash.slice(0, 8) + '-' + hash.slice(8, 12) + '-5' + hash.slice(13, 16) + '-a' + hash.slice(17, 20) + '-' + hash.slice(20, 32),
        name, type: 'n8n-nodes-base.' + type, typeVersion: version, position: [x, y], parameters, ...extra });
    };
    const connect = (from, outputs) => { w.connections[from] = { main: outputs.map(branch => branch.map(node => ({ node, type: 'main', index: 0 }))) }; };
    const code = (name, x, y, jsCode) => add(name, 'code', 2, x, y, { jsCode: runtime + '\n' + jsCode });
    const options = { timeout: 10000, redirect: { redirect: { followRedirects: false } }, response: { response: { responseFormat: 'json' } } };
    const worker = (name, x, y, body) => add(name, 'httpRequest', 4.2, x, y, { method: 'POST',
      url: expression("$('Configuração').first().json.serviceUrl"), authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
      sendBody: true, specifyBody: 'json', jsonBody: expression('JSON.stringify( ' + body + ' )'), options: clone(options),
    }, { credentials: { httpHeaderAuth: clone(refs.worker) }, retryOnFail: false });
    const groupBase = "$('Configuração').first().json.chatwootBaseUrl.replace(/\\/$/, '') + '/api/v1/accounts/' + $('Configuração').first().json.accountId + '/conversations/' + $('Configuração').first().json.conversationId";
    const get = (name, x, y, url, extras = {}, nodeExtras = {}) => add(name, 'httpRequest', 4.2, x, y, { method: 'GET', url: expression(url),
      authentication: 'predefinedCredentialType', nodeCredentialType: 'chatwootApi', options: clone(options), ...extras,
    }, { credentials: { chatwootApi: clone(refs.chatwoot) }, retryOnFail: false, ...nodeExtras });
    const condition = (name, x, y, value) => add(name, 'if', 2.2, x, y, { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{ id: 'check', leftValue: expression(value), rightValue: true, operator: { type: 'boolean', operation: 'equals' } }], combinator: 'and' }, options: {} });
    // Dedicated complete target state. A legacy server returns 404; there is no toggle fallback.
    const readOptions={...clone(options),response:{response:{responseFormat:'json',fullResponse:true,neverError:true}}};
    const messages = (name, x, y) => get(name, x, y, groupBase + " + '/messages/' + $json.external_message_id + '/reactions/state'",{options:clone(readOptions)},{onError:'continueRegularOutput'});
    const resultBody = reconcile
      ? '{ action: "reaction_reconcile_result", payload: { reaction_id: $json.reaction_id, reconcile_token: $json.reconcile_token, outcome: $json.outcome } }'
      : '{ action: "reaction_result", payload: { reaction_id: $json.reaction_id, lease_token: $json.lease_token, outcome: $json.outcome } }';

    add('Executar manualmente', 'manualTrigger', 1, -1200, preview ? 0 : 180, {});
    if (!preview) add('A cada minuto', 'scheduleTrigger', 1.2, -1200, -40, { rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] } });
    code('Configuração', -960, 0, `const cfg=${JSON.stringify({ ...cfg, lane: reconcile ? 'reconcile' : 'new', ...(preview ? { dryRun: true } : {}) }, null, 2)};\nreturn [{json:contactReactionConfiguration(cfg,$execution)}];`);
    get('Chatwoot - conferir usuário da credencial', -720, 0, "$('Configuração').first().json.chatwootBaseUrl.replace(/\\/$/, '') + '/api/v1/profile'");
    code('Confirmar ator autenticado', -480, 0, "return [{json:verifyContactReactionActor($json,$('Configuração').first().json)}];");
    worker('Consultar ou reservar reações', -240, 0, '{ action: $("Configuração").first().json.dryRun ? "reaction_preview" : $("Configuração").first().json.lane === "reconcile" ? "reaction_reserve_reconciliations" : "reaction_reserve_tasks", payload: { worker: $("Confirmar ator autenticado").first().json.worker, limit: 1 } }');
    code('Preparar alvos originais', 0, 0, "const tasks=prepareContactReactionTasks($json,$('Confirmar ator autenticado').first().json);return tasks.length?tasks.map(json=>({json})):[{json:{available:false,readOnly:true}}];");
    add('Uma reação por vez', 'splitInBatches', 3, 240, 0, { batchSize: 1, options: {} });
    condition('Alvo disponível', 480, 0, '$json.available === true');
    code('Sem contato elegível', 720, 220, "return [{json:{post_permitted:false,eligible_targets:0}}];");
    get('Chatwoot - conferir grupo original', 720, -40, groupBase,{options:clone(readOptions)},{onError:'continueRegularOutput'});
    code('Conferir identidade do grupo', 960, -40, "return [{json:prepareContactReactionGroup($json,$('Uma reação por vez').item.json,$('Confirmar ator autenticado').first().json)}];");
    condition('Grupo confirmado',1080,-40,'$json.verifiedGroup === true');
    messages('Chatwoot - ler original e todas as reações', 1200, -40);
    code('Conferir reação sem alterar mensagem', 1440, -40, "return [{json:inspectCurrentContactReactionState($json,$('Conferir identidade do grupo').item.json,$('Confirmar ator autenticado').first().json)}];");
    code('Próximo alvo', 1680, 340, "return [{json:{checked:true}}];");
    connect('Executar manualmente', [['Configuração']]); if (!preview) connect('A cada minuto', [['Configuração']]);
    connect('Configuração', [['Chatwoot - conferir usuário da credencial']]); connect('Chatwoot - conferir usuário da credencial', [['Confirmar ator autenticado']]);
    connect('Confirmar ator autenticado', [['Consultar ou reservar reações']]); connect('Consultar ou reservar reações', [['Preparar alvos originais']]);
    connect('Preparar alvos originais', [['Uma reação por vez']]); connect('Uma reação por vez', [[], ['Alvo disponível']]);
    connect('Alvo disponível', [['Chatwoot - conferir grupo original'], ['Sem contato elegível']]);
    connect('Chatwoot - conferir grupo original', [['Conferir identidade do grupo']]);connect('Conferir identidade do grupo',[['Grupo confirmado']]);
    connect('Grupo confirmado',[['Chatwoot - ler original e todas as reações'],[preview?'Diagnóstico sem reação':'Somente diagnóstico']]);
    connect('Chatwoot - ler original e todas as reações', [['Conferir reação sem alterar mensagem']]);
    connect('Próximo alvo', [['Uma reação por vez']]);
    code('Diagnóstico sem reação', 1680, -260, 'return [{json:contactReactionDiagnostic($json)}];');
    connect('Diagnóstico sem reação', [['Próximo alvo']]);
    if (preview) {
      connect('Conferir reação sem alterar mensagem', [['Diagnóstico sem reação']]);
      return w;
    }
    if (reconcile) {
      condition('Somente diagnóstico', 1680, -40, '$json.readOnly === true');
      worker('Registrar reconciliação sem envio', 1920, 0, resultBody);
      connect('Conferir reação sem alterar mensagem', [['Somente diagnóstico']]);
      connect('Somente diagnóstico', [['Diagnóstico sem reação'], ['Registrar reconciliação sem envio']]);
      connect('Registrar reconciliação sem envio', [['Próximo alvo']]);
      return w;
    }
    condition('Somente diagnóstico', 1680, -40, '$json.readOnly === true');
    condition('Precisa aplicar reação nova', 1680, -40, '$json.postRequired === true');
    worker('Registrar reação já observada ou HOLD', 1920, 220, resultBody);
    connect('Conferir reação sem alterar mensagem', [['Somente diagnóstico']]);
    connect('Somente diagnóstico', [['Diagnóstico sem reação'], ['Precisa aplicar reação nova']]);
    connect('Precisa aplicar reação nova', [['Persistir autorização antes de garantir'], ['Registrar reação já observada ou HOLD']]);
    connect('Registrar reação já observada ou HOLD', [['Próximo alvo']]);
    worker('Persistir autorização antes de garantir', 1920, -40, '{ action: "reaction_begin", payload: { reaction_id: $json.reaction_id, lease_token: $json.lease_token, destination_key: $json.destination_key, external_message_id: $json.external_message_id, emoji: "✅", actor_id: $json.actor_id } }');
    code('Conferir autorização única', 2160, -40, "return [{json:contactReactionDispatchPermission($json,$('Conferir reação sem alterar mensagem').item.json,$('Confirmar ator autenticado').first().json)}];");
    condition('Pode garantir o check uma vez', 2400, -40, '$json.dispatch_allowed === true && $json.postRequired === true');
    connect('Persistir autorização antes de garantir', [['Conferir autorização única']]); connect('Conferir autorização única', [['Pode garantir o check uma vez']]);
    connect('Pode garantir o check uma vez', [['Chatwoot - garantir check sem alternar'], ['Próximo alvo']]);
    add('Chatwoot - garantir check sem alternar', 'httpRequest', 4.2, 2640, -40, { method: 'POST',
      url: expression(groupBase + " + '/messages/' + $json.external_message_id + '/reactions/ensure'"), authentication: 'predefinedCredentialType', nodeCredentialType: 'chatwootApi',
      sendBody: true, specifyBody: 'json', jsonBody: expression('JSON.stringify( { contract: "pamvet_check_v1", emoji: "✅", expected: $json.ensure_expected } )'),
      options: { ...clone(options), response: { response: { responseFormat: 'json', fullResponse: true, neverError: true } } },
    }, { credentials: { chatwootApi: clone(refs.chatwoot) }, retryOnFail: false, onError: 'continueRegularOutput' });
    code('Registrar retorno sem novo envio', 2880, -40, "return [{json:classifyContactReactionEnsure($json,$('Conferir autorização única').item.json,$('Confirmar ator autenticado').first().json)}];");
    worker('Salvar tentativa da reação', 3120, -40, resultBody);
    connect('Chatwoot - garantir check sem alternar', [['Registrar retorno sem novo envio']]); connect('Registrar retorno sem novo envio', [['Salvar tentativa da reação']]);
    connect('Salvar tentativa da reação', [['Próximo alvo']]);
    return w;
  };
  return { worker: build(false), reconciler: build(false, true), preview: build(true) };
}

// Pure candidate preparation. No API calls, credential decryption or production writes.
export async function prepareContactReactionCandidates(live, expectedVersionId) {
  if (!live || live.versionId !== expectedVersionId || typeof live.id !== 'string' || !Array.isArray(live.nodes)) throw new Error('Live reaction workflow drift');
  const find = name => { const n=live.nodes.find(x=>x.name===name);if(!n)throw new Error('Missing live reaction node: '+name);return n; };
  const js=find('Configuração').parameters.jsCode, start=js.lastIndexOf('const cfg='), end=js.indexOf(';\nreturn',start);
  if(start<0||end<0)throw new Error('Live configuration must remain a JSON literal');
  const config=JSON.parse(js.slice(start+10,end));
  const credentials={worker:clone(find('Consultar ou reservar reações').credentials.httpHeaderAuth),chatwoot:clone(find('Chatwoot - conferir usuário da credencial').credentials.chatwootApi)};
  for(const n of live.nodes)for(const [kind,ref] of Object.entries(n.credentials||{})) {
    const donor=kind==='chatwootApi'?credentials.chatwoot:kind==='httpHeaderAuth'?credentials.worker:null;
    if(!donor || JSON.stringify(ref)!==JSON.stringify(donor))throw new Error('Live credential reference drift');
  }
  const generated=await buildContactReactionWorkflows({config,credentials});
  const previousNames={'Persistir autorização antes de garantir':'Persistir início antes do toggle','Pode garantir o check uma vez':'Pode fazer um único toggle',
    'Chatwoot - garantir check sem alternar':'Chatwoot - reagir uma única vez','Registrar retorno sem novo envio':'Registrar submissão sem repetir toggle'};
  const worker={...clone(live),nodes:generated.worker.nodes.map(n=>{
    const old=live.nodes.find(x=>x.name===n.name || x.name===previousNames[n.name]);
    if(!old)return n;
    if(old.type!==n.type)throw new Error('Live node type drift: '+n.name);
    return {...clone(old),...n,id:old.id,position:clone(old.position),...(old.credentials?{credentials:clone(old.credentials)}:{})};
  }),connections:generated.worker.connections,settings:{...clone(live.settings||{}),...generated.worker.settings},pinData:clone(live.pinData||{})};
  const reconciler={...generated.reconciler,settings:{...clone(live.settings||{}),...generated.reconciler.settings}};
  return {worker,reconciler,preview:generated.preview,baseline:{id:live.id,versionId:live.versionId,activeVersionId:live.activeVersionId,nodeCount:live.nodes.length}};
}

const inRoot = value => { const r = path.relative(ROOT, path.resolve(value)); return r === '' || r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
export async function writeContactReactionWorkflows(out = path.join(ROOT, 'n8n/exames'), settings = {}) {
  if (Object.keys(settings).length && inRoot(out)) throw new Error('Bound output must remain outside the public repository');
  const workflows = await buildContactReactionWorkflows(settings); await fs.mkdir(out, { recursive: true }); const result = [];
  for (const [key, workflow] of Object.entries(workflows)) {
    const file = path.join(out, key === 'worker' ? 'OPERACIONAL-07.json' : key === 'reconciler' ? 'OPERACIONAL-07-RECONCILE.json' : 'OPERACIONAL-07-PREVIEW.json'), text = JSON.stringify(workflow, null, 2) + '\n';
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
