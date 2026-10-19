import { useId, useRef, useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Link } from 'react-router-dom'
import { ArrowRight, Check, FlaskConical, Package, Plus, RefreshCw, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { searchSamples, selectedSamples, type ManualSampleDraft, type PendingSample } from './sample-selection'
import './samples.css'

interface SamplesViewProps {
  items: PendingSample[]
  selectedIds: Set<string>
  onToggleItem: (id: string) => void
  onSelectItems: (ids: string[], selected: boolean) => void
  onClearSelection: () => void
  loading: boolean
  error: unknown
  refreshing: boolean
  onRefresh: () => void
  sentBy: string
  onSentByChange: (value: string) => void
  labName: string
  onLabNameChange: (value: string) => void
  submitting: boolean
  submitError: string | null
  onSubmit: () => Promise<boolean>
  manualSubmitting: boolean
  manualError: string | null
  onCreateManual: (draft: ManualSampleDraft) => Promise<boolean>
}

const emptyDraft: ManualSampleDraft = { petName: '', clientName: '', examType: '', labName: '' }

/** Presentation only. Sending, manual creation and eligibility belong to the page. */
export function SamplesView(props: SamplesViewProps) {
  const [search, setSearch] = useState('')
  const [reviewOpen, setReviewOpen] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [manual, setManual] = useState(emptyDraft)
  const formId = useId()
  const reviewOpenerRef = useRef<HTMLButtonElement>(null)
  const visible = searchSamples(props.items, search)
  const selected = selectedSamples(props.items, props.selectedIds)
  const visibleSelected = selectedSamples(visible, props.selectedIds)
  const hiddenCount = selected.length - visibleSelected.length
  const allVisible = visible.length > 0 && visibleSelected.length === visible.length
  const partlyVisible = visibleSelected.length > 0 && !allVisible
  const busy = props.submitting || props.manualSubmitting
  const groups = [...new Set(visible.map(item => item.card.id))].map(cardId => visible.filter(item => item.card.id === cardId))

  const openReview = (opener: HTMLButtonElement) => { reviewOpenerRef.current = opener; setReviewOpen(true) }
  const submit = async (event: FormEvent) => { event.preventDefault(); if (await props.onSubmit()) setReviewOpen(false) }
  const createManual = async (event: FormEvent) => { event.preventDefault(); if (await props.onCreateManual(manual)) { setManual(emptyDraft); setManualOpen(false) } }
  const summary = <>
    <p className="samples-summary-count"><strong>{selected.length}</strong> amostra{selected.length === 1 ? '' : 's'} selecionada{selected.length === 1 ? '' : 's'}</p>
    {selected.length ? <ul className="samples-summary-list">{selected.slice(0, 5).map(item => <li key={item.id}><strong>{item.card.pet_name || 'Pet não identificado'}</strong><span>{item.exam_type}</span></li>)}</ul> : <p className="samples-summary-empty">Selecione as amostras para preparar o envio.</p>}
    {selected.length > 5 && <p className="samples-summary-extra">+{selected.length - 5} na revisão</p>}
  </>

  return <section className={cn("samples-page", selected.length > 0 && "has-selection")} aria-labelledby="samples-title" aria-busy={props.loading}>
    <header className="samples-heading"><div><h1 id="samples-title">Enviar amostras</h1><p>{props.loading ? 'Carregando…' : props.error && !props.items.length ? 'Consulta indisponível' : `${props.items.length} pendente${props.items.length === 1 ? '' : 's'}`}</p></div>
      <Dialog.Root open={manualOpen} onOpenChange={value => { if (!busy) setManualOpen(value) }}><Dialog.Trigger asChild><button type="button" className="samples-secondary-button samples-manual-trigger" disabled={busy} aria-label="Adicionar amostra avulsa"><Plus size={19} aria-hidden="true" /><span>Avulsa</span></button></Dialog.Trigger>
        <Dialog.Portal><Dialog.Overlay className="samples-overlay" /><Dialog.Content className="samples-sheet" onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onInteractOutside={event => { if (busy) event.preventDefault() }}>
          <header className="samples-sheet-heading"><Dialog.Title>Amostra avulsa</Dialog.Title><Dialog.Close asChild><button type="button" className="samples-icon-button" disabled={busy} aria-label="Fechar amostra avulsa"><X size={20} aria-hidden="true" /></button></Dialog.Close></header>
          <Dialog.Description className="samples-sheet-description">Adicione à lista de pendentes.</Dialog.Description>
          <form onSubmit={event => { void createManual(event) }} className="samples-form"><div className="samples-sheet-body">
            {([['petName', 'Nome do pet', true], ['clientName', 'Nome do tutor', false], ['examType', 'Exame', true], ['labName', 'Laboratório', false]] as const).map(([field, label, required]) => <label key={field} className="samples-field"><span>{label}{!required && <small>Opcional</small>}</span><input aria-label={label} value={manual[field]} required={required} disabled={busy} onChange={event => setManual(previous => ({ ...previous, [field]: event.target.value }))} /></label>)}
            {props.manualError && <p className="samples-form-error" role="alert">{props.manualError}</p>}
          </div><footer className="samples-sheet-footer"><button type="submit" className="samples-primary-button" disabled={busy || !manual.petName.trim() || !manual.examType.trim()}>{props.manualSubmitting ? 'Criando…' : 'Adicionar amostra'}<Plus size={17} aria-hidden="true" /></button></footer></form>
        </Dialog.Content></Dialog.Portal>
      </Dialog.Root>
    </header>

    <div className="samples-tools"><label className="samples-search"><Search size={19} aria-hidden="true" /><span className="sr-only">Buscar amostras</span><input type="search" aria-label="Buscar amostras" placeholder="Pet, tutor, exame ou laboratório" value={search} onChange={event => setSearch(event.target.value)} />{search && <button type="button" aria-label="Limpar busca de amostras" onClick={() => setSearch('')}><X size={17} aria-hidden="true" /></button>}</label><button type="button" className="samples-icon-button" onClick={props.onRefresh} disabled={props.refreshing || busy} aria-label="Atualizar amostras"><RefreshCw size={18} aria-hidden="true" /></button></div>
    {Boolean(props.error) && <div className="samples-query-error" role="alert"><p>Não foi possível {props.items.length ? 'atualizar as amostras. Exibindo a última consulta.' : 'carregar as amostras.'}</p><button type="button" className="samples-text-button" onClick={props.onRefresh} disabled={props.refreshing}>Tentar novamente</button></div>}

    <div className="samples-layout"><div className="samples-list">
      {props.loading ? <div className="samples-skeletons" role="status" aria-label="Carregando amostras">{[0, 1, 2].map(id => <div key={id}><span /><span /><span /></div>)}</div>
        : !props.items.length && !props.error ? <div className="samples-empty"><Package size={30} strokeWidth={1.5} aria-hidden="true" /><h2>Nenhuma amostra pendente</h2><p>Novas amostras aparecerão aqui.</p><button type="button" className="samples-text-button" onClick={() => setManualOpen(true)}>Adicionar avulsa</button></div>
          : props.items.length > 0 && !visible.length ? <div className="samples-empty"><Search size={28} aria-hidden="true" /><h2>Nenhuma amostra encontrada</h2><button type="button" className="samples-text-button" onClick={() => setSearch('')}>Limpar busca</button></div>
            : <>
              {visible.length > 0 && <div className="samples-list-selection"><label className="samples-select-all"><input type="checkbox" checked={allVisible} ref={input => { if (input) input.indeterminate = partlyVisible }} aria-checked={partlyVisible ? 'mixed' : allVisible} disabled={busy} onChange={() => props.onSelectItems(visible.map(item => item.id), !allVisible)} /><span>Selecionar todas{search ? ' da busca' : ''}</span></label><span>{visible.length}</span></div>}
              {groups.map(items => <SampleGroup key={items[0].card.id} items={items} selected={props.selectedIds} disabled={busy} onToggleItem={props.onToggleItem} onSelectItems={props.onSelectItems} />)}
            </>}
    </div><aside className="samples-summary" aria-label="Resumo da seleção"><span className="samples-summary-icon"><Package size={24} strokeWidth={1.5} aria-hidden="true" /></span><h2>Próximo envio</h2>{summary}<button type="button" className="samples-primary-button" onClick={event => openReview(event.currentTarget)} disabled={!selected.length || busy}>Revisar envio<ArrowRight size={18} aria-hidden="true" /></button>{selected.length > 0 && <button type="button" className="samples-text-button" onClick={props.onClearSelection} disabled={busy}>Limpar seleção</button>}</aside></div>

    {selected.length > 0 && <div className="samples-mobile-bar"><div aria-live="polite"><strong>{selected.length} selecionada{selected.length === 1 ? '' : 's'}</strong>{hiddenCount > 0 && <span>{hiddenCount} fora da busca</span>}</div>{selected.length > 0 && <button type="button" className="samples-icon-button" aria-label="Limpar seleção de amostras" disabled={busy} onClick={props.onClearSelection}><X size={18} aria-hidden="true" /></button>}<button type="button" className="samples-primary-button" onClick={event => openReview(event.currentTarget)} disabled={!selected.length || busy}>Revisar<ArrowRight size={18} aria-hidden="true" /></button></div>}

    <Dialog.Root open={reviewOpen} onOpenChange={value => { if (!busy) setReviewOpen(value) }}><Dialog.Portal><Dialog.Overlay className="samples-overlay" /><Dialog.Content className="samples-sheet samples-review-sheet" onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onInteractOutside={event => { if (busy) event.preventDefault() }} onCloseAutoFocus={event => { if (reviewOpenerRef.current && reviewOpenerRef.current.offsetParent !== null) { event.preventDefault(); reviewOpenerRef.current.focus({ preventScroll: true }) } }}>
      <header className="samples-sheet-heading"><Dialog.Title>Revisar envio</Dialog.Title><Dialog.Close asChild><button type="button" className="samples-icon-button" disabled={busy} aria-label="Voltar à seleção"><X size={20} aria-hidden="true" /></button></Dialog.Close></header>
      <Dialog.Description className="samples-sheet-description">Confira as amostras e registre a saída para o laboratório.</Dialog.Description>
      <form id={formId} className="samples-form" onSubmit={event => { void submit(event) }}><div className="samples-sheet-body">
        <div className="samples-review-items"><strong>{selected.length} amostra{selected.length === 1 ? '' : 's'}</strong><ul>{selected.map(item => <li key={item.id}><span><strong>{item.card.pet_name || 'Pet não identificado'}</strong><span>{item.card.client_name || 'Tutor não informado'}</span></span><span>{item.exam_type}</span></li>)}</ul></div>
        <label className="samples-field"><span>Quem está enviando</span><input value={props.sentBy} onChange={event => props.onSentByChange(event.target.value)} autoComplete="name" required disabled={busy} /></label>
        <label className="samples-field"><span>Laboratório de destino<small>Opcional</small></span><input aria-label="Laboratório de destino" value={props.labName} onChange={event => props.onLabNameChange(event.target.value)} disabled={busy} /></label>
        {props.submitError && <div className="samples-form-error" role="alert"><p>{props.submitError}</p><Link to="/shipments">Conferir histórico de envios</Link></div>}
      </div><footer className="samples-sheet-footer"><button type="submit" className="samples-primary-button" disabled={busy || !selected.length || !props.sentBy.trim()}>{props.submitting ? 'Registrando…' : `Registrar envio (${selected.length})`}<Check size={18} aria-hidden="true" /></button></footer></form>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </section>
}

function SampleGroup({ items, selected, disabled, onToggleItem, onSelectItems }: { items: PendingSample[]; selected: Set<string>; disabled: boolean; onToggleItem: (id: string) => void; onSelectItems: (ids: string[], selected: boolean) => void }) {
  const card = items[0].card
  const count = items.filter(item => selected.has(item.id)).length
  const all = count === items.length
  return <article className={cn('samples-group', count > 0 && 'has-selection')}>
    <header><span className="samples-pet-icon"><FlaskConical size={21} strokeWidth={1.5} aria-hidden="true" /></span><div><h2>{card.pet_name || 'Pet não identificado'}</h2><p>{card.client_name || 'Tutor não informado'}</p></div>{card.is_orphan && <span className="samples-orphan">Avulsa</span>}<label className="samples-patient-select"><input type="checkbox" aria-label={`Selecionar amostras de ${card.pet_name || 'pet não identificado'}`} checked={all} disabled={disabled} ref={input => { if (input) input.indeterminate = count > 0 && !all }} aria-checked={count > 0 && !all ? 'mixed' : all} onChange={() => onSelectItems(items.map(item => item.id), !all)} /></label></header>
    <div className="samples-group-items">{items.map(item => <label key={item.id} className={cn('samples-item', selected.has(item.id) && 'is-selected')}><input type="checkbox" checked={selected.has(item.id)} disabled={disabled} aria-label={`Selecionar ${item.exam_type} de ${card.pet_name || 'pet não identificado'}`} onChange={() => onToggleItem(item.id)} /><span><strong>{item.exam_type}</strong><span>{item.lab_name || 'Laboratório não informado'}</span></span></label>)}</div>
  </article>
}
