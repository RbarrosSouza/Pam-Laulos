import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const runtime = await fs.readFile(new URL('./n8n-discovery-audit-runtime.mjs', import.meta.url), 'utf8');
const bundle = runtime.replace(/^import crypto from 'node:crypto';\s*/, 'const crypto=require("crypto");\n').replace(/^export /gm, '');
const clone = value => JSON.parse(JSON.stringify(value));

function credential(workflow, nodeName, kind) {
  const reference = workflow.nodes.find(node => node.name === nodeName)?.credentials?.[kind];
  if (!reference || Object.keys(reference).some(key => !['id', 'name'].includes(key))
    || typeof reference.id !== 'string' || typeof reference.name !== 'string') throw new Error('Existing credential reference required: ' + nodeName);
  return clone(reference);
}

export function exportConfiguration(workflow) {
  const source = workflow.nodes.find(node => node.name === 'Configuração')?.parameters.jsCode;
  if (typeof source !== 'string') throw new Error('Configuration node is missing');
  const start = source.indexOf('const cfg=') + 'const cfg='.length, end = source.indexOf(';\nif(', start);
  if (start < 10 || end < start) throw new Error('Configuration literal is missing');
  return JSON.parse(source.slice(start, end));
}

function fields(depth = 8) {
  const part = remaining => 'partId,mimeType,filename,headers(name,value),body(attachmentId,size)' + (remaining ? ',parts(' + part(remaining - 1) + ')' : ',parts(partId)');
  return 'id,threadId,internalDate,payload(' + part(depth) + ')';
}

