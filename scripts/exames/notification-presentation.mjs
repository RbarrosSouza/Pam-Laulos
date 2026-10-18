/** Shared by the generated n8n processing and WhatsApp nodes. No I/O. */
export function examPresentation(document, baseUrl) {
  const confirmed = {...(document.confirmed_data || {})};
  if (!Object.hasOwn(confirmed, 'client_name') && Object.hasOwn(confirmed, 'tutor_name')) confirmed.client_name = confirmed.tutor_name;
  const fields = document.notification_fields || {...(document.extracted_data || {}), ...confirmed};
  const clean = value => typeof value === 'string' ? value.normalize('NFC').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  const text = value => clean(value).replace(/[*_`~]/g, '').trim();
  const filePart = (value, fallback, length) => (clean(value).replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || fallback).slice(0, length);
  const examDate = typeof fields.exam_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fields.exam_date) && Number.isFinite(Date.parse(fields.exam_date + 'T00:00:00Z')) && new Date(fields.exam_date + 'T00:00:00Z').toISOString().slice(0, 10) === fields.exam_date ? fields.exam_date : null;
  const dateLabel = examDate ? examDate.slice(8, 10) + '/' + examDate.slice(5, 7) + '/' + examDate.slice(0, 4) : '';
  const missingFields = ['pet_name', 'client_name', 'exam_type'].filter(field => !/[\p{L}\p{N}]/u.test(text(fields[field])));
  if (!examDate) missingFields.push('exam_date');
  const present = field => !missingFields.includes(field);
  // Only the resolved clinical assignment may be announced as responsible.
  // Raw requester text or an authenticated actor is not a clinical assignment.
  const responsible = document.responsible_vet_id && document.responsible_vet_source !== 'conflict' ? text(document.responsible_vet_name) : '';
  const fileName = ([present('pet_name') ? filePart(fields.pet_name, '', 300) : null, present('client_name') ? filePart(fields.client_name, '', 300) : null, present('exam_type') ? filePart(fields.exam_type, '', 300) : null, dateLabel ? dateLabel.replace(/\//g, '-') : null].filter(Boolean).join(' - ') || 'Exame') + '.pdf';
  let shortUrl = null;
  if (baseUrl) {
    if (typeof document.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(document.id)) throw new Error('Identificador do documento inválido');
    shortUrl = baseUrl.replace(/\/$/, '') + '/e/' + Buffer.from(document.id.replace(/-/g, ''), 'hex').toString('base64url');
  }
  let received = '';
  if (document.received_at && Number.isFinite(Date.parse(document.received_at))) {
    received = new Intl.DateTimeFormat('pt-BR', {timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(new Date(document.received_at)).replace(', ', ' às ');
  }
  const content = [
    '🧪 *Novo exame*',
    '',
    present('client_name') ? '*Tutor:* ' + text(fields.client_name) : null,
    present('pet_name') ? '*Pet:* ' + text(fields.pet_name) : null,
    present('exam_type') ? '*Exame:* ' + text(fields.exam_type) : null,
    dateLabel ? '*Data do exame:* ' + dateLabel : null,
    responsible ? '🩺 *Responsável:* ' + responsible : null,
    missingFields.length ? '📌 Informações incompletas — conferir no Pam Laudos.' : null,
    '',
    '📋 *Abrir e assumir no Pam Laudos*',
    shortUrl,
    '',
    !responsible ? '⏳ Aguardando responsável' : null,
    !document.pet_id ? 'Cadastro no PAM Nexus: selecionar tutor e pet' : null,
    received ? '_Recebido em ' + received + '_' : null,
  ].filter(line => line !== null).join('\n');
  return {ready: missingFields.length === 0, missingFields, fileName, content, shortUrl};
}

export function findExamDelivery(messages, task, destination = {}) {
  const legacyMarker = '[EXAM:' + task.document.id + ':DELIVERY:' + task.id + ']';
  const unique = new Map();
  for (const message of messages) if (message && message.id != null && !unique.has(String(message.id))) unique.set(String(message.id), message);
  return [...unique.values()].filter(message => {
    if (message.private !== false || ![1, 'outgoing'].includes(message.message_type)) return false;
    if (message.inbox_id != null && destination.inboxId != null && Number(message.inbox_id) !== Number(destination.inboxId)) return false;
    if (message.conversation_id != null && destination.conversationId != null && Number(message.conversation_id) !== Number(destination.conversationId)) return false;
    if (task.external_id) return String(message.id) === String(task.external_id);
    const attributes = message.content_attributes || {};
    const internal = attributes.pamvet_exam_document_id === task.document.id && attributes.pamvet_exam_delivery_id === task.id && attributes.pamvet_exam_sha256 === task.document.sha256 && !!task.document.sha256;
    const legacy = String(message.content || '').trim().endsWith(legacyMarker) && Array.isArray(message.attachments) && message.attachments.some(attachment => attachment.file_type === 'file');
    return internal || legacy;
  });
}
