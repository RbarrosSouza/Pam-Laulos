import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Package, Plus, Check, X, User, Cat, Dog, Loader2, History, FlaskConical } from 'lucide-react'
import { usePendingSamples, useCreateShipment, useCreateManualSample } from '@/hooks/useShipment'
import { fadeUp, staggerContainer, staggerItem } from '@/lib/animations'
import { cn, getSpeciesType } from '@/lib/utils'
import { toast } from 'sonner'
import { useNavigate, Link } from 'react-router-dom'

export function ShipSamples() {
  const navigate = useNavigate()
  const { data: cards, isLoading } = usePendingSamples()
  const shipMutation = useCreateShipment()
  const manualMutation = useCreateManualSample()

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sentBy, setSentBy] = useState('')
  const [labName, setLabName] = useState('')
  const [showManual, setShowManual] = useState(false)
  const [manual, setManual] = useState({ petName: '', clientName: '', examType: '', labName: '' })

  const toggleItem = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const selectAll = () => {
    const allIds = cards?.flatMap((c) =>
      c.items.filter((i) => !i.sent_to_lab_at && !i.result_received).map((i) => i.id)
    ) ?? []
    setSelected(new Set(allIds))
  }

  const handleShip = async () => {
    if (selected.size === 0) return toast.error('Selecione pelo menos uma amostra')
    if (!sentBy.trim()) return toast.error('Informe quem está enviando')

    const affectedCardIds = [...new Set(
      pendingItems
        .filter((item) => selected.has(item.id))
        .map((item) => item.card.id)
    )]

    try {
      await shipMutation.mutateAsync({
        itemIds: Array.from(selected),
        sentBy: sentBy.trim(),
        labName: labName.trim() || undefined,
        affectedCardIds,
      })
      toast.success(`${selected.size} amostra${selected.size > 1 ? 's' : ''} enviada${selected.size > 1 ? 's' : ''}`)
      navigate('/')
    } catch (err: any) {
      toast.error('Erro: ' + (err.message || 'Tente novamente'))
    }
  }

  const handleCreateManual = async () => {
    if (!manual.petName || !manual.examType) return toast.error('Informe pet e tipo de exame')

    try {
      await manualMutation.mutateAsync({
        petName: manual.petName,
        clientName: manual.clientName,
        examType: manual.examType,
        labName: manual.labName || undefined,
      })
      toast.success('Amostra avulsa criada')
      setManual({ petName: '', clientName: '', examType: '', labName: '' })
      setShowManual(false)
    } catch (err: any) {
      toast.error('Erro: ' + (err.message || 'Tente novamente'))
    }
  }

  const pendingItems = cards?.flatMap((c) =>
    c.items
      .filter((i) => !i.sent_to_lab_at && !i.result_received)
      .map((i) => ({ ...i, card: c }))
  ) ?? []

  const inputClass = cn(
    'w-full h-11 px-4 text-sm rounded-xl border border-[hsl(var(--border))]',
    'bg-[hsl(var(--background))] text-[hsl(var(--foreground))]',
    'placeholder:text-[hsl(var(--muted-foreground))]',
    'focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary))]/30 focus:border-[hsl(var(--primary))]',
    'transition-all duration-200'
  )

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
            <Package className="w-4.5 h-4.5 text-[hsl(var(--primary))]" />
          </div>
          <h1 className="text-lg font-bold text-[hsl(var(--foreground))] tracking-tight">Enviar Amostras</h1>
        </div>
        <div className="flex items-center gap-1">
          <Link
            to="/shipments"
            className="w-9 h-9 flex items-center justify-center rounded-xl text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))] active:scale-95 transition-all"
            aria-label="Histórico de envios"
          >
            <History className="w-4 h-4" />
          </Link>
          <button
            onClick={() => navigate(-1)}
            className="w-9 h-9 flex items-center justify-center rounded-xl text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))] active:scale-95 transition-all"
            aria-label="Voltar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Form card */}
      <div className="rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 space-y-3 shadow-sm">
        <div>
          <label className="text-[11px] font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wider mb-1.5 block">
            Responsável
          </label>
          <input
            type="text"
            value={sentBy}
            onChange={(e) => setSentBy(e.target.value)}
            placeholder="Nome de quem está enviando…"
            className={inputClass}
          />
        </div>
        <div>
          <label className="text-[11px] font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wider mb-1.5 block">
            Laboratório
          </label>
          <input
            type="text"
            value={labName}
            onChange={(e) => setLabName(e.target.value)}
            placeholder="Destino (opcional)…"
            className={inputClass}
          />
        </div>
      </div>

      {/* Sample list */}
      <div className="rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] overflow-hidden shadow-sm">
        <div className="px-4 py-3 border-b border-[hsl(var(--border))] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FlaskConical className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))]" />
            <span className="text-xs font-semibold text-[hsl(var(--foreground))]">
              Pendentes
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] font-semibold tabular-nums">
              {pendingItems.length}
            </span>
          </div>
          {pendingItems.length > 0 && (
            <button
              onClick={selectAll}
              className="text-xs text-[hsl(var(--primary))] font-semibold hover:underline active:opacity-70 transition-opacity"
            >
              Selecionar todas
            </button>
          )}
        </div>

        {isLoading && (
          <div className="py-12 flex justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-[hsl(var(--primary))]" />
          </div>
        )}

        {!isLoading && pendingItems.length === 0 && (
          <div className="py-12 flex flex-col items-center gap-2">
            <div className="w-10 h-10 rounded-full bg-[hsl(var(--muted))] flex items-center justify-center">
              <Package className="w-5 h-5 text-[hsl(var(--muted-foreground))]" />
            </div>
            <p className="text-sm text-[hsl(var(--muted-foreground))]">Nenhuma amostra pendente</p>
          </div>
        )}

        <motion.div variants={staggerContainer} initial="initial" animate="animate">
          {pendingItems.map((item) => {
            const species = getSpeciesType(item.card.pet_species)
            const SpeciesIcon = species === 'cat' ? Cat : species === 'dog' ? Dog : null
            const isSelected = selected.has(item.id)
            return (
              <motion.button
                key={item.id}
                variants={staggerItem}
                onClick={() => toggleItem(item.id)}
                className={cn(
                  'w-full flex items-center gap-3 px-4 py-3.5',
                  'border-b border-[hsl(var(--border))]/50 last:border-0',
                  'text-left active:scale-[0.99] transition-all duration-150',
                  isSelected
                    ? 'bg-[hsl(var(--primary))]/5'
                    : 'hover:bg-[hsl(var(--muted))]/50'
                )}
              >
                {/* Checkbox */}
                <div className={cn(
                  'w-5 h-5 rounded-lg border-2 flex items-center justify-center shrink-0 transition-all duration-200',
                  isSelected
                    ? 'bg-[hsl(var(--primary))] border-[hsl(var(--primary))] shadow-sm shadow-[hsl(var(--primary))]/25'
                    : 'border-[hsl(var(--border))] dark:border-[hsl(var(--muted-foreground))]/30'
                )}>
                  {isSelected && <Check className="w-3 h-3 text-white" />}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    {SpeciesIcon && <SpeciesIcon className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))] shrink-0" />}
                    <span className="text-sm font-semibold text-[hsl(var(--foreground))] truncate">
                      {item.card.pet_name ?? '—'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-[hsl(var(--muted-foreground))] truncate">{item.exam_type}</span>
                    {item.lab_name && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] font-medium">
                        {item.lab_name}
                      </span>
                    )}
                  </div>
                </div>

                {/* Client */}
                {item.card.client_name && (
                  <span className="flex items-center gap-1 text-[10px] text-[hsl(var(--muted-foreground))] shrink-0">
                    <User className="w-2.5 h-2.5" />
                    {item.card.client_name.split(' ')[0]}
                  </span>
                )}
              </motion.button>
            )
          })}
        </motion.div>
      </div>

      {/* Create manual */}
      <AnimatePresence mode="wait">
        {!showManual ? (
          <motion.button
            key="manual-btn"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowManual(true)}
            className={cn(
              'w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl',
              'border border-dashed border-[hsl(var(--border))]',
              'text-sm text-[hsl(var(--muted-foreground))] font-medium',
              'hover:border-[hsl(var(--primary))] hover:text-[hsl(var(--primary))] hover:bg-[hsl(var(--primary))]/5',
              'active:scale-[0.98] transition-all duration-200'
            )}
          >
            <Plus className="w-4 h-4" />
            Amostra avulsa
          </motion.button>
        ) : (
          <motion.div
            key="manual-form"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className="rounded-2xl border border-amber-200 dark:border-amber-700/50 bg-[hsl(var(--card))] p-4 space-y-3 shadow-sm"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wider">
                Amostra avulsa
              </span>
              <button
                onClick={() => setShowManual(false)}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))] active:scale-90 transition-all"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                placeholder="Pet…"
                value={manual.petName}
                onChange={(e) => setManual({ ...manual, petName: e.target.value })}
                className={cn(inputClass, 'h-10')}
              />
              <input
                placeholder="Tutor…"
                value={manual.clientName}
                onChange={(e) => setManual({ ...manual, clientName: e.target.value })}
                className={cn(inputClass, 'h-10')}
              />
              <input
                placeholder="Tipo de exame…"
                value={manual.examType}
                onChange={(e) => setManual({ ...manual, examType: e.target.value })}
                className={cn(inputClass, 'h-10')}
              />
              <input
                placeholder="Laboratório…"
                value={manual.labName}
                onChange={(e) => setManual({ ...manual, labName: e.target.value })}
                className={cn(inputClass, 'h-10')}
              />
            </div>
            <button
              onClick={handleCreateManual}
              disabled={manualMutation.isPending}
              className={cn(
                'w-full h-10 rounded-xl text-sm font-semibold transition-all duration-200',
                'bg-amber-500 text-white shadow-sm shadow-amber-500/20',
                'hover:bg-amber-600 active:scale-[0.98] disabled:opacity-50'
              )}
            >
              {manualMutation.isPending ? 'Criando…' : 'Criar amostra'}
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Submit */}
      <motion.button
        onClick={handleShip}
        disabled={selected.size === 0 || !sentBy.trim() || shipMutation.isPending}
        whileTap={{ scale: 0.97 }}
        className={cn(
          'w-full h-13 rounded-2xl text-sm font-bold tracking-wide transition-all duration-200',
          selected.size > 0 && sentBy.trim()
            ? 'bg-[hsl(var(--primary))] text-white shadow-lg shadow-[hsl(var(--primary))]/20 hover:shadow-xl hover:shadow-[hsl(var(--primary))]/30'
            : 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] cursor-not-allowed'
        )}
        style={{ height: 52 }}
      >
        {shipMutation.isPending ? (
          <Loader2 className="w-5 h-5 animate-spin mx-auto" />
        ) : (
          `Enviar ${selected.size} amostra${selected.size !== 1 ? 's' : ''}`
        )}
      </motion.button>
    </motion.div>
  )
}
