import { useState, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { History, ChevronDown, Package, User, X, Loader2, FlaskConical } from 'lucide-react'
import { useShipmentHistory } from '@/hooks/useShipment'
import { fadeUp, staggerContainer, staggerItem } from '@/lib/animations'
import { cn } from '@/lib/utils'
import { useNavigate } from 'react-router-dom'
import type { LabShipmentWithItems } from '@/types/exam-card'

type DateFilter = 'today' | 'week' | 'all'

export function ShipmentHistory() {
  const navigate = useNavigate()
  const [dateFilter, setDateFilter] = useState<DateFilter>('today')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const filters = useMemo(() => {
    const now = new Date()
    if (dateFilter === 'today') {
      const today = now.toISOString().split('T')[0]
      return { dateFrom: today, dateTo: today }
    }
    if (dateFilter === 'week') {
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      return { dateFrom: weekAgo.toISOString().split('T')[0], dateTo: now.toISOString().split('T')[0] }
    }
    return {}
  }, [dateFilter])

  const { data: shipments, isLoading } = useShipmentHistory(filters)

  return (
    <motion.div
      variants={fadeUp}
      initial="initial"
      animate="animate"
      exit="exit"
      className="space-y-5 max-w-xl mx-auto pb-8"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-[hsl(var(--primary))]/10 flex items-center justify-center">
            <History className="w-4.5 h-4.5 text-[hsl(var(--primary))]" />
          </div>
          <h1 className="text-lg font-bold text-[hsl(var(--foreground))] tracking-tight">Histórico de Envios</h1>
        </div>
        <button
          onClick={() => navigate(-1)}
          className="w-9 h-9 flex items-center justify-center rounded-xl text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))] active:scale-95 transition-all"
          aria-label="Voltar"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Date filter */}
      <div className="flex items-center gap-2 p-1 rounded-xl bg-[hsl(var(--muted))]/50 border border-[hsl(var(--border))]">
        {([
          { id: 'today', label: 'Hoje' },
          { id: 'week', label: 'Semana' },
          { id: 'all', label: 'Todos' },
        ] as const).map((opt) => (
          <button
            key={opt.id}
            onClick={() => setDateFilter(opt.id)}
            className={cn(
              'flex-1 py-2 rounded-lg text-xs font-semibold transition-all duration-200',
              dateFilter === opt.id
                ? 'bg-[hsl(var(--card))] text-[hsl(var(--foreground))] shadow-sm'
                : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]'
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="py-16 flex justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-[hsl(var(--primary))]" />
        </div>
      )}

      {/* Empty */}
      {!isLoading && (!shipments || shipments.length === 0) && (
        <div className="rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] py-16 text-center shadow-sm">
          <div className="w-12 h-12 rounded-2xl bg-[hsl(var(--muted))] flex items-center justify-center mx-auto mb-3">
            <Package className="w-6 h-6 text-[hsl(var(--muted-foreground))]" />
          </div>
          <p className="text-sm font-medium text-[hsl(var(--muted-foreground))]">Nenhum envio encontrado</p>
        </div>
      )}

      {/* Shipment list */}
      {shipments && shipments.length > 0 && (
        <motion.div variants={staggerContainer} initial="initial" animate="animate" className="space-y-3">
          {shipments.map((shipment) => (
            <ShipmentCard
              key={shipment.id}
              shipment={shipment}
              expanded={expandedId === shipment.id}
              onToggle={() =>
                setExpandedId((prev) => (prev === shipment.id ? null : shipment.id))
              }
            />
          ))}
        </motion.div>
      )}
    </motion.div>
  )
}

function ShipmentCard({
  shipment,
  expanded,
  onToggle,
}: {
  shipment: LabShipmentWithItems
  expanded: boolean
  onToggle: () => void
}) {
  const date = new Date(shipment.sent_at)
  const formattedDate = date.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
  })
  const formattedTime = date.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  })

  return (
    <motion.div
      variants={staggerItem}
      className={cn(
        'rounded-2xl border bg-[hsl(var(--card))] overflow-hidden shadow-sm transition-all duration-200',
        expanded
          ? 'border-[hsl(var(--primary))]/30 shadow-md'
          : 'border-[hsl(var(--border))] hover:shadow-md'
      )}
    >
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-4 text-left active:bg-[hsl(var(--muted))]/30 transition-colors"
      >
        <div className={cn(
          'w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-colors duration-200',
          expanded
            ? 'bg-[hsl(var(--primary))]/15'
            : 'bg-[hsl(var(--muted))]'
        )}>
          <Package className={cn(
            'w-4 h-4 transition-colors duration-200',
            expanded ? 'text-[hsl(var(--primary))]' : 'text-[hsl(var(--muted-foreground))]'
          )} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-[hsl(var(--foreground))]">
              {formattedDate} às {formattedTime}
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))] font-bold tabular-nums">
              {shipment.items_count}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="flex items-center gap-1 text-xs text-[hsl(var(--muted-foreground))]">
              <User className="w-2.5 h-2.5" />
              {shipment.sent_by}
            </span>
            {shipment.lab_name && (
              <>
                <span className="text-[hsl(var(--border))]">·</span>
                <span className="text-xs text-[hsl(var(--muted-foreground))]">
                  {shipment.lab_name}
                </span>
              </>
            )}
          </div>
        </div>

        <ChevronDown
          className={cn(
            'w-4 h-4 text-[hsl(var(--muted-foreground))] shrink-0 transition-transform duration-300',
            expanded && 'rotate-180'
          )}
        />
      </button>

      <AnimatePresence>
        {expanded && shipment.items.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="border-t border-[hsl(var(--border))] mx-4" />
            <div className="px-4 py-3 space-y-0.5">
              {shipment.items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between py-2 px-2 rounded-lg hover:bg-[hsl(var(--muted))]/40 transition-colors"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <FlaskConical className="w-3 h-3 text-[hsl(var(--muted-foreground))] shrink-0" />
                    <span className="text-sm font-medium text-[hsl(var(--foreground))] truncate">
                      {item.pet_name ?? '—'}
                    </span>
                    <span className="text-xs text-[hsl(var(--muted-foreground))]">
                      {item.exam_type}
                    </span>
                  </div>
                  {item.client_name && (
                    <span className="text-[10px] text-[hsl(var(--muted-foreground))] shrink-0 ml-2">
                      {item.client_name.split(' ')[0]}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
