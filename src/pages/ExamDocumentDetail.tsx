import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, CalendarDays, Check, ChevronDown, ChevronRight, Clock3, Copy, FileText, History, Link2, Loader2, Mail, MoreVertical, Phone, Settings2, UserRound, UserRoundPlus } from 'lucide-react'
import { WhatsappLogo } from '@phosphor-icons/react/dist/csr/WhatsappLogo'
import { toast } from 'sonner'
import { useExamAuth } from '@/contexts/exam-auth'
import { useDocumentAction, useExamDocument } from '@/hooks/useExamDocuments'
import { DocumentCorrection, DocumentGroupConfirmation, DocumentProvenance } from '@/components/documents/DocumentControls'
import { DocumentForm, DocumentHistory, DocumentPreview, DocumentSteps } from '@/components/documents/ExamDocumentPanels'
import { ExamDetailSheet } from '@/components/documents/ExamDetailSheet'
import { documentDisplayId, documentLabel } from '@/lib/document-status'
import { getExamDetailProgress } from '@/lib/exam-detail-progress'
import type { ExamDocument } from '@/types/exam-document'
import '@fontsource/manrope/latin-800.css'
import '@fontsource/dm-sans/latin-400.css'
import '@fontsource/dm-sans/latin-500.css'
import '@fontsource/dm-sans/latin-600.css'
import './exam-document-detail.css'

type Panel = 'responsible' | 'contact' | 'patient' | 'pdf' | 'more' | 'identity' | 'steps' | 'history' | 'success' | null
const panelTitles: Record<Exclude<Panel, null>, string> = {
  responsible: 'Responsável pelo exame', contact: 'Contato com o tutor', patient: 'Adicionar exame ao cadastro',
  pdf: 'PDF do exame', more: 'Opções do exame', identity: 'Dados do exame', steps: 'Etapas e pendências', history: 'Histórico do exame', success: 'Contato registrado',
}
function displayDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value === '—' ? 'Data a conferir' : value
}

