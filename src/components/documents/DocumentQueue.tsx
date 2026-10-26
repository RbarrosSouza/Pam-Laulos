import { useState } from 'react'
import { flushSync } from 'react-dom'
import { Link } from 'react-router-dom'
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, FileText, Link2, Loader2, Mail, Phone, Printer, RefreshCw, Search, SlidersHorizontal, Stethoscope, UserRound } from 'lucide-react'
import { WhatsappLogo } from '@phosphor-icons/react/dist/csr/WhatsappLogo'
import { toast } from 'sonner'
import { fetchAllExamDocuments, type DocumentFilter } from '@/hooks/useExamDocuments'
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
  onFetchAll?: () => Promise<ExamDocument[]>
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

function parseDaysInGroup(doc: ExamDocument): number | null {
  if (!doc.oldest_group_sent_at) return null
  const sent = Date.parse(doc.oldest_group_sent_at)
  if (!Number.isFinite(sent)) return null
  const diffHours = (Date.now() - sent) / 3_600_000
  return Math.floor(diffHours / 24)
}

function getDocumentStages(doc: ExamDocument, progress: ReturnType<typeof getExamDetailProgress>, iconSize: number) {
  const origin = progress.originChannel === 'email'
    ? { label: 'E-mail', description: 'Recebido por e-mail', icon: <Mail size={iconSize} /> }
    : progress.originChannel === 'whatsapp'
      ? { label: 'WhatsApp', description: 'Recebido pelo WhatsApp', icon: <WhatsappLogo size={iconSize} /> }
      : { label: progress.originChannel === 'manual' ? 'Arquivo' : 'Origem', description: progress.originChannel === 'manual' ? 'Arquivo recebido manualmente' : 'Origem ainda não identificada', icon: <FileText size={iconSize} /> }
  return [
    { ...origin, done: progress.originReceived },
    { label: 'Grupo', description: progress.groupSent ? 'Enviado ao grupo de WhatsApp' : 'Envio ao grupo ainda não confirmado', icon: <WhatsappLogo size={iconSize} />, done: progress.groupSent, attention: doc.group_status === 'failed' },
    { label: 'Cadastro', description: progress.nexusLinked ? 'Exame anexado ao cadastro' : 'Exame ainda não anexado ao cadastro', icon: <Link2 size={iconSize} />, done: progress.nexusLinked, attention: doc.nexus_status === 'failed' },
    { label: 'Contato', description: progress.contactCompleted ? 'Contato com tutor concluído' : progress.contactedCount ? `Contato registrado em ${progress.contactedCount} de ${progress.itemCount} exames` : 'Contato com tutor pendente', icon: <Phone size={iconSize} />, done: progress.contactCompleted },
  ]
}

function DocumentQueueRow({ doc }: { doc: ExamDocument }) {
  const progress = getExamDetailProgress(doc)
  const pet = field(doc, 'pet_name', 'Pet a identificar')
  const tutor = field(doc, 'client_name', 'Tutor a identificar')
  const exam = field(doc, 'exam_type', 'Exame a identificar')
  const responsible = doc.responsible_vet_name || doc.assigned_name || 'Sem responsável'
  const date = examDate(doc)
  const days = parseDaysInGroup(doc)
  const overdue = !!progress.groupAgeLabel && documentIsOverdue(doc)
  let attention = false
  if (!doc.completed) {
    if (['failed', 'uncertain'].includes(doc.file_status) ||
        ['failed', 'uncertain', 'submitted'].includes(doc.group_status) ||
        doc.nexus_status === 'failed' ||
        doc.process_status === 'failed') {
      attention = true
    }
  }
  const stages = getDocumentStages(doc, progress, 13)
  return (
    <li className={`document-queue-item${overdue ? ' is-overdue' : ''}`}>
      <Link className="document-queue-row" to={`/novos-exames/${doc.id}?from=exames`} state={{ from: '/novos-exames' }}>
        <div className="document-queue-identity">
          <strong className="document-queue-pet">{pet}</strong>
          <span className="document-queue-tutor">{tutor}</span>
        </div>
        <div className="document-queue-exam">
          <span className="document-queue-exam-name">{exam}</span>
          <span className="document-queue-date" aria-label={date ? `Data do exame: ${date}` : 'Data do exame a conferir'}>
            <CalendarDays size={11} aria-hidden="true" />
            {date || 'Data a conferir'}
          </span>
        </div>
        <div className="document-queue-responsible">
          <span className="document-queue-avatar" aria-hidden="true">
            {doc.responsible_vet_id && doc.responsible_vet_avatar_url ? (
              <img src={doc.responsible_vet_avatar_url} alt="" loading="lazy" />
            ) : (
              <UserRound size={13} />
            )}
          </span>
          <span className="document-queue-vet-name">
            <small>Responsável</small>
            <span>{responsible}</span>
          </span>
        </div>
        <div className={`document-queue-pending${doc.completed ? ' is-complete' : attention ? ' needs-attention' : ''}`}>
          <ul className="document-queue-stages" aria-label="Etapas do exame">
            {stages.map(stage => (
              <li
                key={stage.label}
                title={`${stage.label}: ${stage.description}`}
                className={`document-queue-stage-pill${stage.done ? ' is-done' : stage.attention ? ' needs-attention' : ''}`}
                aria-label={`${stage.label}: ${stage.description}`}
              >
                <span className="document-queue-stage-icon" aria-hidden="true">{stage.icon}</span>
              </li>
            ))}
          </ul>
          {days !== null && (
            <span className="document-queue-sla">
              {days === 0 ? (
                <span className="text-[hsl(var(--muted-foreground))]">hoje</span>
              ) : days === 1 ? (
                <span className="text-[hsl(var(--muted-foreground))]">1d</span>
              ) : days >= 2 && days < 4 ? (
                <span className="inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                  {days}d
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 font-semibold text-rose-600 dark:text-rose-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                  {days}d
                </span>
              )}
            </span>
          )}
        </div>
        <ChevronRight className="document-queue-open" size={15} aria-hidden="true" />
      </Link>
    </li>
  )
}

