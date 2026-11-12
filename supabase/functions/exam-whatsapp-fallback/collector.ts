/**
 * Bounded Chatwoot discovery for explicitly configured individual conversations.
 * No network implementation, credentials, storage, dispatch or n8n dependency.
 * Returned media URLs are transient: persist origin identity, not signed URLs.
 * Caller must durably enqueue origins before persisting the returned cursor.
 */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
type Json = Record<string, unknown>;

export interface CollectorConfig {
  chatwootBaseUrl: string;
  accountId: string;
  inboxId: string;
  knownConversationIds: string[];
  authorizedSenders: string[];
  allowedAttachmentOrigins?: string[];
  intakeCutoff: string;
  allowBrazilLegacyMobileAlias?: boolean;
  maxBytes?: number;
}
export interface CollectedOrigin {
  source: {
    channel: "whatsapp"; account_id: string; message_id: string; attachment_id: string;
    original_name: string; mime_type: "application/pdf"; received_at: string; metadata: Json;
  };
  attachment: { id: string; chatwootAttachmentId: string; name: string; contentType: "application/pdf"; size: number | null; downloadUrl: string | null };
  missing: boolean;
  pendingReason: string | null;
}
export interface CollectorCursor {
  version: 1;
  scope: string;
  conversationIndex: number;
  beforeMessageId: string | null;
  highWaterMessageIds: Record<string, string>;
}
export interface CollectorOptions {
  receivedFrom: string;
  receivedThrough: string;
  cursor?: CollectorCursor | null;
  /** Previously enumerated ID floors; absence requires pagination to an empty page. */
  stopBeforeMessageIds?: Record<string, string>;
  maxPages?: number;
  /** At least 100 so a provider message's complete attachment inventory fits. */
  maxOrigins?: number;
  maxMillis?: number;
}
export interface CollectorIO {
  getConversation(id: string, signal: AbortSignal): Promise<unknown>;
  getMessages(id: string, beforeMessageId: string | null, signal: AbortSignal): Promise<unknown>;
  now?: () => number;
}
export interface CollectorResult {
  origins: CollectedOrigin[];
  cursor: CollectorCursor | null;
  complete: boolean;
  scope: "configured_conversations_only";
  coverageGuaranteed: false;
  reason: "complete" | "page_budget" | "origin_budget" | "time_budget" | "source_error";
  errorCode?: string;
  pages: number;
  messages: number;
  highWaterMessageIds: Record<string, string>;
}

