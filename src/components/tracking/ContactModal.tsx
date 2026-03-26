import { useState } from 'react'
import { X, Phone } from 'lucide-react'
import { motion } from 'framer-motion'
import { useMarkContact } from '@/hooks/useExamCards'
import { cn } from '@/lib/utils'
import { dialogVariants, overlayVariants } from '@/lib/animations'
import type { ExamItem, ExamCard } from '@/types/exam-card'

interface ContactModalProps {
  item: ExamItem
  card: ExamCard
  onClose: () => void
}

function todayStr() {
  return new Date().toISOString().split('T')[0]
}

function nowTimeStr() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function ContactModal({ item, card, onClose }: ContactModalProps) {
  const [contactedBy, setContactedBy] = useState(card.vet_name ?? '')
  const [date, setDate] = useState(todayStr())
  const [time, setTime] = useState(nowTimeStr())
  const { mutate, isPending } = useMarkContact()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!contactedBy.trim()) return
    const contactedAt = new Date(`${date}T${time}:00`).toISOString()
    mutate(
      { examItemId: item.id, cardId: card.id, contactedBy: contactedBy.trim(), contactedAt },
      { onSuccess: onClose }
    )
  }

  return (
    <motion.div
      variants={overlayVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4"
    >
      <motion.div
        variants={dialogVariants}
        className="bg-[hsl(var(--card))] rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
      >
        <div className="px-6 pt-5 pb-4 border-b border-[hsl(var(--border))] flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-[hsl(var(--foreground))]">Registrar Contato</h2>
            <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">
              {item.exam_type} · {card.pet_name ?? '—'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))] transition-all"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-[hsl(var(--foreground))] uppercase tracking-wide">
              Vet responsável <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={contactedBy}
              onChange={(e) => setContactedBy(e.target.value)}
              placeholder="Nome da vet"
              required
              className={cn(
                'w-full px-3 py-2.5 text-sm rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))]',
                'text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))]',
                'focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]/40 focus:border-[hsl(var(--primary))] transition-all'
              )}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-[hsl(var(--foreground))] uppercase tracking-wide">
                Data
              </label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
                className={cn(
                  'w-full px-3 py-2.5 text-sm rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))]',
                  'text-[hsl(var(--foreground))]',
                  'focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]/40 focus:border-[hsl(var(--primary))] transition-all'
                )}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-[hsl(var(--foreground))] uppercase tracking-wide">
                Hora
              </label>
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                required
                className={cn(
                  'w-full px-3 py-2.5 text-sm rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))]',
                  'text-[hsl(var(--foreground))]',
                  'focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]/40 focus:border-[hsl(var(--primary))] transition-all'
                )}
              />
            </div>
          </div>

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 text-sm font-medium rounded-xl border border-[hsl(var(--border))] text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))] transition-all"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isPending || !contactedBy.trim()}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-xl bg-[hsl(var(--primary))] text-white hover:bg-[hsl(var(--primary))]/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm"
            >
              <Phone className="w-4 h-4" />
              {isPending ? 'Salvando...' : 'Confirmar'}
            </button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  )
}
