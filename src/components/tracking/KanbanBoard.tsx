import { useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { AnimatePresence } from 'framer-motion'
import { toast } from 'sonner'
import { KanbanColumn } from './KanbanColumn'
import { KanbanCard } from './KanbanCard'
import { VetPickerModal } from './VetPickerModal'
import { CARD_STATUSES } from '@/lib/card-constants'
import { useMoveCard } from '@/hooks/useExamCardMutations'
import type { ExamCard, CardStatus } from '@/types/exam-card'

interface KanbanBoardProps {
  cards: ExamCard[]
  onSelectCard: (card: ExamCard) => void
}

interface PendingDrop {
  card: ExamCard
  fromStatus: CardStatus
  toStatus: CardStatus
}

export function KanbanBoard({ cards, onSelectCard }: KanbanBoardProps) {
  const [activeCard, setActiveCard] = useState<ExamCard | null>(null)
  const [pendingDrop, setPendingDrop] = useState<PendingDrop | null>(null)

  const moveMutation = useMoveCard()

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } })
  )

  const grouped = CARD_STATUSES.map((status) => ({
    status,
    cards: cards.filter((c) => c.status === status),
  }))

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

    const toStatus = over.id as CardStatus
    const fromStatus = card.status

    if (toStatus === fromStatus) return

    if (toStatus === 'contato_realizado') {
      setPendingDrop({ card, fromStatus, toStatus })
      return
    }

    moveMutation.mutate(
      { cardId: card.id, fromStatus, toStatus },
      {
        onError: (err: any) => {
          toast.error('Erro ao mover card: ' + (err.message || 'Falha desconhecida'))
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
        onError: (err: any) => {
          toast.error('Erro ao mover card: ' + (err.message || 'Falha desconhecida'))
        },
      }
    )
  }

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
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

        <DragOverlay dropAnimation={{ duration: 180, easing: 'ease' }}>
          {activeCard ? (
            <div className="rotate-1 scale-[1.03] shadow-2xl opacity-95 pointer-events-none">
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
