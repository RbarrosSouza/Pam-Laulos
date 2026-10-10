import { useRef, useState } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { Loader2, Stethoscope } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useExamAuth } from '@/contexts/exam-auth'
import { useQueryClient } from '@tanstack/react-query'

function safeSignInRedirect(raw: string | null) {
  const fallback = '/novos-exames'
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || Array.from(raw).some(character =>
    character === '\\' || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  )) return fallback
  const base = 'https://pamlaudos-redirect.invalid'
  try {
    const target = new URL(raw, base)
    const routes = new Set(['/', '/tracking', '/ship', '/shipments', '/late', '/settings', '/novos-exames'])
    const documentRoute = /^\/novos-exames\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(target.pathname)
    if (target.origin !== base || (!routes.has(target.pathname) && !documentRoute)) return fallback
    return `${target.pathname}${target.search}${target.hash}`
  } catch { return fallback }
}

export function SignIn() {
  const auth = useExamAuth()
  const client = useQueryClient()
  const [params] = useSearchParams()
  const redirect = safeSignInRedirect(params.get('redirect'))
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestPending = useRef(false)
  if (auth.session && auth.membership && !auth.loading) return <Navigate to={redirect} replace />
  if (auth.session && !auth.loading) return (
    <main className="min-h-screen flex items-center justify-center p-4 bg-[hsl(var(--background))]">
      <section className="w-full max-w-sm rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-7 space-y-5">
        <Stethoscope className="w-8 h-8 text-[hsl(var(--primary))]" />
        <h1 className="text-xl font-bold">Acesso da equipe</h1>
        <p className="text-sm break-all">Você entrou com {auth.session.user.email}.</p>
        <p className="text-sm text-[hsl(var(--muted-foreground))]">{auth.membershipError || 'Esta conta ainda não está autorizada para os exames. Solicite a liberação à gestão ou entre com outra conta.'}</p>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <button type="button" disabled={busy} className="w-full rounded-lg bg-[hsl(var(--primary))] text-white py-2.5 disabled:opacity-50" onClick={async () => {
          if (requestPending.current) return
          requestPending.current = true; setBusy(true); setError(null)
          try {
            const { error: logoutError } = await supabase.auth.signOut({ scope: 'local' })
            if (logoutError) throw logoutError
            client.clear(); setPassword('')
          } catch { setError('Não foi possível sair desta conta. Tente novamente.') }
          finally { requestPending.current = false; setBusy(false) }
        }}>{busy ? 'Aguarde…' : 'Sair e entrar com outra conta'}</button>
        <button type="button" disabled={busy} className="w-full text-sm underline disabled:opacity-50" onClick={async () => {
          if (requestPending.current) return
          requestPending.current = true; setBusy(true); setError(null)
          try { await auth.refreshMembership() }
          catch { setError('Não foi possível conferir seu acesso. Tente novamente.') }
          finally { requestPending.current = false; setBusy(false) }
        }}>Conferir liberação novamente</button>
      </section>
    </main>
  )
  return (
    <main className="min-h-screen flex items-center justify-center p-4 bg-[hsl(var(--background))]">
      <form className="w-full max-w-sm rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-7 space-y-5" onSubmit={async (event) => {
        event.preventDefault(); if (requestPending.current || auth.loading) return
        requestPending.current = true; setBusy(true); setError(null)
        try {
          const { error: loginError } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
          if (loginError) setError('Não foi possível entrar. Confira seu e-mail e senha da clínica.')
        } catch { setError('Não foi possível conectar para entrar. Confira sua conexão e tente novamente.') }
        finally { requestPending.current = false; setBusy(false) }
      }}>
        <Stethoscope className="w-8 h-8 text-[hsl(var(--primary))]" />
        <div><h1 className="text-2xl font-bold">Entrar no PamLaudos</h1><p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">Use sua conta da clínica.</p></div>
        <label className="block text-sm">E-mail<input autoComplete="username" required disabled={busy || auth.loading} type="email" value={email} onChange={e => setEmail(e.target.value)} className="mt-1 w-full rounded-lg border border-[hsl(var(--input))] bg-transparent px-3 py-2" /></label>
        <label className="block text-sm">Senha<input autoComplete="current-password" required disabled={busy || auth.loading} type="password" value={password} onChange={e => setPassword(e.target.value)} className="mt-1 w-full rounded-lg border border-[hsl(var(--input))] bg-transparent px-3 py-2" /></label>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <button disabled={busy || auth.loading} className="w-full rounded-lg bg-[hsl(var(--primary))] text-white py-2.5 flex items-center justify-center gap-2 disabled:opacity-50">{busy && <Loader2 className="w-4 h-4 animate-spin" />}Entrar</button>
        <Link to="/" className="block text-sm text-center text-[hsl(var(--muted-foreground))]">Voltar ao painel</Link>
      </form>
    </main>
  )
}
