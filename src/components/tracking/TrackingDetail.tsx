import { useState } from 'react'
import { X, Clock, User, Phone, Mail, Stethoscope, ShoppingBag, AlertTriangle, Pencil, Trash2, Plus, CheckCircle2, GitMerge, Archive, FileText, MessageCircle } from 'lucide-react'
import { Link } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { toast } from 'sonner'
import { useExamCardLogs, useMarkAllContacted } from '@/hooks/useExamCards'
import { useDeleteCard } from '@/hooks/useExamCardMutations'
import { useVets } from '@/hooks/useVets'
import { StatusBadge } from './StatusBadge'
import { ExamItemRow } from './ExamItemRow'
import { ContactModal } from './ContactModal'
import { EditCardModal } from './EditCardModal'
import { ConfirmDialog } from './ConfirmDialog'
import { MergeCardModal } from './MergeCardModal'
import { formatDate, formatHours, cn } from '@/lib/utils'
import { elapsedHoursForDisplay } from '@/lib/group-time'
import { dialogVariants, overlayVariants } from '@/lib/animations'
import { isManagedExamItem, type ExamCard, type ExamItem, type ExamCardLog } from '@/types/exam-card'

interface TrackingDetailProps {
  card: ExamCard
  onClose: () => void
}

function InfoItem({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ElementType
  label: string
  value: string | null | undefined
}) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="w-7 h-7 rounded-lg bg-[hsl(var(--muted))] flex items-center justify-center shrink-0 mt-0.5">
        <Icon className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))]" />
      </div>
      <div>
        <p className="text-xs text-[hsl(var(--muted-foreground))]">{label}</p>
        <p className="text-sm font-medium text-[hsl(var(--foreground))]">{value || '—'}</p>
      </div>
    </div>
  )
}

function LogItem({ log }: { log: ExamCardLog }) {
  return (
    <div className="flex gap-3 text-sm">
      <div className="flex flex-col items-center">
        <div className="w-2 h-2 rounded-full bg-[hsl(var(--primary))] mt-1.5 shrink-0" />
        <div className="w-px flex-1 bg-[hsl(var(--border))] mt-1" />
      </div>
      <div className="pb-4 min-w-0">
        <p className="font-medium text-[hsl(var(--foreground))]">{log.new_status}</p>
        {log.change_reason && (
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">{log.change_reason}</p>
        )}
        <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">{formatDate(log.created_at)}</p>
      </div>
    </div>
  )
}

