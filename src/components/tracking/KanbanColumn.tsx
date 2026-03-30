import { Inbox } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useDroppable } from '@dnd-kit/core'
import { KanbanCard } from './KanbanCard'
import { staggerContainer } from '@/lib/animations'
import { cn } from '@/lib/utils'
import { STATUS_CONFIG } from '@/lib/card-constants'
import type { ExamCard, CardStatus } from '@/types/exam-card'

interface KanbanColumnProps {
  status: CardStatus
  cards: ExamCard[]
  onSelectCard: (card: ExamCard) => void
}

export function KanbanColumn({ status, cards, onSelectCard }: KanbanColumnProps) {
  const config = STATUS_CONFIG[status]
  const { setNodeRef, isOver } = useDroppable({ id: status })

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex flex-col min-w-[280px] w-[280px] shrink-0 rounded-xl border overflow-hidden transition-colors duration-150',
        isOver
          ? 'border-[hsl(var(--primary))]/60 bg-[hsl(var(--primary))]/5'
          : 'border-[hsl(var(--border))] bg-[hsl(var(--muted))]/30'
      )}
    >
      {/* Sticky header */}
      <div className={cn('px-3.5 py-3 flex items-center justify-between gap-2 sticky top-0 z-10', config.headerBg)}>
        <div className="flex items-center gap-2">
          <span className={cn('w-2 h-2 rounded-full shrink-0', config.dotColor)} />
          <span className={cn('text-sm font-semibold', config.headerText)}>{config.label}</span>
        </div>
        <span className={cn(
          'text-xs font-bold px-2 py-0.5 rounded-full min-w-[22px] text-center',
          config.badgeBg, config.badgeText
        )}>
          {cards.length}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto max-h-[calc(100vh-120px)] p-2.5 space-y-2">
        {cards.length === 0 ? (
          <div className={cn(
            'flex flex-col items-center justify-center py-10 rounded-lg transition-colors',
            isOver
              ? 'text-[hsl(var(--primary))]/60 bg-[hsl(var(--primary))]/5 border-2 border-dashed border-[hsl(var(--primary))]/30'
              : 'text-[hsl(var(--muted-foreground))]'
          )}>
            <Inbox className="w-7 h-7 mb-2 opacity-20" />
            <p className="text-xs opacity-50">{isOver ? 'Soltar aqui' : 'Sem cards'}</p>
          </div>
        ) : (
          <AnimatePresence>
            <motion.div
              variants={staggerContainer}
              initial="initial"
              animate="animate"
              className="space-y-2"
            >
              {cards.map((card) => (
                <KanbanCard
                  key={card.id}
                  card={card}
                  onClick={() => onSelectCard(card)}
                />
              ))}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </div>
  )
}
