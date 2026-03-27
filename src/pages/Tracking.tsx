import { useState, useMemo } from 'react'
import { LayoutList, KanbanSquare, Search, X, SlidersHorizontal, ChevronDown, Filter } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { TrackingTable } from '@/components/tracking/TrackingTable'
import { KanbanBoard } from '@/components/tracking/KanbanBoard'
import { TrackingDetail } from '@/components/tracking/TrackingDetail'
import { DateRangePicker } from '@/components/tracking/DateRangePicker'
import { useExamCards } from '@/hooks/useExamCards'
import { useVets } from '@/hooks/useVets'
import { useRealtimeExams } from '@/hooks/useRealtimeExams'
import { fadeUp } from '@/lib/animations'
import { cn } from '@/lib/utils'
import { STATUS_FILTER_OPTIONS } from '@/lib/card-constants'
import type { ExamCard, CardStatus } from '@/types/exam-card'

type ViewMode = 'board' | 'table'

export function Tracking() {
  const [view, setView] = useState<ViewMode>('board')
  const [search, setSearch] = useState('')
  const [selectedStatuses, setSelectedStatuses] = useState<CardStatus[]>([])
  const [selectedVet, setSelectedVet] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [selectedCard, setSelectedCard] = useState<ExamCard | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)

  useRealtimeExams()
  const { data: vets } = useVets()

  const { data: allCards } = useExamCards({
    search: search || undefined,
    status: selectedStatuses.length > 0 ? selectedStatuses : undefined,
    vetName: selectedVet || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  })

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

  const isToday = dateFrom === new Date().toISOString().split('T')[0] && dateTo === dateFrom
  const hasFilters = search || selectedStatuses.length > 0 || selectedVet || dateFrom || dateTo

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
      const today = new Date().toISOString().split('T')[0]
      setDateFrom(today)
      setDateTo(today)
    }
  }

  return (
    <>
      <motion.div
        variants={fadeUp}
        initial="initial"
        animate="animate"
        exit="exit"
        className="space-y-4"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <h1 className="text-lg md:text-2xl font-bold text-[hsl(var(--foreground))] tracking-tight">
              Exames
            </h1>
            <span className="text-xs text-[hsl(var(--muted-foreground))] tabular-nums">
              {enrichedCards?.length ?? 0}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            {/* Filter toggle (mobile) */}
            <button
              onClick={() => setFiltersOpen(!filtersOpen)}
              className={cn(
                'md:hidden w-8 h-8 flex items-center justify-center rounded-lg border transition-all',
                hasFilters
                  ? 'bg-[hsl(var(--primary))] text-white border-[hsl(var(--primary))]'
                  : 'bg-[hsl(var(--card))] text-[hsl(var(--muted-foreground))] border-[hsl(var(--border))]'
              )}
              aria-label="Filtros"
            >
              <Filter className="w-3.5 h-3.5" />
            </button>

            {/* View toggle */}
            <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-[hsl(var(--muted))] border border-[hsl(var(--border))]">
              <button
                onClick={() => setView('board')}
                className={cn(
                  'w-8 h-8 md:w-auto md:h-auto flex items-center justify-center gap-1.5 md:px-2.5 md:py-1.5 rounded-md text-xs font-medium transition-all',
                  view === 'board'
                    ? 'bg-[hsl(var(--card))] text-[hsl(var(--foreground))] shadow-sm'
                    : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]'
                )}
                aria-label="Visão Board"
              >
                <KanbanSquare className="w-3.5 h-3.5" />
                <span className="hidden md:inline">Board</span>
              </button>
              <button
                onClick={() => setView('table')}
                className={cn(
                  'w-8 h-8 md:w-auto md:h-auto flex items-center justify-center gap-1.5 md:px-2.5 md:py-1.5 rounded-md text-xs font-medium transition-all',
                  view === 'table'
                    ? 'bg-[hsl(var(--card))] text-[hsl(var(--foreground))] shadow-sm'
                    : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]'
                )}
                aria-label="Visão Tabela"
              >
                <LayoutList className="w-3.5 h-3.5" />
                <span className="hidden md:inline">Tabela</span>
              </button>
            </div>
          </div>
        </div>

        {/* Filters Bar — always visible on desktop, collapsible on mobile */}
        <div className={cn('flex flex-col gap-3', !filtersOpen && 'hidden md:flex')}>
          {/* Row 1: Search + Vet + Date */}
          <div className="flex flex-wrap gap-2 items-center">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[hsl(var(--muted-foreground))]" />
              <input
                type="text"
                placeholder="Buscar pet, tutor, exame..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className={cn(
                  'pl-9 pr-8 py-2 text-sm rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))]',
                  'text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))]',
                  'focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]/40 focus:border-[hsl(var(--primary))]',
                  'w-56 transition-all'
                )}
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Vet Filter */}
            <div className="relative">
              <select
                value={selectedVet}
                onChange={(e) => setSelectedVet(e.target.value)}
                className={cn(
                  'appearance-none pl-3 pr-8 py-2 text-sm rounded-lg border bg-[hsl(var(--card))]',
                  'focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]/40 focus:border-[hsl(var(--primary))]',
                  'transition-all cursor-pointer',
                  selectedVet
                    ? 'border-[hsl(var(--primary))] text-[hsl(var(--foreground))]'
                    : 'border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))]'
                )}
              >
                <option value="">Todos os vets</option>
                {vets?.map((vet) => (
                  <option key={vet.id} value={vet.nome}>{vet.nome.split(' ')[0]}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[hsl(var(--muted-foreground))] pointer-events-none" />
            </div>

            {/* Today button */}
            <button
              onClick={toggleToday}
              className={cn(
                'px-3 py-2 rounded-lg text-xs font-medium border transition-all',
                isToday
                  ? 'bg-[hsl(var(--primary))] text-white border-[hsl(var(--primary))]'
                  : 'bg-[hsl(var(--card))] text-[hsl(var(--muted-foreground))] border-[hsl(var(--border))] hover:border-[hsl(var(--primary))]/60'
              )}
            >
              Hoje
            </button>

            {/* Calendar range picker */}
            <DateRangePicker
              from={dateFrom}
              to={dateTo}
              onChange={(f, t) => { setDateFrom(f); setDateTo(t) }}
            />

            {/* Clear all */}
            {hasFilters && (
              <button
                onClick={clearFilters}
                className="text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] flex items-center gap-1 transition-colors"
              >
                <X className="w-3 h-3" /> Limpar
              </button>
            )}
          </div>

          {/* Row 2: Status pills — only in table view */}
          {view === 'table' && (
            <div className="flex items-center gap-2 flex-wrap">
              <SlidersHorizontal className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))] shrink-0" />
              {STATUS_FILTER_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => toggleStatus(opt.value)}
                  className={cn(
                    'px-2.5 py-1 rounded-full text-xs font-medium border transition-all',
                    selectedStatuses.includes(opt.value)
                      ? 'bg-[hsl(var(--primary))] text-white border-[hsl(var(--primary))] shadow-sm'
                      : 'bg-[hsl(var(--card))] text-[hsl(var(--muted-foreground))] border-[hsl(var(--border))] hover:border-[hsl(var(--primary))]/60 hover:text-[hsl(var(--primary))]'
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Content */}
        {view === 'board' ? (
          <KanbanBoard
            cards={enrichedCards}
            onSelectCard={setSelectedCard}
          />
        ) : (
          <TrackingTable
            cards={enrichedCards}
            onSelectCard={setSelectedCard}
          />
        )}
      </motion.div>

      <AnimatePresence>
        {selectedCard && (
          <TrackingDetail card={selectedCard} onClose={() => setSelectedCard(null)} />
        )}
      </AnimatePresence>
    </>
  )
}
