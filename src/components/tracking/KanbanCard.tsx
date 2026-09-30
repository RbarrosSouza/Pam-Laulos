import { useState } from 'react'
import { Clock, ShoppingBag, Mail, AlertTriangle, User, Calendar, Cat, Dog, Check } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useDraggable } from '@dnd-kit/core'
import { staggerItem } from '@/lib/animations'
import { formatHours, formatDate, cn, getSpeciesType } from '@/lib/utils'
import { elapsedHoursForDisplay } from '@/lib/group-time'
import { ExamItemRow } from './ExamItemRow'
import { ContactModal } from './ContactModal'
import type { ExamCard, ExamItem } from '@/types/exam-card'

const MAX_VISIBLE = 4
const TRUNCATE_AT = 3

interface KanbanCardProps {
  card: ExamCard
  onClick: () => void
  isDragging?: boolean
  selected?: boolean
  onToggleSelection?: () => void
}

export function KanbanCard({ card, onClick, isDragging = false, selected = false, onToggleSelection }: KanbanCardProps) {
  const [contactingItem, setContactingItem] = useState<ExamItem | null>(null)

  const { attributes, listeners, setNodeRef, isDragging: isActiveDrag } = useDraggable({
    id: card.id,
    data: { card },
  })

  const petLabel = card.pet_name ?? '—'
  const speciesType = getSpeciesType(card.pet_species)
  const SpeciesIcon = speciesType === 'cat' ? Cat : speciesType === 'dog' ? Dog : null
  const timeColor =
    card.alert_level === 'critical'
      ? 'text-red-500 dark:text-red-400'
      : card.alert_level === 'warning'
      ? 'text-amber-500 dark:text-amber-400'
      : 'text-[hsl(var(--muted-foreground))]'

  const items = card.items ?? []
  const hasMore = items.length > MAX_VISIBLE
  const visibleItems = hasMore ? items.slice(0, TRUNCATE_AT) : items
  const extraCount = items.length - TRUNCATE_AT

  // Progress bar
  const progress = card.items_total > 0
    ? Math.round((card.items_ready / card.items_total) * 100)
    : 0

  // Date: result_received_at (if ready) or created_at (sale date)
  const resultDate = items.find((i) => i.result_received_at)?.result_received_at
  const displayDate = resultDate || card.created_at
  const formattedDate = displayDate
    ? new Date(displayDate).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
    : null
  const groupDate = card.group_sent_at ? formatDate(card.group_sent_at) : null

  const dragging = isActiveDrag || isDragging

  return (
    <>
      <motion.div
        ref={setNodeRef}
        variants={staggerItem}
        whileHover={dragging ? undefined : { y: -2, scale: 1.01, transition: { duration: 0.15 } }}
        onClick={dragging ? undefined : onClick}
        className={cn(
          'relative rounded-xl border bg-[hsl(var(--card))] p-3.5 cursor-grab active:cursor-grabbing shadow-sm',
          'hover:shadow-md transition-all duration-150',
          dragging ? 'opacity-40' : '',
          selected && 'ring-2 ring-[hsl(var(--primary))] border-[hsl(var(--primary))]',
          card.alert_level === 'critical'
            ? 'border-red-300 bg-red-50/60 dark:bg-red-950/30 dark:border-red-800/80 hover:border-red-400 dark:hover:border-red-700'
            : card.alert_level === 'warning'
            ? 'border-amber-200 dark:border-amber-800/80 hover:border-amber-300 dark:hover:border-amber-800'
            : 'border-[hsl(var(--border))] hover:border-[hsl(var(--primary))]/40'
        )}
        {...attributes}
        {...listeners}
      >
        {onToggleSelection && (
          <button
            type="button"
            aria-label={`Selecionar ${petLabel}`}
            aria-pressed={selected}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); onToggleSelection() }}
            className={cn(
              'absolute top-3 right-3 z-10 w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all',
              selected ? 'bg-[hsl(var(--primary))] border-[hsl(var(--primary))]' : 'bg-[hsl(var(--card))] border-[hsl(var(--border))] hover:border-[hsl(var(--primary))]'
            )}
          >
            {selected && <Check className="w-3 h-3 text-white" />}
          </button>
        )}
        {/* Row 1: pet name + vet avatar */}
        <div className={cn('flex items-start justify-between gap-2 mb-2', onToggleSelection && 'pr-7')}>
          <div className="flex items-center gap-1.5 min-w-0">
            {card.alert_level === 'critical' && (
              <span className="w-2 h-2 rounded-full bg-red-500 shrink-0 alert-dot-critical" />
            )}
            {card.alert_level === 'warning' && (
              <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0 alert-dot-warning" />
            )}
            {card.is_orphan && (
              <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0" />
            )}
            <div className="min-w-0">
              <p className="font-bold text-sm text-[hsl(var(--foreground))] leading-tight truncate flex items-center gap-1">
                {SpeciesIcon && <SpeciesIcon className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))] shrink-0" />}
                {petLabel}
              </p>
              {card.client_name && (
                <span className="flex items-center gap-0.5 text-[10px] text-[hsl(var(--muted-foreground))] truncate mt-0.5">
                  <User className="w-2.5 h-2.5 shrink-0" />
                  {card.client_name}
                </span>
              )}
            </div>
          </div>

          {/* Vet avatar (right side, larger) */}
          {card.vet_avatar_url ? (
            <img
              src={card.vet_avatar_url}
              alt={card.vet_name ?? ''}
              title={card.vet_name ?? ''}
              className="w-8 h-8 rounded-full object-cover shrink-0 ring-2 ring-[hsl(var(--border))]"
            />
          ) : card.vet_name ? (
            <div
              title={card.vet_name}
              className="w-8 h-8 rounded-full bg-[hsl(var(--muted))] flex items-center justify-center shrink-0"
            >
              <span className="text-[10px] font-bold text-[hsl(var(--muted-foreground))]">
                {card.vet_name.charAt(0).toUpperCase()}
              </span>
            </div>
          ) : null}
        </div>

        {/* Items list */}
        {items.length > 0 && (
          <div className="space-y-0.5 mb-3">
            {visibleItems.map((item) => (
              <ExamItemRow
                key={item.id}
                item={item}
                compact
                onContactClick={setContactingItem}
              />
            ))}
            {hasMore && (
              <p className="text-[10px] text-[hsl(var(--muted-foreground))] pl-6">
                +{extraCount} mais
              </p>
            )}
          </div>
        )}

        {card.status === 'no_grupo' && groupDate && (
          <p className={cn('mb-2 text-[11px] font-medium', card.alert_level === 'critical' ? 'text-red-600 dark:text-red-400' : 'text-purple-700 dark:text-purple-400')}>
            No grupo desde {groupDate}
          </p>
        )}
        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-[hsl(var(--border))]/50 pt-2">
          <div className="flex items-center gap-1.5">
            {card.is_orphan ? (
              <ShoppingBag className="w-3.5 h-3.5 text-red-500 dark:text-red-400 no-sale-icon" aria-label="Sem venda" />
            ) : card.origin === 'venda' ? (
              <ShoppingBag className="w-3.5 h-3.5 text-[hsl(var(--primary))]" />
            ) : (
              <Mail className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))]" />
            )}
            {formattedDate && (
              <span className="flex items-center gap-0.5 text-[10px] text-[hsl(var(--muted-foreground))]">
                <Calendar className="w-2.5 h-2.5" />
                {formattedDate}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* Progress bar */}
            {card.items_total > 0 && (
              <div className="flex items-center gap-1.5 min-w-0">
                <div className="w-12 h-1.5 rounded-full bg-[hsl(var(--border))] overflow-hidden">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all duration-500',
                      progress === 100
                        ? 'bg-green-500'
                        : progress > 50
                        ? 'bg-[hsl(var(--primary))]'
                        : 'bg-[hsl(var(--muted-foreground))]/40'
                    )}
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <span className="text-[10px] text-[hsl(var(--muted-foreground))] tabular-nums shrink-0">
                  {card.items_ready}/{card.items_total}
                </span>
              </div>
            )}

            {/* Elapsed time */}
            <div className={cn('flex items-center gap-0.5 shrink-0', timeColor)}>
              <Clock className="w-2.5 h-2.5" />
              <span className="text-[10px] font-semibold tabular-nums">{formatHours(elapsedHoursForDisplay(card))}</span>
            </div>
          </div>
        </div>
      </motion.div>

      <AnimatePresence>
        {contactingItem && (
          <ContactModal
            item={contactingItem}
            card={card}
            onClose={() => setContactingItem(null)}
          />
        )}
      </AnimatePresence>
    </>
  )
}
