import type { ExamDocument } from '../types/exam-document'

export type ExamDetailSummary =
  | 'Concluído'
  | 'Aguardando vincular cliente'
  | 'Aguardando salvar no cadastro'
  | 'Contato parcial'
  | 'Aguardando contato'
  | 'Em andamento'

export interface ExamDetailProgress {
  emailReceived: boolean
  originReceived: boolean
  originChannel: 'email' | 'whatsapp' | 'manual' | null
  groupSent: boolean
  nexusLinked: boolean
  contactCompleted: boolean
  contactedCount: number
  itemCount: number
  summary: ExamDetailSummary
  groupAgeLabel: string | null
}

function timestamp(value: string | null | undefined): number | null {
  if (!value?.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function groupAge(sentAt: string | null, now: number): string | null {
  const sent = timestamp(sentAt)
  if (sent === null || !Number.isFinite(now) || sent > now) return null
  const minutes = Math.floor((now - sent) / 60_000)
  if (minutes < 1) return 'No grupo há menos de 1 min'
  if (minutes < 60) return `No grupo há ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `No grupo há ${hours} h`
  const days = Math.floor(hours / 24)
  return `No grupo há ${days} ${days === 1 ? 'dia' : 'dias'}`
}

/** Present persisted pipeline evidence; assignment never implies contact. */
export function getExamDetailProgress(doc: ExamDocument, now = Date.now()): ExamDetailProgress {
  const receivedThrough = (channel: string) => doc.sources.some(source =>
    (source.channel || source.source_channel) === channel
    && timestamp(source.received_at || doc.received_at) !== null,
  )
  const emailReceived = receivedThrough('email')
  // One canonical document may have been received through several channels.
  // Keep the established email presentation when that evidence also exists.
  const originChannel = emailReceived ? 'email'
    : receivedThrough('whatsapp') ? 'whatsapp'
      : receivedThrough('manual') ? 'manual' : null
  const originReceived = originChannel !== null
  // SQL accepts group 'sent' only with provider proof or a team confirmation.
  // 'submitted', 'uncertain', 'completed' and a waiver do not prove an upload.
  const groupSent = doc.group_status === 'sent'
  const nexusLinked = Boolean(doc.pet_id)
    && doc.identification_status === 'confirmed'
    && doc.nexus_status === 'completed'
  const itemCount = doc.items.length
  const contactedCount = doc.items.filter(item => timestamp(item.contacted_at) !== null).length
  const contactCompleted = doc.contact_status === 'completed'
    && itemCount > 0
    && contactedCount === itemCount

  let summary: ExamDetailSummary = 'Em andamento'
  // The database also accounts for storage and authorized group exceptions.
  // Four local indicators alone must not invent an overall completion.
  if (doc.completed) summary = 'Concluído'
  else if (contactCompleted && originReceived && groupSent && doc.file_status === 'saved') {
    if (!doc.pet_id && ['awaiting_link', 'waiting_link', 'pending'].includes(doc.nexus_status)) {
      summary = 'Aguardando vincular cliente'
    } else if (doc.pet_id && doc.identification_status === 'confirmed' && doc.nexus_status === 'pending') {
      summary = 'Aguardando salvar no cadastro'
    }
  } else if (!contactCompleted && contactedCount > 0) summary = 'Contato parcial'
  else if (!contactCompleted && groupSent) summary = 'Aguardando contato'

  return {
    emailReceived,
    originReceived,
    originChannel,
    groupSent,
    nexusLinked,
    contactCompleted,
    contactedCount,
    itemCount,
    summary,
    groupAgeLabel: groupSent && !contactCompleted && !doc.completed
      ? groupAge(doc.oldest_group_sent_at, now)
      : null,
  }
}
