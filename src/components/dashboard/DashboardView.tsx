import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowDown, ArrowUpRight, Check, ChevronRight, CircleCheck, Clock3, FileCheck2, FlaskConical, MessageCircle, RefreshCw, Stethoscope } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ExamCard, ExamCardSummary } from '@/types/exam-card'
import { homeQueueCards, homeTimeLabel, needsHomeAttention, type HomeQueue, type HomeStage } from './home-display'
import './home.css'

export interface DashboardViewProps {
  stats?: ExamCardSummary
  summaryLoading: boolean
  summaryError: unknown
  queues: Record<HomeStage, HomeQueue>
  refreshing: boolean
  onRefresh: () => void
  onOpenCard: (card: ExamCard, opener: HTMLButtonElement) => void
}

const stages = [
  { id: 'no_grupo', label: 'No grupo', title: 'Aguardando contato', Icon: MessageCircle, total: 'total_no_grupo' },
  { id: 'exame_pronto', label: 'Prontos', title: 'Resultados disponíveis', Icon: FileCheck2, total: 'total_exame_pronto' },
  { id: 'aguardando_lab', label: 'Aguardando lab', title: 'Aguardando laboratório', Icon: FlaskConical, total: 'total_aguardando_lab' },
] as const
const batchSize = 6

function useHomeClock() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/** Presentation only: no collection, clinical state, auth or mutations here. */
export function DashboardView(props: DashboardViewProps) {
  const [stage, setStage] = useState<HomeStage>('no_grupo')
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [limit, setLimit] = useState(batchSize)
  const now = useHomeClock()
  const query = props.queues[stage]
  const active = stages.find(value => value.id === stage)!
  const cards = homeQueueCards(query.cards, stage, attentionOnly, now)
  const attentionCount = props.queues.no_grupo.cards.filter(card => needsHomeAttention(card, now)).length
  const visible = cards.slice(0, limit)
  const chooseStage = (value: HomeStage) => { setStage(value); setAttentionOnly(false); setLimit(batchSize) }

  return <section className="home-page" aria-labelledby="home-title">
    <header className="home-heading"><div><h1 id="home-title">Início</h1><p>Visão geral do rastreamento</p></div><button type="button" className="home-refresh" onClick={props.onRefresh} disabled={props.refreshing} aria-label={props.refreshing ? 'Atualizando Início' : 'Atualizar Início'}><RefreshCw size={18} aria-hidden="true" /><span>Atualizar</span></button></header>

    <div className="home-stages" role="group" aria-label="Etapas do rastreamento">
      {stages.map(({ id, label, Icon, total }) => <button type="button" key={id} aria-pressed={stage === id} className={cn('home-stage', stage === id && 'is-active')} onClick={() => chooseStage(id)}>
        <span className="home-stage-top"><span className="home-stage-icon"><Icon size={20} strokeWidth={1.7} aria-hidden="true" /></span><strong>{props.stats ? props.stats[total] : props.summaryLoading ? <span className="home-count-skeleton" aria-label="Carregando total" /> : '—'}</strong></span><span className="home-stage-label">{label}<ChevronRight size={15} aria-hidden="true" /></span>
      </button>)}
    </div>
    {Boolean(props.summaryError) && <p className="home-summary-error" role="alert">Não foi possível atualizar o resumo.{props.stats ? ' Exibindo a última consulta.' : ''}</p>}
    <Link to="/tracking" className="home-completed" aria-label="Abrir rastreamento completo e consultar contatos realizados"><span><CircleCheck size={16} aria-hidden="true" />{props.stats ? <><strong>{props.stats.total_contato_realizado}</strong> com contato realizado</> : props.summaryLoading ? 'Carregando contatos…' : 'Total de contatos indisponível'}</span><span><span className="home-total-label">Total no rastreamento</span><ArrowUpRight size={14} aria-hidden="true" /></span></Link>

    <section className="home-workspace" aria-labelledby="home-queue-title" aria-busy={query.loading}>
      <header className="home-queue-heading"><div><h2 id="home-queue-title">{active.title}</h2><p aria-live="polite">{query.loading ? 'Carregando…' : query.error && !query.cards.length ? 'Consulta indisponível' : `${cards.length} ficha${cards.length === 1 ? '' : 's'} nesta lista`}</p></div><Link className="home-text-link" aria-label={stage === 'aguardando_lab' ? 'Enviar amostras' : 'Abrir Rastreamento'} to={stage === 'aguardando_lab' ? '/ship' : '/tracking'}><span>{stage === 'aguardando_lab' ? 'Enviar amostras' : 'Rastreamento'}</span><ArrowUpRight size={16} aria-hidden="true" /></Link></header>
      <div className="home-queue-toolbar">
        {stage === 'no_grupo' ? <><button type="button" className={cn('home-attention-filter', attentionOnly && 'is-active')} aria-pressed={attentionOnly} disabled={query.loading} onClick={() => { setAttentionOnly(value => !value); setLimit(batchSize) }}><Clock3 size={16} aria-hidden="true" /><span>Mais de 24h</span><strong>{attentionCount}</strong></button><span>Mais antigos primeiro</span></>
          : <p>{stage === 'exame_pronto' ? 'Uma ficha pode ter resultados parciais.' : 'Amostras enviadas e a enviar.'}</p>}
      </div>
      {Boolean(query.error) && <div className="home-query-error" role="alert"><p>Não foi possível {query.cards.length ? 'atualizar esta lista. Exibindo a última consulta.' : 'carregar esta lista.'}</p><button type="button" onClick={props.onRefresh} disabled={props.refreshing}>Tentar novamente</button></div>}
      {query.loading ? <div className="home-skeleton-list" role="status" aria-label="Carregando fichas">{[0, 1, 2].map(id => <div key={id}><span /><span /><span /></div>)}</div>
        : cards.length ? <>
          <ul className="home-work-list">{visible.map(card => <li key={card.id}><HomeCard card={card} now={now} onOpen={props.onOpenCard} /></li>)}</ul>
          <footer className="home-list-footer"><span>{visible.length} de {cards.length} nesta lista</span>{visible.length < cards.length && <button type="button" onClick={() => setLimit(value => value + batchSize)}>Mostrar mais<ArrowDown size={16} aria-hidden="true" /></button>}</footer>
        </> : !query.error ? <div className="home-empty"><active.Icon size={28} strokeWidth={1.6} aria-hidden="true" /><h3>{attentionOnly ? 'Nenhuma ficha acima de 24h nesta lista' : 'Nenhuma ficha nesta etapa'}</h3>{attentionOnly ? <button type="button" onClick={() => { setAttentionOnly(false); setLimit(batchSize) }}>Ver todos no grupo</button> : <Link to={stage === 'aguardando_lab' ? '/ship' : '/tracking'}>{stage === 'aguardando_lab' ? 'Enviar amostras' : 'Abrir Rastreamento'}<ArrowUpRight size={16} aria-hidden="true" /></Link>}</div> : null}
    </section>
  </section>
}

