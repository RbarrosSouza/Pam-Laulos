import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { ExamCard, LabShipmentWithItems } from '@/types/exam-card'

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

/** Create a shipment, mark items as sent, and log in card history */
export function useCreateShipment() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      itemIds,
      sentBy,
      labName,
      notes,
      affectedCardIds,
    }: {
      itemIds: string[]
      sentBy: string
      labName?: string
      notes?: string
      affectedCardIds: string[]
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

      // 3. Log in card history for each affected card
      const now = new Date()
      const timeStr = now.toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'America/Sao_Paulo',
      })
      const labStr = labName ? ` ao laboratório ${labName}` : ''
      const reason = `Exame enviado${labStr} às ${timeStr} por ${sentBy}`

      const logEntries = affectedCardIds.map((cardId) => ({
        exam_card_id: cardId,
        new_status: 'aguardando_lab',
        changed_by: sentBy,
        change_reason: reason,
      }))

      const { error: logErr } = await supabase
        .from('exam_card_log')
        .insert(logEntries)

      if (logErr) throw logErr

      return shipment
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['exam-cards'] })
      queryClient.invalidateQueries({ queryKey: ['pending-samples'] })
      queryClient.invalidateQueries({ queryKey: ['exam-card-stats'] })
      queryClient.invalidateQueries({ queryKey: ['exam-card-logs'] })
      queryClient.invalidateQueries({ queryKey: ['shipment-history'] })
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

/** Fetch shipment history with item details */
export function useShipmentHistory(filters?: {
  dateFrom?: string
  dateTo?: string
}) {
  return useQuery({
    queryKey: ['shipment-history', filters],
    queryFn: async () => {
      let query = supabase
        .from('lab_shipment')
        .select('*')
        .order('sent_at', { ascending: false })

      if (filters?.dateFrom) {
        query = query.gte('sent_at', filters.dateFrom)
      }
      if (filters?.dateTo) {
        query = query.lte('sent_at', filters.dateTo + 'T23:59:59')
      }

      const { data: shipments, error } = await query
      if (error) throw error
      if (!shipments?.length) return [] as LabShipmentWithItems[]

      // Fetch items for all shipments
      const shipmentIds = shipments.map((s) => s.id)
      const { data: items, error: itemsErr } = await supabase
        .from('exam_item')
        .select('id, exam_type, shipment_id, exam_card_id')
        .in('shipment_id', shipmentIds)

      if (itemsErr) throw itemsErr

      // Fetch card details for pet/client names
      const cardIds = [...new Set((items || []).map((i) => i.exam_card_id))]
      const { data: cards } = await supabase
        .from('exam_card')
        .select('id, pet_name, client_name')
        .in('id', cardIds)

      const cardMap = new Map(
        (cards || []).map((c) => [c.id, c])
      )

      return shipments.map((shipment) => ({
        ...shipment,
        items: (items || [])
          .filter((i) => i.shipment_id === shipment.id)
          .map((i) => {
            const card = cardMap.get(i.exam_card_id)
            return {
              id: i.id,
              exam_type: i.exam_type,
              pet_name: card?.pet_name || null,
              client_name: card?.client_name || null,
            }
          }),
      })) as LabShipmentWithItems[]
    },
  })
}
