import { cn } from '@/lib/utils'
import { STATUS_CONFIG } from '@/lib/card-constants'
import type { CardStatus, AlertLevel } from '@/types/exam-card'

interface StatusBadgeProps {
  status: CardStatus
  alertLevel?: AlertLevel
  className?: string
}

export function StatusBadge({ status, alertLevel = 'normal', className }: StatusBadgeProps) {
  const { label, Icon, classes } = STATUS_CONFIG[status]
  const overdueInGroup = status === 'no_grupo' && alertLevel === 'critical'

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border',
        overdueInGroup
          ? 'bg-red-50 text-red-700 border-red-300 dark:bg-red-950/50 dark:text-red-400 dark:border-red-800'
          : classes,
        className
      )}
    >
      <Icon className="w-3 h-3 shrink-0" />
      {label}
      {alertLevel === 'critical' && (
        <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0 alert-dot-critical" />
      )}
      {alertLevel === 'warning' && (
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0 alert-dot-warning" />
      )}
    </span>
  )
}
