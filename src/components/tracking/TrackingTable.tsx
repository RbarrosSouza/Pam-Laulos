import { Search, AlertTriangle, Eye, Stethoscope } from 'lucide-react'
import { StatusBadge } from './StatusBadge'
import { formatHours, formatDate, cn } from '@/lib/utils'
import type { ExamCard } from '@/types/exam-card'

function SkeletonRow() {
  return (
    <tr className="border-b border-[hsl(var(--border))]">
      {[...Array(8)].map((_, i) => (
        <td key={i} className="px-4 py-3">
          <div className="h-4 bg-[hsl(var(--muted))] rounded animate-pulse" style={{ width: `${60 + i * 10}%` }} />
        </td>
      ))}
    </tr>
  )
}

interface TrackingTableProps {
  cards?: ExamCard[]
  onSelectCard: (card: ExamCard) => void
  isLoading?: boolean
}

export function TrackingTable({ cards, onSelectCard, isLoading }: TrackingTableProps) {
  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[hsl(var(--border))] bg-[hsl(var(--muted))]/40">
              <th className="text-left px-4 py-3 text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide">Status</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide">Pet / Tutor</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide hidden md:table-cell">Exames</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide hidden md:table-cell">Lab</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide hidden lg:table-cell">Vet</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide hidden lg:table-cell">Criado</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide">Progresso</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide">Tempo</th>
              <th className="px-4 py-3 w-10" />
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <>
                <SkeletonRow />
                <SkeletonRow />
                <SkeletonRow />
                <SkeletonRow />
              </>
            )}

            {!isLoading && cards?.length === 0 && (
              <tr>
                <td colSpan={9} className="text-center py-16 text-[hsl(var(--muted-foreground))]">
                  <Search className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">Nenhum card encontrado</p>
                </td>
              </tr>
            )}

            {cards?.map((card) => {
              const labName = card.items?.find((i) => i.lab_name)?.lab_name
              const examTypes = card.items?.map((i) => i.exam_type).filter(Boolean)
              const vetFirst = card.vet_name?.split(' ')[0]
              return (
                <tr
                  key={card.id}
                  className={cn(
                    'border-b border-[hsl(var(--border))] hover:bg-[hsl(var(--muted))]/40 cursor-pointer transition-colors group',
                    card.alert_level === 'critical' && 'bg-red-50/50 dark:bg-red-950/20',
                    card.alert_level === 'warning' && 'bg-amber-50/50 dark:bg-amber-950/20'
                  )}
                  onClick={() => onSelectCard(card)}
                >
                  <td className="px-4 py-3">
                    <StatusBadge status={card.status} alertLevel={card.alert_level} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      {card.is_orphan && (
                        <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0" />
                      )}
                      <div>
                        <p className="font-medium text-[hsl(var(--foreground))] leading-tight">
                          {card.pet_name ?? '—'}
                        </p>
                        <p className="text-xs text-[hsl(var(--muted-foreground))] leading-tight mt-0.5">
                          {card.client_name ?? '—'}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    {examTypes && examTypes.length > 0 ? (
                      <div className="space-y-0.5">
                        {examTypes.slice(0, 2).map((t, i) => (
                          <p key={i} className="text-xs text-[hsl(var(--foreground))] truncate max-w-[160px]">{t}</p>
                        ))}
                        {examTypes.length > 2 && (
                          <p className="text-[10px] text-[hsl(var(--muted-foreground))]">+{examTypes.length - 2} mais</p>
                        )}
                      </div>
                    ) : (
                      <span className="text-[hsl(var(--muted-foreground))]">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-[hsl(var(--muted-foreground))] hidden md:table-cell">
                    {labName ?? '—'}
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell">
                    {vetFirst ? (
                      <div className="flex items-center gap-1.5">
                        {card.vet_avatar_url ? (
                          <img src={card.vet_avatar_url} alt="" className="w-5 h-5 rounded-full object-cover" />
                        ) : (
                          <Stethoscope className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))]/60" />
                        )}
                        <span className="text-xs text-[hsl(var(--foreground))]">{vetFirst}</span>
                      </div>
                    ) : (
                      <span className="text-[hsl(var(--muted-foreground))]">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-[hsl(var(--muted-foreground))] hidden lg:table-cell">
                    {formatDate(card.created_at)}
                  </td>
                  <td className="px-4 py-3">
                    {card.items_total > 0 ? (
                      <div className="flex items-center gap-1.5">
                        <div className="w-16 h-1.5 rounded-full bg-[hsl(var(--border))]">
                          <div
                            className="h-full rounded-full bg-[hsl(var(--primary))] transition-all"
                            style={{ width: `${Math.round((card.items_ready / card.items_total) * 100)}%` }}
                          />
                        </div>
                        <span className="text-xs text-[hsl(var(--muted-foreground))] tabular-nums">
                          {card.items_ready}/{card.items_total}
                        </span>
                      </div>
                    ) : (
                      <span className="text-[hsl(var(--muted-foreground))]">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn(
                      'font-semibold text-sm',
                      card.alert_level === 'critical' ? 'text-red-600 dark:text-red-400' :
                      card.alert_level === 'warning' ? 'text-amber-600 dark:text-amber-400' :
                      'text-[hsl(var(--muted-foreground))]'
                    )}>
                      {formatHours(card.hours_elapsed)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={(e) => { e.stopPropagation(); onSelectCard(card) }}
                      className="w-7 h-7 flex items-center justify-center rounded-lg text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--primary))] hover:bg-[hsl(var(--accent))] transition-all opacity-0 group-hover:opacity-100"
                      aria-label="Ver detalhes"
                    >
                      <Eye className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {cards && cards.length > 0 && (
        <div className="px-4 py-2.5 border-t border-[hsl(var(--border))] bg-[hsl(var(--muted))]/20">
          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            {cards.length} card{cards.length !== 1 ? 's' : ''}
          </p>
        </div>
      )}
    </div>
  )
}