function HomeCard({ card, onOpen, now }: { card: ExamCard; onOpen: DashboardViewProps['onOpenCard']; now: number }) {
  const label = card.pet_name || 'Pet não identificado'
  const exams = card.items || []
  const time = homeTimeLabel(card, now)
  const attention = needsHomeAttention(card, now)
  const labs = [...new Set(exams.map(item => item.lab_name).filter(Boolean))]

  return <button type="button" className={cn('home-card', attention && 'needs-attention')} onClick={event => onOpen(card, event.currentTarget)} aria-label={`Abrir ficha de ${label}${card.client_name ? `, tutor ${card.client_name}` : ''}`}>
    <span className="home-card-patient"><strong>{label}</strong><span>{card.client_name || 'Tutor não identificado'}</span></span>
    <span className="home-card-exams">{exams.length ? <>{exams.slice(0, 2).map(item => <span key={item.id}>{item.result_received ? <Check size={14} aria-hidden="true" /> : <span className="home-exam-dot" aria-hidden="true" />}<span>{item.exam_type}<span className="sr-only"> — {item.contacted ? 'Contato realizado' : item.result_received ? 'Resultado recebido' : 'Aguardando resultado'}</span></span></span>)}{exams.length > 2 && <span className="home-more-exams">+{exams.length - 2} exame{exams.length - 2 === 1 ? '' : 's'}</span>}</> : <span>Exame não informado</span>}{labs.length > 0 && <small>{labs.join(' · ')}</small>}</span>
    <span className="home-card-owner"><span className="home-vet"><span className="home-vet-avatar">{card.vet_avatar_url ? <img src={card.vet_avatar_url} alt="" loading="lazy" /> : <Stethoscope size={15} aria-hidden="true" />}</span>{card.vet_name || 'Sem responsável'}</span>{time && <span className={cn('home-group-time', attention && 'needs-attention')}><Clock3 size={14} aria-hidden="true" />{time}</span>}{card.is_orphan && <span className="home-unlinked">Sem venda vinculada</span>}</span>
    <ChevronRight size={18} className="home-card-arrow" aria-hidden="true" />
  </button>
}
