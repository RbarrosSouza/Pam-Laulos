import { useState } from 'react'
import { X, Loader2, UserCheck } from 'lucide-react'
import { motion } from 'framer-motion'
import { dialogVariants, overlayVariants } from '@/lib/animations'
import { cn } from '@/lib/utils'
import { useVets } from '@/hooks/useVets'
import type { ExamCard } from '@/types/exam-card'

interface VetPickerModalProps {
  card: ExamCard
  onConfirm: (contactedBy: string) => void
  onCancel: () => void
}

export function VetPickerModal({ card, onConfirm, onCancel }: VetPickerModalProps) {
  const [selected, setSelected] = useState<string>(card.vet_name ?? '')
  const [custom, setCustom] = useState('')

  const { data: vets, isLoading } = useVets()

  const effectiveName = selected === '__custom__' ? custom.trim() : selected

  function handleConfirm() {
    if (!effectiveName) return
    onConfirm(effectiveName)
  }

  return (
    <motion.div
      variants={overlayVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[60] p-4"
      onClick={onCancel}
    >
      <motion.div
        variants={dialogVariants}
        className="bg-[hsl(var(--card))] rounded-2xl shadow-2xl w-full max-w-xs overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-[hsl(var(--border))] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <UserCheck className="w-4 h-4 text-[hsl(var(--primary))]" />
            <h2 className="text-base font-bold text-[hsl(var(--foreground))]">Quem realizou o contato?</h2>
          </div>
          <button
            onClick={onCancel}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))] transition-all"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Subtitle */}
        <div className="px-5 pt-3 pb-1">
          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            <span className="font-semibold text-[hsl(var(--foreground))]">{card.pet_name ?? 'Card'}</span>
            {card.client_name ? ` · ${card.client_name}` : ''}
          </p>
        </div>

        {/* Vet list */}
        <div className="px-3 pb-3 max-h-52 overflow-y-auto">
          {isLoading && (
            <div className="py-6 flex justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-[hsl(var(--primary))]" />
            </div>
          )}

          {vets?.map((vet) => (
            <button
              key={vet.id}
              onClick={() => setSelected(vet.nome)}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all',
                selected === vet.nome
                  ? 'bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))]'
                  : 'hover:bg-[hsl(var(--muted))]/50 text-[hsl(var(--foreground))]'
              )}
            >
              {vet.avatar_url ? (
                <img src={vet.avatar_url} alt={vet.nome} className="w-8 h-8 rounded-full object-cover shrink-0" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-[hsl(var(--muted))] flex items-center justify-center shrink-0">
                  <span className="text-[11px] font-bold text-[hsl(var(--muted-foreground))]">
                    {vet.nome.charAt(0).toUpperCase()}
                  </span>
                </div>
              )}
              <span className="text-sm font-medium">{vet.nome}</span>
            </button>
          ))}

          {/* Outro / custom */}
          <button
            onClick={() => setSelected('__custom__')}
            className={cn(
              'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all mt-1',
              selected === '__custom__'
                ? 'bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))]'
                : 'hover:bg-[hsl(var(--muted))]/50 text-[hsl(var(--muted-foreground))]'
            )}
          >
            <div className="w-8 h-8 rounded-full border-2 border-dashed border-[hsl(var(--border))] flex items-center justify-center shrink-0">
              <span className="text-xs text-[hsl(var(--muted-foreground))]">+</span>
            </div>
            <span className="text-sm">Outro</span>
          </button>

          {selected === '__custom__' && (
            <input
              autoFocus
              type="text"
              placeholder="Nome de quem contatou"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleConfirm()}
              className="w-full mt-2 px-3 py-2 text-sm rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/30 text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary))]/40"
            />
          )}
        </div>

        {/* Footer */}
        <div className="px-4 pb-4 flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 h-10 rounded-xl text-sm font-medium border border-[hsl(var(--border))] text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))] transition-all"
          >
            Cancelar
          </button>
          <button
            onClick={handleConfirm}
            disabled={!effectiveName}
            className={cn(
              'flex-1 h-10 rounded-xl text-sm font-bold flex items-center justify-center gap-1.5',
              'bg-[hsl(var(--primary))] text-white',
              'hover:opacity-90 active:scale-[0.98] disabled:opacity-40',
              'transition-all duration-200'
            )}
          >
            <UserCheck className="w-3.5 h-3.5" />
            Confirmar
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}
