import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { DndContext, KeyboardSensor, PointerSensor, TouchSensor, useDraggable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { CircleCheck, GripVertical, X } from 'lucide-react'
import { TrackingBoardView } from '@/components/tracking/TrackingBoardView'
import { TrackingCardSurface } from '@/components/tracking/TrackingCardSurface'
import { trackingCollisionDetection } from '@/components/tracking/tracking-dnd'
import { TrackingTable } from '@/components/tracking/TrackingTable'
import { TrackingWorkspace, TrackingDeleteDialog, type TrackingSortOrder, type TrackingViewMode } from '@/components/tracking/TrackingWorkspace'
import { TRACKING_STAGE_LABELS } from '@/components/tracking/tracking-display'
import { elapsedHoursForDisplay } from '@/lib/group-time'
import type { ExamCard, ExamItem, CardStatus } from '@/types/exam-card'

const vets = [{ id: 'demo-vet-1', nome: 'Dra. Exemplo' }, { id: 'demo-vet-2', nome: 'Dra. Modelo' }, { id: 'demo-vet-3', nome: 'Dra. Teste' }]
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()
const item = (id: string, exam_type: string, ready = false, contacted = false): ExamItem => ({ id, exam_card_id: 'demo-card', exam_type, lab_name: 'Laboratório Exemplo', arquivo_url: null, result_received: ready, result_received_at: ready ? ago(4) : null, contacted, contacted_at: contacted ? ago(1) : null, contacted_by: contacted ? vets[0].nome : null, sent_to_lab_at: ago(10), sent_to_lab_by: 'Equipe de exemplo', shipment_id: null })
const makeCard = (id: string, pet: string, tutor: string, status: CardStatus, hours: number, items: ExamItem[], vet = vets[0].nome): ExamCard => ({ id, pet_name: pet, client_name: tutor, status, alert_level: hours > 24 && status === 'no_grupo' ? 'critical' : 'normal', origin: 'venda', is_orphan: false, sale_id: null, pet_species: 'Canina', pet_breed: null, client_phone: null, client_email: null, vet_name: vet, vet_id: null, vet_avatar_url: null, items, items_ready: items.filter(i => i.result_received).length, items_total: items.length, hours_elapsed: hours, group_sent_at: status === 'no_grupo' ? ago(hours) : null, created_at: ago(hours), updated_at: ago(1) })
const fixtures = [
  makeCard('demo-tracking-1', 'Luna', 'Helena Beatriz Oliveira Duarte', 'aguardando_lab', 3, [item('demo-item-1', 'Hemograma completo'), item('demo-item-2', 'Perfil renal')]),
  makeCard('demo-tracking-2', 'Thor', 'João Pereira', 'aguardando_lab', 12, [item('demo-item-3', 'Urinálise', true), item('demo-item-4', 'Urocultura')], vets[1].nome),
  makeCard('demo-tracking-3', 'Mia', 'Clara Souza', 'exame_pronto', 5, [item('demo-item-5', 'Ultrassonografia abdominal', true)], vets[2].nome),
  makeCard('demo-tracking-4', 'Nina', 'Beatriz Ferreira de Almeida', 'no_grupo', 28, [item('demo-item-6', 'Hemograma completo', true)], vets[0].nome),
  makeCard('demo-tracking-5', 'Bento', 'Carlos Oliveira', 'contato_realizado', 46, [item('demo-item-7', 'Radiografia de tórax', true, true)], vets[1].nome),
]
const next: Partial<Record<CardStatus, CardStatus>> = { aguardando_lab: 'exame_pronto', exame_pronto: 'no_grupo', no_grupo: 'contato_realizado' }

function PreviewDraggableCard({ card, selected, onToggleSelection, onOpen }: { card: ExamCard; selected: boolean; onToggleSelection: () => void; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } = useDraggable({ id: card.id, data: { card } })
  return <div ref={setNodeRef} style={transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, position: 'relative', zIndex: 40 } : undefined}><TrackingCardSurface card={card} selected={selected} onToggleSelection={onToggleSelection} onOpen={onOpen} dragging={isDragging}
    dragHandle={<button ref={setActivatorNodeRef} type="button" className="tracking-drag-handle" aria-label={`Arrastar exame de ${card.pet_name}`} {...attributes} {...listeners}><GripVertical size={18} aria-hidden="true" /></button>} /></div>
}

