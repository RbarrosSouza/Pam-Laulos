import { KanbanColumn } from './KanbanColumn'
import { CARD_STATUSES } from '@/lib/card-constants'
import type { ExamCard } from '@/types/exam-card'

interface KanbanBoardProps {
  cards: ExamCard[]
  onSelectCard: (card: ExamCard) => void
}

export function KanbanBoard({ cards, onSelectCard }: KanbanBoardProps) {
  const grouped = CARD_STATUSES.map((status) => ({
    status,
    cards: cards.filter((c) => c.status === status),
  }))

  return (
    <div className="flex gap-3 overflow-x-auto pb-4 -mx-1 px-1">
      {grouped.map(({ status, cards: colCards }) => (
        <KanbanColumn
          key={status}
          status={status}
          cards={colCards}
          onSelectCard={onSelectCard}
        />
      ))}
    </div>
  )
}
