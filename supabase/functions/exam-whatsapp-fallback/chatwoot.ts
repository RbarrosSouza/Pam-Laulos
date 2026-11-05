/** Chatwoot transport for the independent fallback. No implicit retries or clinical inference. */
import { examPresentation } from './exam-presentation.generated.mjs';
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const HASH = /^[a-f\d]{64}$/;
type Json = Record<string, unknown>;

export class ChatwootFallbackError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "ChatwootFallbackError"; }
}
export interface ChatwootConfig {
  baseUrl: string;
  apiAccessToken: string;
  accountId: string | number;
  inboxId: string | number;
  groupConversationId: string | number;
  groupJid: string;
  allowedAttachmentOrigins?: string[];
  maxBytes?: number;
  timeoutMs?: number;
  maxReconcilePages?: number;
  documentBaseUrl?: string;
}
export interface VerifiedPdf { bytes: Uint8Array; sha256: string; sizeBytes: number }
export interface ExpectedPdf { sha256?: string; sizeBytes?: number }
export interface GroupTask {
  documentId: string;
  deliveryId: string;
  leaseToken: string;
  sha256: string;
  sizeBytes: number;
  originalName: string;
  receivedAt: string;
  createdAt?: string;
  link?: string;
  status: "reserved" | "submitted" | "uncertain" | "sent";
  externalId?: string | null;
  configuredDestination: string;
  notificationFields?: Json;
  extractedData?: Json;
  confirmedData?: Json;
  responsibleVetId?: string | null;
  responsibleVetName?: string | null;
  responsibleVetSource?: string | null;
  presentationRevision?: string;
}
export interface DeliveryOutcome {
  status: "submitted" | "sent" | "uncertain" | "failed";
  external_id?: string;
  external_status: string;
  error?: string;
  correlation: string;
}
export interface BeginDispatchInput { deliveryId: string; leaseToken: string; contentSha256: string; presentationRevision?: string }
export interface DispatchCallbacks {
  /** Must atomically consume the reservation before returning the explicit grant. */
  beginDispatch(input: BeginDispatchInput): Promise<{ dispatch_allowed: boolean }>;
}
export interface ChatwootDependencies { fetch?: typeof fetch }
export interface ChatwootMessage extends Json { id: string | number }

