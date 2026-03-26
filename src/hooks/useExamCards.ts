import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { ExamCard, ExamCardLog, CardStatus } from '@/types/exam-card'

export function useExamCards(filters?: {
  status?: CardStatus[]
  search?: string
  vetName?: string
  dateFrom?: string
  dateTo?: string
}) {
  return useQuery({
    queryKey: ['exam-cards', filters],
    queryFn: async () => {
      let query = supabase.from('v_exam_cards').select('*')

      if (filters?.status && filters.status.length > 0) {
        query = query.in('status', filters.status)
      }
      if (filters?.search) {
        query = query.or(
          `pet_name.ilike.%${filters.search}%,client_name.ilike.%${filters.search}%,vet_name.ilike.%${filters.search}%`
        )
      }
      if (filters?.vetName) {
        query = query.ilike('vet_name', `%${filters.vetName}%`)
      }
      if (filters?.dateFrom) {
        query = query.gte('created_at', filters.dateFrom)
      }
      if (filters?.dateTo) {
        query = query.lte('created_at', filters.dateTo + 'T23:59:59')
      }

      const { data, error } = await query.order('updated_at', { ascending: false })
      if (error) throw error
      return (data || []) as ExamCard[]
    },
    refetchInterval: 60_000,
  })
}

export function useExamCardDetail(id: string) {
  return useQuery({
    queryKey: ['exam-card', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_exam_cards')
        .select('*')
        .eq('id', id)
        .single()
      if (error) throw error
      return data as ExamCard
    },
    enabled: !!id,
  })
}

export function useExamCardLogs(cardId: string) {
  return useQuery({
    queryKey: ['exam-card-logs', cardId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('exam_card_log')
        .select('*')
        .eq('exam_card_id', cardId)
        .order('created_at', { ascending: true })
      if (error) throw error
      return (data || []) as ExamCardLog[]
    },
    enabled: !!cardId,
  })
}

export function useMarkContact() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      examItemId,
      cardId,
      contactedBy,
      contactedAt,
    }: {
      examItemId: string
      cardId: string
      contactedBy: string
      contactedAt: string
    }) => {
      const { error: itemError } = await supabase
        .from('exam_item')
        .update({
          contacted: true,
          contacted_at: contactedAt,
          contacted_by: contactedBy,
        })
        .eq('id', examItemId)

      if (itemError) throw itemError

      const { error: logError } = await supabase.from('exam_card_log').insert({
        exam_card_id: cardId,
        new_status: 'contato_realizado',
        changed_by: contactedBy,
        change_reason: `Contato registrado por ${contactedBy}`,
      })

      if (logError) throw logError
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['exam-cards'] })
      queryClient.invalidateQueries({ queryKey: ['exam-card-stats'] })
    },
  })
}
