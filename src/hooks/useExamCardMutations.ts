import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { CardStatus } from '@/types/exam-card'

// ─── Update Card ────────────────────────────────────────────────────────────

interface UpdateCardPayload {
  id: string
  pet_name?: string | null
  pet_species?: string | null
  pet_breed?: string | null
  client_name?: string | null
  client_phone?: string | null
  client_email?: string | null
  vet_name?: string | null
  status?: CardStatus
}

export function useUpdateCard() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, ...fields }: UpdateCardPayload) => {
      const { error } = await supabase
        .from('exam_card')
        .update({ ...fields, updated_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['exam-cards'] })
      queryClient.invalidateQueries({ queryKey: ['exam-card-stats'] })
    },
  })
}

// ─── Delete Card ────────────────────────────────────────────────────────────

export function useDeleteCard() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (cardId: string) => {
      const { error } = await supabase
        .from('exam_card')
        .delete()
        .eq('id', cardId)
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['exam-cards'] })
      queryClient.invalidateQueries({ queryKey: ['exam-card-stats'] })
    },
  })
}

// ─── Update Item ────────────────────────────────────────────────────────────

interface UpdateItemPayload {
  id: string
  exam_type?: string
  lab_name?: string | null
  result_received?: boolean
}

export function useUpdateItem() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, ...fields }: UpdateItemPayload) => {
      const payload: Record<string, unknown> = { ...fields }
      if (fields.result_received !== undefined) {
        payload.result_received_at = fields.result_received ? new Date().toISOString() : null
      }

      const { error } = await supabase
        .from('exam_item')
        .update(payload)
        .eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['exam-cards'] })
      queryClient.invalidateQueries({ queryKey: ['exam-card-stats'] })
    },
  })
}

// ─── Delete Item ────────────────────────────────────────────────────────────

export function useDeleteItem() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (itemId: string) => {
      const { error } = await supabase
        .from('exam_item')
        .delete()
        .eq('id', itemId)
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['exam-cards'] })
      queryClient.invalidateQueries({ queryKey: ['exam-card-stats'] })
    },
  })
}

// ─── Add Item ───────────────────────────────────────────────────────────────

interface AddItemPayload {
  exam_card_id: string
  exam_type: string
  lab_name?: string | null
}

// ─── Merge Cards ─────────────────────────────────────────────────────────────

export function useMergeCards() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      targetCardId,
      sourceCardId,
    }: {
      targetCardId: string
      sourceCardId: string
    }) => {
      const { data, error } = await supabase.rpc('merge_exam_cards', {
        p_target_card_id: targetCardId,
        p_source_card_id: sourceCardId,
      })
      if (error) throw error
      if (!data?.success) throw new Error(data?.error || 'Falha ao fundir')
      return data as { success: boolean; target_card_id: string; items_moved: number; new_status: string }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['exam-cards'] })
      queryClient.invalidateQueries({ queryKey: ['exam-card-stats'] })
      queryClient.invalidateQueries({ queryKey: ['exam-card-logs'] })
    },
  })
}

// ─── Add Item ───────────────────────────────────────────────────────────────

export function useAddItem() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (payload: AddItemPayload) => {
      const { error } = await supabase.from('exam_item').insert({
        ...payload,
        result_received: false,
        contacted: false,
      })
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['exam-cards'] })
      queryClient.invalidateQueries({ queryKey: ['exam-card-stats'] })
    },
  })
}
