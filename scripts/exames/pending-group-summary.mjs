/** Render an already-filtered, complete read-only snapshot. No I/O or delivery side effects. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAX_PENDING_SUMMARY_CHARACTERS = 24_000;

function instant(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new TypeError(`${field}: informe uma data ISO com fuso horário.`);
  }
  const parsed = Date.parse(value);
  const day = Date.parse(value.slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(parsed) || !Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new TypeError(`${field}: data inválida.`);
  }
  return parsed;
}

function plain(value, field) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new TypeError(`${field}: texto inválido.`);
  const clean = value.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/[*_`~]/g, '').replace(/\s+/gu, ' ').trim();
  return /[\p{L}\p{N}]/u.test(clean) ? clean : '';
}

function ageLabel(milliseconds) {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return 'no grupo há menos de 1 min';
  if (minutes < 60) return `no grupo há ${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `no grupo há ${hours}h${minutes % 60 ? ` ${minutes % 60}min` : ''}`;
  const days = Math.floor(hours / 24);
  return `no grupo há ${days}d${hours % 24 ? ` ${hours % 24}h` : ''}`;
}

/**
 * @param {{as_of:string,total:number,has_more:false,documents:Array<{
 * document_id?:string,id?:string,pet_name?:string|null,client_name?:string|null,exam_type?:string|null,
 * responsible_vet_id?:string|null,responsible_vet_name?:string|null,first_group_sent_at:string
 * }>}} snapshot The caller excludes fixtures, rejected/canonical documents, and completed contacts.
 * @param {{baseUrl:string}} options Public Pam Laudos origin, without credentials or query parameters.
 * @returns {{content:string,count:number,documentIds:string[]}}
 */
export function buildPendingGroupSummary(snapshot, { baseUrl } = {}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new TypeError('Snapshot inválido.');
  if (snapshot.has_more !== false) throw new Error('A consulta está incompleta; não enviar um resumo parcial.');
  if (!Array.isArray(snapshot.documents) || !Number.isSafeInteger(snapshot.total) || snapshot.total < 0 || snapshot.total !== snapshot.documents.length) {
    throw new Error('O total não corresponde à lista completa de exames.');
  }
  const asOf = instant(snapshot.as_of, 'as_of');
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Endereço do Pam Laudos inválido.'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new TypeError('Use somente a origem HTTPS pública do Pam Laudos.');
  }
  const ids = new Set();
  const documents = snapshot.documents.map(document => {
    if (!document || typeof document !== 'object') throw new TypeError('ID de exame inválido.');
    const sourceId = document.document_id ?? document.id;
    if (typeof sourceId !== 'string' || !UUID.test(sourceId)) throw new TypeError('ID de exame inválido.');
    if (document.document_id != null && document.id != null && document.document_id.toLowerCase() !== String(document.id).toLowerCase()) {
      throw new TypeError('Os identificadores do exame não correspondem.');
    }
    const id = sourceId.toLowerCase();
    if (ids.has(id)) throw new Error('A lista contém um exame duplicado.');
    ids.add(id);
    const sent = instant(document.first_group_sent_at, 'first_group_sent_at');
    if (sent > asOf) throw new Error('O envio ao grupo não pode estar no futuro da consulta.');
    let responsible = 'Sem responsável';
    if (document.responsible_vet_id != null) {
      if (typeof document.responsible_vet_id !== 'string' || !UUID.test(document.responsible_vet_id)) throw new TypeError('ID de veterinária inválido.');
      responsible = plain(document.responsible_vet_name, 'responsible_vet_name');
      if (!responsible) throw new TypeError('A veterinária atribuída precisa de um nome confirmado.');
    }
    return {
      id, sent, responsible,
      tutor: plain(document.client_name, 'client_name'),
      pet: plain(document.pet_name, 'pet_name'),
      exam: plain(document.exam_type, 'exam_type'),
    };
  }).sort((a, b) => a.sent - b.sent || a.id.localeCompare(b.id, 'en'));

  const date = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' }).format(asOf);
  const time = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(asOf);
  const blocks = documents.map((document, index) => {
    const identity = [document.tutor, document.pet].filter(Boolean).join(' — ');
    const info = [
      identity ? `*${identity}*` : !document.exam ? 'Exame a identificar' : null,
      document.exam || null,
      ageLabel(asOf - document.sent),
      `🩺 ${document.responsible}`,
    ].filter(Boolean).join(' · ');
    return [
      `${index + 1}. ${info}`,
      `${base.origin}/e/${Buffer.from(document.id.replace(/-/g, ''), 'hex').toString('base64url')}`,
    ].join('\n');
  });
  const content = [
    '🧪 *Teste de resumo*',
    'Segue a lista dos exames que precisam de atenção',
    `${date} às ${time}`,
    '',
    ...blocks.flatMap(block => [block, '']),
    `Total: ${snapshot.total} ${snapshot.total === 1 ? 'exame' : 'exames'}`,
    `📋 Pam Laudos: ${base.origin}/novos-exames`,
  ].join('\n');
  if (content.length > MAX_PENDING_SUMMARY_CHARACTERS) throw new Error('O resumo excede 24.000 caracteres; nenhum exame foi cortado ou enviado.');
  return { content, count: documents.length, documentIds: documents.map(document => document.id) };
}
