import { intakeActions, runIntakeAction } from "./intake-service-routes.ts";
import { authenticateExamIntakeMonitor, authorizeExamIntakeMonitorAction, filterExamIntakeMonitorResult } from "./intake-monitor-auth.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.99.3";
import { composioReaderConfig, readComposioDriveOriginal, oauthDriveReaderConfig, readOAuthDriveOriginal } from "./composio-original-reader.ts";
import { selectExamSupabasePrivilegedKey } from "./supabase-privileged-key.ts";

// v1: workers use a dedicated secret, never a browser/service-role credential.
// User-facing file/upload actions additionally require a verified Supabase user and active membership.
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-exam-intake-monitor",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "Content-Disposition, X-Exam-Document-Id",
};
type Json = Record<string, unknown>;

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
function error(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) error("ID inválido");
  return value;
}
function plain(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}
async function sha256(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Restrict redirect following to prevent a compromised external file URL from reaching internal services.
async function readDocumentBytes(client: SupabaseClient, doc: Json): Promise<ArrayBuffer> {
  const bucket = (doc.storage_bucket || doc.staging_bucket) as string | undefined;
  const path = (doc.storage_path || doc.staging_path) as string | undefined;
  let bytes: ArrayBuffer;
  if (bucket && path) {
    if (!['exam_documents_private', 'exam_documents_staging'].includes(bucket)) error("Bucket de documento inválido", 409);
    const { data, error: storageError } = await client.storage.from(bucket).download(path);
    if (storageError || !data) error("Arquivo privado indisponível; preservar pendência", 503);
    bytes = await data.arrayBuffer();
  } else if (typeof doc.drive_file_id === "string") {
    const mode = Deno.env.get("EXAM_DRIVE_READER") || "oauth";
    if (mode === "composio") {
      // Explicit opt-in only. A failed consumer read never falls back to another account/OAuth.
      // This adapter limits streaming to 20 MiB; the existing OAuth/storage limit stays unchanged.
      bytes = await readComposioDriveOriginal({ fileId: doc.drive_file_id, folderId: doc.drive_folder_id, sha256: doc.sha256, sizeBytes: doc.size_bytes },
        composioReaderConfig((name) => Deno.env.get(name)));
    } else if (mode === "oauth") {
      bytes = await readOAuthDriveOriginal({ fileId: doc.drive_file_id, folderId: doc.drive_folder_id, sha256: doc.sha256, sizeBytes: doc.size_bytes },
        oauthDriveReaderConfig((name) => Deno.env.get(name)));
    } else error("Modo de leitura Drive inválido no servidor", 503);
  } else error("Documento ainda não tem arquivo preservado", 409);
  if (bytes.byteLength > 52428800 || bytes.byteLength !== Number(doc.size_bytes)) error("Tamanho do original diverge do registro", 409);
  if (await sha256(bytes) !== doc.sha256) error("Integridade do original divergente; revisão necessária", 409);
  return bytes;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return response({ error: "Use POST" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = selectExamSupabasePrivilegedKey((name) => Deno.env.get(name));
    if (!url || !key) error("Backend de exames não configurado", 503);
    const service = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const authorization = req.headers.get("Authorization") || "";
    const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
    const workerKey = Deno.env.get("EXAM_INGESTION_API_KEY");
    // n8n Header Auth sends the configured value verbatim. A raw 32-byte hex
    // worker token is compatible only when it matches the SAME dedicated secret.
    // User JWTs still require Bearer and go through getUser + active membership.
    const rawWorkerToken = /^[a-f0-9]{64}$/i.test(authorization) ? authorization : undefined;
    const isWorker = Boolean(workerKey && ((bearer && safeEqual(bearer, workerKey))
      || (rawWorkerToken && safeEqual(rawWorkerToken, workerKey))));
    const isMonitor = authenticateExamIntakeMonitor(authorization, (name) => Deno.env.get(name), safeEqual);
    // Explicit monitor intent never falls back to broader worker or member access.
    if (req.headers.has("X-Exam-Intake-Monitor") && (req.headers.get("X-Exam-Intake-Monitor") !== "1" || !isMonitor)) error("Autenticação do monitor inválida", 401);
    if (!bearer && !isWorker && !isMonitor) error("Autenticação obrigatória", 401);
    let userId: string | undefined;
    if (!isWorker && !isMonitor) {
      const { data: auth, error: authError } = await service.auth.getUser(bearer!);
      if (authError || !auth.user) error("Sessão inválida", 401);
      const { data: member, error: memberError } = await service.from("exam_document_member")
        .select("user_id,active").eq("user_id", auth.user.id).eq("active", true).maybeSingle();
      if (memberError || !member) error("Usuário sem autorização para exames", 403);
      userId = auth.user.id;
    }
    const isMultipart = req.headers.get("Content-Type")?.startsWith("multipart/form-data");
    if (isMonitor && isMultipart) authorizeExamIntakeMonitorAction(true, '', true);
    let action: string;
    let payload: Json;
    let form: FormData | undefined;
    if (isMultipart) {
      const length = Number(req.headers.get("content-length") || 0);
      if (length > 53477376) error("Upload acima do limite", 413);
      form = await req.formData();
      action = String(form.get("action") || "upload");
      try { payload = plain(JSON.parse(String(form.get("payload") || "{}"))); } catch { error("Payload de upload inválido"); }
    } else {
      let json: Json;
      try { json = plain(await req.json()); } catch { error("JSON inválido"); }
      action = String(json.action || ""); payload = plain(json.payload);
    }
    authorizeExamIntakeMonitorAction(isMonitor, action, Boolean(isMultipart));
    if (!isWorker && !isMonitor && !['upload', 'file', 'file_url', 'delete'].includes(action)) error("Ação restrita ao worker", 403);
    async function rpc(name: string, args: Json) {
      const { data, error: rpcError } = await service.rpc(name, args);
      if (rpcError) {
        // Return controlled RPC messages without request bodies, secrets or PDF text in technical logs.
        const status = rpcError.code === '42501' ? 403 : rpcError.code === '40001' ? 409 : 400;
        error(rpcError.message, status);
      }
      return data;
    }
    async function document(id: unknown): Promise<Json> {
      const { data, error: docError } = await service.from("exam_document").select("*").eq("id", uuid(id)).maybeSingle();
      if (docError) error("Banco de exames indisponível", 503);
      if (!data) error("Documento não encontrado", 404);
      if (data.deletion_state) error("Ficha em exclusão ou excluída", 409);
      if (data.canonical_document_id) {
        const { data: canonical, error: canonicalError } = await service.from("exam_document").select("*").eq("id", data.canonical_document_id).single();
        if (canonicalError) error("Documento canônico indisponível", 503);
        if (canonical.deletion_state) error("Ficha em exclusão ou excluída", 409);
        return canonical;
      }
      return data;
    }
    if (intakeActions.has(action)) {
      const result = await runIntakeAction(action, payload, rpc, { uuid, hash: sha256 });
      return response(filterExamIntakeMonitorResult(action, result, isMonitor));
    }
    switch (action) {
      case "delete": {
        // Destructive action is never available to worker or monitor credentials.
        if (!userId || isWorker || isMonitor) error("Exclusão exige sessão da equipe", 403);
        const id = uuid(payload.document_id);
        if (payload.confirmation !== 'DELETAR') error("Digite DELETAR para confirmar", 400);
        if (!Number.isSafeInteger(payload.expected_version) || Number(payload.expected_version) < 1) error("Versão da ficha inválida", 400);
        const operation = await rpc('begin_exam_document_deletion', {
          p_id: id, p_version: payload.expected_version, p_actor: userId, p_confirmation: payload.confirmation,
        });
        if (operation.state === 'deleted') return response({ state: 'deleted' });
        if (operation.state !== 'deleting') error("Não foi possível iniciar a exclusão", 409);
        for (const [bucket, path] of [[operation.storage_bucket, operation.storage_path], [operation.staging_bucket, operation.staging_path]]) {
          if (!bucket && !path) continue;
          if (!['exam_documents_private', 'exam_documents_staging'].includes(bucket) || typeof path !== 'string' || !path) error("Local do arquivo inválido; exclusão pendente", 409);
          const { error: removeError } = await service.storage.from(bucket).remove([path]);
          if (removeError) error("Não foi possível remover o arquivo; tente excluir novamente", 503);
        }
        const result = await rpc('finish_exam_document_deletion', { p_id: id, p_actor: userId, p_confirmation: payload.confirmation });
        if (result.state !== 'deleted') error("Exclusão pendente; tente novamente", 409);
        return response({ state: 'deleted' });
      }
      case "reaction_preview": return response(await rpc("preview_exam_contact_reactions", {}));
      case "reaction_reserve_tasks": return response(await rpc("reserve_exam_contact_reactions", {
        p_worker: String(payload.worker || ""), p_limit: Number(payload.limit ?? 1),
      }));
      case "reaction_begin": {
        if (typeof payload.actor_id !== "number" || !Number.isSafeInteger(payload.actor_id) || payload.actor_id < 1) error("REACTION_ACTOR_INVALID");
        return response(await rpc("begin_exam_contact_reaction", {
          p_reaction_id: uuid(payload.reaction_id), p_lease_token: uuid(payload.lease_token),
          p_destination_key: String(payload.destination_key || ""), p_external_message_id: String(payload.external_message_id || ""),
          p_emoji: String(payload.emoji || ""), p_actor_id: payload.actor_id,
        }));
      }
      case "reaction_result": return response(await rpc("record_exam_contact_reaction_result", {
        p_reaction_id: uuid(payload.reaction_id), p_lease_token: uuid(payload.lease_token), p_outcome: plain(payload.outcome),
      }));
      case "pending_summary_preview": return response(await rpc("preview_exam_pending_summary", {}));
      case "pending_summary_reserve": return response(await rpc("reserve_exam_pending_summary", {
        // Day, time window and destination are owned by the server, not payload overrides.
        p_worker: String(payload.worker || ""),
      }));
      case "pending_summary_begin": {
        const content = payload.content;
        if (typeof content !== "string" || !content.trim() || content.length > 12000 || content.includes("\u0000")) error("SUMMARY_CONTENT_INVALID");
        const contentHash = await sha256(new TextEncoder().encode(content).buffer as ArrayBuffer);
        return response(await rpc("begin_exam_pending_summary", {
          p_summary_id: uuid(payload.summary_id), p_lease_token: uuid(payload.lease_token),
          p_destination_key: String(payload.destination_key || ""),
          p_content_sha256: contentHash, p_content_characters: Array.from(content).length,
        }));
      }
      case "pending_summary_result": return response(await rpc("record_exam_pending_summary_result", {
        p_summary_id: uuid(payload.summary_id), p_lease_token: uuid(payload.lease_token), p_outcome: plain(payload.outcome),
      }));
      case "collection_checkpoint": return response(await rpc("load_exam_collection_checkpoint", {
        p_collector_id: String(payload.collector_id || ""), p_scope_key: String(payload.scope_key || ""),
        p_sweep_id: payload.sweep_id == null ? null : uuid(payload.sweep_id),
      }));
      case "collection_begin": return response(await rpc("begin_exam_collection_sweep", {
        p_collector_id: String(payload.collector_id || ""), p_scope_key: String(payload.scope_key || ""),
        p_scope_manifest: plain(payload.scope_manifest), p_received_from: payload.received_from,
        p_received_through: payload.received_through, p_expected_revision: payload.expected_revision ?? null,
        p_request_id: uuid(payload.request_id), p_ttl_seconds: Number(payload.ttl_seconds ?? 900),
      }));
      case "collection_event": return response(await rpc("record_exam_collection_event", {
        p_sweep_id: uuid(payload.sweep_id), p_event: plain(payload.event),
      }));
      case "collection_commit": return response(await rpc("commit_exam_collection_sweep", {
        p_sweep_id: uuid(payload.sweep_id), p_expected_revision: payload.expected_revision ?? null,
      }));
      case "reserve_source": return response(await rpc("reserve_exam_intake_source", { p_source: plain(payload.source) }));
      case "begin_staging": {
        const scope = Deno.env.get("COMPOSIO_STAGING_SCOPE");
        if (!scope || !/^[A-Za-z0-9_.:-]{1,96}$/.test(scope)) error("Staging compartilhado Composio não configurado", 503);
        // Scope is server-owned; changing a payload/lease never grants a new dispatch.
        return response(await rpc("begin_exam_document_staging", {
          p_source: plain(payload.source), p_file: payload.file == null ? null : plain(payload.file), p_provider_scope: scope,
          p_deadline_seconds: Number(payload.deadline_seconds ?? 45),
        }));
      }
      case "staging_result": return response(await rpc("record_exam_document_staging", {
        p_operation_id: uuid(payload.operation_id), p_dispatch_nonce: uuid(payload.dispatch_nonce), p_outcome: plain(payload.outcome),
      }));
      case "stage_file": {
        const file = plain(payload.file);
        // Only the verified manual upload action may stage browser bytes while Drive is paused.
        delete file.staging_bucket; delete file.staging_path;
        return response(await rpc("stage_exam_intake_file", { p_document_id: uuid(payload.document_id), p_file: file, p_worker: String(payload.worker || "ingestion") }));
      }
      case "confirm_file": return response(await rpc("confirm_exam_document_file", { p_document_id: uuid(payload.document_id), p_file: plain(payload.file), p_lease_token: uuid(payload.lease_token) }));
      case "extraction": {
        const extraction = plain(payload.extraction);
        const fields = plain(extraction.fields);
        if (fields.client_name && !fields.tutor_name) fields.tutor_name = fields.client_name;
        if (fields.tutor_name && !fields.client_name) fields.client_name = fields.tutor_name;
        extraction.fields = fields;
        if (payload.drive_name) extraction.drive_name = String(payload.drive_name);
        extraction.delivery_id = uuid(payload.delivery_id);
        extraction.lease_token = uuid(payload.lease_token);
        return response(await rpc("update_exam_document_extraction", { p_document_id: uuid(payload.document_id), p_extraction: extraction }));
      }
      case "reserve_tasks": return response(await rpc("reserve_exam_document_delivery", { p_destination: String(payload.destination), p_worker: String(payload.worker), p_limit: Number(payload.limit ?? 1) }));
      case "task_result": return response(await rpc("complete_exam_document_delivery", { p_delivery_id: uuid(payload.delivery_id), p_lease_token: uuid(payload.lease_token), p_outcome: plain(payload.outcome) }));
      case "reconcile": return response(await rpc("reconcile_exam_document_tasks", {}));
      case "source_error": return response(await rpc("record_exam_document_source_error", {
        p_document_id: uuid(payload.document_id), p_error: String(payload.error || "Falha na obtenção do arquivo"),
        p_review_reason: payload.review_reason ? String(payload.review_reason) : null,
      }));
      case "file": {
        const doc = await document(payload.document_id);
        const bytes = await readDocumentBytes(service, doc);
        const name = String(doc.original_name || "exame.pdf").replace(/[\r\n"\\]/g, "_");
        return new Response(bytes, { headers: { ...cors, "Content-Type": "application/pdf", "Cache-Control": "private, no-store",
          "X-Exam-Document-Id": String(doc.id), "Content-Disposition": `${payload.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}` } });
      }
      case "file_url": {
        const doc = await document(payload.document_id);
        const bucket = doc.storage_bucket || doc.staging_bucket;
        const path = doc.storage_path || doc.staging_path;
        if (!bucket || !path) error("Original no Drive: use a ação file autenticada", 409);
        const { data, error: signError } = await service.storage.from(String(bucket)).createSignedUrl(String(path), 60);
        if (signError || !data) error("Não foi possível abrir o arquivo privado", 503);
        return response({ url: data.signedUrl, expires_in: 60, document_id: doc.id });
      }
      case "upload": {
        if (!form || !userId) error("Upload exige sessão da equipe e multipart", 400);
        const file = form.get("file");
        if (!(file instanceof File)) error("PDF obrigatório");
        const { data: config, error: configError } = await service.from("exam_document_configuration").select("max_file_bytes").single();
        if (configError) error("Configuração de exames não instalada", 503);
        if (!file.size || file.size > Number(config.max_file_bytes)) error("Arquivo acima do limite configurado", 413);
        const bytes = await file.arrayBuffer();
        // File extensions/MIME alone are not evidence of a PDF; preserve only supported PDF input here.
        if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") error("O arquivo enviado não contém um PDF válido");
        const hash = await sha256(bytes);
        const source = await rpc("reserve_exam_document_source", { p_source: { channel: "manual", account_id: userId,
          message_id: String(payload.message_id || crypto.randomUUID()), attachment_id: hash, original_name: file.name,
          mime_type: "application/pdf", metadata: { uploaded_by: userId } } });
        const stagePath = `${source.document_id}/original.pdf`;
        const staged = await rpc("stage_exam_document_file", { p_document_id: source.document_id, p_worker: `manual:${userId}`,
          p_file: { sha256: hash, size_bytes: file.size, staging_bucket: "exam_documents_staging", staging_path: stagePath } });
        if (staged.excluded === true) error("Este arquivo corresponde a uma ficha excluída e não foi importado", 409);
        if (staged.document.file_status !== "saved" && staged.claimed) {
          const canonicalStagePath = String(staged.document.staging_path);
          const { error: uploadError } = await service.storage.from("exam_documents_staging").upload(canonicalStagePath, bytes, { contentType: "application/pdf", upsert: false });
          if (uploadError && String(uploadError.statusCode) !== '409') {
            await service.from("exam_document_delivery").update({ status: "failed", lease_until: null, last_error: "STAGING_UPLOAD_FAILED", next_attempt_at: new Date().toISOString() })
              .eq("id", staged.delivery_id).eq("lease_token", staged.lease_token);
            error("Upload temporário falhou; mantenha o arquivo e tente novamente", 503);
          }
          const verified = await readDocumentBytes(service, staged.document);
          if (verified.byteLength !== file.size) error("Upload temporário sem confirmação", 503);
          const { error: releaseError } = await service.from("exam_document_delivery").update({ status: "pending", attempts: 0, lease_until: null, worker: null })
            .eq("id", staged.delivery_id).eq("lease_token", staged.lease_token);
          if (releaseError) error("Arquivo salvo, mas fila não foi liberada; reconciliar", 503);
        }
        // A second upload must not report success merely because another worker holds
        // a lease. Verify that its bytes already exist; otherwise the caller keeps its File.
        if (staged.document.file_status !== "saved" && !staged.claimed) await readDocumentBytes(service, staged.document);
        const { error: logError } = await service.from("exam_document_event").insert({ document_id: staged.document_id, event_type: "manual_uploaded", actor_id: userId,
          details: { sha256: hash, size_bytes: file.size, duplicate: staged.document_id !== source.document_id } });
        if (logError) error("Arquivo salvo; registro de auditoria pendente", 503);
        return response({ document_id: staged.document_id, duplicate: staged.document_id !== source.document_id, document: await document(staged.document_id), drive_pending: staged.document.file_status !== "saved" }, 201);
      }
      case "attach_nexus": {
        const deliveryId = uuid(payload.delivery_id);
        const leaseToken = uuid(payload.lease_token);
        const { data: task, error: taskError } = await service.from("exam_document_delivery").select("*").eq("id", deliveryId).single();
        if (taskError || task.destination !== "nexus") error("Tarefa de anexação não encontrada", 404);
        if (task.lease_token !== leaseToken || task.status !== 'reserved' || new Date(task.lease_until).getTime() <= Date.now()) error("Reserva de anexação inválida/expirada", 409);
        const doc = await document(task.document_id);
        if (doc.identification_status !== "confirmed" || !doc.pet_id || !plain(doc.confirmed_data).exam_date) error("Paciente e data clínica devem ser confirmados antes de anexar", 409);
        const bytes = await readDocumentBytes(service, doc);
        const path = `${doc.pet_id}/${doc.id}/original.pdf`;
        const { data: existing, error: existingError } = await service.storage.from("exam_documents_private").download(path);
        if (existing) {
          if (await sha256(await existing.arrayBuffer()) !== doc.sha256) error("Objeto existente contém bytes diferentes; revisão necessária", 409);
        } else {
          if (existingError && !['404','400'].includes(String(existingError.statusCode))) error("Não foi possível reconciliar o objeto privado", 503);
          const { error: uploadError } = await service.storage.from("exam_documents_private").upload(path, bytes, { contentType: "application/pdf", upsert: false });
          if (uploadError && uploadError.statusCode !== '409') error("Cópia privada não foi salva", 503);
        }
        const { data: copy, error: copyError } = await service.storage.from("exam_documents_private").download(path);
        if (copyError || !copy) error("Leitura de confirmação do anexo falhou", 503);
        const copyBytes = await copy.arrayBuffer();
        if (copyBytes.byteLength !== bytes.byteLength || await sha256(copyBytes) !== doc.sha256) error("Anexo não passou na confirmação de integridade", 409);
        return response(await rpc("complete_exam_document_delivery", { p_delivery_id: deliveryId, p_lease_token: leaseToken,
          p_outcome: { status: "completed", storage_bucket: "exam_documents_private", storage_path: path, sha256: doc.sha256, size_bytes: doc.size_bytes } }));
      }
      default: error("Ação desconhecida");
    }
  } catch (caught) {
    const e = caught as Error & { status?: number };
    return response({ error: e.status ? e.message : "Falha no serviço de exames; preservar pendência e reconciliar", code: "EXAM_DOCUMENT_ERROR" }, e.status || 500);
  }
});
