import { Link } from 'react-router-dom'
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, FileText, Link2, Loader2, Mail, Phone, RefreshCw, Search, SlidersHorizontal, UserRound } from 'lucide-react'
import { WhatsappLogo } from '@phosphor-icons/react/dist/csr/WhatsappLogo'
import type { DocumentFilter } from '@/hooks/useExamDocuments'
import type { ExamDocument } from '@/types/exam-document'
import { getExamDetailProgress } from '@/lib/exam-detail-progress'
import { documentIsOverdue, documentLabel } from '@/lib/document-status'
import './document-queue.css'

const filters: { value: DocumentFilter; label: string }[] = [
  { value: 'open', label: 'Em andamento' }, { value: 'review', label: 'Selecionar cadastro' },
  { value: 'unassigned', label: 'Sem responsável' }, { value: 'group_failed', label: 'Envio com pendência' },
  { value: 'contact', label: 'Aguardando contato' }, { value: 'nexus', label: 'Pendente no Nexus' },
  { value: 'completed', label: 'Concluídos' }, { value: 'all', label: 'Todos' },
]

export interface DocumentQueueProps {
  documents: ExamDocument[]
  total: number
  page: number
  pageSize: number
  loading: boolean
  error: unknown
  refreshing: boolean
  search: string
  filter: DocumentFilter
  onRefresh: () => void
  onSearchChange: (value: string) => void
  onFilterChange: (value: DocumentFilter) => void
  onPageChange: (value: number) => void
}

function field(doc: ExamDocument, key: 'pet_name' | 'client_name' | 'exam_type', fallback: string) {
  const value = documentLabel(doc, key).trim()
  return value && value !== '—' ? value : fallback
}

