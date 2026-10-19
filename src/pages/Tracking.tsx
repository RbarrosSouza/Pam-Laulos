import { useState, useMemo } from 'react'
import { AnimatePresence } from 'framer-motion'
import { toast } from 'sonner'
import { TrackingTable } from '@/components/tracking/TrackingTable'
import { KanbanBoard } from '@/components/tracking/KanbanBoard'
import { TrackingDetail } from '@/components/tracking/TrackingDetail'
import { VetPickerModal } from '@/components/tracking/VetPickerModal'
import { useExamCards } from '@/hooks/useExamCards'
import { useBulkDeleteCards, useBulkMoveCards } from '@/hooks/useExamCardMutations'
import { useVets } from '@/hooks/useVets'
import { useRealtimeExams } from '@/hooks/useRealtimeExams'
import { elapsedHoursForDisplay } from '@/lib/group-time'
import type { ExamCard, CardStatus } from '@/types/exam-card'

import { TrackingWorkspace, TrackingDeleteDialog, type TrackingViewMode, type TrackingSortOrder } from '@/components/tracking/TrackingWorkspace'

const NEXT_STATUS: Partial<Record<CardStatus, CardStatus>> = {
  aguardando_lab: 'exame_pronto',
  exame_pronto: 'no_grupo',
  no_grupo: 'contato_realizado',
}

