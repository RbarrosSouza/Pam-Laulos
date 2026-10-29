// Optional, read-only consumer MCP adapter. Direct Drive OAuth remains the Edge default.
// Contracts: the verified consumer SEARCH_TOOLS / MULTI_EXECUTE envelopes and native
// GET_FILE_METADATA / DOWNLOAD_FILE. No export, upload helper, provider token or REST proxy.
// Transport source: modelcontextprotocol/typescript-sdk v1.26.0 (Streamable HTTP).
export const COMPOSIO_MCP_ENDPOINT = "https://connect.composio.dev/mcp";
export const COMPOSIO_MAX_PDF_BYTES = 20 * 1024 * 1024;
export const OAUTH_MAX_PDF_BYTES = 50 * 1024 * 1024;
const SEARCH = "COMPOSIO_SEARCH_TOOLS";
const EXECUTE = "COMPOSIO_MULTI_EXECUTE_TOOL";
const METADATA = "GOOGLEDRIVE_GET_FILE_METADATA";
const DOWNLOAD = "GOOGLEDRIVE_DOWNLOAD_FILE";
const DEFAULT_TIMEOUT_MS = 120_000;
type Json = Record<string, unknown>;
type Fetch = typeof fetch;

export class ComposioOriginalError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "ComposioOriginalError"; }
}
function fail(message: string, status = 503): never { throw new ComposioOriginalError(message, status); }
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Resposta do Composio não verificável");
  return value as Json;
}
function cleanError(value: unknown): boolean { return value === undefined || value === null || value === ""; }

export interface ComposioReaderConfig {
  apiKey: string;
  driveAccount: string;
  downloadHosts: string[];
}
export interface ExpectedDriveOriginal {
  fileId: unknown;
  folderId: unknown;
  sha256: unknown;
  sizeBytes: unknown;
}
export interface ConsumerMcpSession {
  listTools(cursor?: string): Promise<unknown>;
  callTool(name: string, args: Json): Promise<unknown>;
  close(): Promise<void>;
}
export interface ReaderDependencies {
  fetch?: Fetch;
  timeoutMs?: number;
  openSession?: (config: ComposioReaderConfig, signal: AbortSignal, http: Fetch) => Promise<ConsumerMcpSession>;
}

// No account inference, wildcard download host or secret from a browser request.
export function composioReaderConfig(get: (name: string) => string | undefined): ComposioReaderConfig {
  const config = {
    apiKey: get("COMPOSIO_CONSUMER_API_KEY") || "",
    driveAccount: get("COMPOSIO_DRIVE_ACCOUNT") || "",
    downloadHosts: (get("COMPOSIO_FILE_DOWNLOAD_HOSTS") || "").split(",").map((s) => s.trim()).filter(Boolean),
  };
  validateConfig(config);
  return config;
}
function publicHost(host: string): boolean {
  // Exact operator-approved DNS names only. Reject IP literals and local/reserved names.
  return host === host.toLowerCase() && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)
    && host.includes(".") && !host.includes("..") && !/^\d+(?:\.\d+){3}$/.test(host)
    && !/(?:^|\.)(?:localhost|local|internal|invalid|test|example)$/.test(host)
    && host.split(".").every((label) => label.length <= 63 && !label.startsWith("-") && !label.endsWith("-"));
}
function validateConfig(config: ComposioReaderConfig): void {
  if (!/^ck_[A-Za-z0-9_-]+$/.test(config.apiKey)
    || !/^[A-Za-z0-9_.:-]{1,200}$/.test(config.driveAccount)
    || !Array.isArray(config.downloadHosts) || !config.downloadHosts.length
    || config.downloadHosts.some((host) => !publicHost(host))) {
    fail("Leitura Composio incompleta no servidor");
  }
}
function validateExpected(expected: ExpectedDriveOriginal, maxBytes = COMPOSIO_MAX_PDF_BYTES, mode = "Composio") {
  if (typeof expected.fileId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(expected.fileId)
    || typeof expected.folderId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(expected.folderId)
    || typeof expected.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(expected.sha256)
    || typeof expected.sizeBytes !== "number" || !Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes < 1) {
    fail(`Registro do original incompleto para leitura ${mode}`, 409);
  }
  if (expected.sizeBytes > maxBytes) fail(`Original acima do limite ${mode} de ${maxBytes / 1024 / 1024} MiB`, 413);
  return { fileId: expected.fileId, folderId: expected.folderId, sha256: expected.sha256, sizeBytes: expected.sizeBytes };
}