function examDate(doc: ExamDocument) {
  const value = documentLabel(doc, 'exam_date').trim()
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|T|\s)/.exec(value)
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`
  return /^(\d{2}\/\d{2}\/\d{4})$/.exec(value)?.[1] || null
}

function DocumentQueueRow({ doc }: { doc: ExamDocument }) {
  const progress = getExamDetailProgress(doc)
  const pet = field(doc, 'pet_name', 'Pet a identificar')
  const tutor = field(doc, 'client_name', 'Tutor a identificar')
  const exam = field(doc, 'exam_type', 'Exame a identificar')
  const responsible = doc.responsible_vet_name || doc.assigned_name || 'Sem responsável'
  const date = examDate(doc)
  const overdue = !!progress.groupAgeLabel && documentIsOverdue(doc)
  let summary: string = progress.summary
  let attention = false
  if (!doc.completed) {
    if (doc.identification_status === 'not_exam') summary = 'Não é exame'
    else if (doc.file_status === 'failed') { summary = 'Falha ao salvar PDF'; attention = true }
    else if (doc.file_status === 'uncertain') { summary = 'Arquivo a confirmar'; attention = true }
    else if (doc.group_status === 'failed') { summary = 'Envio ao grupo falhou'; attention = true }
    else if (['uncertain', 'submitted'].includes(doc.group_status)) { summary = 'Envio ao grupo a confirmar'; attention = true }
    else if (doc.nexus_status === 'failed') { summary = 'Cadastro com pendência'; attention = true }
    else if (doc.process_status === 'failed') { summary = 'Leitura do PDF a conferir'; attention = true }
    else if (summary === 'Em andamento' && ['unidentified', 'suggested', 'review'].includes(doc.identification_status)) summary = 'Selecionar cadastro'
  }
  const origin = progress.originChannel === 'email'
    ? { label: 'E-mail', description: 'Recebido por e-mail', icon: <Mail size={16} /> }
    : progress.originChannel === 'whatsapp'
      ? { label: 'WhatsApp', description: 'Recebido pelo WhatsApp', icon: <WhatsappLogo size={17} /> }
      : { label: progress.originChannel === 'manual' ? 'Arquivo' : 'Origem', description: progress.originChannel === 'manual' ? 'Arquivo recebido manualmente' : 'Origem ainda não identificada', icon: <FileText size={16} /> }
  const stages = [
    { ...origin, done: progress.originReceived },
    { label: 'Grupo', description: progress.groupSent ? 'Enviado ao grupo de WhatsApp' : 'Envio ao grupo ainda não confirmado', icon: <WhatsappLogo size={17} />, done: progress.groupSent },
    { label: 'Cadastro', description: progress.nexusLinked ? 'Exame anexado ao cadastro' : 'Exame ainda não anexado ao cadastro', icon: <Link2 size={16} />, done: progress.nexusLinked },
    { label: 'Contato', description: progress.contactCompleted ? 'Contato com tutor concluído' : progress.contactedCount ? `Contato registrado em ${progress.contactedCount} de ${progress.itemCount} exames` : 'Contato com tutor pendente', icon: <Phone size={16} />, done: progress.contactCompleted },
  ]
  return <li className={`document-queue-item${overdue ? ' is-overdue' : ''}`}>
    <Link className="document-queue-row" to={`/novos-exames/${doc.id}`}>
      <div className="document-queue-identity"><strong className="document-queue-pet">{pet}</strong><span className="document-queue-tutor">{tutor}</span></div>
      <div className="document-queue-exam"><span className="document-queue-exam-name">{exam}</span><span className="document-queue-date" aria-label={date ? `Data do exame: ${date}` : 'Data do exame a conferir'}><CalendarDays size={14} aria-hidden="true" />{date || 'Data a conferir'}</span></div>
      <div className="document-queue-responsible"><span className="document-queue-avatar" aria-hidden="true">{doc.responsible_vet_id && doc.responsible_vet_avatar_url ? <img src={doc.responsible_vet_avatar_url} alt="" loading="lazy" /> : <UserRound size={17} />}</span><span><small>Responsável</small><span>{responsible}</span></span></div>
      <div className={`document-queue-pending${doc.completed ? ' is-complete' : attention ? ' needs-attention' : ''}`}>
        <span className="document-queue-summary">{doc.completed && <Check size={14} aria-hidden="true" />}{summary}{summary === 'Contato parcial' && <span> · {progress.contactedCount}/{progress.itemCount}</span>}</span>
        {progress.groupAgeLabel && <span className="document-queue-age">{progress.groupAgeLabel}</span>}
        <ul className="document-queue-stages" aria-label="Etapas do exame">{stages.map(stage => <li key={stage.label} title={stage.description}>
          <span className={`document-queue-stage${stage.done ? ' is-done' : ''}${stage.label === 'Contato' ? stage.done ? ' contact-done' : ' contact-pending' : ''}`} aria-hidden="true">{stage.icon}</span>
          <span className="document-queue-stage-label" aria-hidden="true">{stage.label}</span><span className="sr-only">{stage.description}</span>
        </li>)}</ul>
      </div>
      <ChevronRight className="document-queue-open" size={19} aria-hidden="true" />
    </Link>
  </li>
}

export function DocumentQueue({ documents, total, page, pageSize, loading, error, refreshing, search, filter, onRefresh, onSearchChange, onFilterChange, onPageChange }: DocumentQueueProps) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return <section className="document-queue" aria-labelledby="document-queue-title">
    <header className="document-queue-header"><div><h1 id="document-queue-title">Recebidos</h1><p>{loading ? 'Carregando exames…' : error ? 'Lista indisponível' : <>{total} {total === 1 ? 'exame' : 'exames'}<span className="document-queue-filter-summary"> · {filters.find(option => option.value === filter)?.label}</span></>}</p></div><button type="button" className="document-queue-refresh" onClick={onRefresh} disabled={refreshing} aria-label={refreshing ? 'Atualizando exames' : 'Atualizar exames'} title="Atualizar exames"><RefreshCw size={19} className={refreshing ? 'animate-spin' : ''} aria-hidden="true" /><span>Atualizar</span></button></header>
    <div className="document-queue-tools"><label className="document-queue-search"><Search size={19} aria-hidden="true" /><span className="sr-only">Buscar por pet, tutor ou arquivo</span><input type="search" placeholder="Pet, tutor ou arquivo" value={search} onChange={event => onSearchChange(event.target.value)} autoComplete="off" spellCheck={false} /></label><label className="document-queue-filter"><SlidersHorizontal size={17} aria-hidden="true" /><span className="sr-only">Filtrar exames</span><select aria-label="Filtrar exames" value={filter} onChange={event => onFilterChange(event.target.value as DocumentFilter)}>{filters.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select><ChevronDown size={14} aria-hidden="true" /></label></div>
    {loading ? <div className="document-queue-feedback" role="status"><Loader2 size={25} className="animate-spin" aria-hidden="true" /><p>Carregando exames…</p></div>
      : error ? <div className="document-queue-feedback is-error" role="alert"><FileText size={28} aria-hidden="true" /><h2>Não foi possível carregar</h2><p>Confira sua conexão e tente novamente.</p><button type="button" onClick={onRefresh} disabled={refreshing}>{refreshing ? 'Atualizando…' : 'Tentar novamente'}</button></div>
        : documents.length === 0 ? <div className="document-queue-feedback"><FileText size={30} aria-hidden="true" /><h2>{search ? 'Nenhum exame encontrado' : 'Nenhum exame nesta lista'}</h2><p>{search ? 'Tente outro nome ou ajuste o filtro.' : 'Os exames recebidos aparecerão aqui.'}</p></div>
          : <div className="document-queue-list" aria-busy={refreshing}><div className="document-queue-columns" aria-hidden="true"><span>Pet e tutor</span><span>Exame e data</span><span>Responsável</span><span>Pendência</span><span /></div><ul aria-label="Exames recebidos">{documents.map(doc => <DocumentQueueRow key={doc.id} doc={doc} />)}</ul></div>}
    {!loading && !error && total > 0 && <footer className="document-queue-pagination"><span>{documents.length ? `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, total)} de ${total}` : `${total} exames`}</span><nav aria-label="Paginação dos exames"><button type="button" aria-label="Página anterior" disabled={page === 0 || refreshing} onClick={() => onPageChange(page - 1)}><ChevronLeft size={18} aria-hidden="true" /></button><span aria-live="polite">{page + 1} / {pages}</span><button type="button" aria-label="Próxima página" disabled={(page + 1) * pageSize >= total || refreshing} onClick={() => onPageChange(page + 1)}><ChevronRight size={18} aria-hidden="true" /></button></nav></footer>}
  </section>
}