export function buildN8nAuditWorkflow(provider, source, dataTableId, { manualPilot = false, scheduledCandidate = false, resumeFence = false, prospectiveCutoff = null, bridgeWorkflowId = null, canary = false, canaryMessageId = null, canaryCollectorId = null, canaryRecheckOnly = false, scheduleDisabled = false, captureAttachmentDetails = false } = {}) {
  if (!['gmail', 'chatwoot'].includes(provider)) throw new Error('Unsupported audit provider');
  if (scheduledCandidate && (provider !== 'gmail' || manualPilot)) throw new Error('A separate Gmail-only scheduled candidate is required');
  if (prospectiveCutoff !== null && (!scheduledCandidate || typeof prospectiveCutoff !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(prospectiveCutoff)
    || !Number.isFinite(Date.parse(prospectiveCutoff)) || new Date(prospectiveCutoff).toISOString() !== prospectiveCutoff))
    throw new Error('A prospective candidate requires an explicit canonical UTC activation cutoff');
  if (bridgeWorkflowId !== null && (!prospectiveCutoff || typeof bridgeWorkflowId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(bridgeWorkflowId)))
    throw new Error('A prospective candidate requires an explicit child workflow ID');
  if (canary && (!prospectiveCutoff || !bridgeWorkflowId || !scheduledCandidate || typeof canaryMessageId!=='string' || !/^[a-f\d]{8,64}$/i.test(canaryMessageId))) throw new Error('Canary requires a prospective bridge and exact fixture message');
  if (canaryCollectorId !== null && (!canary || typeof canaryCollectorId!=='string' || !/^gmail_canary_recheck_[a-z\d_]{8,48}$/.test(canaryCollectorId)))
    throw new Error('A separate recheck collector is allowed only for a manual canary');
  if (canaryRecheckOnly && (!canary || !canaryCollectorId)) throw new Error('Recheck-only requires a separate manual canary');
  if(typeof scheduleDisabled!=='boolean')throw new Error('Schedule guard must be boolean');
  if(typeof captureAttachmentDetails!=='boolean'||captureAttachmentDetails&&!prospectiveCutoff)throw new Error('Attachment metadata requires prospective collection');
  const addBridge=Boolean(bridgeWorkflowId)&&!canaryRecheckOnly;
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(dataTableId)) throw new Error('Verified private Data Table ID required');
  const previous = exportConfiguration(source);
  const cfg = { enabled: manualPilot === true || scheduledCandidate === true, allowScheduled: scheduledCandidate === true && !canary, monitoring: false, auditLookbackSeconds: 86400, provider, dataTableId, serviceUrl: previous.serviceUrl,
    mailbox: previous.mailbox, intakeCutoff: prospectiveCutoff ?? previous.intakeCutoff, includeSpamTrash: true,
    accountId: previous.accountId, inboxId: previous.inboxId, chatwootBaseUrl: previous.chatwootBaseUrl,
    collectorId: canaryCollectorId ?? (prospectiveCutoff ? 'gmail_prospective_' + crypto.createHash('sha256').update(prospectiveCutoff).digest('hex').slice(0,16)
      : provider === 'gmail' ? 'gmail_audit_v2' : 'chatwoot_audit_v2'), maxActions: 100, maxMillis: 180000, leaseMillis: 900000,
    gmailMetadataFields: fields(), gmailNoticeFields: fields().replaceAll('body(attachmentId,size)', 'body(attachmentId,size,data)'), notificationMode: 'home_only',
    ...(resumeFence || scheduledCandidate ? { resumeFence: true } : {}),
    ...(scheduledCandidate ? { continuous: true, overlapSeconds: 300, maxRepeatedFailures: 3, notificationMode: 'home_only', recheckPending: true } : {}),
    ...(prospectiveCutoff ? { prospective: true } : {}), ...(bridgeWorkflowId ? {bridgeEnabled:true,bridgeWorkflowId} : {}), ...(canary ? {canary:true,canaryMessageId} : {}),
    ...(canaryRecheckOnly ? {canaryRecheckOnly:true} : {}), ...(captureAttachmentDetails ? {captureAttachmentDetails:true} : {}) };
  const workerReference = credential(source, 'Reservar origem', 'httpHeaderAuth');
  const providerReference = provider === 'gmail'
    ? credential(source, 'Gmail - IDs paginados', 'oAuth2Api')
    : credential(source, 'Chatwoot - listar conversas da caixa', 'chatwootApi');
  const workflow = { name: 'INTAKE AUDIT — ' + (provider === 'gmail' ? 'Gmail' : 'WhatsApp') + (scheduledCandidate ? ' — PERIÓDICO CANDIDATO (INATIVO)' : manualPilot ? ' — PILOTO MANUAL 1 DIA (INATIVO)' : ' — registros duráveis (INATIVO)'), active: false,
    nodes: [], connections: {}, pinData: {}, settings: { executionOrder: 'v1', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none',
      saveManualExecutions: false, saveExecutionProgress: false, executionTimeout: 240, timezone: 'America/Sao_Paulo' } };
  const add = (name, type, version, parameters, position, extra = {}) => {
    const hex = crypto.createHash('sha256').update('pamvet-intake-discovery-v2:' + provider + ':' + name).digest('hex');
    const id = hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-5' + hex.slice(13, 16) + '-a' + hex.slice(17, 20) + '-' + hex.slice(20, 32);
    workflow.nodes.push({ id, name, type: 'n8n-nodes-base.' + type, typeVersion: version, parameters, position, ...extra });
  };
  const connect = (from, outputs) => { workflow.connections[from] = { main: outputs.map(names => names.map(node => ({ node, type: 'main', index: 0 }))) }; };
  const condition = expression => ({ conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [{ id: crypto.randomUUID(), leftValue: expression, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} });
  const tableId = { __rl: true, value: dataTableId, mode: 'id' };
  const filters = { conditions: [{ keyName: 'collector_key', condition: 'eq', keyValue: cfg.collectorId }] };
  const code = (name, body, position) => add(name, 'code', 2, { jsCode: bundle + '\n' + body }, position);
  const providerHttp = url => ({ method: 'GET', url, authentication: provider === 'gmail' ? 'genericCredentialType' : 'predefinedCredentialType',
    ...(provider === 'gmail' ? { genericAuthType: 'oAuth2Api' } : { nodeCredentialType: 'chatwootApi' }),
    options: { timeout: 30000, redirect: { redirect: { followRedirects: false } },
      response: { response: { responseFormat: 'json', fullResponse: true, neverError: true } } } });
  const providerCredentials = provider === 'gmail' ? { oAuth2Api: providerReference } : { chatwootApi: providerReference };
  const scheduleName = scheduledCandidate ? 'Agenda 5 minutos — candidato INATIVO' : 'Agenda futura — bloqueada por configuração';
  add('Leia antes de habilitar', 'stickyNote', 1, { content: 'AUDITORIA DE RECEBIMENTOS — WORKFLOW INATIVO. Credenciais existentes nos HTTP Request, nenhum segredo em Code. Só GET nos provedores e POST de recibos/reconferência no backend. IDs persistidos por página antes dos metadados; estado e cursores na Data Table privada, nunca staticData. Lease de 15min por CAS; orçamento 100 ações/180s; timeout 240s do engine é soft, precisa prova real. Lookup exige SQL26; retomada exige SQL28; reconferência exige SQL30/Edge correspondente. Não lê PDF, não cria documentos/Drive/grupo e não envia WhatsApp. Recebimento sem documento é pendência genérica; não é exame comprovado. ' + (prospectiveCutoff ? 'PROSPECTIVO: novo coletor isolado; somente a partir do corte explícito. Revisar a integração de processamento e o horário do corte antes da ativação.' : scheduledCandidate ? 'CANDIDATO PERIÓDICO: revisar antes de ativar. Mantém o mesmo coletor, sobreposição de 5min e prova de enumeração independente de preservação.' : 'MANUAL: agenda bloqueada pela configuração e desabilitada no piloto.') }, [-700, -400]);
  add('Conferir manualmente', 'manualTrigger', 1, {}, [-700, 0]);
  add(scheduleName, 'scheduleTrigger', 1.2, { rule: { interval: [{ field: 'minutes', minutesInterval: 5 }] } }, [-700, 200], { disabled: manualPilot === true || canary || scheduleDisabled });
  code('Configuração de auditoria', 'const cfg=' + JSON.stringify(cfg, null, 2) + ";validateAuditConfig(cfg,$execution.mode);return [{json:cfg}];", [-460, 0]);
  const identityUrl = provider === 'gmail' ? 'https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress'
    : previous.chatwootBaseUrl + '/api/v1/accounts/' + previous.accountId + '/inboxes/' + previous.inboxId;
  add('Conferir conta autorizada', 'httpRequest', 4.2, providerHttp(identityUrl), [-220, 0], { credentials: providerCredentials, retryOnFail: false });
  code('Validar conta antes do ledger', "const cfg=$('Configuração de auditoria').first().json;if($json.statusCode!==200||!auditObject($json.body))throw new Error('INTAKE_AUDIT_ACCOUNT_UNAVAILABLE');if(cfg.provider==='gmail'&&String($json.body.emailAddress).toLowerCase()!==cfg.mailbox.toLowerCase())throw new Error('INTAKE_AUDIT_ACCOUNT_MISMATCH');if(cfg.provider==='chatwoot'&&String($json.body.id)!==String(cfg.inboxId))throw new Error('INTAKE_AUDIT_INBOX_MISMATCH');return [{json:cfg}];", [20, 0]);
  add('Carregar continuação privada', 'dataTable', 1.1, { resource: 'row', operation: 'get', dataTableId: tableId, matchType: 'allConditions', filters, returnAll: true }, [260, 0], { alwaysOutputData: true });
  code('Retomar estado auditável', "const cfg=$('Configuração de auditoria').first().json;return [{json:loadAuditState($input.all().map(item=>item.json),cfg,$execution.id,Date.now())}];", [500, 0]);
  add('Outro executor mantém a lease', 'if', 2.2, condition('={{ $json.busy === true }}'), [500, 240]);
  code('Coletor ocupado — sem efeitos', "return [{json:{coverageComplete:false,scanFinished:false,checkpointAdvanced:false,continuationRequired:true,auditOnly:true,monitoring:false,code:'INTAKE_AUDIT_COLLECTOR_BUSY'}}];", [740, 400]);
  code('Preparar persistência privada', "const cfg=$('Configuração de auditoria').first().json;return [{json:auditPersistenceRow($json,cfg)}];", [740, 0]);
  const columns = { mappingMode: 'defineBelow', value: { collector_key: '={{ $json.collector_key }}', state_json: '={{ $json.state_json }}', revision: '={{ $json.revision }}' },
    matchingColumns: [], schema: [{ id: 'collector_key', displayName: 'collector_key', type: 'string' }, { id: 'state_json', displayName: 'state_json', type: 'string' }, { id: 'revision', displayName: 'revision', type: 'number' }], attemptToConvertTypes: false, convertFieldsToString: false };
  add('Estado já possui linha privada', 'if', 2.2, condition('={{ $json.row_id !== null }}'), [980, 0]);
  add('Atualizar continuação por revisão — CAS', 'dataTable', 1.1, { resource: 'row', operation: 'update', dataTableId: tableId,
    matchType: 'allConditions', filters: { conditions: [...filters.conditions, { keyName: 'id', condition: 'eq', keyValue: '={{ $json.row_id }}' },
      { keyName: 'revision', condition: 'eq', keyValue: '={{ $json.expected_revision }}' }] }, columns: clone(columns), options: {} }, [1220, -100], { alwaysOutputData: true });
  add('Criar primeira continuação privada', 'dataTable', 1.1, { resource: 'row', operation: 'insert', dataTableId: tableId, columns: clone(columns), options: {} }, [1220, 100]);
  add('Reler linha após persistência', 'dataTable', 1.1, { resource: 'row', operation: 'get', dataTableId: tableId, matchType: 'allConditions', filters, returnAll: true }, [1460, 300], { alwaysOutputData: true });
  code('Conferir persistência confirmada', "const expected=$('Preparar persistência privada').item.json;return [{json:verifyAuditPersistence($input.all().map(item=>item.json),expected)}];", [1220, 0]);
  code('Dirigir próxima operação', "const cfg=$('Configuração de auditoria').first().json;return [{json:nextAuditOperation($json,cfg,Date.now())}];", [1460, 0]);
  add('Operação encerrada', 'if', 2.2, condition('={{ $json.target === "stop" }}'), [1700, 0]);
  add('Lease final já foi liberada', 'if', 2.2, condition('={{ $json.state.releaseLease === true }}'), [1940, -400]);
  code('Liberar lease antes de encerrar', "return [{json:{...$json.state,releaseLease:true,finalResult:$json.result}}];", [2180, -400]);
  code('Resumo auditável', 'return [{json:$json.result}];', [1940, -240]);
  add('Operação do ledger', 'if', 2.2, condition('={{ $json.target === "backend" }}'), [1940, 0]);
  add('Ledger — evento durável', 'httpRequest', 4.2, { method: 'POST', url: previous.serviceUrl, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json', jsonBody: '={{ ({action:$json.action,payload:$json.payload}) }}',
    options: { timeout: 30000, redirect: { redirect: { followRedirects: false } }, response: { response: { responseFormat: 'json', fullResponse: true, neverError: true } } } }, [2180, -80],
  { credentials: { httpHeaderAuth: workerReference }, retryOnFail: false, onError: 'continueErrorOutput' });
  add('Provedor — somente leitura', 'httpRequest', 4.2, providerHttp('={{ $json.url }}'), [2180, 160],
    { credentials: providerCredentials, retryOnFail: false, onError: 'continueErrorOutput' });
  if (addBridge) {
    add('Encaminhar ao subprocessador', 'if', 2.2, condition('={{ $json.target === "bridge" }}'), [1940, 160]);
    add('Processar mensagem prospectiva', 'executeWorkflow', 1.2, { source: 'database', workflowId: { __rl:true,value:bridgeWorkflowId,mode:'id' },
      mode:'once', options:{waitForSubWorkflow:true} }, [2180, 340], { onError:'continueRegularOutput', alwaysOutputData:true });
    code('Reconsultar depois do subprocessador', "const cfg=$('Configuração de auditoria').first().json;const context=$('Dirigir próxima operação').item.json;const issues=Array.isArray($json.issues)?$json.issues.slice(0,200).map(i=>({message_id:i?.message_id,attachment_id:i?.attachment_id,reason:i?.reason})):[];return [{json:applyAuditResponse(context,{statusCode:200,body:{completed:!$json.error&&$json.scanFinished===true,issues}},cfg,Date.now())}];", [2420,340]);
  }
  code('Aplicar resposta sem perder cursor', "const cfg=$('Configuração de auditoria').first().json;const context=$('Dirigir próxima operação').item.json;let state;try{state=applyAuditResponse(context,$json,cfg,Date.now());}catch(error){state=applyAuditFailure(context,error.message,Date.now());}return [{json:state}];", [2420, 0]);
  connect('Conferir manualmente', [['Configuração de auditoria']]);
  connect(scheduleName, [['Configuração de auditoria']]);
  connect('Configuração de auditoria', [['Conferir conta autorizada']]);
  connect('Conferir conta autorizada', [['Validar conta antes do ledger']]);
  connect('Validar conta antes do ledger', [['Carregar continuação privada']]);
  connect('Carregar continuação privada', [['Retomar estado auditável']]);
  connect('Retomar estado auditável', [['Outro executor mantém a lease']]);
  connect('Outro executor mantém a lease', [['Coletor ocupado — sem efeitos'], ['Preparar persistência privada']]);
  connect('Preparar persistência privada', [['Estado já possui linha privada']]);
  connect('Estado já possui linha privada', [['Atualizar continuação por revisão — CAS'], ['Criar primeira continuação privada']]);
  connect('Atualizar continuação por revisão — CAS', [['Reler linha após persistência']]);
  connect('Criar primeira continuação privada', [['Reler linha após persistência']]);
  connect('Reler linha após persistência', [['Conferir persistência confirmada']]);
  connect('Conferir persistência confirmada', [['Dirigir próxima operação']]);
  connect('Dirigir próxima operação', [['Operação encerrada']]);
  connect('Operação encerrada', [['Lease final já foi liberada'], ['Operação do ledger']]);
  connect('Lease final já foi liberada', [['Resumo auditável'], ['Liberar lease antes de encerrar']]);
  connect('Liberar lease antes de encerrar', [['Preparar persistência privada']]);
  connect('Operação do ledger', [['Ledger — evento durável'], [addBridge ? 'Encaminhar ao subprocessador' : 'Provedor — somente leitura']]);
  if (addBridge) {
    connect('Encaminhar ao subprocessador', [['Processar mensagem prospectiva'], ['Provedor — somente leitura']]);
    connect('Processar mensagem prospectiva', [['Reconsultar depois do subprocessador']]);
    connect('Reconsultar depois do subprocessador', [['Preparar persistência privada']]);
  }
  connect('Ledger — evento durável', [['Aplicar resposta sem perder cursor'], ['Aplicar resposta sem perder cursor']]);
  connect('Provedor — somente leitura', [['Aplicar resposta sem perder cursor'], ['Aplicar resposta sem perder cursor']]);
  connect('Aplicar resposta sem perder cursor', [['Preparar persistência privada']]);
  return workflow;
}

