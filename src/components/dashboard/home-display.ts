import type { ExamCard } from '@/types/exam-card'

export type HomeStage = 'no_grupo' | 'exame_pronto' | 'aguardando_lab'
export interface HomeQueue {
  cards: ExamCard[]
  loading: boolean
  error: unknown
  refreshing: boolean
}

export function contactComplete(card: ExamCard): boolean {
  return card.status === 'contato_realizado' || ((card.items || []).length > 0 && (card.items || []).every(item => item.contacted))
}

/** Never substitute creation/receipt for a confirmed group timestamp. */
export function homeGroupHours(card: ExamCard, now = Date.now()): number | null {
  if (card.status !== 'no_grupo' || contactComplete(card) || !card.group_sent_at) return null
  const timestamp = Date.parse(card.group_sent_at)
  if (!Number.isFinite(timestamp) || timestamp > now) return null
  return (now - timestamp) / 3_600_000
}

export function needsHomeAttention(card: ExamCard, now = Date.now()): boolean {
  const hours = homeGroupHours(card, now)
  return card.alert_level === 'critical' && hours !== null && hours > 24
}

/** Group work starts with the longest confirmed wait; other stages retain query order. */
export function homeQueueCards(cards: ExamCard[], stage: HomeStage, attentionOnly: boolean, now = Date.now()): ExamCard[] {
  const scoped = cards.filter(card => card.status === stage)
  if (stage !== 'no_grupo') return scoped
  return scoped.filter(card => !attentionOnly || needsHomeAttention(card, now))
    .sort((a, b) => (homeGroupHours(b, now) ?? -1) - (homeGroupHours(a, now) ?? -1))
}

export function homeTimeLabel(card: ExamCard, now = Date.now()): string | null {
  if (contactComplete(card)) return null
  const hours = homeGroupHours(card, now)
  if (card.status === 'no_grupo') {
    if (hours === null) return 'Envio sem data'
    if (hours < 1) return 'Há menos de 1h no grupo'
    if (hours < 24) return `Há ${Math.floor(hours)}h no grupo`
    const days = Math.floor(hours / 24)
    const rest = Math.floor(hours % 24)
    return `Há ${days}d${rest ? ` ${rest}h` : ''} no grupo`
  }
  return null
}
