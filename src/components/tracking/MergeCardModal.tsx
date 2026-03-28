import { useState, useMemo } from 'react'
import { GitMerge, X, ArrowRight, ShoppingBag, Mail, AlertTriangle, Loader2 } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { toast } from 'sonner'
import { useExamCards } from '@/hooks/useExamCards'
import { useMergeCards } from '@/hooks/useExamCardMutations'
import { dialogVariants, overlayVariants } from '@/lib/animations'
import { cn } from '@/lib/utils'
import type { ExamCard } from '@/types/exam-card'

interface MergeCardModalProps {
  card: ExamCard
  onClose: () => void
  onMerged: () => void
}

export function MergeCardModal({ card, onClose, onMerged }: MergeCardModalProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [step, setStep] = useState<'select' | 'confirm'>('select')

  const mergeMutation = useMergeCards()

  // Fetch all active cards as candidates
  const { data: allCards, isLoading } = useExamCards({
    status: ['aguardando_lab', 'exame_pronto', 'atrasado'],
  })

  const candidates = useMemo(() => {
    if (!allCards) return []
    return allCards.filter((c) => c.id !== card.id)
  }, [allCards, card.id])

  const selectedCard = candidates.find((c) => c.id === selectedId) ?? null

  // Determine target (keeper) and source (absorbed)
  // The card with richer data (origin=venda, not orphan) is the target
  function pickTarget(a: ExamCard, b: ExamCard): { target: ExamCard; source: ExamCard } {
    if (a.origin === 'venda' && !a.is_orphan) return { target: a, source: b }
    if (b.origin === 'venda' && !b.is_orphan) return { target: b, source: a }
    // Neither is a sale card — pick the one with more data
    const scoreA = (a.client_name ? 1 : 0) + (a.vet_name ? 1 : 0) + (a.client_phone ? 1 : 0)
    const scoreB = (b.client_name ? 1 : 0) + (b.vet_name ? 1 : 0) + (b.client_phone ? 1 : 0)
    return scoreA >= scoreB ? { target: a, source: b } : { target: b, source: a }
  }

  const { target: targetCard, source: sourceCard } = selectedCard
    ? pickTarget(card, selectedCard)
    : { target: null as ExamCard | null, source: null as ExamCard | null }

  async function handleMerge() {
    if (!targetCard || !sourceCard) return
    try {
      const result = await mergeMutation.mutateAsync({
        targetCardId: targetCard.id,
        sourceCardId: sourceCard.id,
      })
      toast.success(`Cards fundidos — ${result.items_moved} exame(s) movido(s)`)
      onMerged()
    } catch (err: any) {
      toast.error('Erro: ' + (err.message || 'Falha ao fundir'))
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
        className="bg-[hsl(var(--card))] rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-[hsl(var(--border))] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GitMerge className="w-4 h-4 text-[hsl(var(--primary))]" />
            <h2 className="text-base font-bold text-[hsl(var(--foreground))]">Fundir cards</h2>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))] transition-all"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Current card summary */}
        <div className="px-5 py-3 border-b border-[hsl(var(--border))] bg-[hsl(var(--muted))]/30">
          <CardChip card={card} label={isOrphan ? 'Órfão (resultado)' : 'Venda (dados)'} />
        </div>

        {/* Body */}
        <div className="max-h-[50vh] overflow-y-auto">
          <AnimatePresence mode="wait">
            {step === 'select' ? (
              <motion.div
                key="select"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                {/* Candidate list header */}
                <div className="px-5 py-2.5">
                  <p className="text-[11px] font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wider">
                    {isOrphan ? 'Cards de venda' : 'Cards órfãos'}
                  </p>
                </div>

                {isLoading && (
                  <div className="py-8 flex justify-center">
                    <Loader2 className="w-5 h-5 animate-spin text-[hsl(var(--primary))]" />
                  </div>
                )}

                {!isLoading && candidates.length === 0 && (
                  <div className="py-8 text-center">
                    <p className="text-sm text-[hsl(var(--muted-foreground))]">Nenhum card compatível</p>
                  </div>
                )}

                {candidates.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => { setSelectedId(c.id); setStep('confirm') }}
                    className={cn(
                      'w-full flex items-center gap-3 px-5 py-3',
                      'border-b border-[hsl(var(--border))]/50 last:border-0',
                      'text-left hover:bg-[hsl(var(--muted))]/50 active:bg-[hsl(var(--muted))]',
                      'transition-colors'
                    )}
                  >
                    <OriginIcon card={c} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-[hsl(var(--foreground))] truncate">
                        {c.pet_name ?? '—'}
                      </p>
                      <p className="text-xs text-[hsl(var(--muted-foreground))] truncate">
                        {c.client_name ?? 'Sem tutor'}
                        {c.items?.length ? ` · ${c.items.length} exame${c.items.length !== 1 ? 's' : ''}` : ''}
                      </p>
                    </div>
                    <ArrowRight className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))] shrink-0" />
                  </button>
                ))}
              </motion.div>
            ) : (
              <motion.div
                key="confirm"
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                className="p-5 space-y-4"
              >
                {/* Merge preview */}
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <CardChip card={sourceCard!} label="Origem" small />
                  </div>
                  <div className="w-8 h-8 rounded-full bg-[hsl(var(--primary))]/10 flex items-center justify-center shrink-0">
                    <ArrowRight className="w-4 h-4 text-[hsl(var(--primary))]" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <CardChip card={targetCard!} label="Destino" small />
                  </div>
                </div>

                <div className="rounded-xl bg-[hsl(var(--muted))]/50 p-3">
                  <p className="text-xs text-[hsl(var(--muted-foreground))]">
                    Os exames de <strong className="text-[hsl(var(--foreground))]">{sourceCard?.pet_name ?? '—'}</strong> serão
                    movidos para o card de <strong className="text-[hsl(var(--foreground))]">{targetCard?.pet_name ?? '—'}</strong>.
                    O card de origem será excluído.
                  </p>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={() => { setStep('select'); setSelectedId(null) }}
                    className="flex-1 h-10 rounded-xl text-sm font-medium border border-[hsl(var(--border))] text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))] transition-all"
                  >
                    Voltar
                  </button>
                  <button
                    onClick={handleMerge}
                    disabled={mergeMutation.isPending}
                    className={cn(
                      'flex-1 h-10 rounded-xl text-sm font-bold flex items-center justify-center gap-2',
                      'bg-[hsl(var(--primary))] text-white',
                      'shadow-sm shadow-[hsl(var(--primary))]/20',
                      'hover:opacity-90 active:scale-[0.98] disabled:opacity-50',
                      'transition-all duration-200'
                    )}
                  >
                    {mergeMutation.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <>
                        <GitMerge className="w-3.5 h-3.5" />
                        Fundir
                      </>
                    )}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </motion.div>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function OriginIcon({ card }: { card: ExamCard }) {
  if (card.is_orphan) {
    return (
      <div className="w-8 h-8 rounded-lg bg-amber-50 dark:bg-amber-950/30 flex items-center justify-center shrink-0">
        <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
      </div>
    )
  }
  if (card.origin === 'venda') {
    return (
      <div className="w-8 h-8 rounded-lg bg-[hsl(var(--primary))]/10 flex items-center justify-center shrink-0">
        <ShoppingBag className="w-3.5 h-3.5 text-[hsl(var(--primary))]" />
      </div>
    )
  }
  return (
    <div className="w-8 h-8 rounded-lg bg-[hsl(var(--muted))] flex items-center justify-center shrink-0">
      <Mail className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))]" />
    </div>
  )
}

function CardChip({ card, label, small }: { card: ExamCard; label: string; small?: boolean }) {
  const itemCount = card.items?.length ?? 0
  const readyCount = card.items?.filter((i) => i.result_received).length ?? 0

  return (
    <div className={small ? 'space-y-0.5' : 'space-y-1'}>
      <span className="text-[10px] font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wider">
        {label}
      </span>
      <p className={cn(
        'font-semibold text-[hsl(var(--foreground))] truncate',
        small ? 'text-xs' : 'text-sm'
      )}>
        {card.pet_name ?? '—'}
      </p>
      <div className="flex items-center gap-1.5">
        {card.origin === 'venda' && !card.is_orphan ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))] font-semibold">
            Venda
          </span>
        ) : (
          <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-amber-100 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 font-semibold">
            Órfão
          </span>
        )}
        <span className="text-[10px] text-[hsl(var(--muted-foreground))]">
          {readyCount}/{itemCount} pronto{readyCount !== 1 ? 's' : ''}
        </span>
      </div>
    </div>
  )
}
