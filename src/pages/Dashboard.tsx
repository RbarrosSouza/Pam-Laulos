import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  FlaskConical, FileCheck2, AlertTriangle, Phone, Clock,
  ChevronRight, User, Stethoscope, Calendar, Cat, Dog
} from 'lucide-react'
import { useExamCards } from '@/hooks/useExamCards'
import { useExamCardStats } from '@/hooks/useExamCardStats'
import { useRealtimeExams } from '@/hooks/useRealtimeExams'
import { TrackingDetail } from '@/components/tracking/TrackingDetail'
import { StatusChart } from '@/components/dashboard/StatusChart'
import { formatHours, cn, getSpeciesType } from '@/lib/utils'
import { fadeUp, staggerContainer, staggerItem } from '@/lib/animations'
import type { ExamCard } from '@/types/exam-card'
import { Link } from 'react-router-dom'

type MobileTab = 'prontos' | 'atrasados' | 'aguardando'

export function Dashboard() {
  const [selectedCard, setSelectedCard] = useState<ExamCard | null>(null)
  const [activeTab, setActiveTab] = useState<MobileTab>('prontos')

  useRealtimeExams()
  const { data: stats } = useExamCardStats()
  const { data: prontos } = useExamCards({ status: ['exame_pronto'] })
  const { data: atrasados } = useExamCards({ status: ['atrasado'] })
  const { data: aguardando } = useExamCards({ status: ['aguardando_lab'] })

  const tabCards = activeTab === 'prontos' ? prontos
    : activeTab === 'atrasados' ? atrasados
    : aguardando

  const tabs = [
    {
      id: 'prontos' as MobileTab,
      icon: FileCheck2,
      count: stats?.total_exame_pronto ?? 0,
      color: 'text-amber-600 dark:text-amber-400',
      bg: 'bg-amber-50 dark:bg-amber-950/40',
      label: 'Prontos',
    },
    {
      id: 'atrasados' as MobileTab,
      icon: AlertTriangle,
      count: stats?.total_atrasado ?? 0,
      color: 'text-red-600 dark:text-red-400',
      bg: 'bg-red-50 dark:bg-red-950/40',
      label: 'Atrasados',
    },
    {
      id: 'aguardando' as MobileTab,
      icon: FlaskConical,
      count: stats?.total_aguardando_lab ?? 0,
      color: 'text-blue-600 dark:text-blue-400',
      bg: 'bg-blue-50 dark:bg-blue-950/40',
      label: 'Lab',
    },
  ]

  const activeTabConfig = tabs.find((t) => t.id === activeTab)!

  return (
    <>
      <motion.div
        variants={fadeUp}
        initial="initial"
        animate="animate"
        exit="exit"
        className="space-y-4 md:space-y-8"
      >
        {/* ── MOBILE LAYOUT ────────────────────────────────────── */}
        <div className="md:hidden space-y-4">

          {/* Stats pills */}
          <div className="flex gap-2">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'flex-1 flex flex-col items-center gap-1 py-3 rounded-xl border transition-all',
                  activeTab === tab.id
                    ? 'bg-[hsl(var(--card))] border-[hsl(var(--primary))] shadow-sm'
                    : 'bg-[hsl(var(--card))] border-[hsl(var(--border))]'
                )}
              >
                <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center', tab.bg)}>
                  <tab.icon className={cn('w-4 h-4', tab.color)} />
                </div>
                <span className={cn(
                  'text-xl font-bold tabular-nums',
                  activeTab === tab.id ? tab.color : 'text-[hsl(var(--foreground))]'
                )}>
                  {tab.count}
                </span>
                <span className="text-[10px] text-[hsl(var(--muted-foreground))] font-medium">
                  {tab.label}
                </span>
              </button>
            ))}
          </div>

          {/* Contato realizado pill */}
          <Link
            to="/tracking"
            className="flex items-center justify-between px-4 py-2.5 rounded-xl bg-[hsl(var(--card))] border border-[hsl(var(--border))]"
          >
            <div className="flex items-center gap-2">
              <Phone className="w-3.5 h-3.5 text-green-500" />
              <span className="text-xs text-[hsl(var(--muted-foreground))]">Contato realizado</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-sm font-bold text-[hsl(var(--foreground))]">
                {stats?.total_contato_realizado ?? 0}
              </span>
              <ChevronRight className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))]" />
            </div>
          </Link>

          {/* Card list */}
          <div className="space-y-2">
            {(!tabCards || tabCards.length === 0) && (
              <div className="flex flex-col items-center py-12 text-[hsl(var(--muted-foreground))]">
                <activeTabConfig.icon className="w-8 h-8 mb-2 opacity-20" />
                <p className="text-sm">Nenhum exame</p>
              </div>
            )}

            <AnimatePresence mode="popLayout">
              {tabCards?.map((card) => (
                <MobileCard
                  key={card.id}
                  card={card}
                  onClick={() => setSelectedCard(card)}
                />
              ))}
            </AnimatePresence>
          </div>
        </div>

        {/* ── DESKTOP LAYOUT ───────────────────────────────────── */}
        <div className="hidden md:block space-y-8">
          <div>
            <h1 className="text-2xl font-bold text-[hsl(var(--foreground))] tracking-tight">Dashboard</h1>
            <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">
              Visao geral dos exames em andamento
            </p>
          </div>

          <motion.div
            variants={staggerContainer}
            initial="initial"
            animate="animate"
            className="grid grid-cols-2 lg:grid-cols-4 gap-4"
          >
            {tabs.map((tab) => (
              <motion.div
                key={tab.id}
                variants={staggerItem}
                className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-5 shadow-sm"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wide">
                      {tab.label}
                    </p>
                    <p className={cn('text-3xl font-bold mt-1', tab.color)}>{tab.count}</p>
                  </div>
                  <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center', tab.bg)}>
                    <tab.icon className={cn('w-5 h-5', tab.color)} />
                  </div>
                </div>
              </motion.div>
            ))}
            <motion.div
              variants={staggerItem}
              className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-5 shadow-sm"
            >
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wide">
                    Contato
                  </p>
                  <p className="text-3xl font-bold mt-1 text-green-600 dark:text-green-400">
                    {stats?.total_contato_realizado ?? 0}
                  </p>
                </div>
                <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-green-50 dark:bg-green-950/40">
                  <Phone className="w-5 h-5 text-green-600 dark:text-green-400" />
                </div>
              </div>
            </motion.div>
          </motion.div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <StatusChart />
            <div className="lg:col-span-2 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-sm p-5">
              <div className="flex items-center gap-2 mb-4">
                <AlertTriangle className="w-4 h-4 text-red-500" />
                <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">
                  Precisam de Atenção
                  {(atrasados?.length ?? 0) > 0 && (
                    <span className="ml-2 inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-400 text-xs font-bold">
                      {atrasados!.length}
                    </span>
                  )}
                </h3>
              </div>

              {!atrasados || atrasados.length === 0 ? (
                <div className="flex flex-col items-center py-12 text-[hsl(var(--muted-foreground))]">
                  <div className="w-10 h-10 rounded-full bg-green-50 dark:bg-green-950/30 flex items-center justify-center mb-3">
                    <span className="text-green-600 dark:text-green-400 font-bold text-sm">OK</span>
                  </div>
                  <p className="text-sm font-medium text-green-600 dark:text-green-400">Tudo em dia</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {atrasados.slice(0, 8).map((card) => (
                    <div
                      key={card.id}
                      className="flex items-center justify-between py-2.5 px-3 rounded-lg bg-[hsl(var(--muted))]/50 hover:bg-[hsl(var(--muted))] transition-colors cursor-pointer"
                      onClick={() => setSelectedCard(card)}
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-[hsl(var(--foreground))] truncate">
                          {card.pet_name ?? '—'}
                        </p>
                        <p className="text-xs text-[hsl(var(--muted-foreground))] truncate">
                          {card.items?.[0]?.exam_type ?? '—'}
                        </p>
                      </div>
                      <span className="text-sm font-semibold text-red-600 dark:text-red-400 ml-3 shrink-0">
                        {formatHours(card.hours_elapsed)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </motion.div>

      <AnimatePresence>
        {selectedCard && (
          <TrackingDetail card={selectedCard} onClose={() => setSelectedCard(null)} />
        )}
      </AnimatePresence>
    </>
  )
}

/* ── Mobile Card Component ──────────────────────────────────── */
function MobileCard({ card, onClick }: { card: ExamCard; onClick: () => void }) {
  const items = card.items ?? []
  const speciesType = getSpeciesType(card.pet_species)
  const SpeciesIcon = speciesType === 'cat' ? Cat : speciesType === 'dog' ? Dog : null
  const timeColor = card.alert_level === 'critical'
    ? 'text-red-500'
    : card.alert_level === 'warning'
    ? 'text-amber-500'
    : 'text-[hsl(var(--muted-foreground))]'

  const resultDate = items.find((i) => i.result_received_at)?.result_received_at
  const displayDate = resultDate || card.created_at
  const formattedDate = displayDate
    ? new Date(displayDate).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
    : null

  return (
    <motion.div
      layout
      variants={staggerItem}
      initial="initial"
      animate="animate"
      exit={{ opacity: 0, scale: 0.95 }}
      onClick={onClick}
      className={cn(
        'rounded-xl border bg-[hsl(var(--card))] p-3 cursor-pointer transition-all active:scale-[0.98]',
        card.alert_level === 'critical'
          ? 'border-red-200 dark:border-red-900/60'
          : card.alert_level === 'warning'
          ? 'border-amber-200 dark:border-amber-900/60'
          : 'border-[hsl(var(--border))]'
      )}
    >
      {/* Header: pet + time */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {card.alert_level === 'critical' && (
              <span className="w-2 h-2 rounded-full bg-red-500 shrink-0 alert-dot-critical" />
            )}
            {card.alert_level === 'warning' && (
              <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0 alert-dot-warning" />
            )}
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
                {card.vet_avatar_url ? (
                  <img src={card.vet_avatar_url} alt="" className="w-3.5 h-3.5 rounded-full object-cover" />
                ) : (
                  <Stethoscope className="w-2.5 h-2.5 shrink-0" />
                )}
                {card.vet_name.split(' ')[0]}
              </span>
            )}
          </div>
        </div>
        <div className={cn('flex items-center gap-1 shrink-0', timeColor)}>
          <Clock className="w-3 h-3" />
          <span className="text-xs font-semibold tabular-nums">{formatHours(card.hours_elapsed)}</span>
        </div>
      </div>

      {/* Exam items (compact) */}
      {items.length > 0 && (
        <div className="space-y-0.5 mb-2">
          {items.slice(0, 3).map((item) => (
            <div key={item.id} className="flex items-center gap-2 pl-1">
              <span className={cn(
                'w-1.5 h-1.5 rounded-full shrink-0',
                item.result_received ? 'bg-green-500' : 'bg-[hsl(var(--border))]'
              )} />
              <span className="text-xs text-[hsl(var(--foreground))] truncate">{item.exam_type}</span>
              {item.lab_name && (
                <span className="text-[10px] text-[hsl(var(--muted-foreground))]/60 truncate ml-auto">
                  {item.lab_name}
                </span>
              )}
            </div>
          ))}
          {items.length > 3 && (
            <p className="text-[10px] text-[hsl(var(--muted-foreground))]/50 pl-4">
              +{items.length - 3} mais
            </p>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between pt-1.5 border-t border-[hsl(var(--border))]/30">
        <div className="flex items-center gap-1.5">
          {card.is_orphan && (
            <span className="text-[10px] text-amber-600 dark:text-amber-400 font-medium">Sem venda</span>
          )}
          {formattedDate && (
            <span className="flex items-center gap-0.5 text-[10px] text-[hsl(var(--muted-foreground))]/60">
              <Calendar className="w-2.5 h-2.5" />
              {formattedDate}
            </span>
          )}
        </div>
        {card.items_total > 0 && (
          <span className="text-[10px] text-[hsl(var(--muted-foreground))] tabular-nums">
            {card.items_ready}/{card.items_total}
          </span>
        )}
      </div>
    </motion.div>
  )
}
