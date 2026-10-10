import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.99.3";

// v1: workers use a dedicated secret, never a browser/service-role credential.
// User-facing file/upload actions additionally require a verified Supabase user and active membership.
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
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

async function driveAccessToken(): Promise<string> {
  const refresh = Deno.env.get("GOOGLE_DRIVE_REFRESH_TOKEN");
  if (refresh) {
    const clientId = Deno.env.get("GOOGLE_DRIVE_CLIENT_ID");
    const clientSecret = Deno.env.get("GOOGLE_DRIVE_CLIENT_SECRET");
    if (!clientId || !clientSecret) error("OAuth do Drive incompleto no servidor", 503);
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refresh, grant_type: "refresh_token" }),
    });
    const json = await res.json();
    if (!res.ok || !json.access_token) error("Servidor não conseguiu autenticar no Drive", 503);
    return json.access_token;
  }
  const access = Deno.env.get("GOOGLE_DRIVE_ACCESS_TOKEN");
  if (!access) error("Acesso privado ao Drive ainda não configurado no servidor", 503);
  return access;
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
    const token = await driveAccessToken();
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(doc.drive_file_id)}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` }, redirect: "error",
    });
    if (!res.ok) error("Original no Drive não pôde ser lido", 503);
    const length = Number(res.headers.get("content-length") || 0);
    if (length > 52428800) error("Arquivo acima do limite de leitura", 413);
    bytes = await res.arrayBuffer();
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
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) error("Backend de exames não configurado", 503);
    const service = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const bearer = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!bearer) error("Autenticação obrigatória", 401);
    const workerKey = Deno.env.get("EXAM_INGESTION_API_KEY");
    const isWorker = Boolean(workerKey && safeEqual(bearer, workerKey));
    let userId: string | undefined;
    if (!isWorker) {
      const { data: auth, error: authError } = await service.auth.getUser(bearer);
      if (authError || !auth.user) error("Sessão inválida", 401);
      const { data: member, error: memberError } = await service.from("exam_document_member")
        .select("user_id,active").eq("user_id", auth.user.id).eq("active", true).maybeSingle();
      if (memberError || !member) error("Usuário sem autorização para exames", 403);
      userId = auth.user.id;
    }
    const isMultipart = req.headers.get("Content-Type")?.startsWith("multipart/form-data");
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
    if (!isWorker && !['upload', 'file', 'file_url'].includes(action)) error("Ação restrita ao worker", 403);
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
      if (data.canonical_document_id) {
        const { data: canonical, error: canonicalError } = await service.from("exam_document").select("*").eq("id", data.canonical_document_id).single();
        if (canonicalError) error("Documento canônico indisponível", 503);
        return canonical;
      }
      return data;
    }
    switch (action) {
      case "reserve_source": return response(await rpc("reserve_exam_document_source", { p_source: plain(payload.source) }));
      case "stage_file": {
        const file = plain(payload.file);
        // Only the verified manual upload action may stage browser bytes while Drive is paused.
        delete file.staging_bucket; delete file.staging_path;
        return response(await rpc("stage_exam_document_file", { p_document_id: uuid(payload.document_id), p_file: file, p_worker: String(payload.worker || "ingestion") }));
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