export function Tracking() {
  const [view, setView] = useState<TrackingViewMode>('board')
  const [search, setSearch] = useState('')
  const [selectedStatuses, setSelectedStatuses] = useState<CardStatus[]>([])
  const [selectedVet, setSelectedVet] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [selectedCard, setSelectedCard] = useState<ExamCard | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showBulkDelete, setShowBulkDelete] = useState(false)
  const [showBulkVet, setShowBulkVet] = useState(false)
  const [sortOrder, setSortOrder] = useState<TrackingSortOrder>('newest')

  useRealtimeExams()
  const { data: vets } = useVets()
  const bulkDelete = useBulkDeleteCards()
  const bulkMove = useBulkMoveCards()

  const query = useExamCards({
    search: search || undefined,
    status: selectedStatuses.length > 0 ? selectedStatuses : undefined,
    vetName: selectedVet || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  })

  const allCards = query.data

  const toggleStatus = (status: CardStatus) => {
    setSelectedStatuses((prev) =>
      prev.includes(status) ? prev.filter((s) => s !== status) : [...prev, status]
    )
  }

  // Enrich cards with vet avatar from veterinarios table
  const enrichedCards = useMemo(() => {
    if (!allCards || !vets) return allCards || []
    const vetMap = new Map(vets.map((v) => [v.nome, v.avatar_url]))
    return allCards.map((card) => ({
      ...card,
      vet_avatar_url: card.vet_avatar_url || (card.vet_name ? vetMap.get(card.vet_name) ?? null : null),
    }))
  }, [allCards, vets])

  const sortedCards = useMemo(() => [...enrichedCards].sort((a, b) => {
    const elapsedDifference = elapsedHoursForDisplay(a) - elapsedHoursForDisplay(b)
    if (elapsedDifference !== 0) {
      return sortOrder === 'newest' ? elapsedDifference : -elapsedDifference
    }
    const dateDifference = new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    return sortOrder === 'newest' ? dateDifference : -dateDifference
  }), [enrichedCards, sortOrder])

  const selectedCards = enrichedCards.filter((card) => selectedIds.has(card.id))
  const activeSelectedIds = new Set(selectedCards.map((card) => card.id))
  const advanceableCards = selectedCards.filter((card) => NEXT_STATUS[card.status])

  const toggleSelection = (cardId: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (next.has(cardId)) next.delete(cardId)
      else next.add(cardId)
      return next
    })
  }

  const toggleGroupSelection = (cardIds: string[]) => {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      const allSelected = cardIds.length > 0 && cardIds.every((cardId) => next.has(cardId))
      cardIds.forEach((cardId) => allSelected ? next.delete(cardId) : next.add(cardId))
      return next
    })
  }

  const executeAdvance = async (contactedBy?: string) => {
    try {
      await bulkMove.mutateAsync(advanceableCards.map((card) => ({
        cardId: card.id,
        fromStatus: card.status,
        toStatus: NEXT_STATUS[card.status]!,
        contactedBy: NEXT_STATUS[card.status] === 'contato_realizado' ? contactedBy : undefined,
      })))
      toast.success(`${advanceableCards.length} exame${advanceableCards.length === 1 ? '' : 's'} avançado${advanceableCards.length === 1 ? '' : 's'}`)
      setSelectedIds(new Set())
      setShowBulkVet(false)
    } catch (error: unknown) {
      toast.error('Erro ao avançar exames: ' + (error instanceof Error ? error.message : 'Tente novamente'))
    }
  }

  const handleAdvance = () => {
    if (advanceableCards.some((card) => NEXT_STATUS[card.status] === 'contato_realizado')) {
      setShowBulkVet(true)
    } else {
      executeAdvance()
    }
  }

  const handleBulkDelete = async () => {
    try {
      await bulkDelete.mutateAsync([...activeSelectedIds])
      toast.success(`${selectedCards.length} ficha${selectedCards.length === 1 ? '' : 's'} removida${selectedCards.length === 1 ? '' : 's'} do rastreamento`)
      setSelectedIds(new Set())
      setShowBulkDelete(false)
    } catch (error: unknown) {
      toast.error('Erro ao excluir exames: ' + (error instanceof Error ? error.message : 'Tente novamente'))
    }
  }

  const today = new Date()
  const localToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const isToday = dateFrom === localToday && dateTo === dateFrom

  const clearFilters = () => {
    setSearch('')
    setSelectedStatuses([])
    setSelectedVet('')
    setDateFrom('')
    setDateTo('')
  }

  const toggleToday = () => {
    if (isToday) {
      setDateFrom('')
      setDateTo('')
    } else {
      setDateFrom(localToday)
      setDateTo(localToday)
    }
  }

  return <>
    <TrackingWorkspace
      count={enrichedCards.length} loading={query.isLoading} error={query.error}
      refreshing={query.isFetching} onRefresh={() => { void query.refetch() }}
      search={search} onSearchChange={setSearch} view={view} onViewChange={setView}
      sortOrder={sortOrder} onSortChange={setSortOrder}
      statuses={selectedStatuses} onToggleStatus={toggleStatus}
      vet={selectedVet} vets={vets || []} onVetChange={setSelectedVet}
      dateFrom={dateFrom} dateTo={dateTo} onDateChange={(from, to) => { setDateFrom(from); setDateTo(to) }}
      isToday={isToday} onToggleToday={toggleToday} onClearFilters={clearFilters}
      selectedCount={selectedCards.length} advanceableCount={advanceableCards.length}
      pending={bulkMove.isPending || bulkDelete.isPending}
      onClearSelection={() => setSelectedIds(new Set())} onAdvance={handleAdvance}
      onRequestDelete={() => setShowBulkDelete(true)}
    >
      {view === 'board' ? <KanbanBoard
        cards={sortedCards} onSelectCard={setSelectedCard} selectedIds={activeSelectedIds}
        onToggleSelection={toggleSelection} onToggleGroupSelection={toggleGroupSelection}
      /> : <TrackingTable
        cards={sortedCards} onSelectCard={setSelectedCard} selectedIds={activeSelectedIds}
        onToggleSelection={toggleSelection}
        onToggleAllSelection={() => toggleGroupSelection(sortedCards.map(card => card.id))}
      />}
    </TrackingWorkspace>
    <TrackingDeleteDialog open={showBulkDelete} count={selectedCards.length}
      loading={bulkDelete.isPending} onConfirm={handleBulkDelete}
      onClose={() => setShowBulkDelete(false)} />
    <AnimatePresence>
      {showBulkVet && selectedCards[0] && <VetPickerModal
        card={selectedCards[0]} title="Quem realizou os contatos?"
        subtitle={`${advanceableCards.length} exame${advanceableCards.length === 1 ? '' : 's'} será${advanceableCards.length === 1 ? '' : 'ão'} avançado${advanceableCards.length === 1 ? '' : 's'}`}
        onConfirm={executeAdvance} onCancel={() => setShowBulkVet(false)}
      />}
      {selectedCard && <TrackingDetail card={selectedCard} onClose={() => setSelectedCard(null)} />}
    </AnimatePresence>
  </>
}
