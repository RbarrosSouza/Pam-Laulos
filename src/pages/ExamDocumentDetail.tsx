import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, CalendarDays, Check, ChevronDown, ChevronRight, Clock3, Copy, FileText, History, Link2, Loader2, Mail, MoreVertical, Phone, Settings2, Trash2, UserRound, UserRoundPlus, X } from 'lucide-react'
import { WhatsappLogo } from '@phosphor-icons/react/dist/csr/WhatsappLogo'
import { toast } from 'sonner'
import { useExamAuth } from '@/contexts/exam-auth'
import { useDocumentAction, useExamDocument } from '@/hooks/useExamDocuments'
import { useVets, type Vet } from '@/hooks/useVets'
import { DocumentCorrection, DocumentGroupConfirmation, DocumentProvenance } from '@/components/documents/DocumentControls'
import { DocumentDelete } from '@/components/documents/DocumentDelete'
import { DocumentNexusRetry } from '@/components/documents/DocumentNexusRetry'
import { DocumentForm, DocumentHistory, DocumentPreview, DocumentSteps } from '@/components/documents/ExamDocumentPanels'
import { ExamDetailSheet } from '@/components/documents/ExamDetailSheet'
import { DocumentVersionReview } from '@/components/documents/DocumentVersionReview'
import { documentDisplayId, documentLabel } from '@/lib/document-status'
import { getExamDetailProgress } from '@/lib/exam-detail-progress'
import { ExamCompletion } from '@/components/documents/ExamCompletion'
import { groupLabels, type Original } from '@/lib/document-version-review'
import type { ExamDocument } from '@/types/exam-document'
import '@fontsource/manrope/latin-800.css'
import '@fontsource/dm-sans/latin-400.css'
import '@fontsource/dm-sans/latin-500.css'
import '@fontsource/dm-sans/latin-600.css'
import './exam-document-detail.css'
import './exam-document-workspace.css'

type Panel = 'responsible' | 'contact' | 'patient' | 'pdf' | 'more' | 'identity' | 'steps' | 'history' | 'delete' | null
const panelTitles: Record<Exclude<Panel, null>, string> = {
  responsible: 'Responsável pelo exame', contact: 'Contato com o tutor', patient: 'Adicionar exame ao cadastro',
  delete: 'Excluir ficha', pdf: 'PDF do exame', more: 'Opções do exame', identity: 'Dados do exame', steps: 'Etapas e pendências', history: 'Histórico do exame',
}
function displayDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value === '—' ? 'Data a conferir' : value
}

