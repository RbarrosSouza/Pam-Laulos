import { AlertTriangle, ArrowUpRight, CircleCheck, Clock3, Search, Stethoscope } from 'lucide-react'
import { cn, formatDate, formatHours } from '@/lib/utils'
import { elapsedHoursForDisplay } from '@/lib/group-time'
import type { ExamCard } from '@/types/exam-card'
import { TrackingCardSurface } from './TrackingCardSurface'
import { TRACKING_ORIGIN_LABELS, TRACKING_STAGE_LABELS } from './tracking-display'
import './tracking-surfaces.css'

interface TrackingTableProps {
  cards?: ExamCard[]
  onSelectCard: (card: ExamCard) => void
  isLoading?: boolean
  selectedIds: Set<string>
  onToggleSelection: (cardId: string) => void
  onToggleAllSelection: () => void
}

export function TrackingTable({ cards = [], onSelectCard, isLoading, selectedIds, onToggleSelection, onToggleAllSelection }: TrackingTableProps) {
  const selectedCount = cards.filter((card) => selectedIds.has(card.id)).length
  const allSelected = cards.length > 0 && selectedCount === cards.length
  const someSelected = selectedCount > 0 && !allSelected
  return (
    <div className="tracking-table-view">
      <div className="tracking-table-selection">
        <label className="tracking-selection">
          <input type="checkbox" checked={allSelected} disabled={!cards.length || isLoading} onChange={onToggleAllSelection} aria-label="Selecionar todos os exames da tabela" aria-checked={someSelected ? 'mixed' : allSelected}
            ref={(input) => { if (input) input.indeterminate = someSelected }} />
          <span>Selecionar todas</span>
        </label>
      </div>
      {isLoading ? <div className="tracking-table-skeleton" role="status" aria-label="Carregando rastreamento">{[1, 2, 3].map((item) => <div key={item}><span /><span /><span /></div>)}</div> : !cards.length ? (
        <div className="tracking-table-empty"><Search size={26} aria-hidden="true" /><h2>Nenhum exame encontrado</h2><p>Tente outro nome ou ajuste os filtros acima.</p></div>
      ) : <>
        <table className="tracking-table">
          <caption className="sr-only">Atendimentos e etapas do rastreamento de exames</caption>
          <thead><tr><th scope="col"><span className="sr-only">Selecionar</span></th><th scope="col">Paciente</th><th scope="col">Exames</th><th scope="col">Responsável</th><th scope="col">Etapa</th></tr></thead>
          <tbody>{cards.map((card) => {
            const labs = [...new Set(card.items.map((item) => item.lab_name).filter(Boolean))]
            const complete = card.status === 'contato_realizado'
            const elapsedHours = elapsedHoursForDisplay(card)
            const slaClass = card.status === 'no_grupo'
              ? elapsedHours >= 48 ? 'sla-critical' : elapsedHours >= 24 ? 'sla-warning' : 'sla-normal'
              : 'sla-neutral'
            return <tr key={card.id} className={cn(selectedIds.has(card.id) && 'is-selected')}>
              <td><label className="tracking-selection"><input type="checkbox" checked={selectedIds.has(card.id)} onChange={() => onToggleSelection(card.id)} aria-label={`Selecionar ${card.pet_name || 'pet não identificado'}`} /></label></td>
              <td><button type="button" className="tracking-table-patient" onClick={() => onSelectCard(card)} aria-label={`Abrir exame de ${card.pet_name || 'pet não identificado'}`}><strong>{card.pet_name || 'Pet não identificado'}</strong><span>{card.client_name || 'Tutor não identificado'}</span><ArrowUpRight size={13} aria-hidden="true" /></button><span className="tracking-table-meta">{TRACKING_ORIGIN_LABELS[card.origin]}</span>{card.is_orphan && <span className="tracking-table-orphan"><AlertTriangle size={12} aria-hidden="true" />Sem venda</span>}</td>
              <td><ul className="tracking-table-exams">{card.items.map((item) => <li key={item.id}>{item.exam_type}</li>)}</ul>{labs.length > 0 && <span className="tracking-table-meta">{labs.join(' · ')}</span>}<span className="tracking-table-meta tabular-nums">{card.items_ready}/{card.items_total} resultados</span></td>
              <td><span className="tracking-table-vet">{card.vet_avatar_url ? <img src={card.vet_avatar_url} alt="" loading="lazy" /> : <Stethoscope size={13} aria-hidden="true" />}<span>{card.vet_name || 'Sem responsável'}</span></span><span className="tracking-table-meta">Criado em {formatDate(card.created_at)}</span></td>
              <td><span className={cn('tracking-table-stage', complete && 'is-complete')}>{complete && <CircleCheck size={13} aria-hidden="true" />}{TRACKING_STAGE_LABELS[card.status]}</span>{!complete && <span className={cn('tracking-table-time tabular-nums', slaClass)} title={card.status === 'no_grupo' && card.group_sent_at ? `No grupo desde ${formatDate(card.group_sent_at)}` : 'Tempo desde a criação'}><span className="tracking-sla-dot" aria-hidden="true" /><Clock3 size={12} aria-hidden="true" />{formatHours(elapsedHours)} {card.status === 'no_grupo' ? 'no grupo' : 'em aberto'}</span>}</td>
            </tr>
          })}</tbody>
        </table>
        <div className="tracking-table-mobile">{cards.map((card) => <TrackingCardSurface key={card.id} card={card} stageLabel={TRACKING_STAGE_LABELS[card.status]} onOpen={() => onSelectCard(card)} selected={selectedIds.has(card.id)} onToggleSelection={() => onToggleSelection(card.id)} />)}</div>
      </>}
    </div>
  )
}
