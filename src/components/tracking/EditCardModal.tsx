import { useState } from 'react'
import { X, Save } from 'lucide-react'
import { motion } from 'framer-motion'
import { toast } from 'sonner'
import { useUpdateCard } from '@/hooks/useExamCardMutations'
import { dialogVariants, overlayVariants } from '@/lib/animations'
import { cn } from '@/lib/utils'
import type { ExamCard, CardStatus } from '@/types/exam-card'

const STATUS_LABELS: Record<CardStatus, string> = {
  aguardando_lab: 'Aguardando Lab',
  exame_pronto: 'Exame Pronto',
  contato_realizado: 'Contato Realizado',
  atrasado: 'Atrasado',
}

interface EditCardModalProps {
  card: ExamCard
  onClose: () => void
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-[hsl(var(--muted-foreground))]">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'h-9 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))]',
          'px-3 text-sm text-[hsl(var(--foreground))]',
          'focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary))]/40 focus:border-[hsl(var(--primary))]',
          'transition-all placeholder:text-[hsl(var(--muted-foreground))]/50'
        )}
      />
    </div>
  )
}

export function EditCardModal({ card, onClose }: EditCardModalProps) {
  const updateCard = useUpdateCard()

  const [petName, setPetName] = useState(card.pet_name ?? '')
  const [petSpecies, setPetSpecies] = useState(card.pet_species ?? '')
  const [petBreed, setPetBreed] = useState(card.pet_breed ?? '')
  const [clientName, setClientName] = useState(card.client_name ?? '')
  const [clientPhone, setClientPhone] = useState(card.client_phone ?? '')
  const [clientEmail, setClientEmail] = useState(card.client_email ?? '')
  const [vetName, setVetName] = useState(card.vet_name ?? '')
  const [status, setStatus] = useState<CardStatus>(card.status)

  async function handleSave() {
    try {
      await updateCard.mutateAsync({
        id: card.id,
        pet_name: petName || null,
        pet_species: petSpecies || null,
        pet_breed: petBreed || null,
        client_name: clientName || null,
        client_phone: clientPhone || null,
        client_email: clientEmail || null,
        vet_name: vetName || null,
        status,
      })
      toast.success('Card atualizado')
      onClose()
    } catch {
      toast.error('Erro ao salvar')
    }
  }

  return (
    <motion.div
      variants={overlayVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <motion.div
        variants={dialogVariants}
        className="bg-[hsl(var(--card))] rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-[hsl(var(--border))] flex items-center justify-between">
          <h2 className="text-base font-semibold text-[hsl(var(--foreground))]">Editar card</h2>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))] transition-all"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5 overflow-y-auto max-h-[calc(90vh-140px)]">
          {/* Status */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-[hsl(var(--muted-foreground))]">Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as CardStatus)}
              className={cn(
                'h-9 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))]',
                'px-3 text-sm text-[hsl(var(--foreground))]',
                'focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary))]/40 focus:border-[hsl(var(--primary))]',
                'transition-all'
              )}
            >
              {(Object.keys(STATUS_LABELS) as CardStatus[]).map((s) => (
                <option key={s} value={s}>{STATUS_LABELS[s]}</option>
              ))}
            </select>
          </div>

          {/* Pet */}
          <div>
            <p className="text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide mb-3">Pet</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Field label="Nome" value={petName} onChange={setPetName} />
              </div>
              <Field label="Espécie" value={petSpecies} onChange={setPetSpecies} />
              <Field label="Raça" value={petBreed} onChange={setPetBreed} />
            </div>
          </div>

          {/* Tutor */}
          <div>
            <p className="text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wide mb-3">Tutor</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Field label="Nome" value={clientName} onChange={setClientName} />
              </div>
              <Field label="Telefone" value={clientPhone} onChange={setClientPhone} type="tel" />
              <Field label="Email" value={clientEmail} onChange={setClientEmail} type="email" />
            </div>
          </div>

          {/* Vet */}
          <Field label="Veterinário" value={vetName} onChange={setVetName} />
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[hsl(var(--border))] flex justify-end gap-2">
          <button
            onClick={onClose}
            className="h-9 px-4 rounded-lg text-sm font-medium text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))] transition-all"
          >
            Cancelar
          </button>
          <button
            onClick={handleSave}
            disabled={updateCard.isPending}
            className={cn(
              'h-9 px-4 rounded-lg text-sm font-semibold flex items-center gap-1.5',
              'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]',
              'hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed'
            )}
          >
            <Save className="w-3.5 h-3.5" />
            {updateCard.isPending ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}
