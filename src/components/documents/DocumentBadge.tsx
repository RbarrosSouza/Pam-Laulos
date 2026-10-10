import { statusLabel } from '@/lib/document-status'
import { cn } from '@/lib/utils'

export function DocumentBadge({ status }: { status: string | null | undefined }) {
  const value = status || ''
  return <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
    ['failed', 'uncertain', 'review'].includes(value) ? 'border-red-200 bg-red-50 text-red-700 dark:bg-red-950/30 dark:border-red-900 dark:text-red-300' :
    ['saved', 'confirmed', 'sent', 'delivered', 'attached', 'completed'].includes(value) ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:border-emerald-900 dark:text-emerald-300' :
    'border-[hsl(var(--border))] bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))')}>{statusLabel(status)}</span>
}
