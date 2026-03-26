import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { ExamCardSummary } from '@/types/exam-card'

export function useExamCardStats() {
  return useQuery({
    queryKey: ['exam-card-stats'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_exam_card_summary')
      if (error) throw error
      return data as ExamCardSummary
    },
    refetchInterval: 30_000,
  })
}
