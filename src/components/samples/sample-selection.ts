import type { ExamCard, ExamItem } from '@/types/exam-card'

export type PendingSample = ExamItem & { card: ExamCard }
export type ManualSampleDraft = { petName: string; clientName: string; examType: string; labName: string }

export function pendingSamples(cards: ExamCard[]): PendingSample[] {
  return cards.filter(card => card.status === 'aguardando_lab').flatMap(card =>
    (card.items || []).filter(item => !item.sent_to_lab_at && !item.result_received).map(item => ({ ...item, card })),
  )
}

export function selectedSamples(items: PendingSample[], selected: Set<string>) {
  return items.filter(item => selected.has(item.id))
}

export function searchSamples(items: PendingSample[], search: string) {
  const normalize = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('pt-BR')
  const term = normalize(search.trim())
  return term ? items.filter(item => normalize([item.card.pet_name, item.card.client_name, item.exam_type, item.lab_name].join(' ')).includes(term)) : items
}