export function ExamDocumentContent({ doc, refresh }: { doc: ExamDocument; refresh: () => Promise<unknown> }) {
  const auth = useExamAuth()
  const action = useDocumentAction()
  const vets = useVets()
  const location = useLocation()
  const [searchParams] = useSearchParams()

  const fromState = (location.state as { from?: string } | null)?.from
  const fromParam = searchParams.get('from')
  const backTarget = fromState || (fromParam === 'home' ? '/' : fromParam === 'tracking' ? '/tracking' : '/novos-exames')
  const backLabel = backTarget === '/' ? 'Voltar para Início' : backTarget === '/tracking' ? 'Voltar para Rastreamento' : 'Voltar para Novos exames'

  const requestedPanel = searchParams.get('panel')
  const initialPanel = requestedPanel && Object.hasOwn(panelTitles, requestedPanel) ? requestedPanel as Panel : null
  const [panel, setPanel] = useState<Panel>(['patient', 'identity', 'pdf'].includes(initialPanel || '') ? null : initialPanel)
  const [workspaceOpen, setWorkspaceOpen] = useState(['patient', 'identity', 'pdf'].includes(initialPanel || ''))
  const [editorMode, setEditorMode] = useState<'patient' | 'identity'>(initialPanel === 'identity' ? 'identity' : 'patient')
  const [editorMounted, setEditorMounted] = useState(['patient', 'identity', 'pdf'].includes(initialPanel || ''))
  const [pdf, setPdf] = useState<Original | null>(initialPanel === 'pdf' ? { document_id: doc.id, original_name: doc.original_name, file_status: doc.file_status, group_status: doc.group_status, sha256: null } : null)
  const [originals, setOriginals] = useState<Original[]>([])
  const [filesExpanded, setFilesExpanded] = useState(false)
  const [mobileTab, setMobileTab] = useState<'card' | 'pdf' | 'form'>(initialPanel === 'pdf' ? 'pdf' : 'form')
  const editorHeading = useRef<HTMLHeadingElement>(null)
  const cardAction = useRef<HTMLButtonElement>(null)
  const editorOpener = useRef<HTMLElement | null>(null)
  const [completionOpen, setCompletionOpen] = useState(false)
  const [completionDocument, setCompletionDocument] = useState<ExamDocument | null>(null)
  const [contactWriteAcknowledged, setContactWriteAcknowledged] = useState(false)
  const cardContainer = useRef<HTMLDivElement>(null)
  const pdfHeading = useRef<HTMLButtonElement>(null)
  const completionDismissed = useRef(false)
  const contactPending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const openEditor = (mode: 'patient' | 'identity' = 'patient') => {
    if (!workspaceOpen) editorOpener.current = document.activeElement as HTMLElement
    setEditorMounted(true); setEditorMode(mode); setWorkspaceOpen(true); setPanel(null); setMobileTab('form')
    requestAnimationFrame(() => { cardContainer.current?.scrollTo({ top: 0 }); editorHeading.current?.focus({ preventScroll: true }) })
  }
  const openPdf = (original?: Original, list?: Original[]) => {
    if (list) setOriginals(list)
    if (!workspaceOpen) editorOpener.current = document.activeElement as HTMLElement
    setPdf(original || { document_id: doc.id, original_name: doc.original_name, file_status: doc.file_status, group_status: doc.group_status, sha256: null })
    setWorkspaceOpen(true); setEditorMounted(true); setPanel(null); setMobileTab('pdf')
    requestAnimationFrame(() => pdfHeading.current?.focus({ preventScroll: true }))
  }
  const openPanel = (target: Panel) => {
    if (target === 'patient' || target === 'identity') openEditor(target)
    else if (target === 'pdf') openPdf()
    else setPanel(target)
  }
  const closeEditor = () => {
    setWorkspaceOpen(false); setPdf(null); setMobileTab('card')
    requestAnimationFrame(() => (editorOpener.current?.isConnected ? editorOpener.current : cardAction.current)?.focus({ preventScroll: true }))
  }
  const [deleting, setDeleting] = useState(false)
  const [savingVetId, setSavingVetId] = useState<string | null>(null)
  const [isSavingContact, setIsSavingContact] = useState(false)
  const assignmentPending = useRef(false)
  const [now, setNow] = useState(Date.now)
  const progress = getExamDetailProgress(doc, now)
  const isContactDone = progress.contactCompleted
  const nexusFailed = !progress.nexusLinked && doc.deliveries.some(delivery => delivery.destination === 'nexus' && delivery.status === 'failed')

  useEffect(() => {
    if (doc.group_status !== 'sent' || doc.contact_status === 'completed' || doc.completed) return
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [doc.group_status, doc.contact_status, doc.completed])
  const user = auth.session?.user
  const ownName = user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email || 'Você'
  const responsibleVet = doc.responsible_vet_id ? vets.data?.find(vet => vet.id === doc.responsible_vet_id) : undefined
  const responsible = doc.responsible_vet_id
    ? doc.responsible_vet_name || responsibleVet?.nome || 'Veterinária definida'
    : doc.assigned_to === user?.id && doc.assigned_to ? ownName : doc.assigned_name || (doc.assigned_to ? 'Responsável definido' : 'Selecionar responsável')
  const responsibleAvatar = doc.responsible_vet_id ? doc.responsible_vet_avatar_url || responsibleVet?.avatar_url : null
  const contactAllowed = auth.role === 'admin' || auth.role === 'vet'
  const pet = documentLabel(doc, 'pet_name')
  const tutor = documentLabel(doc, 'client_name')
  const close = () => setPanel(null)
  const assign = async (vet: Vet) => {
    if (!user || action.isPending || assignmentPending.current || vet.id === doc.responsible_vet_id) return
    assignmentPending.current = true
    setSavingVetId(vet.id)
    try {
      await action.mutateAsync({ name: 'set_exam_document_responsible_vet', args: { p_document_id: doc.id, p_veterinarian_id: vet.id, p_expected_version: doc.version } })
      await refresh()
      toast.success('Responsável salvo.')
      setPanel(current => current === 'responsible' ? null : current)
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Não foi possível salvar o responsável.') }
    finally { assignmentPending.current = false; setSavingVetId(null) }
  }
  const copyLink = () => navigator.clipboard.writeText(`${window.location.origin}/novos-exames/${doc.id}`).then(() => toast.success('Link copiado.')).catch(() => toast.error('Não foi possível copiar o link.'))

  const showSavedContact = async () => {
    setContactWriteAcknowledged(true)
    try {
      const result = await refresh() as { data?: ExamDocument; error?: unknown }
      if (!result?.data || result.data.id !== doc.id || result.error) throw new Error('refresh')
      if (mounted.current) { setContactWriteAcknowledged(false); setCompletionDocument(result.data); setCompletionOpen(!completionDismissed.current); setPanel(current => current === 'contact' ? null : current) }
    } catch {
      // The write succeeded; do not invite a duplicate registration on read failure.
      if (mounted.current) { setCompletionOpen(false); setPanel(current => current === 'contact' ? null : current); toast.success('Contato salvo. Atualize a ficha para conferir as etapas.') }
    }
  }
  const handleDirectContact = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (isContactDone || contactWriteAcknowledged || isSavingContact || action.isPending || contactPending.current) return
    if (!contactAllowed || doc.file_status !== 'saved' || !doc.pet_id) { setPanel('contact'); return }
    const itemIds = doc.items.filter(item => !item.contacted_at).map(item => item.exam_item_id || item.item_id).filter((id): id is string => Boolean(id))
    if (!itemIds.length) { setPanel('contact'); return }
    contactPending.current = true
    completionDismissed.current = false
    setIsSavingContact(true); setCompletionDocument(null); setCompletionOpen(true)
    try {
      await action.mutateAsync({ name: 'record_exam_document_contact', args: { p_document_id: doc.id, p_item_ids: itemIds, p_channel: 'whatsapp', p_note: null, p_contacted_at: new Date().toISOString() } })
      await showSavedContact()
    } catch (error) {
      if (mounted.current) { setCompletionOpen(false); toast.error(error instanceof Error ? error.message : 'Não foi possível registrar o contato.') }
    } finally {
      contactPending.current = false
      if (mounted.current) setIsSavingContact(false)
    }
  }

  const origin = progress.originChannel === 'email'
    ? { label: 'E-mail', description: 'Recebido por e-mail', icon: Mail }
    : progress.originChannel === 'whatsapp'
      ? { label: 'WhatsApp', description: 'Recebido pelo WhatsApp', icon: WhatsappLogo }
      : { label: progress.originChannel === 'manual' ? 'Manual' : 'Origem', description: progress.originReceived ? 'Recebido por envio manual' : 'Recebimento não registrado', icon: FileText }
  const stages = [
    { ...origin, done: progress.originReceived, panel: 'history' as const },
    { label: 'Grupo', description: progress.groupSent ? 'Enviado ao grupo de WhatsApp' : 'Envio ao grupo ainda não confirmado', done: progress.groupSent, icon: WhatsappLogo, panel: 'steps' as const },
    { label: 'Cadastro', description: progress.nexusLinked ? 'Exame anexado ao cadastro' : nexusFailed ? 'Falha ao anexar ao cadastro. Tentar novamente.' : 'Exame ainda não anexado ao cadastro', done: progress.nexusLinked, icon: Link2, panel: 'patient' as const },
    { label: 'Contato', description: isContactDone ? 'Contato com tutor concluído' : 'Contato com tutor pendente', done: isContactDone, icon: Phone, panel: 'contact' as const },
  ]
  return <div className="exam-detail-page exam-workspace-page">
    <header className="workspace-top"><span className="workspace-brand"><span><FileText size={22}/></span>Pam Laudos</span><button className="exam-detail-icon-button" aria-label="Opções do exame" onClick={() => openPanel('more')}><MoreVertical size={24}/></button></header>
    <div className="workspace-page"><nav className="workspace-crumb" aria-label="Navegação da ficha"><Link to={backTarget}><ArrowLeft size={18}/>{backLabel.replace('Voltar para ', '')}</Link><span>/</span><span>Ficha do exame</span><small>{documentDisplayId(doc.id)}</small></nav>
    {workspaceOpen && <nav className="workspace-tabs" aria-label="Áreas da ficha"><button aria-pressed={mobileTab === 'card'} onClick={() => { setMobileTab('card'); setPdf(null) }}>Ficha</button><button aria-pressed={mobileTab === 'pdf'} onClick={() => openPdf()}>PDF</button><button aria-pressed={mobileTab === 'form'} onClick={() => setMobileTab('form')}>Preencher</button></nav>}
    <div className={`exam-workspace${workspaceOpen ? ' split' : ''}${filesExpanded ? ' files-expanded' : ''}`} data-mobile={mobileTab}>
    <div className="workspace-left" hidden={false}>
    <div ref={cardContainer} className="exam-detail-container" hidden={!!pdf}>
      <main className="exam-detail-main">
        <section className="exam-detail-identity" aria-label="Identificação do exame">
          <div className="workspace-cardtop"><p className="exam-detail-type">{documentLabel(doc, 'exam_type') === '—' ? 'Exame recebido' : documentLabel(doc, 'exam_type')}</p><span className={`workspace-pill${progress.nexusLinked ? ' green' : ''}`}>{doc.completed ? 'Card completo' : progress.nexusLinked ? 'Anexado ao cadastro' : doc.pet_id ? 'Anexação em andamento' : 'Selecionar cadastro'}</span></div>
          <h1>{pet === '—' ? 'Pet a identificar' : pet}</h1>
          <p className="exam-detail-tutor">{tutor === '—' ? 'Tutor a identificar' : tutor}</p>
          <div className="exam-detail-meta">
            <span><CalendarDays size={25} aria-hidden="true" />{displayDate(documentLabel(doc, 'exam_date'))}</span>
            <button onClick={() => openPanel('pdf')}><FileText size={25} aria-hidden="true" />Abrir PDF</button>
          </div>
        </section>
        <DocumentVersionReview key={doc.id} documentId={doc.id} onOpenOriginal={openPdf} onExpandedChange={setFilesExpanded} onOriginalsChange={setOriginals}/>
        <DocumentNexusRetry key={`nexus-retry:${doc.id}`} doc={doc} onReview={() => openPanel('patient')} />
        <button className="exam-detail-responsible" onClick={() => openPanel('responsible')} aria-haspopup="dialog">
          <span className="exam-detail-row-copy"><span className="exam-detail-field-label">Responsável</span><strong>{responsible}</strong></span>
          <span className="exam-detail-responsible-icon" aria-hidden="true">{responsibleAvatar ? <img className="exam-detail-responsible-photo" src={responsibleAvatar} alt="" /> : <UserRound size={29} />}<ChevronDown size={15} /></span>
        </button>
        <div className={`exam-detail-contact${isContactDone ? ' is-complete' : ''}`}>
          <button
            type="button"
            className="exam-detail-contact-btn"
            onClick={() => openPanel('contact')}
            aria-haspopup="dialog"
            aria-label={isContactDone ? 'Contato realizado. Ver registro' : 'Registrar contato com o tutor'}
          >
            <span className="exam-detail-row-copy">
              <span className="exam-detail-field-label">Contato com o tutor</span>
              <strong>
                {isSavingContact
                  ? 'Salvando contato…'
                  : isContactDone
                    ? 'Entrei em contato'
                    : progress.contactedCount
                      ? `${progress.contactedCount} de ${progress.itemCount} exames`
                      : 'A realizar'}
              </strong>
            </span>
          </button>
          {isContactDone ? (
            <button
              type="button"
              className="exam-detail-contact-check is-checked"
              onClick={() => openPanel('contact')}
              aria-label="Contato realizado. Ver registro"
            >
              <Check size={21} strokeWidth={2.5} />
            </button>
          ) : (
            <button
              type="button"
              className={`exam-detail-contact-check-btn${isSavingContact ? ' is-loading' : ''}`}
              onClick={handleDirectContact}
              disabled={isSavingContact || contactWriteAcknowledged || !contactAllowed || doc.file_status !== 'saved'}
              title={isSavingContact ? 'Salvando contato...' : 'Marcar contato como concluído'}
              aria-label={isSavingContact ? 'Salvando contato...' : 'Concluir contato com o tutor'}
            >
              {isSavingContact ? (
                <Loader2 size={19} className="animate-spin text-[var(--olive)]" />
              ) : (
                <Check size={18} strokeWidth={2.2} />
              )}
            </button>
          )}
        </div>
        {contactWriteAcknowledged && !isSavingContact && <p className="fine" role="status">Contato salvo. <button className="textbtn" onClick={() => void showSavedContact()}>Atualizar ficha</button></p>}
        <section className="exam-detail-progress" aria-label="Progresso do exame">
          <ul>{stages.map(({ label, description, done, icon: Icon, panel: target }) => <li key={label}><button title={description} aria-label={description} onClick={() => openPanel(target)}><span className={`exam-detail-stage-icon${done ? ' is-done' : ''}${label === 'Cadastro' && nexusFailed ? ' is-failed' : ''}${label === 'Contato' ? done ? ' contact-done' : ' contact-pending' : ''}`}><Icon size={23} aria-hidden="true" />{done && <span className="exam-detail-stage-check"><Check size={10} strokeWidth={3} /></span>}</span><span>{label}</span></button></li>)}</ul>
          <p className={`exam-detail-progress-caption${(doc.completed || isContactDone) ? ' is-complete' : ''}`} role="status">{(doc.completed || isContactDone) ? <Check size={15} /> : progress.groupAgeLabel ? <Clock3 size={14} /> : null}{isContactDone && !progress.groupAgeLabel ? doc.completed ? 'Card completo' : 'Contato concluído' : (progress.groupAgeLabel || progress.summary)}</p>
        </section>
      </main>
      <footer className="exam-detail-footer"><button ref={cardAction} className="exam-detail-primary" onClick={() => openPanel('patient')}><UserRoundPlus size={25} /><span>{progress.nexusLinked ? 'Ver exame no cadastro' : doc.pet_id ? 'Acompanhar cadastro' : 'Adicionar exame ao cadastro'}</span><ChevronRight size={21} /></button></footer>
    </div>
    {pdf && <section className="workspace-pdf" aria-label="Consulta ao PDF"><header className="pdfbar"><button ref={pdfHeading} className="textbtn" onClick={() => { setPdf(null); setMobileTab('card') }}><ArrowLeft size={16}/>Voltar à ficha</button><strong>PDF do exame</strong></header>
      {originals.length > 0 && <div className="pdf-originals"><div className="file-segments">{originals.map((original, index) => <button key={original.document_id} disabled={original.file_status !== 'saved'} aria-pressed={pdf.document_id === original.document_id} onClick={() => setPdf(original)}>{index === 0 ? 'Atual' : 'Anterior'}</button>)}</div><span className={pdf.group_status === 'sent' ? 'sent' : 'pending'}>{groupLabels[pdf.group_status] || 'Envio a conferir'}</span></div>}
      <DocumentPreview key={pdf.document_id} doc={{ id: pdf.document_id, original_name: pdf.original_name, drive_name: pdf.document_id === doc.id ? doc.drive_name : null }}/>
    </section>}
    </div>
    <aside className="workspace-editor" inert={!workspaceOpen} aria-hidden={!workspaceOpen} aria-label="Preenchimento do cadastro" onKeyDown={event => { if (event.key === 'Escape') closeEditor() }}>
      <header className="editor-head"><div><h2 tabIndex={-1} ref={editorHeading}>{editorMode === 'identity' ? 'Dados do exame' : progress.nexusLinked ? 'Exame no cadastro' : doc.pet_id ? 'Cadastro identificado' : 'Adicionar ao cadastro'}</h2><p className="sub">{progress.nexusLinked ? 'Informações salvas no PAM Nexus.' : 'Selecione o paciente e confira o exame.'}</p></div><button className="icon-btn" aria-label="Recolher preenchimento" onClick={closeEditor}><X size={18}/></button></header>
      {editorMounted && <DocumentForm key={`${doc.id}:${editorMode}`} doc={doc} mode={editorMode} compact onOpenPdf={() => openPdf()}/>}
    </aside>
    </div></div>
    {completionOpen && <ExamCompletion document={completionDocument} onClose={() => { completionDismissed.current = true; setCompletionOpen(false) }}/>}
    <ExamDetailSheet open={panel !== null} onOpenChange={open => { if (!open && !deleting) close() }} title={panel ? panelTitles[panel] : ''}>
      {panel === 'responsible' && <div className="exam-detail-team">
        {doc.responsible_vet_source === 'conflict' && !doc.responsible_vet_id && <p className="exam-detail-hint">Responsável a conferir. Selecione uma veterinária da equipe.</p>}
        {vets.isLoading ? <p className="exam-detail-hint flex items-center gap-2" role="status"><Loader2 size={20} className="animate-spin" />Carregando equipe…</p> : vets.error ? <div role="alert"><p className="exam-detail-hint">Não foi possível carregar a equipe.</p><button className="exam-detail-primary" onClick={() => void vets.refetch()}>Tentar novamente</button></div> : !vets.data?.length ? <p className="exam-detail-hint" role="status">Nenhuma veterinária ativa disponível.</p> : <ul className="exam-detail-team-list" aria-label="Veterinárias ativas">{vets.data.map(vet => {
          const selected = doc.responsible_vet_id === vet.id
          return <li key={vet.id}><button className={`exam-detail-vet${selected ? ' is-selected' : ''}`} aria-pressed={selected} disabled={action.isPending || savingVetId !== null || selected} onClick={() => void assign(vet)}>
            <span className="exam-detail-avatar" aria-hidden="true">{vet.avatar_url ? <img src={vet.avatar_url} alt="" /> : <UserRound size={27} />}</span>
            <span><strong>{vet.nome}</strong><small>{selected ? 'Responsável atual' : doc.responsible_vet_id || doc.assigned_to ? 'Definir como responsável' : 'Assumir este exame'}</small></span>
            {savingVetId === vet.id ? <Loader2 size={21} className="animate-spin" aria-label="Salvando responsável" /> : selected ? <Check size={22} aria-hidden="true" /> : <ChevronRight size={20} aria-hidden="true" />}
          </button></li>
        })}</ul>}
      </div>}
      {panel === 'contact' && (isContactDone ? <DocumentProvenance doc={doc} /> : contactWriteAcknowledged ? <p role="status">Contato salvo. Atualize a ficha para conferir as etapas.</p> : !contactAllowed ? <p className="exam-detail-hint">O registro de contato é feito por uma veterinária ou pela gestão.</p> : !doc.pet_id && !isContactDone ? <div className="exam-detail-empty"><UserRoundPlus size={35} /><h3>Confirme o paciente primeiro</h3><p>Selecione o cadastro para registrar o contato com o tutor correto.</p><button className="exam-detail-primary" onClick={() => openPanel('patient')}>Selecionar paciente<ChevronRight size={20} /></button></div> : <DocumentForm key={`${doc.id}:contact`} doc={doc} mode="contact" onContactSaved={async () => { completionDismissed.current = false; setCompletionDocument(null); await showSavedContact() }} />)}
      {panel === 'steps' && <div className="space-y-4"><DocumentSteps doc={doc} /><DocumentGroupConfirmation doc={doc} /></div>}
      {panel === 'history' && <div className="space-y-4"><DocumentProvenance doc={doc} /><DocumentHistory id={doc.id} /></div>}
      {panel === 'more' && <div className="exam-detail-options">
        <button onClick={() => openPanel('identity')}><Settings2 size={21} />Conferir dados do exame<ChevronRight size={18} /></button>
        <button onClick={() => openPanel('steps')}><Link2 size={21} />Etapas e pendências<ChevronRight size={18} /></button>
        <button onClick={() => openPanel('history')}><History size={21} />Histórico e origem<ChevronRight size={18} /></button>
        <button onClick={() => void copyLink()}><Copy size={21} />Copiar link do exame</button>
        <button className="exam-detail-delete-option" onClick={() => openPanel('delete')}><Trash2 size={21} />Excluir ficha<ChevronRight size={18} /></button>
        <details><summary>Versão corrigida</summary>{doc.previous_document_id ? <p>Original preservado: <Link to={`/novos-exames/${doc.previous_document_id}`} onClick={close}>{documentDisplayId(doc.previous_document_id)}</Link></p> : <DocumentCorrection doc={doc} />}</details>
        <p className="exam-detail-reference">{documentDisplayId(doc.id)} · recebido em {new Date(doc.received_at).toLocaleString('pt-BR')}</p>
      </div>}
      {panel === 'delete' && <DocumentDelete doc={doc} backTarget={backTarget} onCancel={() => setPanel('more')} onPendingChange={setDeleting} />}

    </ExamDetailSheet>
  </div>
}

export function ExamDocumentDetail() {
  const { documentId = '' } = useParams()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const fromState = (location.state as { from?: string } | null)?.from
  const fromParam = searchParams.get('from')
  const backTarget = fromState || (fromParam === 'home' ? '/' : fromParam === 'tracking' ? '/tracking' : '/novos-exames')
  const backTitle = backTarget === '/' ? 'Início' : backTarget === '/tracking' ? 'Rastreamento' : 'Novos exames'

  const validId = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(documentId)
  const query = useExamDocument(validId ? documentId : '')
  if (query.data) return <ExamDocumentContent key={documentId} doc={query.data} refresh={query.refetch} />
  return <div className="exam-detail-page"><div className="exam-detail-container exam-detail-loading"><Link to={backTarget}><ArrowLeft size={20} />{backTitle}</Link>{query.isLoading ? <p role="status"><Loader2 size={24} className="animate-spin" />Carregando exame…</p> : <><FileText size={38} /><h1>{validId ? 'Exame indisponível' : 'Link inválido'}</h1><p role="alert">{validId ? 'Confira sua conta ou tente novamente.' : 'Abra novamente o link enviado no grupo.'}</p>{validId && <button className="exam-detail-primary" onClick={() => void query.refetch()}>Tentar novamente</button>}</>}</div></div>
}
