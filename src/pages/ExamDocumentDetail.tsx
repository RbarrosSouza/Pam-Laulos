import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, CalendarDays, Check, ChevronDown, ChevronRight, Clock3, Copy, FileText, History, Link2, Loader2, Mail, MoreVertical, Phone, Settings2, Trash2, UserRound, UserRoundPlus } from 'lucide-react'
import { WhatsappLogo } from '@phosphor-icons/react/dist/csr/WhatsappLogo'
import { toast } from 'sonner'
import { useExamAuth } from '@/contexts/exam-auth'
import { useDocumentAction, useExamDocument } from '@/hooks/useExamDocuments'
import { useVets, type Vet } from '@/hooks/useVets'
import { DocumentCorrection, DocumentGroupConfirmation, DocumentProvenance } from '@/components/documents/DocumentControls'
import { DocumentDelete } from '@/components/documents/DocumentDelete'
import { DocumentForm, DocumentHistory, DocumentPreview, DocumentSteps } from '@/components/documents/ExamDocumentPanels'
import { ExamDetailSheet } from '@/components/documents/ExamDetailSheet'
import { DocumentVersionReview } from '@/components/documents/DocumentVersionReview'
import { documentDisplayId, documentLabel } from '@/lib/document-status'
import { getExamDetailProgress } from '@/lib/exam-detail-progress'
import { triggerFireworksAt } from '@/lib/fireworks'
import type { ExamDocument } from '@/types/exam-document'
import '@fontsource/manrope/latin-800.css'
import '@fontsource/dm-sans/latin-400.css'
import '@fontsource/dm-sans/latin-500.css'
import '@fontsource/dm-sans/latin-600.css'
import './exam-document-detail.css'

