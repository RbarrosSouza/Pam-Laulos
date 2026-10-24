import type { ReactNode } from 'react'
import { AlertTriangle, ArrowUpRight, CalendarDays, Cat, Check, CircleCheck, Clock3, Dog, FileCheck2, Mail, MessageCircle, ShoppingBag, Stethoscope } from 'lucide-react'
import { cn, formatDate, formatHours, getSpeciesType } from '@/lib/utils'
import { elapsedHoursForDisplay } from '@/lib/group-time'
import type { ExamCard } from '@/types/exam-card'
import { TRACKING_ORIGIN_LABELS } from './tracking-display'
import './tracking-surfaces.css'

export interface TrackingCardSurfaceProps {
  card: ExamCard
  onOpen: () => void
  selected?: boolean
  onToggleSelection?: () => void
  children?: ReactNode
  dragHandle?: ReactNode
  dragging?: boolean
  stageLabel?: string
}

export function TrackingCardSurface({ card, onOpen, selected = false, onToggleSelection, children, dragHandle, dragging = false, stageLabel }: TrackingCardSurfaceProps) {
  const petLabel = card.pet_name || 'Pet não identificado'
  const species = getSpeciesType(card.pet_species)
  const SpeciesIcon = species === 'cat' ? Cat : species === 'dog' ? Dog : FileCheck2
  const OriginIcon = card.origin === 'venda' ? ShoppingBag : card.origin === 'whatsapp' ? MessageCircle : card.origin === 'email' ? Mail : FileCheck2
  const complete = card.status === 'contato_realizado'
  const resultDate = card.items?.find((item) => item.result_received_at)?.result_received_at
  const displayDate = resultDate || card.created_at
  const shortDate = displayDate ? new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' }).format(new Date(displayDate)) : null
  const labs = [...new Set((card.items || []).map((item) => item.lab_name).filter(Boolean))]
  const progress = card.items_total > 0 ? Math.min(100, Math.max(0, (card.items_ready / card.items_total) * 100)) : 0
  const elapsedHours = elapsedHoursForDisplay(card)
  const slaClass = card.status === 'no_grupo'
    ? elapsedHours >= 48 ? 'sla-critical' : elapsedHours >= 24 ? 'sla-warning' : 'sla-normal'
    : 'sla-neutral'

  return (
    <article className={cn('tracking-card', selected && 'is-selected', dragging && 'is-dragging', !complete && card.alert_level !== 'normal' && 'needs-attention')}>
      <div className="tracking-card-top">
        <button type="button" onClick={onOpen} className="tracking-card-open" aria-label={`Abrir exame de ${petLabel}${card.client_name ? `, tutor ${card.client_name}` : ''}`}>
          <span className="tracking-card-species"><SpeciesIcon size={14} aria-hidden="true" /></span>
          <span className="tracking-card-identity">
            <strong>{petLabel}</strong>
            <span>{card.client_name || 'Tutor não identificado'}</span>
          </span>
          <ArrowUpRight size={13} className="tracking-card-arrow" aria-hidden="true" />
        </button>
          {onToggleSelection && (
            <label className="tracking-selection" title={`Selecionar ${petLabel}`}>
              <input type="checkbox" checked={selected} onChange={onToggleSelection} aria-label={`Selecionar ${petLabel}`} />
            </label>
          )}
      </div>
      {stageLabel && <p className={cn('tracking-card-stage', complete && 'is-complete')}>{stageLabel}</p>}
      <div className="tracking-card-items">
        {children ?? (
          card.items?.length ? <ul className="tracking-readonly-items">
            {card.items.map((item) => (
              <li key={item.id}>
                {item.contacted ? <CircleCheck size={13} aria-hidden="true" /> : item.result_received ? <Check size={13} aria-hidden="true" /> : <span className="tracking-item-waiting" aria-hidden="true" />}
                <span>{item.exam_type}<span className="sr-only"> — {item.contacted ? 'Contato realizado' : item.result_received ? 'Resultado recebido' : 'Aguardando resultado'}</span></span>
              </li>
            ))}
          </ul> : <p className="tracking-card-no-items">Nenhum exame informado</p>
        )}
        {labs.length > 0 && <p className="tracking-card-labs">{labs.join(' · ')}</p>}
      </div>
      <div className="tracking-card-vet">
        <span className="tracking-vet-avatar">
          {card.vet_avatar_url ? <img src={card.vet_avatar_url} alt="" loading="lazy" /> : <Stethoscope size={12} aria-hidden="true" />}
        </span>
        <span>{card.vet_name || 'Sem responsável'}</span>
      </div>
      {card.items_total > 0 && (
        <div className="tracking-card-progress">
          <span>Resultados</span>
          <progress value={progress} max={100} aria-label={`${card.items_ready} de ${card.items_total} resultados recebidos`} />
          <span className="tabular-nums">{card.items_ready}/{card.items_total}</span>
        </div>
      )}
      <div className="tracking-card-footer">
        <span title={`Origem: ${TRACKING_ORIGIN_LABELS[card.origin]}`}><OriginIcon size={12} aria-hidden="true" />{TRACKING_ORIGIN_LABELS[card.origin]}</span>
        {shortDate && <span title={resultDate ? 'Resultado recebido em' : 'Criado em'}><CalendarDays size={12} aria-hidden="true" />{resultDate ? 'Recebido' : 'Criado'} {shortDate}</span>}
        {dragHandle}
      </div>
      {card.is_orphan && <p className="tracking-card-orphan"><AlertTriangle size={12} aria-hidden="true" />Sem venda</p>}
      {complete ? !stageLabel && <p className="tracking-card-complete"><CircleCheck size={13} aria-hidden="true" />Contato realizado</p> : (
        <p className={cn('tracking-card-time', slaClass)} title={card.status === 'no_grupo' && card.group_sent_at ? `No grupo desde ${formatDate(card.group_sent_at)}` : 'Tempo desde a criação'}>
          <span className="tracking-sla-dot" aria-hidden="true" />
          <Clock3 size={12} aria-hidden="true" /><span className="tabular-nums">{formatHours(elapsedHours)}</span> {card.status === 'no_grupo' ? 'no grupo' : 'em aberto'}
        </p>
      )}
    </article>
  )
}
