import { FlaskConical, FileCheck2, Phone, AlertTriangle } from 'lucide-react'
import type { CardStatus } from '@/types/exam-card'

export interface StatusConfig {
  label: string
  Icon: React.ElementType
  classes: string
  headerBg: string
  headerText: string
  dotColor: string
  badgeBg: string
  badgeText: string
  color: string
}

export const STATUS_CONFIG: Record<CardStatus, StatusConfig> = {
  aguardando_lab: {
    label: 'Aguardando Lab',
    Icon: FlaskConical,
    classes:
      'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/50 dark:text-blue-400 dark:border-blue-900',
    headerBg: 'bg-blue-50 dark:bg-blue-950/40',
    headerText: 'text-blue-700 dark:text-blue-400',
    dotColor: 'bg-blue-500',
    badgeBg: 'bg-blue-100 dark:bg-blue-900/50',
    badgeText: 'text-blue-700 dark:text-blue-300',
    color: '#3b82f6',
  },
  exame_pronto: {
    label: 'Exame Pronto',
    Icon: FileCheck2,
    classes:
      'bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-950/50 dark:text-yellow-400 dark:border-yellow-900',
    headerBg: 'bg-yellow-50 dark:bg-yellow-950/40',
    headerText: 'text-yellow-700 dark:text-yellow-400',
    dotColor: 'bg-yellow-500',
    badgeBg: 'bg-yellow-100 dark:bg-yellow-900/50',
    badgeText: 'text-yellow-700 dark:text-yellow-300',
    color: '#eab308',
  },
  contato_realizado: {
    label: 'Contato Realizado',
    Icon: Phone,
    classes:
      'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/50 dark:text-green-400 dark:border-green-900',
    headerBg: 'bg-green-50 dark:bg-green-950/40',
    headerText: 'text-green-700 dark:text-green-400',
    dotColor: 'bg-green-500',
    badgeBg: 'bg-green-100 dark:bg-green-900/50',
    badgeText: 'text-green-700 dark:text-green-300',
    color: '#22c55e',
  },
  atrasado: {
    label: 'Atrasado',
    Icon: AlertTriangle,
    classes:
      'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/50 dark:text-red-400 dark:border-red-900',
    headerBg: 'bg-red-50 dark:bg-red-950/40',
    headerText: 'text-red-700 dark:text-red-400',
    dotColor: 'bg-red-500',
    badgeBg: 'bg-red-100 dark:bg-red-900/50',
    badgeText: 'text-red-700 dark:text-red-300',
    color: '#ef4444',
  },
}

export const CARD_STATUSES: CardStatus[] = [
  'aguardando_lab',
  'exame_pronto',
  'atrasado',
  'contato_realizado',
]

export const STATUS_FILTER_OPTIONS: { value: CardStatus; label: string }[] = CARD_STATUSES.map(
  (s) => ({ value: s, label: STATUS_CONFIG[s].label })
)
