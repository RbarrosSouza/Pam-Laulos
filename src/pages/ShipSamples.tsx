import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { SamplesView } from '@/components/samples/SamplesView'
import { pendingSamples, selectedSamples, type ManualSampleDraft } from '@/components/samples/sample-selection'
import { usePendingSamples, useCreateShipment, useCreateManualSample } from '@/hooks/useShipment'

export function ShipSamples() {
  const navigate = useNavigate()
  const query = usePendingSamples()
  const shipMutation = useCreateShipment()
  const manualMutation = useCreateManualSample()
  const operation = useRef<'ship' | 'manual' | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sentBy, setSentBy] = useState('')
  const [labName, setLabName] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [manualError, setManualError] = useState<string | null>(null)
  const items = pendingSamples(query.data || [])

  const selectItems = (ids: string[], checked: boolean) => {
    if (operation.current) return
    const eligible = new Set(items.map(item => item.id))
    setSelected(previous => {
      const next = new Set(previous)
      ids.forEach(id => { if (checked && eligible.has(id)) next.add(id); else next.delete(id) })
      return next
    })
    setSubmitError(null)
  }

  const handleShip = async (): Promise<boolean> => {
    if (operation.current) return false
    const batch = selectedSamples(items, selected)
    const sender = sentBy.trim()
    if (!batch.length || !sender) {
      setSubmitError(!batch.length ? 'Selecione pelo menos uma amostra pendente.' : 'Informe quem está enviando.')
      return false
    }
    // Freeze exactly the eligible items shown in the review, even if the query refreshes.
    const payload = {
      itemIds: batch.map(item => item.id),
      sentBy: sender,
      labName: labName.trim() || undefined,
      affectedCardIds: [...new Set(batch.map(item => item.card.id))],
    }
    operation.current = 'ship'
    setSubmitError(null)
    try {
      await shipMutation.mutateAsync(payload)
      setSelected(new Set())
      toast.success(`Envio de ${batch.length} amostra${batch.length === 1 ? '' : 's'} registrado`)
      navigate('/shipments')
      return true
    } catch {
      // The existing backend writes in stages: do not automatically retry an uncertain result.
      setSubmitError('Não foi possível confirmar o envio. Confira o histórico antes de tentar novamente.')
      return false
    } finally {
      operation.current = null
    }
  }

  const handleCreateManual = async (draft: ManualSampleDraft): Promise<boolean> => {
    if (operation.current) return false
    const payload = {
      petName: draft.petName.trim(), clientName: draft.clientName.trim(),
      examType: draft.examType.trim(), labName: draft.labName.trim() || undefined,
    }
    if (!payload.petName || !payload.examType) {
      setManualError('Informe o pet e o exame.')
      return false
    }
    operation.current = 'manual'
    setManualError(null)
    try {
      await manualMutation.mutateAsync(payload)
      toast.success('Amostra adicionada aos pendentes')
      return true
    } catch {
      setManualError('Não foi possível adicionar a amostra. Atualize a lista antes de tentar novamente.')
      return false
    } finally {
      operation.current = null
    }
  }

  return <SamplesView items={items} selectedIds={selected}
    onToggleItem={id => selectItems([id], !selected.has(id))}
    onSelectItems={selectItems} onClearSelection={() => { if (!operation.current) { setSelected(new Set()); setSubmitError(null) } }}
    loading={query.isLoading} error={query.error} refreshing={query.isFetching} onRefresh={() => { void query.refetch() }}
    sentBy={sentBy} onSentByChange={setSentBy} labName={labName} onLabNameChange={setLabName}
    submitting={shipMutation.isPending} submitError={submitError} onSubmit={handleShip}
    manualSubmitting={manualMutation.isPending} manualError={manualError} onCreateManual={handleCreateManual}
  />
}
