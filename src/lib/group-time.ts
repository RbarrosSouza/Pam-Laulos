import type { ExamCard } from '@/types/exam-card'

export function hoursInGroup(card: Pick<ExamCard, 'group_sent_at'>, now = Date.now()): number | null {
  if (!card.group_sent_at) return null
  const sentAt = new Date(card.group_sent_at).getTime()
  if (!Number.isFinite(sentAt)) return null
  return Math.max(0, (now - sentAt) / 3_600_000)
}

export function elapsedHoursForDisplay(card: Pick<ExamCard, 'status' | 'group_sent_at' | 'hours_elapsed'>): number {
  return card.status === 'no_grupo' ? hoursInGroup(card) ?? 0 : card.hours_elapsed
}