export async function writeAuditWorkflows({ gmailExport, whatsappExport, dataTableId, out, manualPilot = false, scheduledCandidate = false, resumeFence = false }) {
  const inputs = await Promise.all([gmailExport, whatsappExport].map(filename => fs.readFile(filename, 'utf8').then(JSON.parse)));
  await fs.mkdir(out, { recursive: true, mode: 0o700 });
  const result = [];
  for (const [index, provider] of (scheduledCandidate ? ['gmail'] : ['gmail', 'chatwoot']).entries()) {
    const workflow = buildN8nAuditWorkflow(provider, inputs[index], dataTableId, { manualPilot, scheduledCandidate, resumeFence });
    const filename = path.join(out, 'INTAKE-AUDIT-' + provider.toUpperCase() + (scheduledCandidate ? '-SCHEDULED-CANDIDATE' : manualPilot ? '-MANUAL-PILOT' : '-INACTIVE') + '.private.json');
    const text = JSON.stringify(workflow, null, 2) + '\n';
    await fs.writeFile(filename, text, { mode: 0o600 });
    result.push({ path: filename, nodes: workflow.nodes.length, active: false, sha256: crypto.createHash('sha256').update(text).digest('hex') });
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), get = key => { const index = args.indexOf(key); return index < 0 ? null : args[index + 1]; };
  const gmailExport = get('--gmail-export'), whatsappExport = get('--whatsapp-export'), dataTableId = get('--table-id'), out = get('--out');
  if (!gmailExport || !whatsappExport || !dataTableId || !out) throw new Error('Use private --gmail-export --whatsapp-export --table-id --out');
  console.log(JSON.stringify(await writeAuditWorkflows({ gmailExport, whatsappExport, dataTableId, out, manualPilot: args.includes('--manual-pilot'), scheduledCandidate: args.includes('--scheduled-candidate'), resumeFence: args.includes('--resume-fence') })));
}
