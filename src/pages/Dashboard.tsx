import { useMemo, useRef, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { DashboardView } from '@/components/dashboard/DashboardView'
import { TrackingDetail } from '@/components/tracking/TrackingDetail'
import { useExamCards } from '@/hooks/useExamCards'
import { useExamCardStats } from '@/hooks/useExamCardStats'
import { useRealtimeExams } from '@/hooks/useRealtimeExams'
import { useVets } from '@/hooks/useVets'
import type { ExamCard } from '@/types/exam-card'

export function Dashboard() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const opener = useRef<HTMLButtonElement | null>(null)
  useRealtimeExams()
  const stats = useExamCardStats()
  const vets = useVets()
  const ready = useExamCards({ status: ['exame_pronto'] })
  const group = useExamCards({ status: ['no_grupo'] })
  const lab = useExamCards({ status: ['aguardando_lab'] })

  const cards = useMemo(() => {
    const avatars = new Map((vets.data || []).map(vet => [vet.nome, vet.avatar_url]))
    const enrich = (values: ExamCard[] | undefined) => (values || []).map(card => ({
      ...card, vet_avatar_url: card.vet_avatar_url || (card.vet_name ? avatars.get(card.vet_name) ?? null : null),
    }))
    return { exame_pronto: enrich(ready.data), no_grupo: enrich(group.data), aguardando_lab: enrich(lab.data) }
  }, [vets.data, ready.data, group.data, lab.data])
  const selectedCard = selectedId ? [...cards.exame_pronto, ...cards.no_grupo, ...cards.aguardando_lab].find(card => card.id === selectedId) : null
  const queuesSettled = !ready.isLoading && !group.isLoading && !lab.isLoading && !ready.error && !group.error && !lab.error

  // Retire an open selection when realtime removes it from the active queues, so it cannot reopen later.
  if (selectedId && !selectedCard && queuesSettled) setSelectedId(null)

  return <>
    <DashboardView stats={stats.data} summaryLoading={stats.isLoading} summaryError={stats.error}
      queues={{
        no_grupo: { cards: cards.no_grupo, loading: group.isLoading, error: group.error, refreshing: group.isFetching },
        exame_pronto: { cards: cards.exame_pronto, loading: ready.isLoading, error: ready.error, refreshing: ready.isFetching },
        aguardando_lab: { cards: cards.aguardando_lab, loading: lab.isLoading, error: lab.error, refreshing: lab.isFetching },
      }}
      refreshing={stats.isFetching || ready.isFetching || group.isFetching || lab.isFetching}
      onRefresh={() => { void stats.refetch(); void ready.refetch(); void group.refetch(); void lab.refetch() }}
      onOpenCard={(card, button) => { opener.current = button; setSelectedId(card.id) }}
    />
    <AnimatePresence>{selectedCard && <TrackingDetail card={selectedCard} onClose={() => { setSelectedId(null); if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }) }} />}</AnimatePresence>
  </>
}