export function TrackingDetail({ card, onClose }: TrackingDetailProps) {
  const [contactingItem, setContactingItem] = useState<ExamItem | null>(null)
  const [showEdit, setShowEdit] = useState(false)
  const [showDeleteCard, setShowDeleteCard] = useState(false)
  const [showConclude, setShowConclude] = useState(false)
  const [showMerge, setShowMerge] = useState(false)
  const [concludeVet, setConcludeVet] = useState(card.vet_name ?? '')
  const [selectedLegacyItemIds, setSelectedLegacyItemIds] = useState<string[]>([])

  const { data: logs } = useExamCardLogs(card.id)
  const { data: vets } = useVets()
  const deleteCard = useDeleteCard()
  const markAllContacted = useMarkAllContacted()

  const petLabel = card.pet_name ?? '—'
  const clientLabel = card.client_name ?? '—'

  const documentIds = [...new Set((card.items ?? []).flatMap((item) => item.document_ids ?? []))]
  const hasManagedItems = documentIds.length > 0
  const pendingLegacyContactItems = (card.items ?? []).filter(
    (item) => item.result_received && !item.contacted && !isManagedExamItem(item)
  )
  const allContacted = (card.items ?? []).length > 0 && (card.items ?? []).every((i) => i.contacted)
  const selectedLegacyItems = pendingLegacyContactItems.filter((item) => selectedLegacyItemIds.includes(item.id))
  const itemsToContact = hasManagedItems ? selectedLegacyItems : pendingLegacyContactItems
  const hasReadyLegacyItems = pendingLegacyContactItems.length > 0
  const activeContactItem = contactingItem && (card.items ?? []).find((item) => item.id === contactingItem.id)
  const originLabel = { venda: 'Venda', email: 'Email', whatsapp: 'WhatsApp', manual: 'Envio manual' }[card.origin]
  const OriginIcon = card.origin === 'venda' ? ShoppingBag : card.origin === 'whatsapp' ? MessageCircle : card.origin === 'manual' ? FileText : Mail

  async function handleConclude() {
    if (markAllContacted.isPending) return
    if (!concludeVet.trim()) return toast.error('Selecione o veterinário')
    if (itemsToContact.length === 0) return toast.error('Selecione os exames sem documento que tiveram contato')
    try {
      await markAllContacted.mutateAsync({
        cardId: card.id,
        itemIds: itemsToContact.map((item) => item.id),
        contactedBy: concludeVet.trim(),
      })
      toast.success(hasManagedItems ? `Contato registrado para ${itemsToContact.length} exame(s) sem documento` : 'Contato registrado')
      setShowConclude(false)
      setSelectedLegacyItemIds([])
      onClose()
    } catch {
      toast.error('Erro ao concluir')
    }
  }

  async function handleDeleteCard() {
    if (deleteCard.isPending) return
    try {
      await deleteCard.mutateAsync(card.id)
      toast.success(hasManagedItems ? 'Card arquivado; documentos e histórico preservados' : 'Card excluído')
      onClose()
    } catch {
      toast.error(hasManagedItems ? 'Erro ao arquivar card' : 'Erro ao excluir card')
    }
  }

  return (
    <>
      <motion.div
        variants={overlayVariants}
        initial="initial"
        animate="animate"
        exit="exit"
        className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-40 p-4"
        onClick={onClose}
      >
        <motion.div
          variants={dialogVariants}
          className="bg-[hsl(var(--card))] rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="px-6 py-4 border-b border-[hsl(var(--border))] flex items-start justify-between gap-4 shrink-0">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {card.is_orphan && (
                  <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
                )}
                <h2 className="text-base font-bold text-[hsl(var(--foreground))] leading-tight">
                  {petLabel}
                </h2>
              </div>
              <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">
                {clientLabel}
                {card.is_orphan && (
                  <>
                    <ShoppingBag className="w-3 h-3 ml-2 text-red-500 dark:text-red-400 no-sale-icon inline" />
                    <span className="ml-1 text-red-500 dark:text-red-400 text-xs">Sem venda</span>
                  </>
                )}
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <StatusBadge status={card.status} alertLevel={card.alert_level} />
              <button
                onClick={() => setShowEdit(true)}
                title="Editar"
                className="w-7 h-7 flex items-center justify-center rounded-lg text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))] transition-all"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              {card.status !== 'contato_realizado' && (
                <button
                  onClick={() => setShowMerge(true)}
                  title="Fundir cards"
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--primary))] hover:bg-[hsl(var(--primary))]/10 transition-all"
                >
                  <GitMerge className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                onClick={() => setShowDeleteCard(true)}
                title={hasManagedItems ? 'Arquivar card' : 'Excluir card'}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-[hsl(var(--muted-foreground))] hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-all"
              >
                {hasManagedItems ? <Archive className="w-3.5 h-3.5" /> : <Trash2 className="w-3.5 h-3.5" />}
              </button>
              <button
                onClick={onClose}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))] transition-all"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="overflow-y-auto flex-1">
            <div className="p-6 space-y-6">
              {/* Info grid */}
              <div className="grid grid-cols-2 gap-4">
                <InfoItem
                  icon={OriginIcon}
                  label="Origem"
                  value={originLabel}
                />
                <InfoItem
                  icon={Clock}
                  label="Tempo decorrido"
                  value={formatHours(card.hours_elapsed)}
                />
                {card.group_sent_at && (
                  <InfoItem icon={Clock} label="Colocado no grupo em" value={formatDate(card.group_sent_at)} />
                )}
                {card.status === 'no_grupo' && (
                  <InfoItem icon={Clock} label="Tempo no grupo" value={formatHours(elapsedHoursForDisplay(card))} />
                )}
                <InfoItem icon={Clock} label="Criado em" value={formatDate(card.created_at)} />
                <InfoItem icon={User} label="Pet" value={petLabel} />
                <InfoItem icon={User} label="Tutor" value={clientLabel} />
                {card.client_phone && (
                  <InfoItem icon={Phone} label="Telefone" value={card.client_phone} />
                )}
                {card.client_email && (
                  <InfoItem icon={Mail} label="Email" value={card.client_email} />
                )}
                {card.vet_name && (
                  <InfoItem icon={Stethoscope} label="Veterinário" value={card.vet_name} />
                )}
              </div>

              {/* Conclude contact — quick action */}
              {allContacted && (
                <div className="flex items-center gap-3 p-3 rounded-xl bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800/50">
                  <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400 shrink-0" />
                  <span className="text-sm font-medium text-green-700 dark:text-green-300">Contato concluído</span>
                </div>
              )}

              {hasManagedItems && (
                <div className="space-y-2">
                  <Link
                    to={documentIds.length === 1 ? `/novos-exames/${documentIds[0]}` : '/novos-exames'}
                    onClick={onClose}
                    className="w-full flex items-center justify-center gap-2 py-3 px-3 rounded-xl bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] text-sm font-semibold hover:opacity-90 transition-opacity"
                  >
                    <FileText className="w-4 h-4 shrink-0" />
                    {allContacted ? 'Ver documentos em Novos exames' : 'Registrar contato em Novos exames'}
                  </Link>
                  <p className="text-xs text-[hsl(var(--muted-foreground))]">
                    Abra cada documento nos links dos exames para registrar contato e revisar o resultado.
                  </p>
                </div>
              )}

              {hasReadyLegacyItems && !showConclude && (
                <button
                  onClick={() => { setSelectedLegacyItemIds([]); setShowConclude(true) }}
                  className={cn(
                    'w-full flex items-center justify-center gap-2 py-3 rounded-xl',
                    'bg-green-600 dark:bg-green-600 text-white text-sm font-semibold',
                    'shadow-sm shadow-green-600/20 hover:bg-green-700 active:scale-[0.98]',
                    'transition-all duration-200'
                  )}
                >
                  <CheckCircle2 className="w-4 h-4" />
                  {hasManagedItems ? 'Registrar contato dos itens sem documento' : 'Concluir contato'} ({pendingLegacyContactItems.length} exame{pendingLegacyContactItems.length !== 1 ? 's' : ''})
                </button>
              )}

              {showConclude && hasReadyLegacyItems && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="p-4 rounded-xl border border-green-200 dark:border-green-800/50 bg-green-50/50 dark:bg-green-950/20 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-green-700 dark:text-green-400 uppercase tracking-wider">
                      {hasManagedItems ? 'Contato dos itens sem documento' : 'Confirmar contato'}
                    </span>
                    <button
                      onClick={() => setShowConclude(false)}
                      className="w-6 h-6 flex items-center justify-center rounded-lg text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))] transition-all"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {hasManagedItems && (
                    <fieldset className="space-y-2">
                      <legend className="text-xs text-[hsl(var(--muted-foreground))] mb-2">
                        Selecione somente os exames abaixo para os quais houve contato com o tutor.
                      </legend>
                      {pendingLegacyContactItems.map((item) => (
                        <label key={item.id} className="flex items-center gap-2 text-sm cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selectedLegacyItemIds.includes(item.id)}
                            disabled={markAllContacted.isPending}
                            onChange={(event) => setSelectedLegacyItemIds((ids) => event.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id))}
                            className="accent-green-600"
                          />
                          {item.exam_type}
                        </label>
                      ))}
                    </fieldset>
                  )}
                  <div>
                    <label className="text-[11px] font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wider mb-1.5 block">
                      Veterinário responsável
                    </label>
                    <select
                      value={concludeVet}
                      disabled={markAllContacted.isPending}
                      onChange={(e) => setConcludeVet(e.target.value)}
                      className={cn(
                        'w-full h-10 px-3 text-sm rounded-xl border border-[hsl(var(--border))]',
                        'bg-[hsl(var(--background))] text-[hsl(var(--foreground))]',
                        'focus:outline-none focus:ring-2 focus:ring-green-500/30 focus:border-green-500',
                        'transition-all'
                      )}
                    >
                      <option value="">Selecionar…</option>
                      {vets?.map((vet) => (
                        <option key={vet.id} value={vet.nome}>{vet.nome}</option>
                      ))}
                    </select>
                  </div>
                  <p className="text-xs text-[hsl(var(--muted-foreground))]">
                    {new Date().toLocaleDateString('pt-BR')} às {new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                  </p>
                  <button
                    onClick={handleConclude}
                    disabled={!concludeVet.trim() || itemsToContact.length === 0 || markAllContacted.isPending}
                    className={cn(
                      'w-full h-11 rounded-xl text-sm font-bold flex items-center justify-center gap-2',
                      'bg-green-600 text-white shadow-sm shadow-green-600/20',
                      'hover:bg-green-700 active:scale-[0.98] disabled:opacity-50',
                      'transition-all duration-200'
                    )}
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    {markAllContacted.isPending ? 'Registrando…' : hasManagedItems ? `Confirmar ${itemsToContact.length} exame(s)` : 'Confirmar'}
                  </button>
                </motion.div>
              )}

              {/* Exam items */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide">
                    Exames
                  </h3>
                  <span className="text-xs text-[hsl(var(--muted-foreground))]">
                    {card.items_ready}/{card.items_total} prontos
                  </span>
                </div>
                <div className={cn(
                  'rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] divide-y divide-[hsl(var(--border))]'
                )}>
                  {card.items && card.items.map((item) => (
                    <div key={item.id} className="px-4 py-2">
                      <ExamItemRow
                        item={item}
                        cardId={card.id}
                        onContactClick={(selectedItem) => { if (!isManagedExamItem(selectedItem)) setContactingItem(selectedItem) }}
                      />
                    </div>
                  ))}
                  {/* Add item row */}
                  <AddItemRow cardId={card.id} />
                </div>
              </div>

              {/* Timeline */}
              {logs && logs.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide mb-4">
                    Histórico
                  </h3>
                  <div>
                    {logs.map((log) => (
                      <LogItem key={log.id} log={log} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </motion.div>
      </motion.div>

      <AnimatePresence>
        {activeContactItem && !isManagedExamItem(activeContactItem) && (
          <ContactModal
            item={activeContactItem}
            card={card}
            onClose={() => setContactingItem(null)}
          />
        )}
        {showEdit && (
          <EditCardModal
            card={card}
            onClose={() => setShowEdit(false)}
          />
        )}
        {showDeleteCard && (
          <ConfirmDialog
            title={hasManagedItems ? 'Arquivar card' : 'Excluir card'}
            description={hasManagedItems ? `O card de ${petLabel} será retirado do acompanhamento. Os documentos, contatos e o histórico serão preservados.` : `Isso vai excluir permanentemente o card de ${petLabel} e todos os seus exames. Esta ação não pode ser desfeita.`}
            confirmLabel={hasManagedItems ? 'Arquivar' : 'Excluir'}
            loadingLabel={hasManagedItems ? 'Arquivando…' : 'Excluindo…'}
            loading={deleteCard.isPending}
            onConfirm={handleDeleteCard}
            onClose={() => setShowDeleteCard(false)}
          />
        )}
        {showMerge && (
          <MergeCardModal
            card={card}
            onClose={() => setShowMerge(false)}
            onMerged={() => { setShowMerge(false); onClose() }}
          />
        )}
      </AnimatePresence>
    </>
  )
}

// ─── Inline add item ─────────────────────────────────────────────────────────

import { useAddItem } from '@/hooks/useExamCardMutations'

function AddItemRow({ cardId }: { cardId: string }) {
  const [open, setOpen] = useState(false)
  const [examType, setExamType] = useState('')
  const [labName, setLabName] = useState('')
  const addItem = useAddItem()

  async function handleAdd() {
    if (!examType.trim()) return
    try {
      await addItem.mutateAsync({
        exam_card_id: cardId,
        exam_type: examType.trim(),
        lab_name: labName.trim() || null,
      })
      toast.success('Exame adicionado')
      setExamType('')
      setLabName('')
      setOpen(false)
    } catch {
      toast.error('Erro ao adicionar exame')
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--primary))] hover:bg-[hsl(var(--primary))]/5 transition-all"
      >
        <Plus className="w-3.5 h-3.5" />
        Adicionar exame
      </button>
    )
  }

  return (
    <div className="px-4 py-3 flex items-center gap-2">
      <input
        autoFocus
        type="text"
        placeholder="Tipo de exame"
        value={examType}
        onChange={(e) => setExamType(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
        className={cn(
          'flex-1 h-8 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))]',
          'px-2.5 text-xs text-[hsl(var(--foreground))] focus:outline-none',
          'focus:ring-2 focus:ring-[hsl(var(--primary))]/40 focus:border-[hsl(var(--primary))]',
          'placeholder:text-[hsl(var(--muted-foreground))]/40'
        )}
      />
      <input
        type="text"
        placeholder="Lab (opcional)"
        value={labName}
        onChange={(e) => setLabName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
        className={cn(
          'w-28 h-8 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))]',
          'px-2.5 text-xs text-[hsl(var(--foreground))] focus:outline-none',
          'focus:ring-2 focus:ring-[hsl(var(--primary))]/40 focus:border-[hsl(var(--primary))]',
          'placeholder:text-[hsl(var(--muted-foreground))]/40'
        )}
      />
      <button
        onClick={handleAdd}
        disabled={!examType.trim() || addItem.isPending}
        className="h-8 px-3 rounded-lg text-xs font-semibold bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-40 transition-all"
      >
        OK
      </button>
      <button
        onClick={() => setOpen(false)}
        className="h-8 px-2 rounded-lg text-xs text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))] transition-all"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}
