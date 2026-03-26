import {
  FlaskConical,
  FileCheck2,
  AlertTriangle,
  AlertCircle,
  Timer,
  TrendingUp,
} from 'lucide-react'
import { motion } from 'framer-motion'
import { useExamCardStats } from '@/hooks/useExamCardStats'
import { formatHours } from '@/lib/utils'
import { staggerContainer, staggerItem } from '@/lib/animations'
import { cn } from '@/lib/utils'

interface KpiCardProps {
  label: string
  value: string | number
  sublabel?: string
  icon: React.ElementType
  iconBg: string
  iconColor: string
  valueColor?: string
  highlight?: boolean
}

function KpiCard({
  label,
  value,
  sublabel,
  icon: Icon,
  iconBg,
  iconColor,
  valueColor,
  highlight,
}: KpiCardProps) {
  return (
    <motion.div
      variants={staggerItem}
      whileHover={{ y: -2, transition: { duration: 0.15 } }}
      className={cn(
        'rounded-xl border p-5 bg-[hsl(var(--card))] shadow-sm cursor-default',
        'border-[hsl(var(--border))]',
        highlight && 'ring-2 ring-red-500/20 border-red-200 dark:border-red-900'
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wide truncate">
            {label}
          </p>
          <p className={cn('text-3xl font-bold tracking-tight', valueColor || 'text-[hsl(var(--foreground))]')}>
            {value}
          </p>
          {sublabel && (
            <p className="text-xs text-[hsl(var(--muted-foreground))]">{sublabel}</p>
          )}
        </div>
        <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center shrink-0', iconBg)}>
          <Icon className={cn('w-5 h-5', iconColor)} />
        </div>
      </div>
    </motion.div>
  )
}

function SkeletonCard() {
  return (
    <div className="rounded-xl border border-[hsl(var(--border))] p-5 bg-[hsl(var(--card))] animate-pulse">
      <div className="flex items-start justify-between">
        <div className="space-y-2 flex-1">
          <div className="h-3 w-20 bg-[hsl(var(--muted))] rounded" />
          <div className="h-8 w-12 bg-[hsl(var(--muted))] rounded" />
          <div className="h-3 w-24 bg-[hsl(var(--muted))] rounded" />
        </div>
        <div className="w-10 h-10 bg-[hsl(var(--muted))] rounded-xl" />
      </div>
    </div>
  )
}

export function StatsCards() {
  const { data: stats, isLoading } = useExamCardStats()

  if (isLoading || !stats) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        {[...Array(5)].map((_, i) => <SkeletonCard key={i} />)}
      </div>
    )
  }

  return (
    <motion.div
      variants={staggerContainer}
      initial="initial"
      animate="animate"
      className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4"
    >
      <KpiCard
        label="Aguardando Lab"
        value={stats.total_aguardando_lab}
        sublabel="Sem resultado"
        icon={FlaskConical}
        iconBg="bg-blue-50 dark:bg-blue-950/50"
        iconColor="text-blue-600 dark:text-blue-400"
      />
      <KpiCard
        label="Exames Prontos"
        value={stats.total_exame_pronto}
        sublabel="Aguardando contato"
        icon={FileCheck2}
        iconBg="bg-yellow-50 dark:bg-yellow-950/50"
        iconColor="text-yellow-600 dark:text-yellow-400"
      />
      <KpiCard
        label="Atrasados"
        value={stats.total_atrasado}
        sublabel="Acima do prazo"
        icon={AlertTriangle}
        iconBg={stats.total_atrasado > 0 ? 'bg-red-50 dark:bg-red-950/50' : 'bg-[hsl(var(--muted))]'}
        iconColor={stats.total_atrasado > 0 ? 'text-red-600 dark:text-red-400' : 'text-[hsl(var(--muted-foreground))]'}
        valueColor={stats.total_atrasado > 0 ? 'text-red-600 dark:text-red-400' : undefined}
        highlight={stats.total_atrasado > 0}
      />
      <KpiCard
        label="Órfãos"
        value={stats.total_orphans}
        sublabel="Sem venda vinculada"
        icon={AlertCircle}
        iconBg={stats.total_orphans > 0 ? 'bg-amber-50 dark:bg-amber-950/50' : 'bg-[hsl(var(--muted))]'}
        iconColor={stats.total_orphans > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-[hsl(var(--muted-foreground))]'}
      />
      <KpiCard
        label="Tempo Médio"
        value={stats.avg_contact_hours > 0 ? formatHours(stats.avg_contact_hours) : '—'}
        sublabel="Para contato"
        icon={stats.avg_contact_hours > 0 ? TrendingUp : Timer}
        iconBg="bg-purple-50 dark:bg-purple-950/50"
        iconColor="text-purple-600 dark:text-purple-400"
      />
    </motion.div>
  )
}
