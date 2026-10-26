import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useExamAuth } from '@/contexts/exam-auth'
import { DocumentActionError, normalizeDocumentActionError } from '@/lib/document-action-error'
import type { DocumentCandidate, DocumentEvent, ExamDocument } from '@/types/exam-document'

export const DOCUMENT_PAGE_SIZE = 25
export type DocumentFilter = 'open' | 'all' | 'review' | 'unassigned' | 'group_failed' | 'contact' | 'nexus' | 'completed'

export function buildExamDocumentsQuery(search: string, filter: DocumentFilter) {
  let query = supabase.from('v_exam_documents').select('*', { count: 'exact' }).order('received_at', { ascending: false })
  if (filter === 'open') query = query.eq('completed', false).neq('identification_status', 'not_exam')
  if (filter === 'review') query = query.in('identification_status', ['unidentified', 'suggested', 'review'])
  if (filter === 'unassigned') query = query.is('responsible_vet_id', null).is('assigned_to', null).eq('completed', false)
  if (filter === 'group_failed') query = query.in('group_status', ['failed', 'uncertain'])
  if (filter === 'contact') query = query.neq('contact_status', 'completed').neq('identification_status', 'not_exam')
  if (filter === 'nexus') query = query.neq('nexus_status', 'completed').neq('identification_status', 'not_exam')
  if (filter === 'completed') query = query.eq('completed', true)
  const term = search.replace(/[(),]/g, ' ').trim()
  if (term) {
    const idTerm = term.replace(/^EX-/i, '')
    if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(idTerm)) query = query.eq('id', idTerm)
    else query = query.or(`display_code.ilike.%${term}%,original_name.ilike.%${term}%,extracted_data->>pet_name.ilike.%${term}%,extracted_data->>client_name.ilike.%${term}%,confirmed_data->>pet_name.ilike.%${term}%,confirmed_data->>client_name.ilike.%${term}%`)
  }
  return query
}

export async function fetchAllExamDocuments(search: string, filter: DocumentFilter): Promise<ExamDocument[]> {
  const { data, error } = await buildExamDocumentsQuery(search, filter).limit(1000)
  if (error) throw error
  return (data || []) as ExamDocument[]
}

export function useExamDocuments(search: string, filter: DocumentFilter, page: number) {
  const auth = useExamAuth()
  return useQuery({
    queryKey: ['exam-documents', auth.session?.user.id, search, filter, page],
    enabled: !!auth.session && auth.membership,
    queryFn: async () => {
      const query = buildExamDocumentsQuery(search, filter)
      const { data, error, count } = await query.range(page * DOCUMENT_PAGE_SIZE, (page + 1) * DOCUMENT_PAGE_SIZE - 1)
      if (error) throw error
      return { documents: (data || []) as ExamDocument[], count: count || 0 }
    },
    refetchInterval: 30_000,
  })
}

export function useExamDocument(id: string) {
  const auth = useExamAuth()
  return useQuery({
    queryKey: ['exam-document', auth.session?.user.id, id],
    enabled: !!id && !!auth.session && auth.membership,
    queryFn: async () => {
      const { data, error } = await supabase.from('v_exam_documents').select('*').eq('id', id).single()
      if (error) throw error
      return data as ExamDocument
    },
    refetchInterval: 15_000,
  })
}

export function useDocumentEvents(id: string) {
  const auth = useExamAuth()
  return useQuery({
    queryKey: ['exam-document-events', auth.session?.user.id, id],
    enabled: !!id && !!auth.session && auth.membership,
    queryFn: async () => {
      const { data, error } = await supabase.from('exam_document_event').select('*').eq('document_id', id).order('created_at', { ascending: false }).limit(100)
      if (error) throw error
      return (data || []) as DocumentEvent[]
    },
  })
}

export function useDocumentCandidates(query: string) {
  const auth = useExamAuth()
  return useQuery({
    queryKey: ['exam-document-candidates', auth.session?.user.id, query],
    enabled: auth.membership && query.trim().length >= 2,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('search_exam_document_candidates', { p_query: query.trim(), p_limit: 20 })
      if (error) throw error
      return (data || []) as DocumentCandidate[]
    },
  })
}

export async function callDocumentService(action: string, payload: Record<string, unknown> = {}, file?: File) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Entre novamente para continuar.')
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/exam-document-service`
  let body: BodyInit
  const headers: Record<string, string> = { Authorization: `Bearer ${session.access_token}`, apikey: import.meta.env.VITE_SUPABASE_ANON_KEY }
  if (file) {
    const form = new FormData()
    form.set('action', action)
    form.set('payload', JSON.stringify(payload))
    form.set('file', file)
    body = form
  } else {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify({ action, payload })
  }
  const response = await fetch(url, { method: 'POST', headers, body })
  if (!response.ok) {
    const result = await response.json().catch(() => null)
    throw new Error(result?.error || 'Não foi possível concluir esta etapa. Tente novamente.')
  }
  if (action === 'file') return response.blob()
  const result = await response.json()
  if (result.success === false || result.error) throw new Error(result.error || 'Não foi possível concluir esta etapa.')
  return result
}

export function useDocumentAction() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async ({ name, args }: { name: string; args: Record<string, unknown> }) => {
      try {
        const { data, error } = await supabase.rpc(name, args)
        if (error) throw error
        if (data?.success === false || data?.error) throw data.error
        return data
      } catch (error) {
        throw normalizeDocumentActionError(error)
      }
    },
    onError: error => {
      if (error instanceof DocumentActionError && error.code === '40001') {
        // Refresh the version/identity while the component preserves local edits.
        // A conflict must never trigger an automatic second write.
        client.invalidateQueries({ queryKey: ['exam-documents'] })
        client.invalidateQueries({ queryKey: ['exam-document'] })
        client.invalidateQueries({ queryKey: ['exam-document-events'] })
      }
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['exam-documents'] })
      client.invalidateQueries({ queryKey: ['exam-document'] })
      client.invalidateQueries({ queryKey: ['exam-document-events'] })
      client.invalidateQueries({ queryKey: ['exam-cards'] })
      client.invalidateQueries({ queryKey: ['exam-card'] })
      client.invalidateQueries({ queryKey: ['exam-card-logs'] })
      client.invalidateQueries({ queryKey: ['exam-card-stats'] })
    },
  })
}