function envelope(result: unknown): Json {
  const call = object(result);
  if (call.isError === true || !Array.isArray(call.content)) fail("Ferramenta Composio não confirmou a leitura");
  const candidates: Json[] = [];
  for (const block of call.content) {
    const content = object(block);
    if (content.type !== "text" || typeof content.text !== "string") continue;
    let value: unknown;
    try { value = JSON.parse(content.text); } catch { continue; } // additional human-readable MCP guidance
    candidates.push(object(value));
  }
  if (candidates.length !== 1) fail("Resposta do Composio não verificável");
  const value = candidates[0];
  if (value.successful !== true || !cleanError(value.error)) fail("Ferramenta Composio não confirmou a leitura");
  return object(value.data);
}
function batchData(result: unknown, slug: string, sessionId: string): Json {
  const batch = envelope(result);
  if (batch.total_count !== 1 || batch.success_count !== 1 || batch.error_count !== 0
    || !Array.isArray(batch.results) || batch.results.length !== 1
    || object(batch.session).id !== sessionId) fail("Lote Composio não confirmou a leitura");
  const entry = object(batch.results[0]);
  const response = object(entry.response);
  if (entry.tool_slug !== slug || entry.index !== 0 || response.successful !== true || !cleanError(response.error)) {
    fail("Ferramenta Composio não confirmou a leitura");
  }
  return object(response.data);
}
function searchSession(result: unknown, account: string): string {
  const data = envelope(result);
  const session = object(data.session);
  if (typeof session.id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(session.id)
    || !Array.isArray(data.toolkit_connection_statuses)) fail("Sessão Composio não verificável");
  const drives = data.toolkit_connection_statuses.map(object).filter((t) => t.toolkit === "googledrive");
  if (drives.length !== 1 || drives[0].has_active_connection !== true || !Array.isArray(drives[0].accounts)) {
    fail("Conta Drive configurada não está ativa no Composio");
  }
  const accounts = drives[0].accounts.map(object).filter((a) => a.id === account);
  if (accounts.length !== 1 || accounts[0].status !== "ACTIVE") fail("Conta Drive configurada não está ativa no Composio");
  return session.id;
}
function metadataMatches(data: Json, expected: ReturnType<typeof validateExpected>): void {
  const size = typeof data.size === "string" && /^\d+$/.test(data.size) ? Number(data.size) : data.size;
  if (data.id !== expected.fileId || data.mimeType !== "application/pdf" || data.trashed !== false
    || size !== expected.sizeBytes || (data.sha256Checksum !== undefined && data.sha256Checksum !== expected.sha256)
    || !Array.isArray(data.parents) || data.parents.length !== 1 || data.parents[0] !== expected.folderId) {
    fail("Metadados do original no Drive divergem do registro", 409);
  }
  if (data.appProperties !== undefined) {
    const props = object(data.appProperties);
    if (props.sha256 !== undefined && props.sha256 !== expected.sha256) fail("Hash do original no Drive divergente", 409);
  }
}
function originalDownload(data: Json, expectedId: string): string {
  if (data.id !== expectedId || data.mimeType !== "application/pdf" || data.export_applied !== false) {
    fail("Composio não confirmou download do PDF original", 409);
  }
  const file = object(data.downloaded_file_content);
  if (file.mimetype !== "application/pdf" || typeof file.s3url !== "string") fail("Download do PDF original indisponível");
  return file.s3url;
}
function checkedDownloadUrl(value: string, hosts: string[]): URL {
  let url: URL;
  try { url = new URL(value); } catch { fail("URL de download do original não permitida"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")
    || !publicHost(url.hostname) || !hosts.includes(url.hostname)) fail("URL de download do original não permitida");
  return url;
}

// Race cancellation explicitly: a test/custom stream need not honor the fetch AbortSignal.
async function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) fail("Tempo de leitura do original esgotado");
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new ComposioOriginalError("Tempo de leitura do original esgotado", 503));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
async function closeSession(session: { close(): Promise<void> }): Promise<void> {
  // Cleanup must not turn a bounded read into an unbounded request if a transport stalls.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.resolve().then(() => session.close()).catch(() => {}),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 100); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
async function downloadPdf(url: URL, expected: ReturnType<typeof validateExpected>, http: Fetch, signal: AbortSignal, options: {maxBytes?: number; mode?: string; headers?: HeadersInit} = {}): Promise<ArrayBuffer> {
  const maxBytes = options.maxBytes ?? COMPOSIO_MAX_PDF_BYTES;
  const mode = options.mode ?? "Composio";
  // Deliberately no authorization, consumer key, cookie or caller headers on the signed file URL.
  const response = await cancellable(http(url, { method: "GET", ...(options.headers ? { headers: options.headers } : {}), redirect: "error", credentials: "omit", signal }), signal);
  if (response.status !== 200 || response.redirected || !response.body) {
    void response.body?.cancel().catch(() => {});
    fail(`Original no ${mode} não pôde ser lido; preservar pendência`);
  }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes || Number(length) !== expected.sizeBytes)) {
    void response.body.cancel().catch(() => {});
    fail("Tamanho do original diverge do registro", 409);
  }
  const reader = response.body.getReader();
  // The persisted size is bounded before allocation. Copy chunks directly instead
  // of retaining a second complete PDF until the hashing/upload phases finish.
  const bytes = new Uint8Array(expected.sizeBytes);
  let total = 0;
  let complete = false;
  try {
    for (;;) {
      const next = await cancellable(reader.read(), signal);
      if (next.done) { complete = true; break; }
      total += next.value.byteLength;
      if (total > maxBytes) fail(`Original acima do limite ${mode} de ${maxBytes / 1024 / 1024} MiB`, 413);
      if (total > expected.sizeBytes) fail("Tamanho do original diverge do registro", 409);
      bytes.set(next.value, total - next.value.byteLength);
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (total !== expected.sizeBytes) fail("Tamanho do original diverge do registro", 409);
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") fail("Original recebido não é PDF", 409);
  const digest = await cancellable(crypto.subtle.digest("SHA-256", bytes), signal);
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hash !== expected.sha256) fail("Integridade do original divergente; revisão necessária", 409);
  return bytes.buffer;
}

