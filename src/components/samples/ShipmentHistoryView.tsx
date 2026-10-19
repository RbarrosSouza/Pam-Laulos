import { useId, useState } from 'react'
import { CalendarDays, ChevronDown, FlaskConical, PackageCheck, RefreshCw, UserRound } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LabShipmentWithItems } from '@/types/exam-card'
import type { ShipmentHistoryFilter } from './shipment-history-period'
import './shipment-history.css'

export type { ShipmentHistoryFilter } from './shipment-history-period'

interface ShipmentHistoryViewProps {
  shipments: LabShipmentWithItems[]
  loading: boolean
  error: unknown
  refreshing: boolean
  onRefresh: () => void
  filter: ShipmentHistoryFilter
  onFilterChange: (filter: ShipmentHistoryFilter) => void
}

const dateFormatter = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric',
})
const timeFormatter = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit',
})
const periodOptions = [
  { value: 'today', label: 'Hoje' },
  { value: 'week', label: '7 dias' },
  { value: 'all', label: 'Todos' },
] as const

/** Presentation only. Queries and their date filter stay in the page adapter. */
export function ShipmentHistoryView(props: ShipmentHistoryViewProps) {
  const { shipments, loading, error, refreshing, filter } = props
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const hasData = shipments.length > 0

  return <section className="shipment-history" aria-labelledby="shipment-history-title" aria-busy={loading}>
    <header className="shipment-history-heading">
      <div><h1 id="shipment-history-title">Histórico de envios</h1><p aria-live="polite">{loading ? 'Carregando…' : error && !hasData ? 'Consulta indisponível' : `${shipments.length} envio${shipments.length === 1 ? '' : 's'}`}</p></div>
      <button type="button" className="shipment-history-refresh" onClick={props.onRefresh} disabled={refreshing} aria-label={refreshing ? 'Atualizando histórico de envios' : 'Atualizar histórico de envios'}><RefreshCw size={18} aria-hidden="true" /><span>Atualizar</span></button>
    </header>

    <div className="shipment-history-period" role="group" aria-label="Período dos envios">
      {periodOptions.map(option => <button key={option.value} type="button" aria-pressed={filter === option.value} onClick={() => props.onFilterChange(option.value)}>{option.label}</button>)}
    </div>

    {Boolean(error) && <div className="shipment-history-error" role="alert"><div><strong>Não foi possível {hasData ? 'atualizar' : 'carregar'} os envios.</strong>{hasData && <p>Exibindo a última consulta.</p>}</div><button type="button" onClick={props.onRefresh} disabled={refreshing}>Tentar novamente</button></div>}

    {loading ? <div className="shipment-history-skeletons" role="status" aria-label="Carregando histórico de envios">{[0, 1, 2].map(key => <div key={key}><span /><div><span /><span /></div><span /></div>)}</div>
      : !hasData && !error ? <div className="shipment-history-empty"><PackageCheck size={30} strokeWidth={1.5} aria-hidden="true" /><h2>{filter === 'today' ? 'Nenhum envio hoje' : filter === 'week' ? 'Nenhum envio nos últimos 7 dias' : 'Nenhum envio registrado'}</h2><p>Os envios ao laboratório aparecerão aqui.</p><button type="button" onClick={props.onRefresh} disabled={refreshing}>Atualizar</button></div>
        : hasData ? <ul className="shipment-history-list">{shipments.map(shipment => <ShipmentRecord key={shipment.id} shipment={shipment} expanded={expandedId === shipment.id} onToggle={() => setExpandedId(previous => previous === shipment.id ? null : shipment.id)} />)}</ul> : null}
  </section>
}

function ShipmentRecord({ shipment, expanded, onToggle }: { shipment: LabShipmentWithItems; expanded: boolean; onToggle: () => void }) {
  const panelId = useId()
  const buttonId = useId()
  const date = new Date(shipment.sent_at)
  const validDate = !Number.isNaN(date.getTime())
  const formattedDate = validDate ? dateFormatter.format(date) : 'Data não informada'
  const formattedTime = validDate ? timeFormatter.format(date) : ''

  return <li className={cn('shipment-history-record', expanded && 'is-expanded')}>
    <button type="button" className="shipment-history-summary" id={buttonId} aria-expanded={expanded} aria-controls={panelId} onClick={onToggle}>
      <span className="shipment-history-symbol"><PackageCheck size={21} strokeWidth={1.7} aria-hidden="true" /></span>
      <span className="shipment-history-destination"><strong>{shipment.lab_name || 'Laboratório não informado'}</strong><span><UserRound size={14} aria-hidden="true" />{shipment.sent_by || 'Responsável não informado'}</span></span>
      <span className="shipment-history-meta"><span className="shipment-history-time"><CalendarDays size={15} aria-hidden="true" /><time dateTime={validDate ? shipment.sent_at : undefined}>{formattedDate}{formattedTime && <span>{formattedTime}</span>}</time></span><span className="shipment-history-count">{shipment.items_count}<span> exame{shipment.items_count === 1 ? '' : 's'}</span></span></span>
      <ChevronDown size={18} className="shipment-history-chevron" aria-hidden="true" />
    </button>

    <div id={panelId} aria-labelledby={buttonId} className="shipment-history-details" hidden={!expanded}>
      {shipment.items.length > 0 ? <ul className="shipment-history-items">{shipment.items.map(item => <li key={item.id}><span className="shipment-history-item-icon"><FlaskConical size={18} aria-hidden="true" /></span><div className="shipment-history-patient"><strong>{item.pet_name || 'Pet não informado'}</strong><span>{item.client_name || 'Tutor não informado'}</span></div><span className="shipment-history-exam">{item.exam_type || 'Exame não informado'}</span></li>)}</ul>
        : <p className="shipment-history-no-items">Os detalhes dos exames não estão disponíveis neste envio.</p>}
      {shipment.notes && <div className="shipment-history-notes"><h2>Observações</h2><p>{shipment.notes}</p></div>}
    </div>
  </li>
}
