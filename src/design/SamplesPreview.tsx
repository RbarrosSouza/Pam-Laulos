import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { SamplesView } from '@/components/samples/SamplesView'
import { ShipmentHistoryView } from '@/components/samples/ShipmentHistoryView'
import { getShipmentDateFilters, shipmentCalendarDate, type ShipmentHistoryFilter } from '@/components/samples/shipment-history-period'
import { pendingSamples, selectedSamples } from '@/components/samples/sample-selection'
import type { ExamCard, ExamItem, LabShipmentWithItems } from '@/types/exam-card'

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()
const sample = (id: string, cardId: string, exam: string, received = false, sent = false): ExamItem => ({ id, exam_card_id: cardId, exam_type: exam, lab_name: 'Laboratório Exemplo', arquivo_url: null, result_received: received, result_received_at: received ? ago(2) : null, contacted: false, contacted_at: null, contacted_by: null, sent_to_lab_at: sent ? ago(20) : null, sent_to_lab_by: sent ? 'Equipe de exemplo' : null, shipment_id: null })
const card = (id: string, pet: string, tutor: string, items: ExamItem[], orphan = false): ExamCard => ({ id, pet_name: pet, client_name: tutor, status: 'aguardando_lab', alert_level: 'normal', origin: 'venda', is_orphan: orphan, sale_id: null, pet_species: 'Canina', pet_breed: null, client_phone: null, client_email: null, vet_name: 'Dra. Exemplo', vet_id: null, vet_avatar_url: null, items, items_ready: 0, items_total: items.length, hours_elapsed: 3, group_sent_at: null, created_at: ago(3), updated_at: ago(1) })
const fixtures = [
  card('sample-card-1', 'Luna', 'Helena Beatriz Oliveira Duarte', [sample('sample-1', 'sample-card-1', 'Hemograma completo'), sample('sample-2', 'sample-card-1', 'Perfil renal')]),
  card('sample-card-2', 'Thor', 'João Pereira', [sample('sample-3', 'sample-card-2', 'Urocultura'), sample('sample-ready', 'sample-card-2', 'Urinálise', true)]),
  card('sample-card-3', 'Mia', 'Clara Souza', [sample('sample-4', 'sample-card-3', 'Coproparasitológico'), sample('sample-sent', 'sample-card-3', 'Hemograma completo', false, true)], true),
]
const history: LabShipmentWithItems[] = [
  { id: 'shipment-demo-1', lab_name: 'Laboratório Exemplo', sent_by: 'Equipe de exemplo', sent_at: ago(0.25), items_count: 2, notes: null, created_at: ago(0.25), items: [{ id: 'history-item-1', exam_type: 'Hemograma completo', pet_name: 'Bento', client_name: 'Carlos Oliveira' }, { id: 'history-item-2', exam_type: 'Perfil hepático', pet_name: 'Nina', client_name: 'Beatriz Ferreira de Almeida' }] },
  { id: 'shipment-demo-2', lab_name: 'Centro de Diagnóstico Modelo', sent_by: 'Equipe de exemplo', sent_at: ago(48), items_count: 1, notes: 'Amostra acondicionada para transporte.', created_at: ago(48), items: [{ id: 'history-item-3', exam_type: 'Citologia', pet_name: 'Mel', client_name: 'Roberta Beatriz Lopes Oliveira' }] },
  { id: 'shipment-demo-3', lab_name: null, sent_by: 'Equipe de exemplo', sent_at: ago(240), items_count: 1, notes: null, created_at: ago(240), items: [] },
]

/** DEV-only local simulation. No auth, hooks, network or operational data. */
export function SamplesPreview() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [cards, setCards] = useState(fixtures)
  const [shipments, setShipments] = useState(history)
  const [selected, setSelected] = useState(new Set<string>())
  const [sentBy, setSentBy] = useState('')
  const [labName, setLabName] = useState('')
  const [filter, setFilter] = useState<ShipmentHistoryFilter>('today')
  const items = pendingSamples(cards)
  const select = (ids: string[], checked: boolean) => setSelected(previous => { const next = new Set(previous); ids.forEach(id => checked ? next.add(id) : next.delete(id)); return next })

  if (pathname === '/shipments') {
    const { startAt, endBefore } = getShipmentDateFilters(filter, shipmentCalendarDate(new Date()))
    const filtered = shipments.filter(shipment => (!startAt || shipment.sent_at >= startAt) && (!endBefore || shipment.sent_at < endBefore))
    return <ShipmentHistoryView shipments={filtered} loading={false} error={null} refreshing={false} onRefresh={() => {}} filter={filter} onFilterChange={setFilter} />
  }
  return <SamplesView items={items} selectedIds={selected} onToggleItem={id => select([id], !selected.has(id))} onSelectItems={select} onClearSelection={() => setSelected(new Set())}
    loading={false} error={null} refreshing={false} onRefresh={() => {}} sentBy={sentBy} onSentByChange={setSentBy} labName={labName} onLabNameChange={setLabName} submitting={false} submitError={null} manualSubmitting={false} manualError={null}
    onSubmit={async () => {
      const batch = selectedSamples(items, selected)
      if (!batch.length || !sentBy.trim()) return false
      const now = new Date().toISOString()
      const ids = new Set(batch.map(item => item.id))
      setShipments(previous => [{ id: `shipment-demo-${crypto.randomUUID()}`, lab_name: labName.trim() || null, sent_by: sentBy.trim(), sent_at: now, created_at: now, notes: null, items_count: batch.length, items: batch.map(item => ({ id: item.id, exam_type: item.exam_type, pet_name: item.card.pet_name, client_name: item.card.client_name })) }, ...previous])
      setCards(previous => previous.map(value => ({ ...value, items: value.items.map(item => ids.has(item.id) ? { ...item, sent_to_lab_at: now } : item) })))
      setSelected(new Set()); setFilter('today'); navigate('/shipments'); return true
    }}
    onCreateManual={async draft => {
      if (!draft.petName.trim() || !draft.examType.trim()) return false
      const id = `manual-demo-${crypto.randomUUID()}`
      const item = { ...sample(`${id}-item`, id, draft.examType.trim()), lab_name: draft.labName.trim() || null }
      setCards(previous => [card(id, draft.petName.trim(), draft.clientName.trim(), [item], true), ...previous]); return true
    }} />
}
