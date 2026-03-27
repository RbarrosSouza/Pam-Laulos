import { useState, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { History, ChevronDown, Package, User, X, Loader2 } from 'lucide-react'
import { useShipmentHistory } from '@/hooks/useShipment'
import { fadeUp } from '@/lib/animations'
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
      className="space-y-4 max-w-xl mx-auto"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <History className="w-5 h-5 text-[hsl(var(--primary))]" />
          <h1 className="text-lg font-bold text-[hsl(var(--foreground))]">Histórico de Envios</h1>
        </div>
        <button
          onClick={() => navigate(-1)}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Date filter */}
      <div className="flex items-center gap-1.5">
        {([
          { id: 'today', label: 'Hoje' },
          { id: 'week', label: 'Esta semana' },
          { id: 'all', label: 'Todos' },
        ] as const).map((opt) => (
          <button
            key={opt.id}
            onClick={() => setDateFilter(opt.id)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-xs font-medium border transition-all',
              dateFilter === opt.id
                ? 'bg-[hsl(var(--primary))] text-white border-[hsl(var(--primary))]'
                : 'bg-[hsl(var(--card))] text-[hsl(var(--muted-foreground))] border-[hsl(var(--border))] hover:border-[hsl(var(--primary))]/60'
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="py-12 flex justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-[hsl(var(--muted-foreground))]" />
        </div>
      )}

      {/* Empty */}
      {!isLoading && (!shipments || shipments.length === 0) && (
        <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-8 text-center">
          <Package className="w-8 h-8 text-[hsl(var(--muted-foreground))] mx-auto mb-2" />
          <p className="text-sm text-[hsl(var(--muted-foreground))]">Nenhum envio encontrado</p>
        </div>
      )}

      {/* Shipment list */}
      {shipments && shipments.length > 0 && (
        <div className="space-y-2">
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
        </div>
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
    <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[hsl(var(--muted))]/30 transition-colors"
      >
        <Package className="w-4 h-4 text-[hsl(var(--primary))] shrink-0" />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-[hsl(var(--foreground))]">
              {formattedDate} às {formattedTime}
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] font-medium tabular-nums">
              {shipment.items_count} amostra{shipment.items_count !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="flex items-center gap-0.5 text-xs text-[hsl(var(--muted-foreground))]">
              <User className="w-2.5 h-2.5" />
              {shipment.sent_by}
            </span>
            {shipment.lab_name && (
              <span className="text-xs text-[hsl(var(--muted-foreground))]">
                → {shipment.lab_name}
              </span>
            )}
          </div>
        </div>

        <ChevronDown
          className={cn(
            'w-4 h-4 text-[hsl(var(--muted-foreground))] shrink-0 transition-transform duration-200',
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
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="border-t border-[hsl(var(--border))]/50 px-4 py-2 space-y-1.5">
              {shipment.items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between py-1"
                >
                  <div className="min-w-0">
                    <span className="text-sm text-[hsl(var(--foreground))]">
                      {item.pet_name ?? '—'}
                    </span>
                    <span className="text-xs text-[hsl(var(--muted-foreground))] ml-2">
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
    </div>
  )
}
