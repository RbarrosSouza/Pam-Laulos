import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

export interface Vet {
  id: string
  nome: string
  avatar_url: string | null
}

export function useVets() {
  return useQuery({
    queryKey: ['vets'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('veterinarios')
        .select('id, nome, avatar_url')
        .eq('ativo', true)
        .order('nome')
      if (error) throw error
      return (data || []) as Vet[]
    },
    staleTime: 5 * 60 * 1000,
  })
}