function fail(code: string): never { throw new ChatwootFallbackError(code); }
function object(value: unknown): value is Json { return value !== null && typeof value === "object" && !Array.isArray(value); }
function providerId(value: unknown): string {
  const normalized = typeof value === "number" ? String(value) : value;
  if (typeof normalized !== "string" || !/^[1-9]\d{0,15}$/.test(normalized)
    || !Number.isSafeInteger(Number(normalized)) || Number(normalized) >= Number.MAX_SAFE_INTEGER) fail("provider_id_invalid");
  return normalized;
}
function publicUrl(value: string): URL {
  if (typeof value !== "string" || value.length > 8192 || /[\x00-\x20\x7f\\]/.test(value)
    || /%(?![a-f\d]{2})/i.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(value)) fail("url_not_allowed");
  let url: URL;
  try { url = new URL(value); } catch { return fail("url_not_allowed"); }
  const labels = url.hostname.split(".");
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash
    || labels.length < 2 || labels.some(label => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))
    || !/^[a-z][a-z\d-]*$/i.test(labels.at(-1) || "")
    || labels.some(label => ["localhost", "local", "localdomain", "internal", "intranet", "lan", "home"].includes(label.toLowerCase()))) fail("url_not_allowed");
  return url;
}
function publicOrigin(value: string): string {
  const url = publicUrl(value);
  if (url.pathname !== "/" || url.search) fail("origin_not_allowed");
  return url.origin;
}
async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
}
function validateTask(task: GroupTask, destination: string, maxBytes: number): void {
  if (!UUID.test(task.documentId) || !UUID.test(task.deliveryId) || !UUID.test(task.leaseToken)
    || !HASH.test(task.sha256) || !Number.isSafeInteger(task.sizeBytes) || task.sizeBytes < 1 || task.sizeBytes > maxBytes
    || task.configuredDestination !== destination || !Number.isFinite(Date.parse(task.receivedAt))
    || (task.createdAt !== undefined && !Number.isFinite(Date.parse(task.createdAt)))) fail("group_task_invalid");
  if (task.externalId != null) providerId(task.externalId);
}
function uuidShortId(uuid: string): string {
  const bytes = uuid.replace(/-/g, "").match(/../g)!.map(value => parseInt(value, 16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function prepareFallbackCaption(task: GroupTask, documentBaseUrl?: string): { content: string; fileName: string } {
  if (!UUID.test(task.documentId) || !Number.isFinite(Date.parse(task.receivedAt))) fail("caption_metadata_invalid");
  let baseUrl = documentBaseUrl ? publicOrigin(documentBaseUrl) : undefined;
  if (task.link) {
    const url = publicUrl(task.link);
    if (url.search || url.pathname !== "/e/" + uuidShortId(task.documentId)
      || (baseUrl && url.origin !== baseUrl)) fail("document_link_invalid");
    baseUrl = url.origin;
  }
  // Old claims have no identity fence. Their original label is never treated as
  // a patient name; use the shared empty-field presentation until re-reserved.
  const fenced = typeof task.presentationRevision === 'string' && /^[a-f\d]{32}$/.test(task.presentationRevision);
  const presentation = examPresentation({ id: task.documentId, received_at: task.receivedAt,
    ...(fenced ? { notification_fields: task.notificationFields, extracted_data: task.extractedData,
      confirmed_data: task.confirmedData, responsible_vet_id: task.responsibleVetId,
      responsible_vet_name: task.responsibleVetName, responsible_vet_source: task.responsibleVetSource } : {}),
  }, baseUrl);
  return { fileName: presentation.fileName, content: presentation.content };
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    void response.body?.cancel().catch(() => {}); fail("response_size_exceeded");
  }
  if (!response.body) fail("response_body_missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) fail("response_size_exceeded");
      chunks.push(part.value);
    }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function verifyPdf(bytes: Uint8Array, expected: ExpectedPdf, maxBytes: number): Promise<VerifiedPdf> {
  if (!bytes.byteLength || bytes.byteLength > maxBytes || !new TextDecoder().decode(bytes.subarray(0, 1024)).includes("%PDF-")) fail("pdf_bytes_invalid");
  if (expected.sizeBytes !== undefined && (!Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes !== bytes.byteLength)) fail("pdf_size_mismatch");
  const sha256 = await digest(bytes);
  if (expected.sha256 !== undefined && (!HASH.test(expected.sha256) || expected.sha256 !== sha256)) fail("pdf_hash_mismatch");
  return { bytes, sha256, sizeBytes: bytes.byteLength };
}
function correlation(task: GroupTask): string { return `[EXAM:${task.documentId}:DELIVERY:${task.deliveryId}]`; }
function uncertain(task: GroupTask, code: string): DeliveryOutcome {
  return { status: "uncertain", ...(task.externalId ? { external_id: task.externalId } : {}), external_status: code, error: code, correlation: correlation(task) };
}
function attachmentMatches(message: ChatwootMessage, task: GroupTask): boolean {
  if (!Array.isArray(message.attachments) || message.attachments.length !== 1 || !object(message.attachments[0])) return false;
  const attachment = message.attachments[0];
  try { providerId(attachment.id); } catch { return false; }
  if (attachment.file_type !== "file") return false;
  if (attachment.extension != null && String(attachment.extension).toLowerCase() !== "pdf") return false;
  if (attachment.content_type != null && !["application/pdf", "application/octet-stream"].includes(String(attachment.content_type).split(";")[0].trim().toLowerCase())) return false;
  for (const field of ["file_size", "size"]) if (attachment[field] != null && Number(attachment[field]) !== task.sizeBytes) return false;
  return true;
}
function messageMatches(message: ChatwootMessage, task: GroupTask): boolean {
  if (message.private !== false || ![1, "outgoing"].includes(message.message_type as string | number)) return false;
  if (task.externalId && String(message.id) !== task.externalId) return false;
  const attrs = message.content_attributes;
  return object(attrs) && attrs.pamvet_exam_document_id === task.documentId
    && attrs.pamvet_exam_delivery_id === task.deliveryId && attrs.pamvet_exam_sha256 === task.sha256 && attachmentMatches(message, task);
}
function messageTime(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value * 1000;
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) return Number(value) * 1000;
  return typeof value === "string" ? Date.parse(value) : NaN;
}

export function createChatwootClient(config: ChatwootConfig, dependencies: ChatwootDependencies = {}) {
  const base = publicOrigin(config.baseUrl);
  const account = providerId(config.accountId), inbox = providerId(config.inboxId), group = providerId(config.groupConversationId);
  if (typeof config.apiAccessToken !== "string" || !config.apiAccessToken || /[\x00-\x20\x7f]/.test(config.apiAccessToken)) fail("chatwoot_credential_invalid");
  if (!/^\d{6,32}(?:-\d{1,20})?@g\.us$/.test(config.groupJid)) fail("group_jid_invalid");
  const maxBytes = config.maxBytes ?? MAX_PDF_BYTES, timeoutMs = config.timeoutMs ?? 25_000, maxPages = config.maxReconcilePages ?? 20;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PDF_BYTES
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
    || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) fail("chatwoot_limits_invalid");
  if (config.documentBaseUrl) publicOrigin(config.documentBaseUrl);
  if ((config.allowedAttachmentOrigins?.length ?? 0) > 20) fail("attachment_origins_invalid");
  const attachmentOrigins = new Set([base, ...(config.allowedAttachmentOrigins || []).map(publicOrigin)]);
  const destination = `chatwoot:${account}:${inbox}:${group}:${config.groupJid}`;
  const fetcher = dependencies.fetch || fetch;

  async function request<T>(url: string, init: RequestInit, consume: (response: Response) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) fail("request_aborted");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => { controller.abort(); reject(new ChatwootFallbackError("request_aborted")); };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new ChatwootFallbackError("request_timeout")); }, timeoutMs);
    });
    try {
      return await Promise.race([(async () => {
        const response = await fetcher(url, { ...init, signal: controller.signal, redirect: "manual", credentials: "omit", cache: "no-store" });
        return consume(response);
      })(), timedOut, interrupted]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }
  async function jsonResponse(response: Response): Promise<Json> {
    const bytes = await readBounded(response, MAX_JSON_BYTES);
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return fail("provider_json_invalid"); }
    if (!object(body)) fail("provider_json_invalid");
    return body;
  }
  function apiUrl(conversation: string | number, suffix = ""): string {
    return `${base}/api/v1/accounts/${account}/conversations/${providerId(conversation)}${suffix}`;
  }
  function assertScope(value: Json, conversation: string): void {
    for (const [field, expected] of [["account_id", account], ["inbox_id", inbox], ["conversation_id", conversation]]) {
      if (value[field] != null && providerId(value[field]) !== expected) fail("provider_scope_mismatch");
    }
  }
  async function getConversation(conversationId: string | number, signal?: AbortSignal): Promise<Json> {
    const id = providerId(conversationId);
    const body = await request(apiUrl(id), { method: "GET", headers: { api_access_token: config.apiAccessToken } }, async response => {
      if (response.status !== 200) fail("conversation_unavailable");
      return jsonResponse(response);
    }, signal);
    if (providerId(body.id) !== id || providerId(body.inbox_id) !== inbox) fail("conversation_scope_mismatch");
    assertScope(body, id);
    return body;
  }
  async function verifyGroup(signal?: AbortSignal): Promise<Json> {
    const conversation = await getConversation(group, signal);
    const meta = object(conversation.meta) ? conversation.meta : {};
    const sender = object(meta.sender) ? meta.sender : object(conversation.contact) ? conversation.contact : {};
    const contactInbox = object(conversation.contact_inbox) ? conversation.contact_inbox : {};
    const extra = object(sender.additional_attributes) ? sender.additional_attributes : {};
    const jid = sender.identifier || contactInbox.source_id || extra.jid;
    if (jid !== config.groupJid) fail("group_destination_mismatch");
    return conversation;
  }
  async function listMessages(conversationId: string | number, before?: string | number, signal?: AbortSignal): Promise<ChatwootMessage[]> {
    const id = providerId(conversationId), cursor = before == null ? null : providerId(before);
    const body = await request(apiUrl(id, "/messages" + (cursor ? "?before=" + cursor : "")),
      { method: "GET", headers: { api_access_token: config.apiAccessToken } }, async response => {
        if (response.status !== 200) fail("messages_unavailable");
        return jsonResponse(response);
      }, signal);
    if (!Array.isArray(body.payload) || body.payload.length > 100) fail("messages_payload_invalid");
    return body.payload.map(value => {
      if (!object(value)) fail("message_invalid");
      const messageId = providerId(value.id);
      if (cursor && Number(messageId) >= Number(cursor)) fail("message_cursor_not_advancing");
      assertScope(value, id);
      return value as ChatwootMessage;
    });
  }
  // AgentBot credentials can permit conversation reads/POST while denying the
  // message index. Verify the actual read endpoints needed by intake and receipts.
  async function preflightReadAccess(sourceConversationId: string | number, signal?: AbortSignal): Promise<{ sourceConversation: Json; groupConversation: Json }> {
    const sourceConversation = await getConversation(sourceConversationId, signal);
    const groupConversation = await verifyGroup(signal);
    await listMessages(sourceConversationId, undefined, signal);
    await listMessages(group, undefined, signal);
    return { sourceConversation, groupConversation };
  }
  async function downloadPdf(downloadUrl: string, expected: ExpectedPdf = {}, signal?: AbortSignal): Promise<VerifiedPdf> {
    let current = downloadUrl;
    const visited = new Set<string>();
    for (let hop = 0; hop < 4; hop++) {
      const url = publicUrl(current);
      if (!attachmentOrigins.has(url.origin) || visited.has(url.href)) fail("media_redirect_not_allowed");
      visited.add(url.href);
      const result = await request(url.href, { method: "GET", headers: { Accept: "application/pdf, application/octet-stream" } }, async response => {
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          void response.body?.cancel().catch(() => {});
          if (!location || (!/^https:\/\//i.test(location) && (!location.startsWith("/") || location.startsWith("//")))) fail("media_redirect_not_allowed");
          return { location: /^https:\/\//i.test(location) ? location : url.origin + location };
        }
        if (response.status !== 200) fail("media_download_failed");
        const mime = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (!["application/pdf", "application/octet-stream"].includes(mime)) fail("media_mime_invalid");
        return { pdf: await verifyPdf(await readBounded(response, maxBytes), expected, maxBytes) };
      }, signal);
      if (result.pdf) return result.pdf;
      current = result.location!;
    }
    return fail("media_redirect_limit");
  }
  async function reconcileGroup(task: GroupTask, signal?: AbortSignal): Promise<DeliveryOutcome> {
    validateTask(task, destination, maxBytes);
    const matches = new Map<string, ChatwootMessage>();
    const seen = new Set<string>();
    // The provider's exclusive ID cursor can locate an old known receipt in one
    // page without walking newer group traffic. Matching still verifies all IDs,
    // the content hash and the attachment; this never authorizes another POST.
    let before: string | undefined = task.externalId ? String(Number(task.externalId) + 1) : undefined;
    let complete = false;
    const earliest = Date.parse(task.createdAt || task.receivedAt) - 86_400_000;
    try {
      await verifyGroup(signal);
      for (let page = 0; page < maxPages; page++) {
        const messages = await listMessages(group, before, signal);
        for (const message of messages) {
          const id = providerId(message.id);
          if (seen.has(id)) fail("message_pagination_cycle");
          seen.add(id);
          if (messageMatches(message, task)) matches.set(id, message);
        }
        if (matches.size > 1) return uncertain(task, "reconciliation_multiple_matches");
        if (task.externalId && matches.size === 1) { complete = true; break; }
        if (!messages.length || messages.every(message => Number.isFinite(messageTime(message.created_at)) && messageTime(message.created_at) < earliest)) { complete = true; break; }
        before = String(Math.min(...messages.map(message => Number(message.id))));
      }
    } catch { return uncertain(task, "reconciliation_unavailable"); }
    if (!complete) return uncertain(task, "reconciliation_incomplete");
    if (matches.size !== 1) return uncertain(task, "reconciliation_no_match");
    const message = [...matches.values()][0];
    const status = String(message.status || "api_created");
    return { status: ["delivered", "read"].includes(status) ? "sent" : status === "failed" ? "uncertain" : "submitted",
      external_id: String(message.id), external_status: status,
      ...(status === "failed" ? { error: "provider_delivery_failed_requires_review" } : {}), correlation: correlation(task) };
  }
  async function sendGroupOnce(task: GroupTask, pdf: VerifiedPdf, callbacks: DispatchCallbacks, signal?: AbortSignal): Promise<DeliveryOutcome> {
    validateTask(task, destination, maxBytes);
    if (task.externalId || ["submitted", "uncertain", "sent"].includes(task.status)) return reconcileGroup(task, signal);
    if (task.status !== "reserved") fail("dispatch_not_reserved");
    let form: FormData, content: string;
    try {
      await verifyGroup(signal);
      await verifyPdf(pdf.bytes, { sha256: task.sha256, sizeBytes: task.sizeBytes }, maxBytes);
      const presentation = prepareFallbackCaption(task, config.documentBaseUrl);
      content = presentation.content;
      form = new FormData();
      form.set("content", content); form.set("message_type", "outgoing"); form.set("private", "false");
      form.set("attachments[]", new Blob([pdf.bytes.slice().buffer], { type: "application/pdf" }), presentation.fileName);
      form.set("content_attributes", JSON.stringify({ pamvet_exam_document_id: task.documentId,
        pamvet_exam_delivery_id: task.deliveryId, pamvet_exam_sha256: task.sha256 }));
    } catch (error) {
      return { status: "failed", external_status: "preflight_failed", error: error instanceof ChatwootFallbackError ? error.code : "group_preflight_failed", correlation: correlation(task) };
    }
    const grant = await callbacks.beginDispatch({ deliveryId: task.deliveryId, leaseToken: task.leaseToken,
      contentSha256: await digest(new TextEncoder().encode(content)),
      ...(task.presentationRevision ? { presentationRevision: task.presentationRevision } : {}) });
    if (grant?.dispatch_allowed !== true) fail("dispatch_fence_denied");
    // After the durable grant, every ambiguous result remains uncertain. No POST retry exists here.
    try {
      return await request(apiUrl(group, "/messages"), { method: "POST", headers: { api_access_token: config.apiAccessToken }, body: form }, async response => {
        if (response.status >= 400 && response.status < 500 && ![408, 409, 429].includes(response.status)) {
          void response.body?.cancel().catch(() => {});
          return { status: "uncertain", external_status: "rejected", error: "provider_rejected_" + response.status, correlation: correlation(task) };
        }
        if (response.status < 200 || response.status >= 300) return uncertain(task, "response_unknown");
        const body = await jsonResponse(response);
        const id = providerId(body.id);
        assertScope(body, group);
        return { status: "submitted", external_id: id, external_status: String(body.status || "api_created"), correlation: correlation(task) };
      }, signal);
    } catch { return uncertain(task, "response_unknown"); }
  }
  return { getConversation, listMessages, preflightReadAccess, downloadPdf, sendGroupOnce, reconcileGroup, destination };
}
