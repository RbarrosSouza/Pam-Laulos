// Offline tests; all HTTP/MCP responses are synthetic. No consumer key/account or signed URL is real.
// Run: npx --yes deno@2.9.6 test --no-lock --node-modules-dir=none supabase/tests/composio-original-reader.test.ts
import {
  COMPOSIO_MAX_PDF_BYTES, COMPOSIO_MCP_ENDPOINT, ComposioOriginalError, composioReaderConfig,
  readComposioDriveOriginal, type ConsumerMcpSession, type ReaderDependencies,
} from "../functions/exam-document-service/composio-original-reader.ts";

function assert(value: unknown, message = "assertion failed"): asserts value { if (!value) throw new Error(message); }
function equal(a: unknown, b: unknown) { assert(JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
const key = "ck_offline_fixture";
const account = "googledrive_fixture-account";
const host = "temp.00000000000000000000000000000000.r2.cloudflarestorage.com";
const signedUrl = `https://${host}/synthetic.pdf?fixture_signature=redacted`;
const bytes = new TextEncoder().encode("%PDF-1.4\nSynthetic fixture; no clinical data.\n%%EOF\n");
async function hash(value: Uint8Array<ArrayBuffer>) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", value))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const digest = await hash(bytes);
const expected = { fileId: "fixture-file-id", folderId: "fixture-folder-id", sha256: digest, sizeBytes: bytes.length };
const config = { apiKey: key, driveAccount: account, downloadHosts: [host] };
type Json = Record<string, unknown>;
function call(data: Json, error: unknown = null) { return { content: [{ type: "text", text: JSON.stringify({ successful: true, error, data }) }] }; }
function batch(slug: string, data: Json) {
  return call({ results: [{ tool_slug: slug, index: 0, response: { successful: true, data } }], total_count: 1, success_count: 1, error_count: 0, session: { id: "fixture-session" } });
}
function fixture() {
  const state = {
    metadata: { id: expected.fileId, mimeType: "application/pdf", size: String(bytes.length), parents: [expected.folderId], trashed: false } as Json,
    download: { id: expected.fileId, mimeType: "application/pdf", export_applied: false,
      downloaded_file_content: { name: "synthetic.pdf", mimetype: "application/pdf", s3url: signedUrl } } as Json,
    accounts: [{ id: account, status: "ACTIVE" }, { id: "googledrive_wrong-account", status: "ACTIVE" }] as Json[],
    requested: [] as { name: string; args: Json }[], httpCalls: [] as { url: string; init?: RequestInit }[], closed: false,
    response: () => new Response(bytes, { headers: { "Content-Length": String(bytes.length) } }),
    wrap: (value: unknown) => value,
    list: () => ({ tools: [{ name: "COMPOSIO_SEARCH_TOOLS" }, { name: "COMPOSIO_MULTI_EXECUTE_TOOL" }] }),
  };
  const session: ConsumerMcpSession = {
    async listTools() { return state.list(); },
    async callTool(name, args) {
      state.requested.push({ name, args });
      if (name === "COMPOSIO_SEARCH_TOOLS") return state.wrap(call({ session: { id: "fixture-session" }, toolkit_connection_statuses: [
        { toolkit: "googledrive", has_active_connection: true, accounts: state.accounts },
      ] }));
      const tool = (args.tools as Json[])[0];
      return state.wrap(batch(String(tool.tool_slug), tool.tool_slug === "GOOGLEDRIVE_GET_FILE_METADATA" ? state.metadata : state.download));
    },
    async close() { state.closed = true; },
  };
  const deps: ReaderDependencies = {
    openSession: async () => session,
    fetch: async (input, init) => { state.httpCalls.push({ url: String(input), init }); return state.response(); },
  };
  return { state, deps, run: () => readComposioDriveOriginal(expected, config, deps) };
}
async function refused(run: () => Promise<unknown>, status: number) {
  try { await run(); throw new Error("operation unexpectedly succeeded"); }
  catch (cause) {
    assert(cause instanceof ComposioOriginalError, "must return controlled reader error");
    equal(cause.status, status);
    assert(!/https?:|fixture_signature|ck_|provider body|confidential|PRIVATE_KEY/.test(cause.message), "error must not expose provider details, URL or key");
  }
}

Deno.test("valid original requires explicit account and strips authentication from file download", async () => {
  const { state, run } = fixture();
  equal([...new Uint8Array(await run())], [...bytes]);
  equal(state.requested.map((r) => r.name), ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_MULTI_EXECUTE_TOOL"]);
  for (const request of state.requested.slice(1)) {
    equal((request.args.tools as Json[])[0].account, account);
    equal(request.args.session_id, "fixture-session"); equal(request.args.sync_response_to_workbench, false);
  }
  const downloadArgs = (state.requested[2].args.tools as Json[])[0].arguments;
  equal(downloadArgs, { fileId: expected.fileId }); // no export/conversion parameter
  equal(state.httpCalls.length, 1);
  equal(state.httpCalls[0].init?.headers, undefined);
  equal(state.httpCalls[0].init?.redirect, "error"); equal(state.httpCalls[0].init?.credentials, "omit");
  assert(state.closed);
});
Deno.test("native checksum and appProperties are compared when the connector emits them", async () => {
  const { state, run } = fixture(); state.metadata.sha256Checksum = digest; state.metadata.appProperties = { sha256: digest };
  equal([...new Uint8Array(await run())], [...bytes]);
});
Deno.test("20 MiB limit is enforced before MCP connection", async () => {
  let opened = false;
  await refused(() => readComposioDriveOriginal({ ...expected, sizeBytes: COMPOSIO_MAX_PDF_BYTES + 1 }, config, {
    openSession: async () => { opened = true; throw new Error("unreachable"); },
  }), 413); assert(!opened);
});
for (const field of ["fileId", "folderId", "sha256", "sizeBytes"] as const) {
  Deno.test(`missing expected ${field} fails before any network operation`, async () => {
    await refused(() => readComposioDriveOriginal({ ...expected, [field]: undefined }, config), 409);
  });
}
Deno.test("server configuration rejects missing consumer credential, account and wildcard/IP hosts", async () => {
  for (const value of [{ ...config, apiKey: "" }, { ...config, driveAccount: "" }, { ...config, downloadHosts: [] },
    { ...config, downloadHosts: ["*.r2.cloudflarestorage.com"] }, { ...config, downloadHosts: ["127.0.0.1"] },
    { ...config, downloadHosts: ["localhost"] }, { ...config, apiKey: "ck_value\r\nAuthorization: bad" }]) {
    await refused(() => readComposioDriveOriginal(expected, value), 503);
  }
  const env = new Map([["COMPOSIO_CONSUMER_API_KEY", key], ["COMPOSIO_DRIVE_ACCOUNT", account], ["COMPOSIO_FILE_DOWNLOAD_HOSTS", ` ${host} `]]);
  equal(composioReaderConfig((name) => env.get(name)), config);
});
for (const change of [
  { id: "wrong-id" }, { mimeType: "application/vnd.google-apps.document" }, { size: "999" }, { trashed: true }, { trashed: undefined },
  { parents: ["wrong-folder"] }, { parents: [] }, { parents: [expected.folderId, "extra-parent"] },
  { sha256Checksum: "0".repeat(64) }, { appProperties: { sha256: "0".repeat(64) } },
]) {
  Deno.test(`metadata mismatch ${Object.keys(change)[0]} denies download`, async () => {
    const { state, run } = fixture(); Object.assign(state.metadata, change);
    await refused(run, 409); equal(state.httpCalls.length, 0); equal(state.requested.length, 2); assert(state.closed);
  });
}
Deno.test("wrong, inactive or ambiguous account never selects a default account", async () => {
  for (const accounts of [[{ id: "other", status: "ACTIVE" }], [{ id: account, status: "INACTIVE" }],
    [{ id: account, status: "ACTIVE" }, { id: account, status: "ACTIVE" }]]) {
    const { state, run } = fixture(); state.accounts = accounts;
    await refused(run, 503); equal(state.requested.length, 1); equal(state.httpCalls.length, 0);
  }
});
Deno.test("MCP isError and nested unsuccessful/error responses are refused and sanitized", async () => {
  for (const alter of [
    (value: unknown) => ({ ...(value as Json), isError: true }),
    (value: unknown) => { const data = JSON.parse(((value as Json).content as Json[])[0].text as string); data.successful = false; return { content: [{ type: "text", text: JSON.stringify(data) }] }; },
    (value: unknown) => { const data = JSON.parse(((value as Json).content as Json[])[0].text as string); data.error = `${signedUrl} provider body PRIVATE_KEY=${key}`; return { content: [{ type: "text", text: JSON.stringify(data) }] }; },
  ]) {
    const { state, run } = fixture(); state.wrap = alter;
    await refused(run, 503); assert(state.closed); equal(state.httpCalls.length, 0);
  }
  const { state, deps, run } = fixture();
  const original = deps.openSession!;
  deps.openSession = async (...args) => { const session = await original(...args); const invoke = session.callTool;
    session.callTool = async (name, params) => {
      const result = await invoke(name, params);
      if (name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
        return call({ results: [{ tool_slug: "GOOGLEDRIVE_GET_FILE_METADATA", index: 0,
          response: { successful: false, error: `${signedUrl} confidential ${key}`, data: state.metadata } }], total_count: 1, success_count: 1, error_count: 0, session: { id: "fixture-session" } });
      }
      return result;
    }; return session;
  };
  await refused(run, 503); equal(state.httpCalls.length, 0);
});
Deno.test("JSON envelope ambiguity and unbounded tools pagination are refused", async () => {
  const { state, run } = fixture(); state.wrap = (value: unknown) => ({ content: [...((value as Json).content as Json[]), ...((value as Json).content as Json[])] });
  await refused(run, 503);
  const next = fixture(); let pages = 0;
  next.state.list = () => ({ tools: [], nextCursor: `cursor-${pages++}` });
  await refused(next.run, 503); equal(pages, 10); equal(next.state.requested.length, 0);
});
for (const change of [{ id: "wrong-id" }, { mimeType: "application/msword" }, { export_applied: true }, { export_applied: undefined }]) {
  Deno.test(`converted or unverified download ${Object.keys(change)[0]} is rejected`, async () => {
    const { state, run } = fixture(); Object.assign(state.download, change);
    await refused(run, 409); equal(state.httpCalls.length, 0);
  });
}
for (const url of ["http://" + host + "/file", "https://127.0.0.1/file", "https://[::1]/file", "https://localhost/file",
  "https://evil.example/file", `https://user:pass@${host}/file`, `https://${host}:8443/file`, `${signedUrl}#secret`,
  "https://www.googleapis.com/drive/v3/files/id/export?mimeType=application/pdf"]) {
  Deno.test(`unapproved signed URL is blocked before HTTP: ${url.split(/[/?#]/)[2]}`, async () => {
    const { state, run } = fixture(); state.download.downloaded_file_content = { mimetype: "application/pdf", s3url: url };
    await refused(run, 503); equal(state.httpCalls.length, 0);
  });
}
Deno.test("redirect and expired URL return controlled errors without provider bodies", async () => {
  for (const status of [302, 403, 404, 500]) {
    const { state, run } = fixture(); state.response = () => new Response(`provider body confidential ${signedUrl} ${key}`, { status });
    await refused(run, 503); equal(state.httpCalls.length, 1);
  }
});
Deno.test("wrong declared length and short body refuse the original", async () => {
  const declared = fixture(); declared.state.response = () => new Response(bytes, { headers: { "Content-Length": "999" } });
  await refused(declared.run, 409);
  const truncated = fixture(); truncated.state.response = () => new Response(bytes.slice(0, -1));
  await refused(truncated.run, 409);
});
Deno.test("chunked body over 20 MiB is canceled without Content-Length", async () => {
  const { state, deps } = fixture(); let canceled = false; let pulls = 0;
  state.metadata.size = String(COMPOSIO_MAX_PDF_BYTES);
  state.response = () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { canceled = true; },
  }));
  await refused(() => readComposioDriveOriginal({ ...expected, sizeBytes: COMPOSIO_MAX_PDF_BYTES }, config, deps), 413);
  assert(canceled); assert(pulls <= 23, "reader must stop near the cap rather than drain the body"); assert(state.closed);
});
Deno.test("pending stream read times out and is canceled", async () => {
  const { state, deps } = fixture(); let canceled = false;
  state.response = () => new Response(new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); }, cancel() { canceled = true; } }));
  await refused(() => readComposioDriveOriginal(expected, config, { ...deps, timeoutMs: 30 }), 503);
  assert(canceled); assert(state.closed);
});
Deno.test("PDF signature and final hash are verified even if metadata matches", async () => {
  const corrupt = fixture(); corrupt.state.response = () => new Response(new Uint8Array(bytes.length)); await refused(corrupt.run, 409);
  const wrongHash = fixture(); const changed = bytes.slice(); changed[10] ^= 1; wrongHash.state.response = () => new Response(changed); await refused(wrongHash.run, 409);
});
Deno.test("network and MCP exceptions never expose URLs, arguments or credentials", async () => {
  const error = new Error(`provider body ${signedUrl} PRIVATE_KEY=${key}`);
  const { deps } = fixture(); deps.fetch = async () => { throw error; };
  await refused(() => readComposioDriveOriginal(expected, config, deps), 503);
  await refused(() => readComposioDriveOriginal(expected, config, { openSession: async () => { throw error; } }), 503);
});
Deno.test("stalled session cleanup cannot prevent a bounded read from returning", async () => {
  const { deps } = fixture(); const open = deps.openSession!;
  deps.openSession = async (...args) => { const session = await open(...args); session.close = () => new Promise(() => {}); return session; };
  const started = performance.now();
  equal([...new Uint8Array(await readComposioDriveOriginal(expected, config, deps))], [...bytes]);
  assert(performance.now() - started < 500, "cleanup deadline must hold");
});
Deno.test("execution envelope must belong to the searched session", async () => {
  const { state, run } = fixture();
  state.wrap = (value: unknown) => {
    const data = JSON.parse(((value as Json).content as Json[])[0].text as string);
    if (data.data.results) data.data.session.id = "wrong-session";
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  };
  await refused(run, 503); equal(state.httpCalls.length, 0);
});

