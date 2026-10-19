import { useId, useState, type FormEventHandler } from 'react'
import { Eye, EyeOff, Stethoscope } from 'lucide-react'
import '@fontsource/manrope/latin-800.css'
import '@fontsource/dm-sans/latin-400.css'
import '@fontsource/dm-sans/latin-500.css'
import '@fontsource/dm-sans/latin-600.css'
import '@/pages/sign-in.css'

interface LoginViewProps {
  email: string
  password: string
  busy?: boolean
  loading?: boolean
  error?: string | null
  onEmailChange: (value: string) => void
  onPasswordChange: (value: string) => void
  onSubmit: FormEventHandler<HTMLFormElement>
}

export function LoginBrand() {
  return <div className="login-brand"><Stethoscope size={25} strokeWidth={1.75} aria-hidden="true" /><span>Pam Laudos</span></div>
}

/** Presentational surface; authentication stays in SignIn. */
export function LoginView({ email, password, busy = false, loading = false, error, onEmailChange, onPasswordChange, onSubmit }: LoginViewProps) {
  const [showPassword, setShowPassword] = useState(false)
  const id = useId()
  const unavailable = busy || loading
  const errorId = `${id}-error`
  return <main className="login-page">
    <section className="login-panel" aria-labelledby={`${id}-title`}>
      <LoginBrand />
      <header className="login-heading">
        <h1 id={`${id}-title`}>Boas-vindas.</h1>
        <p>Entre com sua conta da clínica.</p>
      </header>
      <form className="login-form" aria-busy={unavailable} onSubmit={onSubmit}>
        <div className="login-field">
          <label htmlFor={`${id}-email`}>E-mail</label>
          <input id={`${id}-email`} autoComplete="username" autoCapitalize="none" spellCheck={false} required disabled={unavailable} type="email" value={email} onChange={event => onEmailChange(event.target.value)} aria-describedby={error ? errorId : undefined} />
        </div>
        <div className="login-field">
          <label htmlFor={`${id}-password`}>Senha</label>
          <div className="login-password">
            <input id={`${id}-password`} autoComplete="current-password" required disabled={unavailable} type={showPassword ? 'text' : 'password'} value={password} onChange={event => onPasswordChange(event.target.value)} aria-describedby={error ? errorId : undefined} />
            <button type="button" className="login-password-toggle" disabled={unavailable} aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'} aria-pressed={showPassword} aria-controls={`${id}-password`} onClick={() => setShowPassword(current => !current)}>
              {showPassword ? <EyeOff size={21} strokeWidth={1.75} aria-hidden="true" /> : <Eye size={21} strokeWidth={1.75} aria-hidden="true" />}
            </button>
          </div>
        </div>
        {error && <p id={errorId} role="alert" className="login-error">{error}</p>}
        <button type="submit" disabled={unavailable} className="login-primary">{busy ? 'Entrando…' : loading ? 'Aguarde…' : 'Entrar'}</button>
      </form>
    </section>
  </main>
}