async function openConsumerSession(config: ComposioReaderConfig, signal: AbortSignal, http: Fetch): Promise<ConsumerMcpSession> {
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import("npm:@modelcontextprotocol/sdk@1.26.0/client/index.js"),
    import("npm:@modelcontextprotocol/sdk@1.26.0/client/streamableHttp.js"),
  ]);
  const client = new Client({ name: "pamvet-original-reader", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(COMPOSIO_MCP_ENDPOINT), {
    requestInit: { headers: { "x-consumer-api-key": config.apiKey }, redirect: "error", credentials: "omit" },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const target = input instanceof Request ? input.url : String(input);
      if (target !== COMPOSIO_MCP_ENDPOINT) fail("Destino MCP não permitido");
      return http(input, { ...init, redirect: "error", credentials: "omit", signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) });
    },
  });
  // Fetch and the outer race own cancellation. Giving the shared signal to SDK
  // requests can emit cancellation notifications again for already-completed reads.
  const options = { timeout: DEFAULT_TIMEOUT_MS };
  try { await cancellable(client.connect(transport, options), signal); }
  catch (cause) { await closeSession(client); throw cause; }
  return {
    listTools: (cursor) => client.listTools(cursor ? { cursor } : undefined, options),
    callTool: (name, args) => client.callTool({ name, arguments: args }, undefined, options),
    close: () => client.close(),
  };
}
async function requireTools(session: ConsumerMcpSession, signal: AbortSignal): Promise<void> {
  const found = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = object(await cancellable(session.listTools(cursor), signal));
    if (!Array.isArray(result.tools)) fail("Ferramentas MCP não verificáveis");
    for (const tool of result.tools) { const entry = object(tool); if (typeof entry.name === "string") found.add(entry.name); }
    if (result.nextCursor === undefined) {
      if (!found.has(SEARCH) || !found.has(EXECUTE)) fail("Ferramentas de leitura Composio indisponíveis");
      return;
    }
    if (typeof result.nextCursor !== "string" || !result.nextCursor || cursors.has(result.nextCursor)) fail("Paginação MCP não verificável");
    cursor = result.nextCursor; cursors.add(cursor);
  }
  fail("Paginação MCP acima do limite de leitura");
}