/** DEV-only controller. No auth, database, network or operational hook imports. */
export function TrackingPreview() {
  const [cards, setCards] = useState(fixtures)
  const [search, setSearch] = useState('')
  const [view, setView] = useState<TrackingViewMode>('board')
  const [sortOrder, setSortOrder] = useState<TrackingSortOrder>('newest')
  const [statuses, setStatuses] = useState<CardStatus[]>([])
  const [vet, setVet] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [selectedIds, setSelectedIds] = useState(new Set<string>())
  const [openedCard, setOpenedCard] = useState<ExamCard | null>(null)
  const [showDelete, setShowDelete] = useState(false)
  const [showVet, setShowVet] = useState(false)
  const [pendingDrag, setPendingDrag] = useState<{ id: string; status: CardStatus } | null>(null)
  const [message, setMessage] = useState('')
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }), useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }), useSensor(KeyboardSensor))
  const day = new Date()
  const today = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
  const filtered = cards.filter(card => [card.pet_name, card.client_name, card.vet_name].join(' ').toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR'))
    && (!statuses.length || statuses.includes(card.status)) && (!vet || card.vet_name === vet)
    && (!dateFrom || card.created_at.slice(0, 10) >= dateFrom) && (!dateTo || card.created_at.slice(0, 10) <= dateTo))
    .sort((a, b) => (sortOrder === 'newest' ? 1 : -1) * (elapsedHoursForDisplay(a) - elapsedHoursForDisplay(b)))
  const selected = filtered.filter(card => selectedIds.has(card.id))
  const activeIds = new Set(selected.map(card => card.id))
  const advanceable = selected.filter(card => next[card.status])
  const toggleSelection = (id: string) => setSelectedIds(previous => { const value = new Set(previous); if (value.has(id)) value.delete(id); else value.add(id); return value })
  const toggleGroup = (ids: string[]) => setSelectedIds(previous => { const value = new Set(previous); const all = ids.every(id => value.has(id)); ids.forEach(id => all ? value.delete(id) : value.add(id)); return value })
  const advance = () => {
    const ids = new Set(advanceable.map(card => card.id))
    setCards(previous => previous.map(card => pendingDrag?.id === card.id ? { ...card, status: pendingDrag.status } : !pendingDrag && ids.has(card.id) ? { ...card, status: next[card.status]!, group_sent_at: next[card.status] === 'no_grupo' ? ago(0) : card.group_sent_at } : card))
    setPendingDrag(null); setSelectedIds(new Set()); setShowVet(false); setMessage('Etapa atualizada nesta prévia. Nenhum registro real foi alterado.')
  }
  const dragEnd = ({ active, over }: DragEndEvent) => {
    const card = active.data.current?.card as ExamCard | undefined
    const status = (over?.data.current?.status ?? over?.id) as CardStatus | undefined
    if (!card || !status || !(status in TRACKING_STAGE_LABELS) || status === card.status) return
    if (status === 'contato_realizado') { setPendingDrag({ id: card.id, status }); setShowVet(true); return }
    setCards(previous => previous.map(value => value.id === card.id ? { ...value, status, group_sent_at: status === 'no_grupo' ? ago(0) : value.group_sent_at } : value))
    setMessage('Etapa atualizada nesta prévia. Nenhum registro real foi alterado.')
  }
  return <>
    <TrackingWorkspace count={filtered.length} loading={false} error={null} refreshing={false} onRefresh={() => setMessage('Prévia atualizada. Dados fictícios.')}
      search={search} onSearchChange={setSearch} view={view} onViewChange={setView} sortOrder={sortOrder} onSortChange={setSortOrder}
      statuses={statuses} onToggleStatus={status => setStatuses(previous => previous.includes(status) ? previous.filter(value => value !== status) : [...previous, status])}
      vet={vet} vets={vets} onVetChange={setVet} dateFrom={dateFrom} dateTo={dateTo} onDateChange={(from, to) => { setDateFrom(from); setDateTo(to) }}
      isToday={dateFrom === today && dateTo === today} onToggleToday={() => { const clear = dateFrom === today && dateTo === today; setDateFrom(clear ? '' : today); setDateTo(clear ? '' : today) }}
      onClearFilters={() => { setSearch(''); setStatuses([]); setVet(''); setDateFrom(''); setDateTo('') }} selectedCount={selected.length} advanceableCount={advanceable.length} pending={false}
      onClearSelection={() => setSelectedIds(new Set())} onAdvance={() => advanceable.some(card => next[card.status] === 'contato_realizado') ? setShowVet(true) : advance()} onRequestDelete={() => setShowDelete(true)}>
      {message && <p className="tracking-preview-notice" role="status">{message}</p>}
      {view === 'board' ? <DndContext sensors={sensors} collisionDetection={trackingCollisionDetection} onDragEnd={dragEnd}><TrackingBoardView cards={filtered} onSelectCard={setOpenedCard} selectedIds={activeIds} onToggleSelection={toggleSelection} onToggleGroupSelection={toggleGroup}
        renderCard={(card, props) => <PreviewDraggableCard card={card} {...props} />} /></DndContext>
        : <TrackingTable cards={filtered} onSelectCard={setOpenedCard} selectedIds={activeIds} onToggleSelection={toggleSelection} onToggleAllSelection={() => toggleGroup(filtered.map(card => card.id))} />}
    </TrackingWorkspace>
    <TrackingDeleteDialog open={showDelete} count={selected.length} loading={false} onClose={() => setShowDelete(false)} onConfirm={() => { setShowDelete(false); setSelectedIds(new Set()); setMessage('Exclusão simulada. Nenhum registro real foi alterado.') }} />
    <Dialog.Root open={Boolean(openedCard)} onOpenChange={open => { if (!open) setOpenedCard(null) }}><Dialog.Portal><Dialog.Overlay className="tracking-dialog-overlay" /><Dialog.Content className="tracking-filter-sheet" aria-describedby={undefined}><header className="tracking-sheet-heading"><Dialog.Title>{openedCard?.pet_name}</Dialog.Title><Dialog.Close asChild><button type="button" className="tracking-icon-button" aria-label="Fechar ficha"><X size={20} /></button></Dialog.Close></header><div className="tracking-sheet-body"><p>{openedCard?.client_name}</p><strong>{openedCard && TRACKING_STAGE_LABELS[openedCard.status]}</strong><ul>{openedCard?.items.map(i => <li key={i.id}>{i.exam_type}</li>)}</ul><p className="tracking-preview-description">A ficha detalhada mantém suas funções atuais. Nesta etapa, estamos refinando a navegação, os filtros e a visão geral do Rastreamento.</p></div></Dialog.Content></Dialog.Portal></Dialog.Root>
    <Dialog.Root open={showVet} onOpenChange={open => { setShowVet(open); if (!open) setPendingDrag(null) }}><Dialog.Portal><Dialog.Overlay className="tracking-dialog-overlay" /><Dialog.Content className="tracking-filter-sheet"><header className="tracking-sheet-heading"><Dialog.Title>Quem realizou os contatos?</Dialog.Title><Dialog.Close asChild><button type="button" className="tracking-icon-button" aria-label="Cancelar confirmação"><X size={20} /></button></Dialog.Close></header><div className="tracking-sheet-body"><Dialog.Description className="tracking-preview-description">Confirmação visual com a equipe fictícia desta prévia.</Dialog.Description>{vets.map(person => <button type="button" className="tracking-preview-vet" key={person.id} onClick={advance}><span>{person.nome}</span><CircleCheck size={20} aria-hidden="true" /></button>)}</div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </>
}
