import { useRef, useState } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useExamAuth } from '@/contexts/exam-auth'
import { useQueryClient } from '@tanstack/react-query'
import { LoginBrand, LoginView } from '@/components/auth/LoginView'

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
    const shortDocumentRoute = /^\/e\/[A-Za-z0-9_-]{21}[AQgw]$/.test(target.pathname)
    if (target.origin !== base || (!routes.has(target.pathname) && !documentRoute && !shortDocumentRoute)) return fallback
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
    <main className="login-page">
      <section className="login-panel login-access" aria-labelledby="login-access-title" aria-busy={busy}>
        <LoginBrand />
        <header className="login-heading">
          <h1 id="login-access-title">{auth.membershipError ? 'Vamos tentar de novo.' : 'Acesso da equipe'}</h1>
          <p className="login-account">Você entrou com <span>{auth.session.user.email}</span>.</p>
        </header>
        <p className="login-access-description">{auth.membershipError || 'Esta conta ainda não está autorizada para os exames. Solicite a liberação à gestão ou entre com outra conta.'}</p>
        {error && <p role="alert" className="login-error">{error}</p>}
        <div className="login-access-actions">
          <button type="button" disabled={busy} className="login-primary" onClick={async () => {
            if (requestPending.current) return
            requestPending.current = true; setBusy(true); setError(null)
            try {
              const { error: logoutError } = await supabase.auth.signOut({ scope: 'local' })
              if (logoutError) throw logoutError
              client.clear(); setPassword('')
            } catch { setError('Não foi possível sair desta conta. Tente novamente.') }
            finally { requestPending.current = false; setBusy(false) }
          }}>{busy ? 'Aguarde…' : 'Sair e entrar com outra conta'}</button>
          <button type="button" disabled={busy} className="login-secondary" onClick={async () => {
            if (requestPending.current) return
            requestPending.current = true; setBusy(true); setError(null)
            try { await auth.refreshMembership() }
            catch { setError('Não foi possível conferir seu acesso. Tente novamente.') }
            finally { requestPending.current = false; setBusy(false) }
          }}>Conferir liberação novamente</button>
        </div>
      </section>
    </main>
  )
  return <LoginView
    email={email}
    password={password}
    busy={busy}
    loading={auth.loading}
    error={error}
    onEmailChange={setEmail}
    onPasswordChange={setPassword}
    onSubmit={async (event) => {
      event.preventDefault(); if (requestPending.current || auth.loading) return
      requestPending.current = true; setBusy(true); setError(null)
      try {
        const { error: loginError } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
        if (loginError) setError('Não foi possível entrar. Confira seu e-mail e senha da clínica.')
      } catch { setError('Não foi possível conectar para entrar. Confira sua conexão e tente novamente.') }
      finally { requestPending.current = false; setBusy(false) }
    }}
  />
}
