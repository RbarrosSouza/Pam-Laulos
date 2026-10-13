import type { ExamDocument } from '@/types/exam-document'

export function documentLabel(document: ExamDocument, field: 'pet_name' | 'client_name' | 'exam_type' | 'exam_date' | 'lab_name') {
  return document.confirmed_data?.[field] || document.extracted_data?.[field] || '—'
}

const LABELS: Record<string, string> = {
  pending: 'Pendente', saved: 'Salvo', failed: 'Falhou', uncertain: 'A confirmar',
  unidentified: 'Não identificado', suggested: 'Conferir cadastro', confirmed: 'Confirmado', review: 'Em conferência', not_exam: 'Não é exame',
  reserved: 'Processando', submitted: 'Enviado à API', sent: 'Enviado', delivered: 'Entregue',
  attached: 'Anexado', waiting_link: 'Aguardando vínculo', awaiting_link: 'Aguardando vínculo', assigned: 'Assumido', completed: 'Realizado',
  queued: 'Na fila', processing: 'Processando', ready: 'Pronto', ignored: 'Desconsiderado', waived: 'Dispensado',
}
export function statusLabel(status: string | null | undefined) { return status ? LABELS[status] || status : '—' }
export function documentIsOverdue(document: ExamDocument, now = Date.now()) {
  if (document.contact_status === 'completed' || !document.oldest_group_sent_at) return false
  const sent = Date.parse(document.oldest_group_sent_at)
  return Number.isFinite(sent) && now - sent >= 24 * 60 * 60 * 1000
}
export function documentDisplayId(id: string) { return `EX-${id.slice(0, 8).toUpperCase()}` }
