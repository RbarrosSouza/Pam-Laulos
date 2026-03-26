import { useState } from 'react'
import { motion } from 'framer-motion'
import { Package, Plus, Check, X, User, Cat, Dog, Loader2 } from 'lucide-react'
import { usePendingSamples, useCreateShipment, useCreateManualSample } from '@/hooks/useShipment'
import { fadeUp } from '@/lib/animations'
import { cn, getSpeciesType } from '@/lib/utils'
import { toast } from 'sonner'
import { useNavigate } from 'react-router-dom'

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

    try {
      await shipMutation.mutateAsync({
        itemIds: Array.from(selected),
        sentBy: sentBy.trim(),
        labName: labName.trim() || undefined,
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
          <Package className="w-5 h-5 text-[hsl(var(--primary))]" />
          <h1 className="text-lg font-bold text-[hsl(var(--foreground))]">Enviar Amostras</h1>
        </div>
        <button
          onClick={() => navigate(-1)}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Responsável + Lab */}
      <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 space-y-3">
        <div>
          <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] mb-1 block">Responsável pelo envio</label>
          <input
            type="text"
            value={sentBy}
            onChange={(e) => setSentBy(e.target.value)}
            placeholder="Quem está enviando..."
            className="w-full px-3 py-2 text-sm rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]/40"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] mb-1 block">Laboratório destino</label>
          <input
            type="text"
            value={labName}
            onChange={(e) => setLabName(e.target.value)}
            placeholder="Opcional..."
            className="w-full px-3 py-2 text-sm rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]/40"
          />
        </div>
      </div>

      {/* Sample list */}
      <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] overflow-hidden">
        <div className="px-4 py-3 border-b border-[hsl(var(--border))] bg-[hsl(var(--muted))]/30 flex items-center justify-between">
          <span className="text-xs font-semibold text-[hsl(var(--foreground))]">
            Amostras pendentes ({pendingItems.length})
          </span>
          {pendingItems.length > 0 && (
            <button onClick={selectAll} className="text-xs text-[hsl(var(--primary))] font-medium">
              Selecionar todas
            </button>
          )}
        </div>

        {isLoading && (
          <div className="p-8 flex justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-[hsl(var(--muted-foreground))]" />
          </div>
        )}

        {!isLoading && pendingItems.length === 0 && (
          <div className="p-8 text-center text-sm text-[hsl(var(--muted-foreground))]">
            Nenhuma amostra pendente de envio
          </div>
        )}

        {pendingItems.map((item) => {
          const species = getSpeciesType(item.card.pet_species)
          const SpeciesIcon = species === 'cat' ? Cat : species === 'dog' ? Dog : null
          return (
            <button
              key={item.id}
              onClick={() => toggleItem(item.id)}
              className={cn(
                'w-full flex items-center gap-3 px-4 py-3 border-b border-[hsl(var(--border))]/50 last:border-0 transition-colors text-left',
                selected.has(item.id)
                  ? 'bg-[hsl(var(--accent))]/40'
                  : 'hover:bg-[hsl(var(--muted))]/30'
              )}
            >
              {/* Checkbox */}
              <div className={cn(
                'w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-all',
                selected.has(item.id)
                  ? 'bg-[hsl(var(--primary))] border-[hsl(var(--primary))]'
                  : 'border-[hsl(var(--border))]'
              )}>
                {selected.has(item.id) && <Check className="w-3 h-3 text-white" />}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  {SpeciesIcon && <SpeciesIcon className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))]/60 shrink-0" />}
                  <span className="text-sm font-medium text-[hsl(var(--foreground))] truncate">
                    {item.card.pet_name ?? '—'}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-[hsl(var(--muted-foreground))] truncate">{item.exam_type}</span>
                  {item.lab_name && (
                    <span className="text-[10px] text-[hsl(var(--muted-foreground))]/50">{item.lab_name}</span>
                  )}
                </div>
              </div>

              {/* Client */}
              {item.card.client_name && (
                <span className="flex items-center gap-0.5 text-[10px] text-[hsl(var(--muted-foreground))] shrink-0">
                  <User className="w-2.5 h-2.5" />
                  {item.card.client_name.split(' ')[0]}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Create manual */}
      {!showManual ? (
        <button
          onClick={() => setShowManual(true)}
          className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border border-dashed border-[hsl(var(--border))] text-sm text-[hsl(var(--muted-foreground))] hover:border-[hsl(var(--primary))]/60 hover:text-[hsl(var(--primary))] transition-colors"
        >
          <Plus className="w-4 h-4" />
          Criar amostra avulsa
        </button>
      ) : (
        <div className="rounded-xl border border-amber-200 dark:border-amber-900/60 bg-[hsl(var(--card))] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-amber-600 dark:text-amber-400">Amostra avulsa (sem venda)</span>
            <button onClick={() => setShowManual(false)} className="text-[hsl(var(--muted-foreground))]">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input
              placeholder="Nome do pet"
              value={manual.petName}
              onChange={(e) => setManual({ ...manual, petName: e.target.value })}
              className="px-3 py-2 text-sm rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring))]/40"
            />
            <input
              placeholder="Nome do tutor"
              value={manual.clientName}
              onChange={(e) => setManual({ ...manual, clientName: e.target.value })}
              className="px-3 py-2 text-sm rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring))]/40"
            />
            <input
              placeholder="Tipo de exame"
              value={manual.examType}
              onChange={(e) => setManual({ ...manual, examType: e.target.value })}
              className="px-3 py-2 text-sm rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring))]/40"
            />
            <input
              placeholder="Laboratório"
              value={manual.labName}
              onChange={(e) => setManual({ ...manual, labName: e.target.value })}
              className="px-3 py-2 text-sm rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring))]/40"
            />
          </div>
          <button
            onClick={handleCreateManual}
            disabled={manualMutation.isPending}
            className="w-full py-2 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 transition-colors disabled:opacity-50"
          >
            {manualMutation.isPending ? 'Criando...' : 'Criar amostra'}
          </button>
        </div>
      )}

      {/* Submit */}
      <button
        onClick={handleShip}
        disabled={selected.size === 0 || !sentBy.trim() || shipMutation.isPending}
        className={cn(
          'w-full py-3.5 rounded-xl text-sm font-semibold transition-all',
          selected.size > 0 && sentBy.trim()
            ? 'bg-[hsl(var(--primary))] text-white hover:opacity-90 active:scale-[0.98]'
            : 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] cursor-not-allowed'
        )}
      >
        {shipMutation.isPending ? (
          <Loader2 className="w-4 h-4 animate-spin mx-auto" />
        ) : (
          `Enviar ${selected.size} amostra${selected.size !== 1 ? 's' : ''}`
        )}
      </button>
    </motion.div>
  )
}
