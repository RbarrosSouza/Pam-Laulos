import type { ReactNode } from 'react'
import { Inbox } from 'lucide-react'
import { useDroppable } from '@dnd-kit/core'
import { cn } from '@/lib/utils'
import type { ExamCard, CardStatus } from '@/types/exam-card'
import { TrackingCardSurface } from './TrackingCardSurface'
import { TRACKING_STAGES } from './tracking-display'

export interface TrackingCardRenderProps {
  selected: boolean
  onToggleSelection: () => void
  onOpen: () => void
}

export type TrackingCardRenderer = (card: ExamCard, props: TrackingCardRenderProps) => ReactNode

interface KanbanColumnProps {
  status: CardStatus
  cards: ExamCard[]
  onSelectCard: (card: ExamCard) => void
  selectedIds: Set<string>
  onToggleSelection: (cardId: string) => void
  onToggleAll: () => void
  renderCard?: TrackingCardRenderer
}

export function KanbanColumn({ status, cards, onSelectCard, selectedIds, onToggleSelection, onToggleAll, renderCard }: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: status })
  const stage = TRACKING_STAGES.find((item) => item.status === status)!
  const selectedCount = cards.filter((card) => selectedIds.has(card.id)).length
  const allSelected = cards.length > 0 && selectedCount === cards.length
  const someSelected = selectedCount > 0 && !allSelected
  return (
    <section ref={setNodeRef} className={cn('tracking-column', isOver && 'is-over')} aria-label={stage.label}>
      <header className="tracking-column-heading">
        <stage.Icon size={15} aria-hidden="true" />
        <h2>{stage.label}</h2>
        <span className="tracking-stage-count tabular-nums">{cards.length}</span>
        <label className="tracking-selection" title={`Selecionar todos em ${stage.label}`}>
          <input type="checkbox" checked={allSelected} disabled={!cards.length} aria-label={`Selecionar todos em ${stage.label}`} aria-checked={someSelected ? 'mixed' : allSelected}
            ref={(input) => { if (input) input.indeterminate = someSelected }} onChange={onToggleAll} />
        </label>
      </header>
      <div className="tracking-column-cards">
        {cards.length ? cards.map((card) => {
          const props = { selected: selectedIds.has(card.id), onToggleSelection: () => onToggleSelection(card.id), onOpen: () => onSelectCard(card) }
          return <div key={card.id}>{renderCard ? renderCard(card, props) : <TrackingCardSurface card={card} {...props} />}</div>
        }) : <div className="tracking-column-empty"><Inbox size={20} aria-hidden="true" /><p>{isOver ? 'Soltar aqui' : 'Nenhum exame nesta etapa'}</p></div>}
      </div>
    </section>
  )
}