type Panel = 'responsible' | 'contact' | 'patient' | 'pdf' | 'more' | 'identity' | 'steps' | 'history' | 'success' | 'delete' | null
const panelTitles: Record<Exclude<Panel, null>, string> = {
  responsible: 'Responsável pelo exame', contact: 'Contato com o tutor', patient: 'Adicionar exame ao cadastro',
  delete: 'Excluir ficha', pdf: 'PDF do exame', more: 'Opções do exame', identity: 'Dados do exame', steps: 'Etapas e pendências', history: 'Histórico do exame', success: 'Contato registrado',
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

  const initialPanel = (searchParams.get('panel') as Panel) || null
  const [panel, setPanel] = useState<Panel>(initialPanel)
  const [deleting, setDeleting] = useState(false)
  const [savingVetId, setSavingVetId] = useState<string | null>(null)
  const [justCompleted, setJustCompleted] = useState(false)
  const [isCelebrating, setIsCelebrating] = useState(false)
  const [isSavingContact, setIsSavingContact] = useState(false)
  const [showCelebrationBanner, setShowCelebrationBanner] = useState(false)
  const assignmentPending = useRef(false)
  const [now, setNow] = useState(Date.now)
  const progress = getExamDetailProgress(doc, now)
  const isContactDone = progress.contactCompleted || justCompleted

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

  // Direct check action on card with loader, festive fireworks and completion message
  const handleDirectContact = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (isContactDone || isSavingContact || action.isPending) return

    setIsSavingContact(true)

    const rect = event.currentTarget.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2

    const itemIds = doc.items
      .map(item => item.item_id || item.exam_item_id)
      .filter((id): id is string => Boolean(id))

    if (doc.pet_id && itemIds.length > 0) {
      try {
        await action.mutateAsync({
          name: 'record_exam_document_contact',
          args: {
            p_document_id: doc.id,
            p_item_ids: itemIds,
            p_channel: 'whatsapp',
            p_note: null,
            p_contacted_at: new Date().toISOString(),
          },
        })
        await refresh()
      } catch (err) {
        console.error('Erro ao registrar contato:', err)
      } finally {
        setIsSavingContact(false)
        setJustCompleted(true)
        setShowCelebrationBanner(true)
        setIsCelebrating(true)
        triggerFireworksAt(x, y)
        setTimeout(() => setIsCelebrating(false), 900)
      }
    } else {
      setIsSavingContact(false)
      setPanel('contact')
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
    { label: 'Cadastro', description: progress.nexusLinked ? 'Exame anexado ao cadastro' : 'Exame ainda não anexado ao cadastro', done: progress.nexusLinked, icon: Link2, panel: 'patient' as const },
    { label: 'Contato', description: isContactDone ? 'Contato com tutor concluído' : 'Contato com tutor pendente', done: isContactDone, icon: Phone, panel: 'contact' as const },
  ]
  return <div className="exam-detail-page">
    <div className="exam-detail-container">
      <header className="exam-detail-header">
        <Link to={backTarget} className="exam-detail-icon-button" aria-label={backLabel}><ArrowLeft size={26} /></Link>
        <span>Pam Laudos</span>
        <button className="exam-detail-icon-button" aria-label="Opções do exame" onClick={() => setPanel('more')}><MoreVertical size={25} /></button>
      </header>
      <main className="exam-detail-main">
        <section className="exam-detail-identity" aria-label="Identificação do exame">
          <p className="exam-detail-type">{documentLabel(doc, 'exam_type') === '—' ? 'Exame recebido' : documentLabel(doc, 'exam_type')}</p>
          <h1>{pet === '—' ? 'Pet a identificar' : pet}</h1>
          <p className="exam-detail-tutor">{tutor === '—' ? 'Tutor a identificar' : tutor}</p>
          <div className="exam-detail-meta">
            <span><CalendarDays size={25} aria-hidden="true" />{displayDate(documentLabel(doc, 'exam_date'))}</span>
            <button onClick={() => setPanel('pdf')}><FileText size={25} aria-hidden="true" />Abrir PDF</button>
          </div>
        </section>
        <DocumentVersionReview key={doc.id} documentId={doc.id} refresh={refresh}/>
        <button className="exam-detail-responsible" onClick={() => setPanel('responsible')} aria-haspopup="dialog">
          <span className="exam-detail-row-copy"><span className="exam-detail-field-label">Responsável</span><strong>{responsible}</strong></span>
          <span className="exam-detail-responsible-icon" aria-hidden="true">{responsibleAvatar ? <img className="exam-detail-responsible-photo" src={responsibleAvatar} alt="" /> : <UserRound size={29} />}<ChevronDown size={15} /></span>
        </button>
        <div className={`exam-detail-contact${isContactDone ? ' is-complete' : ''}${isCelebrating ? ' is-celebrating' : ''}`}>
          <button
            type="button"
            className="exam-detail-contact-btn"
            onClick={() => setPanel('contact')}
            aria-haspopup="dialog"
            aria-label={isContactDone ? 'Contato realizado. Ver registro' : 'Registrar contato com o tutor'}
          >
            <span className="exam-detail-row-copy">
              <span className="exam-detail-field-label">Contato com o tutor</span>
              <strong>
                {isSavingContact
                  ? 'Salvando contato…'
                  : isContactDone
                    ? '✓ Exame concluído'
                    : progress.contactedCount
                      ? `${progress.contactedCount} de ${progress.itemCount} exames`
                      : 'Entrei em contato'}
              </strong>
            </span>
          </button>
          {isContactDone ? (
            <button
              type="button"
              className="exam-detail-contact-check is-checked"
              onClick={() => setPanel('contact')}
              aria-label="Contato realizado. Ver registro"
            >
              <Check size={21} strokeWidth={2.5} />
            </button>
          ) : (
            <button
              type="button"
              className={`exam-detail-contact-check-btn${isSavingContact ? ' is-loading' : ''}`}
              onClick={handleDirectContact}
              disabled={isSavingContact}
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
        {showCelebrationBanner && (
          <div className="exam-detail-celebration-banner" role="status">
            <div className="exam-detail-celebration-copy">
              <span className="exam-detail-celebration-emoji" aria-hidden="true">🎉</span>
              <div>
                <strong>Exame concluído com sucesso!</strong>
                <p>Contato registrado e fila sincronizada.</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowCelebrationBanner(false)}
              className="exam-detail-celebration-close"
              aria-label="Fechar mensagem de conclusão"
            >
              ✕
            </button>
          </div>
        )}
        <section className="exam-detail-progress" aria-label="Progresso do exame">
          <ul>{stages.map(({ label, description, done, icon: Icon, panel: target }) => <li key={label}><button title={description} aria-label={description} onClick={() => setPanel(target)}><span className={`exam-detail-stage-icon${done ? ' is-done' : ''}${label === 'Contato' ? done ? ' contact-done' : ' contact-pending' : ''}`}><Icon size={23} aria-hidden="true" />{done && <span className="exam-detail-stage-check"><Check size={10} strokeWidth={3} /></span>}</span><span>{label}</span></button></li>)}</ul>
          <p className={`exam-detail-progress-caption${(doc.completed || isContactDone) ? ' is-complete' : ''}`} role="status">{(doc.completed || isContactDone) ? <Check size={15} /> : progress.groupAgeLabel ? <Clock3 size={14} /> : null}{isContactDone && !progress.groupAgeLabel ? '✓ Contato concluído' : (progress.groupAgeLabel || progress.summary)}</p>
        </section>
      </main>
      <footer className="exam-detail-footer"><button className="exam-detail-primary" onClick={() => setPanel('patient')}><UserRoundPlus size={25} /><span>{progress.nexusLinked ? 'Ver exame no cadastro' : doc.pet_id ? 'Acompanhar cadastro' : 'Adicionar exame ao cadastro'}</span><ChevronRight size={21} /></button></footer>
    </div>
    <ExamDetailSheet open={panel !== null} onOpenChange={open => { if (!open && !deleting) close() }} title={panel ? panelTitles[panel] : ''} wide={panel === 'pdf'} centered={panel === 'success'}>
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
      {panel === 'contact' && (isContactDone ? <DocumentProvenance doc={doc} /> : !contactAllowed ? <p className="exam-detail-hint">O registro de contato é feito por uma veterinária ou pela gestão.</p> : !doc.pet_id && !isContactDone ? <div className="exam-detail-empty"><UserRoundPlus size={35} /><h3>Confirme o paciente primeiro</h3><p>Selecione o cadastro para registrar o contato com o tutor correto.</p><button className="exam-detail-primary" onClick={() => setPanel('patient')}>Selecionar paciente<ChevronRight size={20} /></button></div> : <DocumentForm key={`${doc.id}:contact`} doc={doc} mode="contact" onContactSaved={async () => {
        // The contact RPC has already succeeded. A refresh failure must not
        // turn a saved contact into an apparent write failure or invite retry.
        try { await refresh() } catch { /* Query state retains any read error. */ }
        const cx = typeof window !== 'undefined' ? window.innerWidth / 2 : 200
        const cy = typeof window !== 'undefined' ? window.innerHeight * 0.4 : 200
        triggerFireworksAt(cx, cy)
        setJustCompleted(true)
        setShowCelebrationBanner(true)
        setPanel(current => current === 'contact' ? 'success' : current)
      }} />)}
      {panel === 'patient' && <div className="space-y-5"><DocumentForm key={`${doc.id}:patient`} doc={doc} mode="patient" onSaved={() => setPanel(current => current === 'patient' ? null : current)} />{progress.nexusLinked && <button className="exam-detail-primary" onClick={() => setPanel('pdf')}><FileText size={22} />Abrir exame anexado</button>}</div>}
      {panel === 'identity' && <DocumentForm key={`${doc.id}:identity`} doc={doc} mode="identity" onSaved={() => setPanel(current => current === 'identity' ? null : current)} />}
      {panel === 'pdf' && <DocumentPreview doc={doc} />}
      {panel === 'steps' && <div className="space-y-4"><DocumentSteps doc={doc} /><DocumentGroupConfirmation doc={doc} /></div>}
      {panel === 'history' && <div className="space-y-4"><DocumentProvenance doc={doc} /><DocumentHistory id={doc.id} /></div>}
      {panel === 'more' && <div className="exam-detail-options">
        <button onClick={() => setPanel('identity')}><Settings2 size={21} />Conferir dados do exame<ChevronRight size={18} /></button>
        <button onClick={() => setPanel('steps')}><Link2 size={21} />Etapas e pendências<ChevronRight size={18} /></button>
        <button onClick={() => setPanel('history')}><History size={21} />Histórico e origem<ChevronRight size={18} /></button>
        <button onClick={() => void copyLink()}><Copy size={21} />Copiar link do exame</button>
        <button className="exam-detail-delete-option" onClick={() => setPanel('delete')}><Trash2 size={21} />Excluir ficha<ChevronRight size={18} /></button>
        <details><summary>Versão corrigida</summary>{doc.previous_document_id ? <p>Original preservado: <Link to={`/novos-exames/${doc.previous_document_id}`} onClick={close}>{documentDisplayId(doc.previous_document_id)}</Link></p> : <DocumentCorrection doc={doc} />}</details>
        <p className="exam-detail-reference">{documentDisplayId(doc.id)} · recebido em {new Date(doc.received_at).toLocaleString('pt-BR')}</p>
      </div>}
      {panel === 'delete' && <DocumentDelete doc={doc} backTarget={backTarget} onCancel={() => setPanel('more')} onPendingChange={setDeleting} />}
      {panel === 'success' && <div className="exam-detail-success" role="status"><span className="exam-detail-success-mark"><Check size={42} strokeWidth={2.5} /></span><h3>{isContactDone ? 'Contato concluído' : 'Contato registrado'}</h3><p>{doc.completed ? 'Todas as etapas deste exame estão concluídas.' : progress.contactCompleted ? 'O contato com o tutor foi registrado. Acompanhe as etapas restantes na tela do exame.' : 'O contato foi salvo para os itens selecionados. Acompanhe o andamento na tela do exame.'}</p><button className="exam-detail-primary" onClick={close}>Voltar ao exame<Check size={20} /></button></div>}
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