export function ExamDocumentContent({ doc, refresh }: { doc: ExamDocument; refresh: () => Promise<unknown> }) {
  const auth = useExamAuth()
  const action = useDocumentAction()
  const [panel, setPanel] = useState<Panel>(null)
  const [now, setNow] = useState(Date.now)
  const progress = getExamDetailProgress(doc, now)
  useEffect(() => {
    if (doc.group_status !== 'sent' || doc.contact_status === 'completed' || doc.completed) return
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [doc.group_status, doc.contact_status, doc.completed])
  const user = auth.session?.user
  const ownName = user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email || 'Você'
  const assignedToMe = !!user && doc.assigned_to === user.id
  const responsible = assignedToMe ? ownName : doc.assigned_name || (doc.assigned_to ? 'Responsável definido' : 'Selecionar responsável')
  const contactAllowed = auth.role === 'admin' || auth.role === 'vet'
  const pet = documentLabel(doc, 'pet_name')
  const tutor = documentLabel(doc, 'client_name')
  const close = () => setPanel(null)
  const assign = async () => {
    if (!user || action.isPending) return
    try {
      await action.mutateAsync({ name: 'assign_exam_document', args: { p_document_id: doc.id, p_assignee_id: user.id } })
      await refresh()
      toast.success('Responsável salvo.')
      close()
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Não foi possível salvar o responsável.') }
  }
  const copyLink = () => navigator.clipboard.writeText(`${window.location.origin}/novos-exames/${doc.id}`).then(() => toast.success('Link copiado.')).catch(() => toast.error('Não foi possível copiar o link.'))
  const stages = [
    { label: 'E-mail', description: progress.emailReceived ? 'Recebido por e-mail' : 'Origem por e-mail não registrada', done: progress.emailReceived, icon: Mail, panel: 'history' as const },
    { label: 'Grupo', description: progress.groupSent ? 'Enviado ao grupo de WhatsApp' : 'Envio ao grupo ainda não confirmado', done: progress.groupSent, icon: WhatsappLogo, panel: 'steps' as const },
    { label: 'Cadastro', description: progress.nexusLinked ? 'Exame anexado ao cadastro' : 'Exame ainda não anexado ao cadastro', done: progress.nexusLinked, icon: Link2, panel: 'patient' as const },
    { label: 'Contato', description: progress.contactCompleted ? 'Contato com tutor concluído' : 'Contato com tutor pendente', done: progress.contactCompleted, icon: Phone, panel: 'contact' as const },
  ]
  return <div className="exam-detail-page">
    <div className="exam-detail-container">
      <header className="exam-detail-header">
        <Link to="/novos-exames" className="exam-detail-icon-button" aria-label="Voltar para Novos exames"><ArrowLeft size={26} /></Link>
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
        <button className="exam-detail-responsible" onClick={() => setPanel('responsible')} aria-haspopup="dialog">
          <span className="exam-detail-row-copy"><span className="exam-detail-field-label">Responsável</span><strong>{responsible}</strong>{assignedToMe && <span className="exam-detail-you">Você</span>}</span>
          <span className="exam-detail-responsible-icon" aria-hidden="true"><UserRound size={29} /><ChevronDown size={15} /></span>
        </button>
        <button className={`exam-detail-contact${progress.contactCompleted ? ' is-complete' : ''}`} onClick={() => setPanel('contact')} aria-haspopup="dialog" aria-label={progress.contactCompleted ? 'Contato realizado. Ver registro' : 'Registrar contato com o tutor'}>
          <span className="exam-detail-row-copy"><span className="exam-detail-field-label">Contato com o tutor</span><strong>{progress.contactCompleted ? 'Realizado' : progress.contactedCount ? `${progress.contactedCount} de ${progress.itemCount} exames` : 'Entrei em contato'}</strong></span>
          <span className="exam-detail-contact-check" aria-hidden="true">{progress.contactCompleted && <Check size={21} />}</span>
        </button>
        <section className="exam-detail-progress" aria-label="Progresso do exame">
          <ul>{stages.map(({ label, description, done, icon: Icon, panel: target }) => <li key={label}><button title={description} aria-label={description} onClick={() => setPanel(target)}><span className={`exam-detail-stage-icon${done ? ' is-done' : ''}${label === 'Contato' ? done ? ' contact-done' : ' contact-pending' : ''}`}><Icon size={23} aria-hidden="true" />{done && <span className="exam-detail-stage-check"><Check size={10} strokeWidth={3} /></span>}</span><span>{label}</span></button></li>)}</ul>
          <p className={`exam-detail-progress-caption${doc.completed ? ' is-complete' : ''}`} role="status">{doc.completed ? <Check size={15} /> : progress.groupAgeLabel ? <Clock3 size={14} /> : null}{progress.groupAgeLabel || progress.summary}</p>
        </section>
      </main>
      <footer className="exam-detail-footer"><button className="exam-detail-primary" onClick={() => setPanel('patient')}><UserRoundPlus size={25} /><span>{progress.nexusLinked ? 'Ver exame no cadastro' : doc.pet_id ? 'Acompanhar cadastro' : 'Adicionar exame ao cadastro'}</span><ChevronRight size={21} /></button></footer>
    </div>
    <ExamDetailSheet open={panel !== null} onOpenChange={open => { if (!open) close() }} title={panel ? panelTitles[panel] : ''} wide={panel === 'pdf'}>
      {panel === 'responsible' && <div className="exam-detail-team">
        {doc.assigned_to && !assignedToMe && <p className="exam-detail-hint">{responsible}. Assuma somente se o atendimento foi transferido para você.</p>}
        <button className={`exam-detail-vet${assignedToMe ? ' is-selected' : ''}`} disabled={action.isPending || assignedToMe} onClick={() => void assign()}>
          <span className="exam-detail-avatar"><UserRound size={27} /></span>
          <span><strong>{ownName}</strong><small>{assignedToMe ? 'Você · responsável atual' : doc.assigned_to ? 'Transferir para mim' : 'Assumir este exame'}</small></span>
          {action.isPending ? <Loader2 size={21} className="animate-spin" /> : assignedToMe ? <Check size={22} /> : <ChevronRight size={20} />}
        </button><p className="exam-detail-hint">A responsabilidade é registrada na conta da equipe que possui acesso ao exame.</p>
      </div>}
      {panel === 'contact' && (progress.contactCompleted ? <DocumentProvenance doc={doc} /> : !contactAllowed ? <p className="exam-detail-hint">O registro de contato é feito por uma veterinária ou pela gestão.</p> : !doc.pet_id && !progress.contactCompleted ? <div className="exam-detail-empty"><UserRoundPlus size={35} /><h3>Confirme o paciente primeiro</h3><p>Selecione o cadastro para registrar o contato com o tutor correto.</p><button className="exam-detail-primary" onClick={() => setPanel('patient')}>Selecionar paciente<ChevronRight size={20} /></button></div> : <DocumentForm key={`${doc.id}:contact`} doc={doc} mode="contact" onContactSaved={async () => { await refresh(); setPanel('success') }} />)}
      {panel === 'patient' && <div className="space-y-5"><DocumentForm key={`${doc.id}:patient`} doc={doc} mode="patient" />{progress.nexusLinked && <button className="exam-detail-primary" onClick={() => setPanel('pdf')}><FileText size={22} />Abrir exame anexado</button>}</div>}
      {panel === 'identity' && <DocumentForm key={`${doc.id}:identity`} doc={doc} mode="identity" />}
      {panel === 'pdf' && <DocumentPreview doc={doc} />}
      {panel === 'steps' && <div className="space-y-4"><DocumentSteps doc={doc} /><DocumentGroupConfirmation doc={doc} /></div>}
      {panel === 'history' && <div className="space-y-4"><DocumentProvenance doc={doc} /><DocumentHistory id={doc.id} /></div>}
      {panel === 'more' && <div className="exam-detail-options">
        <button onClick={() => setPanel('identity')}><Settings2 size={21} />Conferir dados do exame<ChevronRight size={18} /></button>
        <button onClick={() => setPanel('steps')}><Link2 size={21} />Etapas e pendências<ChevronRight size={18} /></button>
        <button onClick={() => setPanel('history')}><History size={21} />Histórico e origem<ChevronRight size={18} /></button>
        <button onClick={() => void copyLink()}><Copy size={21} />Copiar link do exame</button>
        <details><summary>Versão corrigida</summary>{doc.previous_document_id ? <p>Original preservado: <Link to={`/novos-exames/${doc.previous_document_id}`} onClick={close}>{documentDisplayId(doc.previous_document_id)}</Link></p> : <DocumentCorrection doc={doc} />}</details>
        <p className="exam-detail-reference">{documentDisplayId(doc.id)} · recebido em {new Date(doc.received_at).toLocaleString('pt-BR')}</p>
      </div>}
      {panel === 'success' && <div className="exam-detail-success" role="status"><span className="exam-detail-success-mark"><Check size={42} strokeWidth={2.5} /></span><h3>{progress.contactCompleted ? 'Contato concluído' : 'Contato registrado'}</h3><p>{doc.completed ? 'Todas as etapas deste exame estão concluídas.' : progress.contactCompleted ? 'O contato com o tutor foi registrado. Acompanhe as etapas restantes na tela do exame.' : 'O registro foi salvo. Os demais itens continuam pendentes de contato.'}</p><button className="exam-detail-primary" onClick={close}>Voltar ao exame<Check size={20} /></button></div>}
    </ExamDetailSheet>
  </div>
}

export function ExamDocumentDetail() {
  const { documentId = '' } = useParams()
  const validId = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(documentId)
  const query = useExamDocument(validId ? documentId : '')
  if (query.data) return <ExamDocumentContent key={documentId} doc={query.data} refresh={query.refetch} />
  return <div className="exam-detail-page"><div className="exam-detail-container exam-detail-loading"><Link to="/novos-exames"><ArrowLeft size={20} />Novos exames</Link>{query.isLoading ? <p role="status"><Loader2 size={24} className="animate-spin" />Carregando exame…</p> : <><FileText size={38} /><h1>{validId ? 'Exame indisponível' : 'Link inválido'}</h1><p role="alert">{validId ? 'Confira sua conta ou tente novamente.' : 'Abra novamente o link enviado no grupo.'}</p>{validId && <button className="exam-detail-primary" onClick={() => void query.refetch()}>Tentar novamente</button>}</>}</div></div>
}