export async function readComposioDriveOriginal(input: ExpectedDriveOriginal, config: ComposioReaderConfig, dependencies: ReaderDependencies = {}): Promise<ArrayBuffer> {
  const expected = validateExpected(input);
  validateConfig(config);
  const controller = new AbortController();
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > DEFAULT_TIMEOUT_MS) fail("Prazo de leitura Composio inválido");
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let session: ConsumerMcpSession | undefined;
  try {
    const http = dependencies.fetch ?? fetch;
    session = await cancellable((dependencies.openSession ?? openConsumerSession)(config, controller.signal, http), controller.signal);
    await requireTools(session, controller.signal);
    const found = await cancellable(session.callTool(SEARCH, {
      queries: [{ use_case: "Read Google Drive file metadata and download the original PDF without export or conversion", known_fields: `file_id:${expected.fileId}` }],
      session: { generate_id: true },
    }), controller.signal);
    const sessionId = searchSession(found, config.driveAccount);
    async function execute(slug: string, args: Json): Promise<Json> {
      const result = await cancellable(session!.callTool(EXECUTE, {
        tools: [{ tool_slug: slug, arguments: args, account: config.driveAccount }],
        session_id: sessionId, sync_response_to_workbench: false,
      }), controller.signal);
      return batchData(result, slug, sessionId);
    }
    metadataMatches(await execute(METADATA, { fileId: expected.fileId, fields: "id,mimeType,size,sha256Checksum,parents,trashed,appProperties", supportsAllDrives: true }), expected);
    const url = checkedDownloadUrl(originalDownload(await execute(DOWNLOAD, { fileId: expected.fileId }), expected.fileId), config.downloadHosts);
    return await downloadPdf(url, expected, http, controller.signal);
  } catch (cause) {
    // SDK/network errors may contain signed URLs, response bodies or request details.
    // Only this module's fixed public messages escape to the Edge handler.
    if (cause instanceof ComposioOriginalError) throw cause;
    return fail(controller.signal.aborted ? "Tempo de leitura do original esgotado" : "Leitura Composio indisponível; preservar pendência");
  } finally {
    clearTimeout(timer); controller.abort();
    if (session) await closeSession(session);
  }
}


