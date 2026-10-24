import { useRef, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowRight, ArrowUpDown, CalendarDays, Check, KanbanSquare, LayoutList, RefreshCw, Search, SlidersHorizontal, Trash2, X } from 'lucide-react'
import { CARD_STATUSES, STATUS_CONFIG } from '@/lib/card-constants'
import { cn } from '@/lib/utils'
import type { CardStatus } from '@/types/exam-card'
import './tracking-workspace.css'

export type TrackingViewMode = 'board' | 'table'
export type TrackingSortOrder = 'newest' | 'oldest'
interface TrackingWorkspaceProps {
  count: number
  loading: boolean
  error: unknown
  refreshing: boolean
  onRefresh: () => void
  search: string
  onSearchChange: (value: string) => void
  view: TrackingViewMode
  onViewChange: (value: TrackingViewMode) => void
  sortOrder: TrackingSortOrder
  onSortChange: (value: TrackingSortOrder) => void
  statuses: CardStatus[]
  onToggleStatus: (value: CardStatus) => void
  vet: string
  vets: { id: string; nome: string }[]
  onVetChange: (value: string) => void
  dateFrom: string
  dateTo: string
  onDateChange: (from: string, to: string) => void
  isToday: boolean
  onToggleToday: () => void
  onClearFilters: () => void
  selectedCount: number
  advanceableCount: number
  pending: boolean
  onClearSelection: () => void
  onAdvance: () => void
  onRequestDelete: () => void
  children: ReactNode
}