function fail(code: string): never { throw new Error(code); }
function object(value: unknown): value is Json { return value !== null && typeof value === "object" && !Array.isArray(value); }
function id(value: unknown, code = "whatsapp_id_invalid"): string {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !/^[1-9]\d{0,15}$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) >= Number.MAX_SAFE_INTEGER) fail(code);
  return text;
}
function instant(value: unknown): number {
  let n: number;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) n = value < 1e12 ? value * 1000 : value;
  else if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) n = Date.parse(value);
  else fail("whatsapp_received_at_invalid");
  if (!Number.isFinite(n) || n <= 0) fail("whatsapp_received_at_invalid");
  return n;
}
export function normalizeBrazilPhone(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64 || !/^\+?[\d\s().-]+$/.test(value)) return null;
  const digits = value.replace(/\D/g, "");
  const national = digits.length === 12 || digits.length === 13 ? (digits.startsWith("55") ? digits.slice(2) : "") : digits;
  if (!/^[1-9]\d[2-9]\d{7,8}$/.test(national) || (national.length === 11 && national[2] !== "9")) return null;
  return "55" + national;
}
function aliases(phone: string, legacy: boolean): string[] {
  return legacy && /^55[1-9]\d9[6-9]\d{7}$/.test(phone) ? [phone, phone.slice(0, 4) + phone.slice(5)] : [phone];
}
function providerPhone(value: unknown): string | null {
  return typeof value === "string" ? normalizeBrazilPhone(value.replace(/@(s\.whatsapp\.net|c\.us)$/, "")) : null;
}
function mediaUrl(value: unknown): { href: string; origin: string; pathname: string } {
  if (typeof value !== "string" || value.length > 8192 || /[\x00-\x20\x7f\\#]/.test(value) || /%(?![a-f\d]{2})/i.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(value)) fail("whatsapp_media_url_invalid");
  const match = /^https:\/\/([a-z\d.-]+)(?::443)?(\/[^?#]*)?(\?[^#]*)?$/i.exec(value);
  if (!match) fail("whatsapp_media_url_invalid");
  const host = match[1].toLowerCase(), labels = host.split(".");
  if (host.length > 253 || labels.length < 2 || labels.some(x => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(x))
    || !/^[a-z][a-z\d-]*$/.test(labels.at(-1)!) || labels.some(x => ["localhost", "local", "localdomain", "internal", "intranet", "lan", "home"].includes(x))) fail("whatsapp_media_url_invalid");
  const origin = "https://" + host, pathname = match[2] || "/";
  return { origin, pathname, href: origin + pathname + (match[3] || "") };
}
export function allowedAttachmentUrl(value: unknown, config: CollectorConfig): string | null {
  try {
    const url = mediaUrl(value);
    const allowed = [config.chatwootBaseUrl, ...(config.allowedAttachmentOrigins || [])].map(x => mediaUrl(x).origin);
    return allowed.includes(url.origin) ? url.href : null;
  } catch { return null; }
}
export function resolveAllowedAttachmentRedirect(location: unknown, current: string, config: CollectorConfig): string {
  if (typeof location !== "string") fail("whatsapp_media_redirect_not_allowed");
  const candidate = /^https:\/\//i.test(location) ? location : location.startsWith("/") && !location.startsWith("//") ? mediaUrl(current).origin + location : null;
  const result = allowedAttachmentUrl(candidate, config);
  if (!result) fail("whatsapp_media_redirect_not_allowed");
  return result;
}
function group(value: Json, conversation: Json): boolean {
  const sender = object(value.sender) ? value.sender : {}, meta = object(conversation.meta) ? conversation.meta : {}, contact = object(meta.sender) ? meta.sender : {};
  const objects = [value, conversation, sender, contact, value.additional_attributes, conversation.additional_attributes,
    sender.additional_attributes, contact.additional_attributes, conversation.custom_attributes, sender.custom_attributes, contact.custom_attributes].filter(object);
  if (objects.some(x => x.is_group === true || x.group === true || x.type === "group" || x.contact_type === "group" || (typeof x.group_type === "string" && x.group_type.toLowerCase() === "group") || x.group_id != null)) return true;
  const inbox = object(conversation.contact_inbox) ? conversation.contact_inbox : {};
  return [inbox.source_id, sender.identifier, sender.phone_number, contact.identifier, contact.phone_number,
    ...objects.flatMap(x => [x.chat_id, x.remote_jid, x.jid, x.identifier, x.source_id])].some(x => typeof x === "string" && /@(?:g\.us|broadcast)$/i.test(x));
}
function mirror(message: Json, conversation: Json): boolean {
  return [message.content_attributes, message.additional_attributes, conversation.additional_attributes].some(x => object(x) && Object.keys(x).some(k => /^pamvet_exam_/.test(k)))
    || (typeof message.content === "string" && /\[EXAM:[a-f\d-]+:DELIVERY:[a-f\d-]+\]/i.test(message.content));
}
function body(value: unknown): Json {
  if (!object(value)) fail("whatsapp_response_invalid");
  if (Object.hasOwn(value, "statusCode")) {
    if (value.statusCode !== 200 || !object(value.body)) fail("whatsapp_response_not_successful");
    return value.body;
  }
  return value;
}
function validatedConfig(config: CollectorConfig): CollectorConfig {
  if (!object(config)) fail("whatsapp_config_invalid");
  id(config.accountId); id(config.inboxId); instant(config.intakeCutoff);
  if (!Array.isArray(config.knownConversationIds) || !config.knownConversationIds.length || config.knownConversationIds.length > 20
    || new Set(config.knownConversationIds.map(x => id(x))).size !== config.knownConversationIds.length) fail("whatsapp_conversations_config_invalid");
  if (!Array.isArray(config.authorizedSenders) || !config.authorizedSenders.length || config.authorizedSenders.length > 20
    || config.authorizedSenders.some(x => normalizeBrazilPhone(x)?.length !== 13)) fail("whatsapp_senders_config_invalid");
  if (config.allowBrazilLegacyMobileAlias !== undefined && typeof config.allowBrazilLegacyMobileAlias !== "boolean") fail("whatsapp_alias_config_invalid");
  if (config.allowedAttachmentOrigins !== undefined && (!Array.isArray(config.allowedAttachmentOrigins) || config.allowedAttachmentOrigins.length > 20)) fail("whatsapp_origins_config_invalid");
  for (const origin of [config.chatwootBaseUrl, ...(config.allowedAttachmentOrigins || [])]) {
    const url = mediaUrl(origin);
    if (url.href !== url.origin + "/") fail("whatsapp_origins_config_invalid");
  }
  if (!Number.isSafeInteger(config.maxBytes ?? MAX_PDF_BYTES) || (config.maxBytes ?? MAX_PDF_BYTES) < 1 || (config.maxBytes ?? MAX_PDF_BYTES) > MAX_PDF_BYTES) fail("whatsapp_max_bytes_invalid");
  return config;
}
function verifiedConversation(value: unknown, conversationId: string, config: CollectorConfig): Json {
  const conversation = body(value);
  if (!config.knownConversationIds.includes(conversationId) || id(conversation.id) !== conversationId || id(conversation.inbox_id) !== config.inboxId
    || (conversation.account_id != null && id(conversation.account_id) !== config.accountId)) fail("whatsapp_conversation_scope_mismatch");
  if (group({}, conversation) || mirror({}, conversation)) fail("whatsapp_individual_conversation_required");
  const meta = object(conversation.meta) ? conversation.meta : {}, contact = object(meta.sender) ? meta.sender : null;
  if (!contact || (contact.type != null && contact.type !== "contact")) fail("whatsapp_contact_unproven");
  id(contact.id);
  const phone = normalizeBrazilPhone(contact.phone_number);
  const allowed = config.authorizedSenders.flatMap(x => aliases(normalizeBrazilPhone(x)!, config.allowBrazilLegacyMobileAlias === true));
  if (!phone || !allowed.includes(phone)) fail("whatsapp_sender_not_authorized");
  if (conversation.contact_inbox != null && (!object(conversation.contact_inbox) || !allowed.includes(providerPhone(conversation.contact_inbox.source_id) || ""))) fail("whatsapp_individual_conversation_unproven");
  return conversation;
}
/** Preflight uses the same pinned-conversation and sender policy as discovery. */
export function verifyFallbackSourceConversation(value: unknown, config: CollectorConfig): Json {
  validatedConfig(config);
  const conversation = body(value);
  return verifiedConversation(conversation, id(conversation.id), config);
}
function originalName(a: Json): string {
  for (const value of [a.file_name, a.filename, a.name, a.fallback_title]) {
    if (typeof value === "string" && value.trim() && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value)) return value.trim().replace(/[\\/]/g, "_");
  }
  try {
    const value = decodeURIComponent(mediaUrl(a.data_url).pathname.split("/").at(-1) || "");
    if (/\.pdf$/i.test(value) && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value)) return value.replace(/[\\/]/g, "_");
  } catch { /* Unusable URL remains a pending candidate below. */ }
  return "Exame.pdf";
}
/** Same authorization as OP05; generic/missing MIME remains a candidate for byte validation. */
export function inspectFallbackMessage(conversationValue: unknown, messageValue: unknown, config: CollectorConfig): CollectedOrigin[] {
  validatedConfig(config);
  if (!object(messageValue)) fail("whatsapp_message_invalid");
  const message = messageValue;
  if (![0, "incoming"].includes(message.message_type as string | number)) return [];
  if (message.private !== false) { if (message.private === true) return []; fail("whatsapp_message_privacy_unproven"); }
  const conv = body(conversationValue), conversationId = id(conv.id);
  const conversation = verifiedConversation(conv, conversationId, config);
  const messageId = id(message.id);
  for (const [field, expected] of [["conversation_id", conversationId], ["account_id", config.accountId], ["inbox_id", config.inboxId]]) {
    if (message[field] != null && id(message[field]) !== expected) fail("whatsapp_message_scope_mismatch");
  }
  if (group(message, conversation) || mirror(message, conversation)) return [];
  const sender = object(message.sender) ? message.sender : null;
  const contact = (conversation.meta as Json).sender as Json;
  if (!sender || (sender.type != null && sender.type !== "contact") || id(sender.id) !== id(contact.id)) fail("whatsapp_sender_identity_mismatch");
  const phone = normalizeBrazilPhone(sender.phone_number), contactPhone = normalizeBrazilPhone(contact.phone_number);
  const canonical = config.authorizedSenders.map(x => normalizeBrazilPhone(x)!).find(x => {
    const allowed = aliases(x, config.allowBrazilLegacyMobileAlias === true);
    return !!phone && !!contactPhone && allowed.includes(phone) && allowed.includes(contactPhone);
  });
  if (!canonical) fail("whatsapp_sender_phone_mismatch");
  if (conversation.contact_inbox != null && ![phone, contactPhone].includes(providerPhone((conversation.contact_inbox as Json).source_id))) fail("whatsapp_contact_inbox_mismatch");
  const received = instant(message.created_at);
  if (received < instant(config.intakeCutoff)) return [];
  if (message.attachments != null && !Array.isArray(message.attachments)) fail("whatsapp_attachment_inventory_invalid");
  if (!Array.isArray(message.attachments) || !message.attachments.length) return [];
  if (message.attachments.length > 100) fail("whatsapp_attachment_limit");
  const result: CollectedOrigin[] = [], seen = new Set<string>();
  for (const item of message.attachments) {
    if (!object(item)) fail("whatsapp_attachment_invalid");
    const attachmentId = id(item.id);
    if (seen.has(attachmentId)) fail("whatsapp_duplicate_attachment_id");
    seen.add(attachmentId);
    if (item.account_id != null && id(item.account_id) !== config.accountId || item.message_id != null && id(item.message_id) !== messageId) fail("whatsapp_attachment_scope_mismatch");
    const mime = item.content_type ?? item.mime_type;
    const mimeText = typeof mime === "string" ? mime.split(";")[0].trim().toLowerCase() : null;
    const generic = mime == null || mimeText === "application/octet-stream";
    let pdf = mimeText === "application/pdf" || generic || [item.file_name, item.filename, item.name, item.fallback_title].some(x => typeof x === "string" && /\.pdf$/i.test(x)) || typeof item.extension === "string" && item.extension.toLowerCase().replace(/^\./, "") === "pdf";
    try { pdf ||= /\.pdf$/i.test(decodeURIComponent(mediaUrl(item.data_url).pathname)); } catch { /* Validate as pending when other PDF evidence exists. */ }
    if (!pdf) continue;
    const size = item.file_size == null ? null : typeof item.file_size === "number" || typeof item.file_size === "string" && /^\d+$/.test(item.file_size) ? Number(item.file_size) : NaN;
    const badSize = size !== null && (!Number.isSafeInteger(size) || size <= 0 || size > (config.maxBytes ?? MAX_PDF_BYTES));
    const badMime = mime != null && !["application/pdf", "application/octet-stream"].includes(mimeText || "");
    const url = allowedAttachmentUrl(item.data_url, config);
    const reason = badSize ? "pdf_size_invalid_or_exceeds_limit" : badMime ? "pdf_metadata_mismatch" : !url ? "pdf_url_missing_or_untrusted" : null;
    const key = "chatwoot-attachment:" + attachmentId, name = originalName(item);
    result.push({ source: { channel: "whatsapp", account_id: "chatwoot:" + config.accountId + ":inbox:" + config.inboxId, message_id: messageId,
      attachment_id: key, original_name: name, mime_type: "application/pdf", received_at: new Date(received).toISOString(),
      metadata: { provider: "chatwoot", chatwoot_account_id: config.accountId, chatwoot_inbox_id: config.inboxId, chatwoot_conversation_id: conversationId,
        chatwoot_message_id: messageId, chatwoot_attachment_id: attachmentId, sender_phone: canonical, sender_allowlisted: true, unknown_sender: false,
        exam_candidate: true, missing_attachment: !url, unsupported_attachment: badSize || badMime, pending_reason: reason } },
      attachment: { id: key, chatwootAttachmentId: attachmentId, name, contentType: "application/pdf", size: Number.isFinite(size) ? size : null, downloadUrl: reason ? null : url },
      missing: reason !== null, pendingReason: reason });
  }
  return result;
}

export async function collectWhatsappOrigins(config: CollectorConfig, io: CollectorIO, options: CollectorOptions): Promise<CollectorResult> {
  validatedConfig(config);
  const from = Math.max(instant(options.receivedFrom), instant(config.intakeCutoff)), through = instant(options.receivedThrough);
  if (through <= from) fail("whatsapp_window_invalid");
  const pagesLimit = options.maxPages ?? 8, originsLimit = options.maxOrigins ?? 100, millis = options.maxMillis ?? 40_000;
  if (!Number.isSafeInteger(pagesLimit) || pagesLimit < 1 || pagesLimit > 100 || !Number.isSafeInteger(originsLimit) || originsLimit < 100 || originsLimit > 1000
    || !Number.isSafeInteger(millis) || millis < 10 || millis > 120_000) fail("whatsapp_budget_invalid");
  const floors = options.stopBeforeMessageIds || {};
  for (const [key, value] of Object.entries(floors)) if (!config.knownConversationIds.includes(id(key)) || id(value) !== value) fail("whatsapp_watermark_invalid");
  const scopeMaterial = JSON.stringify([config.accountId, config.inboxId, config.knownConversationIds, config.authorizedSenders, config.allowBrazilLegacyMobileAlias === true,
    config.chatwootBaseUrl, config.allowedAttachmentOrigins || [], config.maxBytes ?? MAX_PDF_BYTES, config.intakeCutoff, from, through, Object.entries(floors).sort()]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scopeMaterial));
  const scope = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
  const cursor: CollectorCursor = options.cursor ? structuredClone(options.cursor) : { version: 1, scope, conversationIndex: 0, beforeMessageId: null, highWaterMessageIds: {} };
  if (cursor.version !== 1 || cursor.scope !== scope || !Number.isSafeInteger(cursor.conversationIndex) || cursor.conversationIndex < 0 || cursor.conversationIndex >= config.knownConversationIds.length
    || cursor.beforeMessageId !== null && id(cursor.beforeMessageId) !== cursor.beforeMessageId || !object(cursor.highWaterMessageIds)) fail("whatsapp_cursor_invalid");
  for (const [key, value] of Object.entries(cursor.highWaterMessageIds)) if (!config.knownConversationIds.includes(id(key)) || id(value) !== value) fail("whatsapp_cursor_invalid");
  const origins: CollectedOrigin[] = [], now = io.now || Date.now, deadline = now() + millis;
  let pages = 0, messages = 0;
  const result = (reason: CollectorResult["reason"], errorCode?: string): CollectorResult => ({ origins, cursor: reason === "complete" ? null : structuredClone(cursor), complete: reason === "complete",
    scope: "configured_conversations_only", coverageGuaranteed: false, reason, ...(errorCode ? { errorCode } : {}), pages, messages, highWaterMessageIds: { ...cursor.highWaterMessageIds } });
  const call = async (fn: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> => {
    const remaining = Math.min(8_000, deadline - now());
    if (remaining <= 0) fail("whatsapp_time_budget");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([fn(controller.signal), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("whatsapp_request_timeout")); }, remaining); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
  };
  try {
    while (cursor.conversationIndex < config.knownConversationIds.length) {
      if (now() >= deadline) return result("time_budget");
      if (pages >= pagesLimit) return result("page_budget");
      const conversationId = config.knownConversationIds[cursor.conversationIndex];
      const conversation = verifiedConversation(await call(signal => io.getConversation(conversationId, signal)), conversationId, config);
      let done = false;
      while (!done) {
        if (now() >= deadline) return result("time_budget");
        if (pages >= pagesLimit) return result("page_budget");
        const response = body(await call(signal => io.getMessages(conversationId, cursor.beforeMessageId, signal)));
        if (!Array.isArray(response.payload) || response.payload.length > 100 || response.payload.some(x => !object(x))) fail("whatsapp_messages_payload_invalid");
        const rows = (response.payload as Json[]).slice().sort((a, b) => Number(id(b.id)) - Number(id(a.id)));
        if (new Set(rows.map(x => id(x.id))).size !== rows.length) fail("whatsapp_message_page_duplicate");
        if (cursor.beforeMessageId !== null && rows.some(x => Number(id(x.id)) >= Number(cursor.beforeMessageId))) fail("whatsapp_message_pagination_cycle");
        pages++;
        if (rows.length && !cursor.highWaterMessageIds[conversationId]) cursor.highWaterMessageIds[conversationId] = id(rows[0].id);
        if (!rows.length) done = true;
        for (const row of rows) {
          const messageId = id(row.id);
          if (floors[conversationId] && Number(messageId) <= Number(floors[conversationId])) { done = true; break; }
          for (const [field, expected] of [["conversation_id", conversationId], ["account_id", config.accountId], ["inbox_id", config.inboxId]]) if (row[field] != null && id(row[field]) !== expected) fail("whatsapp_message_scope_mismatch");
          const received = instant(row.created_at);
          // Never offer a committed ID floor that would hide a message outside
          // this round's upper time boundary, even if provider times are unordered.
          if (received >= through) {
            const safeFloor = Math.min(Number(cursor.highWaterMessageIds[conversationId] || messageId), Number(messageId) - 1);
            if (safeFloor > 0) cursor.highWaterMessageIds[conversationId] = String(safeFloor);
            else delete cursor.highWaterMessageIds[conversationId];
          }
          const found = received >= from && received < through ? inspectFallbackMessage(conversation, row, config) : [];
          if (origins.length + found.length > originsLimit) return result("origin_budget");
          origins.push(...found); messages++; cursor.beforeMessageId = messageId;
        }
        if (done) { cursor.conversationIndex++; cursor.beforeMessageId = null; }
      }
    }
    return result("complete");
  } catch (error) {
    const code = error instanceof Error && /^whatsapp_[a-z0-9_]+$/.test(error.message) ? error.message
      : error instanceof Error && error.name === 'ChatwootFallbackError' && /^[a-z][a-z0-9_]{0,80}$/.test(error.message)
        ? 'whatsapp_' + error.message : "whatsapp_source_request_failed";
    return result(code === "whatsapp_time_budget" ? "time_budget" : "source_error", code);
  }
}
