import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

export function useRealtimeExams() {
  const queryClient = useQueryClient()

  useEffect(() => {
    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: ['exam-cards'] })
      queryClient.invalidateQueries({ queryKey: ['exam-card-stats'] })
    }

    const cardChannel = supabase
      .channel('exam-cards-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'exam_card' }, invalidate)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'exam_item' }, invalidate)
      .subscribe()

    return () => {
      supabase.removeChannel(cardChannel)
    }
  }, [queryClient])
}
