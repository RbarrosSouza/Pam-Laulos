import { useState } from 'react'
import { useDndContext, useDroppable } from '@dnd-kit/core'
import { cn } from '@/lib/utils'
import type { CardStatus, ExamCard } from '@/types/exam-card'
import { KanbanColumn, type TrackingCardRenderer } from './KanbanColumn'
import { TRACKING_STAGES } from './tracking-display'
import './tracking-surfaces.css'

interface TrackingBoardViewProps {
  cards: ExamCard[]
  onSelectCard: (card: ExamCard) => void
  selectedIds: Set<string>
  onToggleSelection: (cardId: string) => void
  onToggleGroupSelection: (cardIds: string[]) => void
  renderCard?: TrackingCardRenderer
}

interface TrackingStageButtonProps {
  stage: typeof TRACKING_STAGES[number]
  count: number
  selected: boolean
  disabled: boolean
  onSelect: () => void
}

function TrackingStageButton({ stage, count, selected, disabled, onSelect }: TrackingStageButtonProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `stage-${stage.status}`, data: { status: stage.status } })
  return (
    <button ref={setNodeRef} type="button" className={cn('tracking-stage-button', selected && 'is-active', isOver && 'is-drop-over')} aria-pressed={selected} disabled={disabled} onClick={onSelect}>
      <stage.Icon size={14} aria-hidden="true" /><span>{stage.label}</span><span className="tracking-stage-count tabular-nums">{count}</span>
    </button>
  )
}

export function TrackingBoardView({ cards, onSelectCard, selectedIds, onToggleSelection, onToggleGroupSelection, renderCard }: TrackingBoardViewProps) {
  const [activeStage, setActiveStage] = useState<CardStatus>('aguardando_lab')
  const { active } = useDndContext()
  const groups = TRACKING_STAGES.map((stage) => ({ ...stage, cards: cards.filter((card) => card.status === stage.status) }))
  const populatedStage = groups.find((stage) => stage.status === activeStage && stage.cards.length > 0)
  const effectiveStage = populatedStage?.status || groups.find((stage) => stage.cards.length > 0)?.status || activeStage
  return (
    <div className="tracking-board">
      <div className={cn('tracking-stage-switcher', Boolean(active) && 'is-dragging')} role="group" aria-label="Etapa do rastreamento">
        {groups.map((stage) => (
          <TrackingStageButton key={stage.status} stage={stage} count={stage.cards.length} selected={effectiveStage === stage.status}
            disabled={!active && !stage.cards.length && cards.length > 0} onSelect={() => setActiveStage(stage.status)} />
        ))}
      </div>
      <div className="tracking-board-columns">
        {groups.map(({ status, cards: stageCards }) => (
          <div key={status} className={cn('tracking-column-slot', effectiveStage === status && 'is-active')}>
            <KanbanColumn status={status} cards={stageCards} onSelectCard={onSelectCard} selectedIds={selectedIds} onToggleSelection={onToggleSelection}
              onToggleAll={() => onToggleGroupSelection(stageCards.map((card) => card.id))} renderCard={renderCard} />
          </div>
        ))}
      </div>
    </div>
  )
}
