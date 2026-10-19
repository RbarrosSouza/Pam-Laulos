import { useState } from 'react'
import { GripVertical } from 'lucide-react'
import { AnimatePresence } from 'framer-motion'
import { useDraggable } from '@dnd-kit/core'
import { ExamItemRow } from './ExamItemRow'
import { ContactModal } from './ContactModal'
import { TrackingCardSurface } from './TrackingCardSurface'
import { isManagedExamItem, type ExamCard, type ExamItem } from '@/types/exam-card'

interface KanbanCardProps {
  card: ExamCard
  onClick: () => void
  isDragging?: boolean
  selected?: boolean
  onToggleSelection?: () => void
}

export function KanbanCard({ card, onClick, isDragging = false, selected = false, onToggleSelection }: KanbanCardProps) {
  const [contactingItem, setContactingItem] = useState<ExamItem | null>(null)
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging: isActiveDrag } = useDraggable({ id: card.id, data: { card } })
  // A document can become managed while this card is open. Preserve the same
  // document-owned contact boundary as the detailed tracking view.
  const contactItem = contactingItem && card.items.find((item) => item.id === contactingItem.id)
  const canContact = contactItem && !isManagedExamItem(contactItem)

  return (
    <>
      <div ref={setNodeRef}>
        <TrackingCardSurface card={card} onOpen={onClick} selected={selected} onToggleSelection={onToggleSelection} dragging={isActiveDrag || isDragging}
          dragHandle={!isDragging && <button ref={setActivatorNodeRef} type="button" className="tracking-drag-handle" aria-label={`Arrastar exame de ${card.pet_name || 'pet não identificado'}`} {...attributes} {...listeners}><GripVertical size={18} aria-hidden="true" /></button>}>
          {card.items.length > 0 ? card.items.map((item) => <ExamItemRow key={item.id} item={item} compact onContactClick={setContactingItem} />) : undefined}
        </TrackingCardSurface>
      </div>
      <AnimatePresence>
        {canContact && <ContactModal item={contactItem} card={card} onClose={() => setContactingItem(null)} />}
      </AnimatePresence>
    </>
  )
}
