import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { ExamCard } from '@/types/exam-card'

/** Fetch cards with pending items (not yet sent to lab, no result) */
export function usePendingSamples() {
  return useQuery({
    queryKey: ['pending-samples'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_exam_cards')
        .select('*')
        .eq('status', 'aguardando_lab')
        .order('created_at', { ascending: false })
      if (error) throw error
      // Filter to only cards that have at least one item not yet sent
      return (data || []).filter((card: ExamCard) =>
        card.items?.some((i) => !i.sent_to_lab_at && !i.result_received)
      ) as ExamCard[]
    },
  })
}

/** Create a shipment and mark items as sent */
export function useCreateShipment() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      itemIds,
      sentBy,
      labName,
      notes,
    }: {
      itemIds: string[]
      sentBy: string
      labName?: string
      notes?: string
    }) => {
      // 1. Create shipment record
      const { data: shipment, error: shipErr } = await supabase
        .from('lab_shipment')
        .insert({
          lab_name: labName || null,
          sent_by: sentBy,
          items_count: itemIds.length,
          notes: notes || null,
        })
        .select('id')
        .single()

      if (shipErr) throw shipErr

      // 2. Update all selected items
      const { error: updateErr } = await supabase
        .from('exam_item')
        .update({
          sent_to_lab_at: new Date().toISOString(),
          sent_to_lab_by: sentBy,
          shipment_id: shipment.id,
        })
        .in('id', itemIds)

      if (updateErr) throw updateErr

      return shipment
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['exam-cards'] })
      queryClient.invalidateQueries({ queryKey: ['pending-samples'] })
      queryClient.invalidateQueries({ queryKey: ['exam-card-stats'] })
    },
  })
}

/** Create an orphan card (manual sample without sale) */
export function useCreateManualSample() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      petName,
      clientName,
      examType,
      labName,
    }: {
      petName: string
      clientName: string
      examType: string
      labName?: string
    }) => {
      // Create card
      const { data: card, error: cardErr } = await supabase
        .from('exam_card')
        .insert({
          status: 'aguardando_lab',
          alert_level: 'normal',
          origin: 'venda',
          is_orphan: true,
          pet_name: petName,
          client_name: clientName,
        })
        .select('id')
        .single()

      if (cardErr) throw cardErr

      // Create exam item
      const { error: itemErr } = await supabase
        .from('exam_item')
        .insert({
          exam_card_id: card.id,
          exam_type: examType,
          lab_name: labName || null,
        })

      if (itemErr) throw itemErr

      return card
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['exam-cards'] })
      queryClient.invalidateQueries({ queryKey: ['pending-samples'] })
      queryClient.invalidateQueries({ queryKey: ['exam-card-stats'] })
    },
  })
}
