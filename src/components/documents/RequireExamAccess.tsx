import { useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Loader2, LockKeyhole } from 'lucide-react'
import { useExamAuth } from '@/contexts/exam-auth'
import { supabase } from '@/lib/supabase'
import { useQueryClient } from '@tanstack/react-query'

export function RequireExamAccess({ children }: { children: ReactNode }) {
  const auth = useExamAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const client = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const requestPending = useRef(false)
  const loginPath = `/entrar?redirect=${encodeURIComponent(`${location.pathname}${location.search}${location.hash}`)}`
  if (auth.loading) return <div className="flex items-center gap-2 py-16 justify-center"><Loader2 className="w-5 h-5 animate-spin" />Conferindo acesso…</div>
  if (!auth.session || !auth.membership) return (
    <div className="max-w-lg mx-auto mt-10 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-7 text-center space-y-4">
      <LockKeyhole className="w-9 h-9 mx-auto text-[hsl(var(--primary))]" />
      <h1 className="text-xl font-semibold">Exames da equipe</h1>
      {auth.session?.user.email && <p className="text-xs text-[hsl(var(--muted-foreground))] break-all">Conta: {auth.session.user.email}</p>}
      <p className="text-sm text-[hsl(var(--muted-foreground))]">{auth.session ? auth.membershipError || 'Seu usuário ainda não tem acesso aos documentos de exames. Solicite a liberação à gestão da clínica.' : 'Entre com sua conta da clínica para acessar os novos exames e seus arquivos.'}</p>
      {actionError && <p role="alert" className="text-sm text-red-600">{actionError}</p>}
      {!auth.session ? <Link className="inline-flex rounded-lg bg-[hsl(var(--primary))] px-4 py-2 text-white" to={loginPath}>Entrar</Link> : <div className="flex flex-wrap gap-3 justify-center">
        <button type="button" disabled={busy} className="rounded-lg border px-4 py-2 disabled:opacity-50" onClick={async () => {
          if (requestPending.current) return
          requestPending.current = true; setBusy(true); setActionError(null)
          try { await auth.refreshMembership() }
          catch { setActionError('Não foi possível conferir seu acesso. Tente novamente.') }
          finally { requestPending.current = false; setBusy(false) }
        }}>{busy ? 'Aguarde…' : 'Conferir novamente'}</button>
        <button type="button" disabled={busy} className="rounded-lg bg-[hsl(var(--primary))] px-4 py-2 text-white disabled:opacity-50" onClick={async () => {
          if (requestPending.current) return
          requestPending.current = true; setBusy(true); setActionError(null)
          try {
            const { error } = await supabase.auth.signOut({ scope: 'local' })
            if (error) throw error
            client.clear(); navigate(loginPath, { replace: true })
          } catch { setActionError('Não foi possível sair desta conta. Tente novamente.') }
          finally { requestPending.current = false; setBusy(false) }
        }}>Sair e trocar conta</button>
      </div>}
    </div>
  )
  return children
}