export function DocumentQueue({ documents, total, page, pageSize, loading, error, refreshing, search, filter, onRefresh, onSearchChange, onFilterChange, onPageChange, onFetchAll }: DocumentQueueProps) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const [isPrinting, setIsPrinting] = useState(false)
  const [printDocuments, setPrintDocuments] = useState<ExamDocument[]>(documents)

  const handlePrint = async () => {
    if (isPrinting || loading || total === 0) return
    try {
      setIsPrinting(true)
      let targetDocs: ExamDocument[]
      if (onFetchAll) {
        targetDocs = await onFetchAll()
      } else if (total <= documents.length && page === 0) {
        targetDocs = documents
      } else {
        targetDocs = await fetchAllExamDocuments(search, filter)
      }
      if (!targetDocs.length) {
        toast.error('Nenhum exame para imprimir com os filtros selecionados.')
        setIsPrinting(false)
        return
      }
      flushSync(() => {
        setPrintDocuments(targetDocs)
      })
      window.print()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível preparar a impressão.')
    } finally {
      setIsPrinting(false)
    }
  }

  const printItems = printDocuments.length ? printDocuments : documents
  const currentFilterLabel = filters.find(option => option.value === filter)?.label || 'Todos'
  const printDate = new Date().toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <section className="document-queue" aria-labelledby="document-queue-title">
      <header className="document-queue-header">
        <div>
          <h1 id="document-queue-title">Recebidos</h1>
          <p>
            {loading ? 'Carregando exames…' : error ? 'Lista indisponível' : (
              <>{total} {total === 1 ? 'exame' : 'exames'}<span className="document-queue-filter-summary"> · {filters.find(option => option.value === filter)?.label}</span></>
            )}
          </p>
        </div>
        <div className="document-queue-header-actions">
          <button
            type="button"
            className="document-queue-print"
            onClick={() => void handlePrint()}
            disabled={isPrinting || loading || total === 0}
            aria-label="Imprimir lista completa de exames"
            title="Imprimir lista completa"
          >
            {isPrinting ? (
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            ) : (
              <Printer size={13} aria-hidden="true" />
            )}
            <span>{isPrinting ? 'Preparando…' : 'Imprimir'}</span>
          </button>
          <button
            type="button"
            className="document-queue-refresh"
            onClick={onRefresh}
            disabled={refreshing || isPrinting}
            aria-label={refreshing ? 'Atualizando exames' : 'Atualizar exames'}
            title="Atualizar exames"
          >
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} aria-hidden="true" />
            <span>Atualizar</span>
          </button>
        </div>
      </header>
      <div className="document-queue-tools">
        <label className="document-queue-search">
          <Search size={14} aria-hidden="true" />
          <span className="sr-only">Buscar por pet, tutor ou arquivo</span>
          <input
            type="search"
            placeholder="Buscar por pet, tutor ou arquivo..."
            value={search}
            onChange={event => onSearchChange(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="document-queue-filter">
          <SlidersHorizontal size={14} aria-hidden="true" />
          <span className="sr-only">Filtrar exames</span>
          <select
            aria-label="Filtrar exames"
            value={filter}
            onChange={event => onFilterChange(event.target.value as DocumentFilter)}
          >
            {filters.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <ChevronDown size={13} aria-hidden="true" />
        </label>
      </div>
      {loading ? (
        <div className="document-queue-feedback" role="status">
          <Loader2 size={24} className="animate-spin" aria-hidden="true" />
          <p>Carregando exames…</p>
        </div>
      ) : error ? (
        <div className="document-queue-feedback is-error" role="alert">
          <FileText size={26} aria-hidden="true" />
          <h2>Não foi possível carregar</h2>
          <p>Confira sua conexão e tente novamente.</p>
          <button type="button" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? 'Atualizando…' : 'Tentar novamente'}
          </button>
        </div>
      ) : documents.length === 0 ? (
        <div className="document-queue-feedback">
          <FileText size={28} aria-hidden="true" />
          <h2>{search ? 'Nenhum exame encontrado' : 'Nenhum exame nesta lista'}</h2>
          <p>{search ? 'Tente outro nome ou ajuste o filtro.' : 'Os exames recebidos aparecerão aqui.'}</p>
        </div>
      ) : (
        <div className="document-queue-list" aria-busy={refreshing}>
          <div className="document-queue-columns" aria-hidden="true">
            <span>Paciente</span>
            <span>Exame e data</span>
            <span>Responsável</span>
            <span>Pendências</span>
            <span />
          </div>
          <ul aria-label="Exames recebidos">
            {documents.map(doc => <DocumentQueueRow key={doc.id} doc={doc} />)}
          </ul>
        </div>
      )}
      {!loading && !error && total > 0 && (
        <footer className="document-queue-pagination">
          <span>{documents.length ? `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, total)} de ${total}` : `${total} exames`}</span>
          <nav aria-label="Paginação dos exames">
            <button type="button" aria-label="Página anterior" disabled={page === 0 || refreshing} onClick={() => onPageChange(page - 1)}>
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
            <span aria-live="polite">{page + 1} / {pages}</span>
            <button type="button" aria-label="Próxima página" disabled={(page + 1) * pageSize >= total || refreshing} onClick={() => onPageChange(page + 1)}>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </nav>
        </footer>
      )}

      {/* VISÃO EXCLUSIVA DE IMPRESSÃO (A4 / VETERINÁRIOS) */}
      <div className="document-queue-print-view" aria-hidden="true">
        <header className="document-queue-print-header">
          <div className="document-queue-print-brand">
            <div className="document-queue-print-logo">
              <Stethoscope size={18} strokeWidth={2} aria-hidden="true" />
              <span>Pam Laudos · PamVet</span>
            </div>
            <span className="document-queue-print-badge">Controle Clínico</span>
          </div>
          <div className="document-queue-print-title-row">
            <div>
              <h2 className="document-queue-print-title">Lista de Exames Recebidos</h2>
              <p className="document-queue-print-meta">
                <span><strong>Filtro:</strong> {currentFilterLabel}</span>
                {search.trim() && <span> · <strong>Busca:</strong> &ldquo;{search.trim()}&rdquo;</span>}
                <span> · <strong>Total:</strong> {printItems.length} {printItems.length === 1 ? 'exame' : 'exames'}</span>
              </p>
            </div>
            <div className="document-queue-print-timestamp">
              <small>Emissão</small>
              <span>{printDate}</span>
            </div>
          </div>
        </header>

        <table className="document-queue-print-table">
          <thead>
            <tr>
              <th className="th-check">Check</th>
              <th className="th-patient">Paciente / Tutor</th>
              <th className="th-exam">Exame / Data</th>
              <th className="th-vet">Responsável</th>
              <th className="th-pending">Etapas / SLA</th>
            </tr>
          </thead>
          <tbody>
            {printItems.map(doc => {
              const pet = field(doc, 'pet_name', 'Pet a identificar')
              const tutor = field(doc, 'client_name', 'Tutor a identificar')
              const exam = field(doc, 'exam_type', 'Exame a identificar')
              const responsible = doc.responsible_vet_name || doc.assigned_name || 'Sem responsável'
              const date = examDate(doc)
              const days = parseDaysInGroup(doc)
              const progress = getExamDetailProgress(doc)
              const stages = getDocumentStages(doc, progress, 10)
              return (
                <tr key={doc.id}>
                  <td className="td-check">
                    <span className="print-box" />
                  </td>
                  <td className="td-patient">
                    <strong className="print-pet">{pet}</strong>
                    <span className="print-tutor">{tutor}</span>
                  </td>
                  <td className="td-exam">
                    <span className="print-exam">{exam}</span>
                    <span className="print-date">
                      <CalendarDays size={8} aria-hidden="true" />
                      {date || 'Data a conferir'}
                    </span>
                  </td>
                  <td className="td-vet">
                    <div className="print-vet">
                      <span className="print-avatar" aria-hidden="true">
                        {doc.responsible_vet_id && doc.responsible_vet_avatar_url ? (
                          <img src={doc.responsible_vet_avatar_url} alt="" />
                        ) : (
                          <UserRound size={9} />
                        )}
                      </span>
                      <span className="print-vet-name">{responsible}</span>
                    </div>
                  </td>
                  <td className="td-pending">
                    <div className="print-pending">
                      <div className="print-stages">
                        {stages.map(stage => (
                          <span
                            key={stage.label}
                            className={`print-stage-pill${stage.done ? ' is-done' : stage.attention ? ' needs-attention' : ''}`}
                            title={stage.label}
                          >
                            {stage.icon}
                          </span>
                        ))}
                      </div>
                      {days !== null && (
                        <span className={`print-sla${days >= 4 ? ' is-late' : days >= 2 ? ' is-warning' : ''}`}>
                          {days === 0 ? 'hoje' : `${days}d`}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        <footer className="document-queue-print-footer">
          <span>Pam Laudos · Triagem e Rastreabilidade de Exames</span>
          <span>Conferência clínica e entrega aos veterinários</span>
        </footer>
      </div>
    </section>
  )
}
