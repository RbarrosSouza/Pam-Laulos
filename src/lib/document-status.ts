import type { DocumentFields, ExamDocument } from '@/types/exam-document'

export function documentLabel(document: ExamDocument, field: 'pet_name' | 'client_name' | 'exam_type' | 'exam_date' | 'lab_name') {
  return document.confirmed_data?.[field] || document.extracted_data?.[field] || '—'
}

const LABELS: Record<string, string> = {
  pending: 'Pendente', saved: 'Salvo', failed: 'Falhou', uncertain: 'A confirmar',
  unidentified: 'Selecionar cadastro', suggested: 'Selecionar cadastro', confirmed: 'Confirmado', review: 'Em conferência', not_exam: 'Não é exame',
  reserved: 'Processando', submitted: 'Enviado à API', sent: 'Enviado', delivered: 'Entregue',
  attached: 'Anexado', waiting_link: 'Selecionar cadastro', awaiting_link: 'Selecionar cadastro', assigned: 'Assumido', completed: 'Realizado',
  queued: 'Na fila', processing: 'Processando', ready: 'Pronto', ignored: 'Desconsiderado', waived: 'Dispensado',
}
export function statusLabel(status: string | null | undefined) { return status ? LABELS[status] || status : '—' }
export function documentIsOverdue(document: ExamDocument, now = Date.now()) {
  if (document.contact_status === 'completed' || !document.oldest_group_sent_at) return false
  const sent = Date.parse(document.oldest_group_sent_at)
  return Number.isFinite(sent) && now - sent >= 24 * 60 * 60 * 1000
}
export function documentDisplayId(id: string) { return `EX-${id.slice(0, 8).toUpperCase()}` }

// Delivery and contact updates must not discard an identification in progress.
// The mutation still sends the latest document version for the database CAS.
export function documentEditSnapshot(document: ExamDocument) {
  const values = (fields: DocumentFields) => [fields.client_name, fields.pet_name, fields.exam_type, fields.exam_date, fields.lab_name, fields.species].map(value => value || null)
  return JSON.stringify([document.id, values(document.extracted_data), values(document.confirmed_data), document.identification_status, document.pet_id, document.previous_document_id, document.review_reason])
}
