import { useState } from 'react'
import { X, Clock, User, Phone, Mail, Stethoscope, ShoppingBag, AlertTriangle, Pencil, Trash2, Plus } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { toast } from 'sonner'
import { useExamCardLogs } from '@/hooks/useExamCards'
import { useDeleteCard } from '@/hooks/useExamCardMutations'
import { StatusBadge } from './StatusBadge'
import { ExamItemRow } from './ExamItemRow'
import { ContactModal } from './ContactModal'
import { EditCardModal } from './EditCardModal'
import { ConfirmDialog } from './ConfirmDialog'
import { formatDate, formatHours, cn } from '@/lib/utils'
import { dialogVariants, overlayVariants } from '@/lib/animations'
import type { ExamCard, ExamItem, ExamCardLog } from '@/types/exam-card'

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

  const { data: logs } = useExamCardLogs(card.id)
  const deleteCard = useDeleteCard()

  const petLabel = card.pet_name ?? '—'
  const clientLabel = card.client_name ?? '—'

  async function handleDeleteCard() {
    try {
      await deleteCard.mutateAsync(card.id)
      toast.success('Card excluído')
      onClose()
    } catch {
      toast.error('Erro ao excluir card')
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
                  <span className="ml-2 text-amber-600 dark:text-amber-400">· Sem venda vinculada</span>
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
              <button
                onClick={() => setShowDeleteCard(true)}
                title="Excluir card"
                className="w-7 h-7 flex items-center justify-center rounded-lg text-[hsl(var(--muted-foreground))] hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-all"
              >
                <Trash2 className="w-3.5 h-3.5" />
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
                  icon={card.origin === 'venda' ? ShoppingBag : Mail}
                  label="Origem"
                  value={card.origin === 'venda' ? 'Venda' : 'Email'}
                />
                <InfoItem
                  icon={Clock}
                  label="Tempo decorrido"
                  value={formatHours(card.hours_elapsed)}
                />
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
                        onContactClick={setContactingItem}
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
        {contactingItem && (
          <ContactModal
            item={contactingItem}
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
            title="Excluir card"
            description={`Isso vai excluir permanentemente o card de ${petLabel} e todos os seus exames. Esta ação não pode ser desfeita.`}
            loading={deleteCard.isPending}
            onConfirm={handleDeleteCard}
            onClose={() => setShowDeleteCard(false)}
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
        className="w-full flex items-center gap-2 px-4 py-2.5 text-xs text-[hsl(var(--muted-foreground))]/60 hover:text-[hsl(var(--primary))] hover:bg-[hsl(var(--primary))]/5 transition-all"
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
