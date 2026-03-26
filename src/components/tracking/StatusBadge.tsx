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

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border',
        classes,
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
