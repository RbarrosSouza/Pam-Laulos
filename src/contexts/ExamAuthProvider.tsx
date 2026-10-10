import { useEffect, useState, useCallback, useRef } from 'react'
import type { ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { ExamAuthContext } from './exam-auth'

type TeamRole = 'admin' | 'vet' | 'reception'

export function ExamAuthProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient()
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [membership, setMembership] = useState(false)
  const [role, setRole] = useState<TeamRole | null>(null)
  const [membershipError, setMembershipError] = useState<string | null>(null)
  const mounted = useRef(false)
  const generation = useRef(0)
  const userId = useRef<string | null>(null)
  const invalidateChecks = useCallback(() => { generation.current++ }, [])

  const update = useCallback(async (current: Session | null) => {
    if (!mounted.current) return
    const revision = ++generation.current
    const changedUser = userId.current !== (current?.user.id || null)
    userId.current = current?.user.id || null
    setSession(current)
    // A token refresh must not unmount a contact form and erase an unsaved note.
    if (changedUser) { client.clear(); setMembership(false); setRole(null); setLoading(true) }
    if (!current) { setMembership(false); setRole(null); setMembershipError(null); setLoading(false); return }
    try {
      const { data, error } = await supabase.rpc('is_exam_document_member')
      const member = !error && data === true ? await supabase.from('exam_document_member').select('role').eq('user_id', current.user.id).eq('active', true).maybeSingle() : null
      if (!mounted.current || generation.current !== revision) return
      const memberRole = member?.data?.role
      setMembership(!error && !member?.error && data === true)
      setRole(['admin', 'vet', 'reception'].includes(memberRole) ? memberRole as TeamRole : null)
      setMembershipError(error || member?.error ? 'Não foi possível conferir seu acesso. Tente novamente.' : null)
    } catch {
      if (!mounted.current || generation.current !== revision) return
      setMembership(false); setRole(null); setMembershipError('Não foi possível conferir seu acesso. Tente novamente.')
    }
    if (mounted.current && generation.current === revision) setLoading(false)
  }, [client])

  const refreshMembership = useCallback(async () => {
    const { data: { session: current } } = await supabase.auth.getSession()
    await update(current)
  }, [update])

  useEffect(() => {
    mounted.current = true
    const startup = generation.current
    supabase.auth.getSession().then(({ data }) => {
      if (mounted.current && generation.current === startup) void update(data.session)
    }).catch(() => {
      if (mounted.current && generation.current === startup) { setMembershipError('Não foi possível carregar sua sessão.'); setLoading(false) }
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, current) => {
      // Supabase holds its auth lock during this callback.
      window.setTimeout(() => { void update(current) }, 0)
    })
    return () => { mounted.current = false; invalidateChecks(); subscription.unsubscribe() }
  }, [update, invalidateChecks])

  return <ExamAuthContext.Provider value={{ session, loading, membership, role, membershipError, refreshMembership }}>{children}</ExamAuthContext.Provider>
}
