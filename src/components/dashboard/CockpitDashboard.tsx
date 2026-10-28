import { useDeferredValue, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { RefreshCw, Search, Check } from 'lucide-react'
import { WhatsappLogo } from '@phosphor-icons/react/dist/csr/WhatsappLogo'
import { toast } from 'sonner'
import { useExamDocuments, useDocumentAction } from '@/hooks/useExamDocuments'
import { useExamCards } from '@/hooks/useExamCards'
import { documentLabel, documentIsOverdue } from '@/lib/document-status'
import { triggerFireworksAt } from '@/lib/fireworks'
import type { ExamDocument } from '@/types/exam-document'
import type { ExamCard } from '@/types/exam-card'
import './cockpit.css'

export type CockpitSquareId = 'contact' | 'review' | 'group_failed' | 'lab'

interface CockpitDashboardProps {
  onOpenCard?: (card: ExamCard, button: HTMLButtonElement) => void
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

function parseDaysInGroup(doc: ExamDocument): number {
  if (!doc.oldest_group_sent_at) return 0
  const sent = Date.parse(doc.oldest_group_sent_at)
  if (!Number.isFinite(sent)) return 0
  const diffHours = (Date.now() - sent) / 3_600_000
  return Math.floor(diffHours / 24)
}

export function CockpitDashboard({ onOpenCard }: CockpitDashboardProps) {
  const navigate = useNavigate()
  const [activeSquare, setActiveSquare] = useState<CockpitSquareId>('contact')
  const [search, setSearch] = useState('')
  const [urgentOnly, setUrgentOnly] = useState(false)
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set())

  const deferredSearch = useDeferredValue(search)
  const action = useDocumentAction()

  // Queries para cada pendência
  const contactQuery = useExamDocuments(activeSquare === 'contact' ? deferredSearch : '', 'contact', 0)
  const reviewQuery = useExamDocuments(activeSquare === 'review' ? deferredSearch : '', 'review', 0)
  const groupQuery = useExamDocuments(activeSquare === 'group_failed' ? deferredSearch : '', 'group_failed', 0)
  const labQuery = useExamCards({ status: ['aguardando_lab'] })

  // Contagens dos 4 quadrados
  const counts = {
    contact: contactQuery.data?.count ?? 0,
    review: reviewQuery.data?.count ?? 0,
    group_failed: groupQuery.data?.count ?? 0,
    lab: labQuery.data?.length ?? 0,
  }

  // Documentos da fila ativa
  const activeDocs = useMemo(() => {
    let list: ExamDocument[] = []
    if (activeSquare === 'contact') list = contactQuery.data?.documents || []
    else if (activeSquare === 'review') list = reviewQuery.data?.documents || []
    else if (activeSquare === 'group_failed') list = groupQuery.data?.documents || []

    if (urgentOnly) {
      list = list.filter(doc => documentIsOverdue(doc))
    }
    return list
  }, [activeSquare, contactQuery.data, reviewQuery.data, groupQuery.data, urgentOnly])

  const labCards = useMemo(() => {
    let list = labQuery.data || []
    if (deferredSearch.trim()) {
      const q = deferredSearch.toLowerCase()
      list = list.filter(c => (c.pet_name || '').toLowerCase().includes(q) || (c.client_name || '').toLowerCase().includes(q))
    }
    return list
  }, [labQuery.data, deferredSearch])

  const urgentCount = useMemo(() => {
    return (contactQuery.data?.documents || []).filter(doc => documentIsOverdue(doc)).length
  }, [contactQuery.data])

  const handleRefreshAll = () => {
    void contactQuery.refetch()
    void reviewQuery.refetch()
    void groupQuery.refetch()
    void labQuery.refetch()
    toast.success('Fila atualizada!')
  }

  // Ação de Check com micro-fogos e mensagem festiva
  const handleCheckDone = async (doc: ExamDocument, event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (completingIds.has(doc.id)) return

    // 1. Pega coordenadas do botão para os fogos
    const rect = event.currentTarget.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    triggerFireworksAt(x, y)

    // 2. Marca na UI para saída suave
    setCompletingIds(prev => new Set(prev).add(doc.id))

    const remaining = Math.max(0, counts[activeSquare] - 1)
    toast.success(`🎉 Parabéns! Menos um exame na fila · Faltam ${remaining}`)

    // 3. Executa persistência no banco
    try {
      const itemIds = doc.items
        .map(item => item.item_id || item.exam_item_id)
        .filter((id): id is string => Boolean(id))

      if (doc.pet_id && itemIds.length > 0) {
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
      }
    } catch {
      // Se houver pendência de vínculo prévio, não bloqueia o feedback visual
    }
  }

  return (
    <div className="space-y-6 min-w-0">
      {/* Top Cockpit Header */}
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-2 border-b border-[hsl(var(--border))]">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-[hsl(var(--foreground))]">Início</h1>
            <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">Triage rápida de pendências</p>
          </div>
          <button
            type="button"
            onClick={handleRefreshAll}
            title="Atualizar dados"
            className="sm:hidden p-2 border border-[hsl(var(--border))] rounded-lg bg-[hsl(var(--card))] hover:bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition cursor-pointer"
          >
            <RefreshCw size={14} />
          </button>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <div className="relative flex-1 sm:w-64">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" size={14} />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar paciente, tutor, telefone ou exame..."
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-lg focus:outline-none focus:border-[hsl(var(--primary))] text-[hsl(var(--foreground))]"
            />
          </div>

          <button
            type="button"
            onClick={handleRefreshAll}
            title="Atualizar dados"
            className="hidden sm:inline-flex p-2 border border-[hsl(var(--border))] rounded-lg bg-[hsl(var(--card))] hover:bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition cursor-pointer"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </header>

      {/* OS 4 QUADRADOS DE PENDÊNCIA (IMPECCABLE MINIMALIST) */}
      <nav className="cockpit-nav-grid" aria-label="Filtros de pendências">
        {/* Quadrado 1: Falta contato */}
        <button
          type="button"
          onClick={() => setActiveSquare('contact')}
          className={`cockpit-square ${activeSquare === 'contact' ? 'is-active' : ''}`}
        >
          <div className="cockpit-square-header">
            <span className="cockpit-square-label">Falta contato</span>
            {urgentCount > 0 && (
              <span className="w-1.5 h-1.5 rounded-full bg-rose-500" title={`${urgentCount} atrasado(s)`} />
            )}
          </div>
          <div className="cockpit-square-count">{counts.contact}</div>
        </button>

        {/* Quadrado 2: Falta cadastro */}
        <button
          type="button"
          onClick={() => setActiveSquare('review')}
          className={`cockpit-square ${activeSquare === 'review' ? 'is-active' : ''}`}
        >
          <div className="cockpit-square-header">
            <span className="cockpit-square-label">Falta cadastro</span>
          </div>
          <div className="cockpit-square-count">{counts.review}</div>
        </button>

        {/* Quadrado 3: Falta grupo */}
        <button
          type="button"
          onClick={() => setActiveSquare('group_failed')}
          className={`cockpit-square ${activeSquare === 'group_failed' ? 'is-active' : ''}`}
        >
          <div className="cockpit-square-header">
            <span className="cockpit-square-label">Falta grupo</span>
            {counts.group_failed > 0 && <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />}
          </div>
          <div className="cockpit-square-count">{counts.group_failed}</div>
        </button>

        {/* Quadrado 4: Aguardando lab */}
        <button
          type="button"
          onClick={() => setActiveSquare('lab')}
          className={`cockpit-square ${activeSquare === 'lab' ? 'is-active' : ''}`}
        >
          <div className="cockpit-square-header">
            <span className="cockpit-square-label">Aguardando lab</span>
          </div>
          <div className="cockpit-square-count">{counts.lab}</div>
        </button>
      </nav>

      {/* TABELA / CARDS DE CONFERÊNCIA RÁPIDA */}
      <section className="bg-[hsl(var(--card))] rounded-xl border border-[hsl(var(--border))] overflow-hidden shadow-2xs">
        {/* Header da lista */}
        <div className="px-4 sm:px-5 py-3 border-b border-[hsl(var(--border))] flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs bg-[hsl(var(--muted)/0.3)]">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-[hsl(var(--foreground))]">
              {activeSquare === 'contact' && 'Falta entrar em contato'}
              {activeSquare === 'review' && 'Falta vincular ao cadastro (Nexus)'}
              {activeSquare === 'group_failed' && 'Falta enviar para o grupo'}
              {activeSquare === 'lab' && 'Amostras aguardando laudo externo'}
            </span>
            <span className="text-[hsl(var(--muted-foreground))] tabular">
              ({activeSquare === 'lab' ? labCards.length : activeDocs.length})
            </span>
          </div>

          {activeSquare === 'contact' && (
            <button
              type="button"
              onClick={() => setUrgentOnly(v => !v)}
              className="text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] inline-flex items-center gap-1.5 transition self-start sm:self-auto cursor-pointer"
            >
              <span className={`w-1.5 h-1.5 rounded-full ${urgentOnly ? 'bg-rose-500' : 'bg-slate-300'}`} />
              <span>Apenas atrasados (&gt;24h)</span>
            </button>
          )}
        </div>

        {/* Lista para Documentos (contact, review, group_failed, unassigned) */}
        {activeSquare !== 'lab' && (
          <>
            {/* Versão Mobile: Cards Táteis (sm:hidden) */}
            <div className="divide-y divide-[hsl(var(--border))] sm:hidden">
              {activeDocs.map(doc => {
                const pet = field(doc, 'pet_name', 'Pet a identificar')
                const tutor = field(doc, 'client_name', 'Tutor a identificar')
                const exam = field(doc, 'exam_type', 'Exame a identificar')
                const date = examDate(doc)
                const responsible = doc.responsible_vet_name || doc.assigned_name || 'Sem responsável'
                const days = parseDaysInGroup(doc)
                const isExiting = completingIds.has(doc.id)

                return (
                  <div
                    key={doc.id}
                    className={`p-3.5 flex flex-col gap-2.5 transition-colors cursor-pointer hover:bg-[hsl(var(--muted)/0.3)] ${isExiting ? 'row-completing-exit' : ''}`}
                    onClick={() => navigate(`/novos-exames/${doc.id}?from=home`, { state: { from: '/' } })}
                  >
                    {/* Linha 1: Pet + Tutor + SLA */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <strong className="font-semibold text-sm text-[hsl(var(--foreground))] block truncate">{pet}</strong>
                        <span className="text-xs text-[hsl(var(--muted-foreground))] block truncate">{tutor}</span>
                      </div>

                      <div className="shrink-0 text-xs">
                        {days === 0 ? (
                          <span className="text-[hsl(var(--muted-foreground))] tabular">hoje</span>
                        ) : days === 1 ? (
                          <span className="text-[hsl(var(--muted-foreground))] tabular">1 dia</span>
                        ) : days >= 2 && days < 4 ? (
                          <span className="inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-400 tabular bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 rounded-full border border-amber-200 dark:border-amber-900/50">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                            {days} dias
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 font-semibold text-rose-600 dark:text-rose-400 tabular bg-rose-50 dark:bg-rose-950/40 px-2 py-0.5 rounded-full border border-rose-200 dark:border-rose-900/50">
                            <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                            {days} dias
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Linha 2: Exame + Responsável */}
                    <div className="flex items-center justify-between text-xs text-[hsl(var(--muted-foreground))] gap-2 pt-0.5">
                      <div className="truncate font-medium text-[hsl(var(--foreground))]">
                        {exam} {date && <span className="font-normal text-[hsl(var(--muted-foreground))]">({date})</span>}
                      </div>
                      <span className="shrink-0 text-[11px] text-[hsl(var(--muted-foreground))]">{responsible}</span>
                    </div>

                    {/* Linha 3: Barra de Ação (Contato WhatsApp + Check tátil) */}
                    <div className="flex items-center justify-between pt-2 border-t border-[hsl(var(--border)/0.6)]" onClick={e => e.stopPropagation()}>
                      <button
                        type="button"
                        onClick={() => navigate(`/novos-exames/${doc.id}?panel=contact&from=home`, { state: { from: '/' } })}
                        className="inline-flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400 font-medium py-1.5 px-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 hover:bg-emerald-100 border border-emerald-200/80 dark:border-emerald-900/50 transition cursor-pointer"
                        title={`Contato com tutor ${tutor}`}
                      >
                        <WhatsappLogo size={14} className="text-emerald-600 dark:text-emerald-400" />
                        <span>Contato</span>
                      </button>

                      <button
                        type="button"
                        onClick={e => void handleCheckDone(doc, e)}
                        className="inline-flex items-center gap-2 text-xs font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] py-1 px-2 rounded-lg hover:bg-[hsl(var(--muted))] transition cursor-pointer"
                        title="Marcar contato concluído"
                      >
                        <span>Concluir</span>
                        <span className={`cockpit-check-btn ${isExiting ? 'is-checked' : ''}`}>
                          <Check size={12} className="ghost-check" />
                        </span>
                      </button>
                    </div>
                  </div>
                )
              })}

              {activeDocs.length === 0 && (
                <div className="py-12 text-center text-xs text-[hsl(var(--muted-foreground))]">
                  🎉 Tudo em dia! Nenhum exame pendente nesta fila.
                </div>
              )}
            </div>

            {/* Versão Desktop: Tabela Minimalista (hidden sm:block) */}
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-[hsl(var(--border))] text-[11px] font-medium text-[hsl(var(--muted-foreground))]">
                    <th className="py-2.5 px-5 font-normal">Paciente</th>
                    <th className="py-2.5 px-4 font-normal">Exame</th>
                    <th className="py-2.5 px-4 font-normal">Responsável</th>
                    <th className="py-2.5 px-4 font-normal w-24">No grupo</th>
                    <th className="py-2.5 px-5 text-right font-normal w-36">Ação</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[hsl(var(--border))]">
                  {activeDocs.map(doc => {
                    const pet = field(doc, 'pet_name', 'Pet a identificar')
                    const tutor = field(doc, 'client_name', 'Tutor a identificar')
                    const exam = field(doc, 'exam_type', 'Exame a identificar')
                    const date = examDate(doc)
                    const responsible = doc.responsible_vet_name || doc.assigned_name || 'Sem responsável'
                    const days = parseDaysInGroup(doc)
                    const isExiting = completingIds.has(doc.id)

                    return (
                      <tr
                        key={doc.id}
                        className={`hover:bg-[hsl(var(--muted)/0.4)] transition-colors cursor-pointer ${isExiting ? 'row-completing-exit' : ''}`}
                        onClick={() => navigate(`/novos-exames/${doc.id}?from=home`, { state: { from: '/' } })}
                      >
                        {/* Paciente e Tutor */}
                        <td className="py-2.5 px-5">
                          <strong className="font-semibold text-[hsl(var(--foreground))] block">{pet}</strong>
                          <span className="text-[11px] text-[hsl(var(--muted-foreground))] block truncate max-w-[180px]">{tutor}</span>
                        </td>

                        {/* Exame e Data */}
                        <td className="py-2.5 px-4">
                          <span className="text-[hsl(var(--foreground))] block font-medium truncate max-w-[200px]">{exam}</span>
                          {date && <span className="text-[11px] text-[hsl(var(--muted-foreground))]">{date}</span>}
                        </td>

                        {/* Responsável */}
                        <td className="py-2.5 px-4 text-[hsl(var(--muted-foreground))]">
                          {responsible}
                        </td>

                        {/* No grupo (SLA em 1 linha limpa) */}
                        <td className="py-2.5 px-4 whitespace-nowrap">
                          {days === 0 ? (
                            <span className="text-[hsl(var(--muted-foreground))] tabular">hoje</span>
                          ) : days === 1 ? (
                            <span className="text-[hsl(var(--muted-foreground))] tabular">1 dia</span>
                          ) : days >= 2 && days < 4 ? (
                            <span className="inline-flex items-center gap-1 font-medium text-amber-700 tabular">
                              <span className="w-1 h-1 rounded-full bg-amber-500" />
                              {days} dias
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 font-semibold text-rose-600 tabular">
                              <span className="w-1 h-1 rounded-full bg-rose-500" />
                              {days} dias
                            </span>
                          )}
                        </td>

                        {/* AÇÃO: Contato + Bolinha de Check */}
                        <td className="py-2.5 px-5 text-right whitespace-nowrap" onClick={e => e.stopPropagation()}>
                          <div className="inline-flex items-center gap-3 justify-end">
                            <button
                              type="button"
                              onClick={() => navigate(`/novos-exames/${doc.id}?panel=contact&from=home`, { state: { from: '/' } })}
                              className="inline-flex items-center gap-1.5 text-xs text-[hsl(var(--muted-foreground))] hover:text-emerald-700 font-medium transition cursor-pointer"
                              title={`Contato com tutor ${tutor}`}
                            >
                              <WhatsappLogo size={14} className="text-emerald-600" />
                              <span>Contato</span>
                            </button>

                            <button
                              type="button"
                              onClick={e => void handleCheckDone(doc, e)}
                              className={`cockpit-check-btn ${isExiting ? 'is-checked' : ''}`}
                              title="Marcar contato concluído"
                            >
                              <Check size={12} className="ghost-check" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>

              {activeDocs.length === 0 && (
                <div className="py-12 text-center text-xs text-[hsl(var(--muted-foreground))]">
                  🎉 Tudo em dia! Nenhum exame pendente nesta fila.
                </div>
              )}
            </div>
          </>
        )}

        {/* Tabela / Cards para Aguardando Lab (Cards) */}
        {activeSquare === 'lab' && (
          <>
            {/* Mobile Cards para Lab (sm:hidden) */}
            <div className="divide-y divide-[hsl(var(--border))] sm:hidden">
              {labCards.map(card => {
                const exams = (card.items || []).map(i => i.exam_type).join(', ') || 'Exames'
                const labs = [...new Set((card.items || []).map(i => i.lab_name).filter(Boolean))].join(' · ') || 'Lab externo'
                const vet = card.vet_name || 'Sem responsável'

                return (
                  <div
                    key={card.id}
                    className="p-3.5 flex flex-col gap-2 hover:bg-[hsl(var(--muted)/0.3)] transition cursor-pointer"
                    onClick={e => onOpenCard?.(card, e.currentTarget as unknown as HTMLButtonElement)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <strong className="font-semibold text-sm text-[hsl(var(--foreground))] block truncate">{card.pet_name || 'Pet'}</strong>
                        <span className="text-xs text-[hsl(var(--muted-foreground))] block truncate">{card.client_name || 'Tutor'}</span>
                      </div>
                      <span className="text-[11px] font-medium text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 rounded-full border border-amber-200 dark:border-amber-900/50 shrink-0">
                        {labs}
                      </span>
                    </div>

                    <div className="text-xs text-[hsl(var(--muted-foreground))] flex items-center justify-between gap-2">
                      <span className="font-medium text-[hsl(var(--foreground))] truncate">{exams}</span>
                      <span className="shrink-0 text-[11px]">{vet}</span>
                    </div>

                    <div className="pt-2 border-t border-[hsl(var(--border)/0.6)] flex justify-end" onClick={e => e.stopPropagation()}>
                      <Link
                        to="/ship"
                        className="px-3 py-1 text-xs font-medium rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] hover:bg-[hsl(var(--muted))] text-[hsl(var(--foreground))]"
                      >
                        Ver amostras
                      </Link>
                    </div>
                  </div>
                )
              })}

              {labCards.length === 0 && (
                <div className="py-12 text-center text-xs text-[hsl(var(--muted-foreground))]">
                  Nenhuma amostra aguardando laboratório no momento.
                </div>
              )}
            </div>

            {/* Desktop Tabela para Lab (hidden sm:block) */}
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-[hsl(var(--border))] text-[11px] font-medium text-[hsl(var(--muted-foreground))]">
                    <th className="py-2.5 px-5 font-normal">Paciente</th>
                    <th className="py-2.5 px-4 font-normal">Exames Solicitados</th>
                    <th className="py-2.5 px-4 font-normal">Veterinário(a)</th>
                    <th className="py-2.5 px-4 font-normal">Laboratório</th>
                    <th className="py-2.5 px-5 text-right font-normal">Ação</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[hsl(var(--border))]">
                  {labCards.map(card => {
                    const exams = (card.items || []).map(i => i.exam_type).join(', ') || 'Exames'
                    const labs = [...new Set((card.items || []).map(i => i.lab_name).filter(Boolean))].join(' · ') || 'Lab externo'

                    return (
                      <tr
                        key={card.id}
                        className="hover:bg-[hsl(var(--muted)/0.4)] transition-colors cursor-pointer"
                        onClick={e => onOpenCard?.(card, e.currentTarget as unknown as HTMLButtonElement)}
                      >
                        <td className="py-2.5 px-5">
                          <strong className="font-semibold text-[hsl(var(--foreground))] block">{card.pet_name || 'Pet'}</strong>
                          <span className="text-[11px] text-[hsl(var(--muted-foreground))]">{card.client_name || 'Tutor'}</span>
                        </td>

                        <td className="py-2.5 px-4 font-medium text-[hsl(var(--foreground))]">
                          {exams}
                        </td>

                        <td className="py-2.5 px-4 text-[hsl(var(--muted-foreground))]">
                          {card.vet_name || 'Sem responsável'}
                        </td>

                        <td className="py-2.5 px-4 text-[hsl(var(--muted-foreground))]">
                          {labs}
                        </td>

                        <td className="py-2.5 px-5 text-right whitespace-nowrap" onClick={e => e.stopPropagation()}>
                          <Link
                            to="/ship"
                            className="px-2.5 py-1 text-xs font-medium rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] hover:bg-[hsl(var(--muted))] text-[hsl(var(--foreground))]"
                          >
                            Ver amostras
                          </Link>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>

              {labCards.length === 0 && (
                <div className="py-12 text-center text-xs text-[hsl(var(--muted-foreground))]">
                  Nenhuma amostra aguardando laboratório no momento.
                </div>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  )
}