// Separate server OAuth reader for the existing direct-Drive path. Its secrets
// are injected by the Edge environment, never inferred from n8n/browser OAuth.
export interface OAuthDriveReaderConfig {
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
}
export interface OAuthReaderDependencies { fetch?: Fetch; timeoutMs?: number; }
function opaqueCredential(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16384 && !/[\x00-\x20\x7f]/.test(value);
}
function validateOAuthConfig(config: OAuthDriveReaderConfig): void {
  if (config.refreshToken) {
    if (!opaqueCredential(config.refreshToken) || !opaqueCredential(config.clientId) || !opaqueCredential(config.clientSecret)) fail("OAuth do Drive incompleto no servidor");
  } else if (!opaqueCredential(config.accessToken)) fail("Acesso privado ao Drive ainda não configurado no servidor");
}
export function oauthDriveReaderConfig(get: (name: string) => string | undefined): OAuthDriveReaderConfig {
  const refreshToken = get("GOOGLE_DRIVE_REFRESH_TOKEN");
  const config = refreshToken ? {refreshToken, clientId:get("GOOGLE_DRIVE_CLIENT_ID"), clientSecret:get("GOOGLE_DRIVE_CLIENT_SECRET")}
    : {accessToken:get("GOOGLE_DRIVE_ACCESS_TOKEN")};
  validateOAuthConfig(config);
  return config;
}
async function boundedJson(response: Response, signal: AbortSignal, limit: number): Promise<Json> {
  if (response.status !== 200 || response.redirected || !response.body || !/^application\/json(?:;|$)/i.test(response.headers.get("content-type") || "")) {
    void response.body?.cancel().catch(() => {}); fail("Resposta privada do Drive não verificável; preservar pendência");
  }
  const declared=response.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared)>limit)) {
    void response.body.cancel().catch(() => {}); fail("Resposta privada do Drive acima do limite");
  }
  const reader=response.body.getReader(), chunks:Uint8Array[]=[];
  let total=0,complete=false;
  try {
    for (;;) {
      const part=await cancellable(reader.read(),signal);
      if(part.done){complete=true;break;}
      total+=part.value.byteLength;
      if(total>limit)fail("Resposta privada do Drive acima do limite");
      chunks.push(part.value);
    }
  }finally{if(!complete)void reader.cancel().catch(()=>{});reader.releaseLock();}
  const bytes=new Uint8Array(total);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  if(declared!==null&&Number(declared)!==total)fail("Resposta privada do Drive não verificável; preservar pendência");
  let parsed:unknown;try{parsed=JSON.parse(new TextDecoder().decode(bytes));}catch{fail("Resposta privada do Drive não verificável; preservar pendência");}
  return object(parsed);
}
export async function readOAuthDriveOriginal(input:ExpectedDriveOriginal,config:OAuthDriveReaderConfig,dependencies:OAuthReaderDependencies={}):Promise<ArrayBuffer>{
  const expected=validateExpected(input,OAUTH_MAX_PDF_BYTES,"OAuth"), credentials={...config};
  validateOAuthConfig(credentials);
  const timeoutMs=dependencies.timeoutMs??DEFAULT_TIMEOUT_MS;
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>DEFAULT_TIMEOUT_MS)fail("Prazo de leitura OAuth inválido");
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs),http=dependencies.fetch??fetch;
  try {
    let accessToken:string;
    if(credentials.refreshToken){
      const response=await cancellable(http("https://oauth2.googleapis.com/token",{method:"POST",redirect:"error",credentials:"omit",signal:controller.signal,
        body:new URLSearchParams({client_id:credentials.clientId!,client_secret:credentials.clientSecret!,refresh_token:credentials.refreshToken,grant_type:"refresh_token"})}),controller.signal);
      const data=await boundedJson(response,controller.signal,32768);
      if(!opaqueCredential(data.access_token)||data.token_type!=="Bearer"||typeof data.expires_in!=="number"||!Number.isInteger(data.expires_in)||data.expires_in<1||data.expires_in>86400)fail("Servidor não conseguiu autenticar no Drive");
      accessToken=data.access_token;
    }else accessToken=credentials.accessToken!;
    const headers={Authorization:`Bearer ${accessToken}`};
    const base=`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(expected.fileId)}`;
    const response=await cancellable(http(base+"?fields=id,mimeType,size,sha256Checksum,parents,trashed,appProperties&supportsAllDrives=true",{method:"GET",headers,redirect:"error",credentials:"omit",signal:controller.signal}),controller.signal);
    metadataMatches(await boundedJson(response,controller.signal,65536),expected);
    return await downloadPdf(new URL(base+"?alt=media&supportsAllDrives=true"),expected,http,controller.signal,{maxBytes:OAUTH_MAX_PDF_BYTES,mode:"Drive",headers});
  }catch(cause){
    // Native errors can include bodies/headers/token URLs. Return fixed owned
    // messages only; never retry refresh, follow redirects or choose other auth.
    if(cause instanceof ComposioOriginalError)throw cause;
    fail(controller.signal.aborted?"Tempo de leitura do original esgotado":"Leitura OAuth indisponível; preservar pendência");
  }finally{clearTimeout(timer);controller.abort();}
}