// Native pinned SDK with a simulated Streamable HTTP endpoint: initialization,
// notifications, tool discovery, explicit account invocation, JSON and SSE responses.
for (const sse of [false, true]) {
  Deno.test(`pinned MCP SDK negotiates ${sse ? "SSE" : "JSON"} without real network or redirected secrets`, async () => {
    const observed: string[] = [];
    const { state, deps } = fixture(); delete deps.openSession;
    deps.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== COMPOSIO_MCP_ENDPOINT) {
        equal(url, signedUrl); equal(new Headers(init?.headers).get("x-consumer-api-key"), null);
        equal(new Headers(init?.headers).get("Authorization"), null); equal(init?.credentials, "omit"); equal(init?.redirect, "error");
        return new Response(bytes);
      }
      equal(new Headers(init?.headers).get("x-consumer-api-key"), key); equal(init?.redirect, "error"); equal(init?.credentials, "omit");
      if (init?.method === "GET") return new Response(null, { status: 405 });
      const rpc = JSON.parse(String(init?.body)) as Json; observed.push(String(rpc.method));
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      let result: unknown;
      if (rpc.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "offline-fixture", version: "1.0.0" } };
      else if (rpc.method === "tools/list") result = { tools: ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_MULTI_EXECUTE_TOOL"].map((name) => ({ name, inputSchema: { type: "object" } })) };
      else {
        equal(rpc.method, "tools/call"); const params = rpc.params as Json;
        if (params.name === "COMPOSIO_SEARCH_TOOLS") result = call({ session: { id: "fixture-session" }, toolkit_connection_statuses: [
          { toolkit: "googledrive", has_active_connection: true, accounts: state.accounts },
        ] });
        else {
          equal(params.name, "COMPOSIO_MULTI_EXECUTE_TOOL"); const args = params.arguments as Json; const tool = (args.tools as Json[])[0];
          equal(tool.account, account); equal(args.session_id, "fixture-session");
          result = batch(String(tool.tool_slug), tool.tool_slug === "GOOGLEDRIVE_GET_FILE_METADATA" ? state.metadata : state.download);
        }
      }
      const message = JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result });
      return new Response(sse ? `event: message\ndata: ${message}\n\n` : message, {
        headers: { "Content-Type": sse ? "text/event-stream" : "application/json", "mcp-session-id": "fixture-mcp-session" },
      });
    };
    equal([...new Uint8Array(await readComposioDriveOriginal(expected, config, deps))], [...bytes]);
    equal(observed, ["initialize", "notifications/initialized", "tools/list", "tools/call", "tools/call", "tools/call"]);
  });
}
Deno.test("native SDK HTTP errors remain sanitized and do not retry or follow redirects", async () => {
  for (const status of [302, 401, 500]) {
    let requests = 0;
    await refused(() => readComposioDriveOriginal(expected, config, {
      fetch: async (input, init) => {
        requests++; equal(String(input), COMPOSIO_MCP_ENDPOINT); equal(init?.redirect, "error");
        return new Response(`provider body confidential ${signedUrl} PRIVATE_KEY=${key}`, { status, headers: { Location: "https://evil.example/credential" } });
      },
    }), 503);
    equal(requests, 1);
  }
});
Deno.test("native SDK initialization stalls are interrupted within the deadline", async () => {
  let aborted = false;
  await refused(() => readComposioDriveOriginal(expected, config, {
    timeoutMs: 30,
    fetch: async (_input, init) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
      return await new Promise<Response>(() => {});
    },
  }), 503);
  assert(aborted);
});
