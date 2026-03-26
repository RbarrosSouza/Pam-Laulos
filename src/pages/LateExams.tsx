import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { AlertTriangle, Clock, User, Stethoscope, Calendar, Cat, Dog } from 'lucide-react'
import { useExamCards } from '@/hooks/useExamCards'
import { useRealtimeExams } from '@/hooks/useRealtimeExams'
import { TrackingDetail } from '@/components/tracking/TrackingDetail'
import { formatHours, cn, getSpeciesType } from '@/lib/utils'
import { fadeUp, staggerItem } from '@/lib/animations'
import type { ExamCard } from '@/types/exam-card'

export function LateExams() {
  const [selectedCard, setSelectedCard] = useState<ExamCard | null>(null)
  useRealtimeExams()

  const { data: cards, isLoading } = useExamCards({ status: ['atrasado'] })

  return (
    <>
      <motion.div
        variants={fadeUp}
        initial="initial"
        animate="animate"
        exit="exit"
        className="space-y-4 max-w-xl mx-auto"
      >
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-red-500" />
          <h1 className="text-lg font-bold text-[hsl(var(--foreground))]">Atrasados</h1>
          {cards && cards.length > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-400 text-xs font-bold">
              {cards.length}
            </span>
          )}
        </div>

        {isLoading && (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-24 rounded-xl bg-[hsl(var(--muted))] animate-pulse" />
            ))}
          </div>
        )}

        {!isLoading && (!cards || cards.length === 0) && (
          <div className="flex flex-col items-center py-16 text-[hsl(var(--muted-foreground))]">
            <div className="w-12 h-12 rounded-full bg-green-50 dark:bg-green-950/30 flex items-center justify-center mb-3">
              <span className="text-green-600 dark:text-green-400 font-bold">OK</span>
            </div>
            <p className="text-sm font-medium text-green-600 dark:text-green-400">Nenhum exame atrasado</p>
          </div>
        )}

        <AnimatePresence mode="popLayout">
          {cards?.map((card) => {
            const items = card.items ?? []
            const species = getSpeciesType(card.pet_species)
            const SpeciesIcon = species === 'cat' ? Cat : species === 'dog' ? Dog : null
            const resultDate = items.find((i) => i.result_received_at)?.result_received_at
            const displayDate = resultDate || card.created_at
            const formattedDate = displayDate
              ? new Date(displayDate).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
              : null

            return (
              <motion.div
                key={card.id}
                layout
                variants={staggerItem}
                initial="initial"
                animate="animate"
                exit={{ opacity: 0, scale: 0.95 }}
                onClick={() => setSelectedCard(card)}
                className="rounded-xl border border-red-200 dark:border-red-900/60 bg-[hsl(var(--card))] p-3 cursor-pointer transition-all active:scale-[0.98]"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-red-500 shrink-0 alert-dot-critical" />
                      <p className="font-bold text-sm text-[hsl(var(--foreground))] truncate flex items-center gap-1">
                        {SpeciesIcon && <SpeciesIcon className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))]/60 shrink-0" />}
                        {card.pet_name ?? '—'}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      {card.client_name && (
                        <span className="flex items-center gap-0.5 text-[10px] text-[hsl(var(--muted-foreground))] truncate">
                          <User className="w-2.5 h-2.5 shrink-0" />
                          {card.client_name}
                        </span>
                      )}
                      {card.vet_name && (
                        <span className="flex items-center gap-0.5 text-[10px] text-[hsl(var(--muted-foreground))]/70 truncate">
                          <Stethoscope className="w-2.5 h-2.5 shrink-0" />
                          {card.vet_name.split(' ')[0]}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 text-red-500">
                    <Clock className="w-3.5 h-3.5" />
                    <span className="text-sm font-bold tabular-nums">{formatHours(card.hours_elapsed)}</span>
                  </div>
                </div>

                {items.length > 0 && (
                  <div className="space-y-0.5 mb-2">
                    {items.slice(0, 3).map((item) => (
                      <div key={item.id} className="flex items-center gap-2 pl-1">
                        <span className={cn(
                          'w-1.5 h-1.5 rounded-full shrink-0',
                          item.result_received ? 'bg-green-500' : 'bg-[hsl(var(--border))]'
                        )} />
                        <span className="text-xs text-[hsl(var(--foreground))] truncate">{item.exam_type}</span>
                      </div>
                    ))}
                  </div>
                )}

                {formattedDate && (
                  <div className="flex items-center gap-0.5 text-[10px] text-[hsl(var(--muted-foreground))]/60 pt-1.5 border-t border-[hsl(var(--border))]/30">
                    <Calendar className="w-2.5 h-2.5" />
                    {formattedDate}
                  </div>
                )}
              </motion.div>
            )
          })}
        </AnimatePresence>
      </motion.div>

      <AnimatePresence>
        {selectedCard && (
          <TrackingDetail card={selectedCard} onClose={() => setSelectedCard(null)} />
        )}
      </AnimatePresence>
    </>
  )
}