/** Presentation only: the page owns queries, selection and all operational actions. */
export function TrackingWorkspace(props: TrackingWorkspaceProps) {
  const { count, loading, error, refreshing, search, view, statuses, vet, dateFrom, dateTo } = props
  const filterCount = statuses.length + Number(Boolean(vet)) + Number(Boolean(dateFrom || dateTo))
  const hasFilters = Boolean(search || filterCount)
  const hasData = count > 0
  return <section className="tracking-workspace" aria-labelledby="tracking-title" aria-busy={loading}>
    <header className="tracking-heading">
      <div><h1 id="tracking-title">Rastreamento</h1><p aria-live="polite">{loading ? 'Carregando…' : error && !hasData ? 'Consulta indisponível' : `${count} ficha${count === 1 ? '' : 's'}`}</p></div>
      <div className="tracking-view-switch" role="group" aria-label="Visualização do rastreamento">
        <button type="button" aria-label="Visualizar quadro" aria-pressed={view === 'board'} onClick={() => props.onViewChange('board')}><KanbanSquare size={15} aria-hidden="true" /><span>Quadro</span></button>
        <button type="button" aria-label="Visualizar lista" aria-pressed={view === 'table'} onClick={() => props.onViewChange('table')}><LayoutList size={15} aria-hidden="true" /><span>Lista</span></button>
      </div>
    </header>

    <div className="tracking-tools">
      <label className="tracking-search"><Search size={15} aria-hidden="true" /><span className="sr-only">Buscar por pet, tutor ou veterinária</span><input type="search" aria-label="Buscar por pet, tutor ou veterinária" placeholder="Pet, tutor ou veterinária" value={search} onChange={event => props.onSearchChange(event.target.value)} />{search && <button type="button" onClick={() => props.onSearchChange('')} aria-label="Limpar busca"><X size={14} aria-hidden="true" /></button>}</label>
      <Dialog.Root>
        <Dialog.Trigger asChild><button type="button" className={cn('tracking-icon-button tracking-filter-trigger', filterCount > 0 && 'is-active')} aria-label={filterCount ? `Filtros, ${filterCount} aplicado${filterCount === 1 ? '' : 's'}` : 'Filtros'}><SlidersHorizontal size={15} aria-hidden="true" /><span className="tracking-filter-label">Filtros</span>{filterCount > 0 && <span className="tracking-filter-count">{filterCount}</span>}</button></Dialog.Trigger>
        <Dialog.Portal><Dialog.Overlay className="tracking-dialog-overlay" /><Dialog.Content className="tracking-filter-sheet" aria-describedby={undefined}>
          <header className="tracking-sheet-heading"><Dialog.Title>Filtros</Dialog.Title><Dialog.Close asChild><button type="button" className="tracking-icon-button" aria-label="Fechar filtros"><X size={16} aria-hidden="true" /></button></Dialog.Close></header>
          <div className="tracking-sheet-body">
            <fieldset><legend>Etapas</legend><div className="tracking-status-options">{CARD_STATUSES.map(status => <label key={status}><input type="checkbox" checked={statuses.includes(status)} onChange={() => props.onToggleStatus(status)} /><span className="tracking-option-check"><Check size={14} aria-hidden="true" /></span><span>{STATUS_CONFIG[status].label}</span></label>)}</div></fieldset>
            <label className="tracking-field"><span>Veterinária responsável</span><select aria-label="Veterinária responsável" value={vet} onChange={event => props.onVetChange(event.target.value)}><option value="">Toda a equipe</option>{props.vets.map(person => <option key={person.id} value={person.nome}>{person.nome}</option>)}</select></label>
            <fieldset><legend><CalendarDays size={17} aria-hidden="true" />Criação da ficha</legend><div className="tracking-date-range"><label className="tracking-field"><span>De</span><input type="date" value={dateFrom} max={dateTo || undefined} onChange={event => props.onDateChange(event.target.value, dateTo)} /></label><label className="tracking-field"><span>Até</span><input type="date" value={dateTo} min={dateFrom || undefined} onChange={event => props.onDateChange(dateFrom, event.target.value)} /></label></div><button type="button" className={cn('tracking-today', props.isToday && 'is-active')} aria-pressed={props.isToday} onClick={props.onToggleToday}>Hoje</button></fieldset>
            <label className="tracking-field"><span><ArrowUpDown size={17} aria-hidden="true" />Ordenar por tempo</span><select aria-label="Ordenar por tempo" value={props.sortOrder} onChange={event => props.onSortChange(event.target.value as TrackingSortOrder)}><option value="newest">Mais recentes</option><option value="oldest">Mais antigos</option></select></label>
          </div>
          <footer className="tracking-sheet-footer"><button type="button" className="tracking-text-button" onClick={props.onClearFilters} disabled={!hasFilters}>Limpar filtros</button><Dialog.Close asChild><button type="button" className="tracking-primary-button">Ver resultados</button></Dialog.Close></footer>
        </Dialog.Content></Dialog.Portal>
      </Dialog.Root>
      <button type="button" className="tracking-icon-button tracking-refresh" onClick={props.onRefresh} disabled={refreshing} aria-label={refreshing ? 'Atualizando rastreamento' : 'Atualizar rastreamento'}><RefreshCw size={15} aria-hidden="true" /></button>
    </div>

    {filterCount > 0 && <div className="tracking-applied-filters" aria-label="Filtros aplicados">{statuses.map(status => <button key={status} type="button" onClick={() => props.onToggleStatus(status)} aria-label={`Remover filtro ${STATUS_CONFIG[status].label}`}>{STATUS_CONFIG[status].label}<X size={14} aria-hidden="true" /></button>)}{vet && <button type="button" onClick={() => props.onVetChange('')} aria-label={`Remover filtro de ${vet}`}>{vet}<X size={14} aria-hidden="true" /></button>}{(dateFrom || dateTo) && <button type="button" onClick={() => props.onDateChange('', '')} aria-label="Remover filtro de período">Período de criação<X size={14} aria-hidden="true" /></button>}</div>}

    {props.selectedCount > 0 && <div className="tracking-bulk-bar" role="region" aria-label="Ações da seleção"><div><strong aria-live="polite">{props.selectedCount} selecionada{props.selectedCount === 1 ? '' : 's'}</strong><button type="button" className="tracking-text-button" onClick={props.onClearSelection} disabled={props.pending}>Limpar</button></div><div><button type="button" className="tracking-icon-button tracking-delete" onClick={props.onRequestDelete} disabled={props.pending} aria-label="Excluir fichas selecionadas"><Trash2 size={19} aria-hidden="true" /></button><button type="button" className="tracking-primary-button" onClick={props.onAdvance} disabled={props.pending || props.advanceableCount === 0}>Avançar ({props.advanceableCount})<ArrowRight size={18} aria-hidden="true" /></button></div></div>}

    {Boolean(error) && <div className="tracking-query-error" role="alert"><div><strong>Não foi possível {hasData ? 'atualizar' : 'carregar'} o rastreamento.</strong>{hasData && <p>Exibindo a última consulta.</p>}</div><button type="button" className="tracking-text-button" onClick={props.onRefresh} disabled={refreshing}>Tentar novamente</button></div>}
    {loading ? <div className="tracking-skeletons" role="status" aria-label="Carregando fichas">{[0, 1, 2].map(key => <div key={key}><span /><span /><span /></div>)}</div>
      : !hasData && !error ? <div className="tracking-empty"><Search size={28} strokeWidth={1.5} aria-hidden="true" /><h2>{hasFilters ? 'Nenhuma ficha encontrada' : 'Tudo em dia por aqui'}</h2><p>{hasFilters ? 'Tente outro nome ou ajuste os filtros.' : 'Novas fichas aparecerão neste rastreamento.'}</p><button type="button" className="tracking-text-button" onClick={hasFilters ? props.onClearFilters : props.onRefresh}>{hasFilters ? 'Limpar busca e filtros' : 'Atualizar'}</button></div>
        : hasData ? props.children : null}
  </section>
}

export function TrackingDeleteDialog({ open, count, loading, onConfirm, onClose }: { open: boolean; count: number; loading: boolean; onConfirm: () => void; onClose: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  return <Dialog.Root open={open} onOpenChange={value => { if (!value && !loading) onClose() }}><Dialog.Portal><Dialog.Overlay className="tracking-dialog-overlay" /><Dialog.Content role="alertdialog" className="tracking-delete-dialog" onOpenAutoFocus={event => { openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; event.preventDefault(); cancelRef.current?.focus() }} onCloseAutoFocus={event => { if (openerRef.current?.isConnected) { event.preventDefault(); openerRef.current.focus({ preventScroll: true }) } }} onPointerDownOutside={event => event.preventDefault()} onEscapeKeyDown={event => { if (loading) event.preventDefault() }}>
    <Dialog.Title>Excluir {count} ficha{count === 1 ? '' : 's'}?</Dialog.Title><Dialog.Description>Fichas ligadas a documentos serão arquivadas, preservando PDFs e histórico. As demais fichas e seus itens serão excluídos.</Dialog.Description>
    <footer><button ref={cancelRef} type="button" className="tracking-text-button" onClick={onClose} disabled={loading}>Cancelar</button><button type="button" className="tracking-danger-button" onClick={onConfirm} disabled={loading}>{loading ? 'Excluindo…' : 'Confirmar exclusão'}</button></footer>
  </Dialog.Content></Dialog.Portal></Dialog.Root>
}
