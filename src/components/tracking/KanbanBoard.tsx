import { useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { AnimatePresence } from 'framer-motion'
import { toast } from 'sonner'
import { KanbanCard } from './KanbanCard'
import { TrackingBoardView } from './TrackingBoardView'
import { trackingCollisionDetection } from './tracking-dnd'
import { VetPickerModal } from './VetPickerModal'
import { CARD_STATUSES } from '@/lib/card-constants'
import { useMoveCard } from '@/hooks/useExamCardMutations'
import type { ExamCard, CardStatus } from '@/types/exam-card'

interface KanbanBoardProps {
  cards: ExamCard[]
  onSelectCard: (card: ExamCard) => void
  selectedIds: Set<string>
  onToggleSelection: (cardId: string) => void
  onToggleGroupSelection: (cardIds: string[]) => void
}

interface PendingDrop {
  card: ExamCard
  fromStatus: CardStatus
  toStatus: CardStatus
}

export function KanbanBoard({ cards, onSelectCard, selectedIds, onToggleSelection, onToggleGroupSelection }: KanbanBoardProps) {
  const [activeCard, setActiveCard] = useState<ExamCard | null>(null)
  const [pendingDrop, setPendingDrop] = useState<PendingDrop | null>(null)

  const moveMutation = useMoveCard()

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor)
  )

  function handleDragStart(event: DragStartEvent) {
    const card = event.active.data.current?.card as ExamCard | undefined
    if (card) setActiveCard(card)
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveCard(null)

    const { active, over } = event
    if (!over) return

    const card = active.data.current?.card as ExamCard | undefined
    if (!card) return

    const toStatus = (over.data.current?.status ?? over.id) as CardStatus
    if (!CARD_STATUSES.includes(toStatus)) return
    const fromStatus = card.status

    if (toStatus === fromStatus) return

    if (toStatus === 'contato_realizado') {
      setPendingDrop({ card, fromStatus, toStatus })
      return
    }

    moveMutation.mutate(
      { cardId: card.id, fromStatus, toStatus },
      {
        onError: (err: unknown) => {
          toast.error('Erro ao mover card: ' + (err instanceof Error ? err.message : 'Falha desconhecida'))
        },
      }
    )
  }

  function handleVetConfirm(contactedBy: string) {
    if (!pendingDrop) return
    const { card, fromStatus, toStatus } = pendingDrop
    setPendingDrop(null)

    moveMutation.mutate(
      { cardId: card.id, fromStatus, toStatus, contactedBy },
      {
        onError: (err: unknown) => {
          toast.error('Erro ao mover card: ' + (err instanceof Error ? err.message : 'Falha desconhecida'))
        },
      }
    )
  }

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={trackingCollisionDetection}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveCard(null)}
      >
        <TrackingBoardView cards={cards} onSelectCard={onSelectCard} selectedIds={selectedIds}
          onToggleSelection={onToggleSelection} onToggleGroupSelection={onToggleGroupSelection}
          renderCard={(card, props) => <KanbanCard card={card} onClick={props.onOpen}
            selected={props.selected} onToggleSelection={props.onToggleSelection} />} />

        <DragOverlay dropAnimation={{ duration: 180, easing: 'ease' }}>
          {activeCard ? (
            <div className="shadow-lg opacity-95 pointer-events-none">
              <KanbanCard card={activeCard} onClick={() => {}} isDragging />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <AnimatePresence>
        {pendingDrop && (
          <VetPickerModal
            card={pendingDrop.card}
            onConfirm={handleVetConfirm}
            onCancel={() => setPendingDrop(null)}
          />
        )}
      </AnimatePresence>
    </>
  )
}
