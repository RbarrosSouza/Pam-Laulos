import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Stethoscope } from 'lucide-react'
import { BottomNav } from '@/components/layout/BottomNav'
import { APP_SECTIONS, normalizeAppPath, sectionForPath } from '@/components/layout/navigation'
import { cn } from '@/lib/utils'
import './app-frame.css'

/** Presentation only. Authentication remains on the existing protected routes. */
export function AppFrame({ children, notice }: { children: ReactNode; notice?: ReactNode }) {
  const { pathname } = useLocation()
  const currentPath = normalizeAppPath(pathname)
  const section = sectionForPath(pathname)
  return (
    <div className="app-frame">
      <a className="app-skip-link" href="#app-content">Ir para o conteúdo</a>
      <aside className="app-sidebar" aria-label="Barra lateral">
        <Link to="/" className="app-brand" aria-label="Pam Laudos — início">
          <span className="app-brand-symbol"><Stethoscope size={23} strokeWidth={1.65} aria-hidden="true" /></span>
          <span>Pam Laudos</span>
        </Link>
        <nav className="app-primary-nav" aria-label="Navegação principal">
          {APP_SECTIONS.map(({ id, to, label, icon: Icon }) => (
            <Link key={id} to={to} aria-current={section.id === id ? 'page' : undefined}
              className={cn('app-nav-link', section.id === id && 'is-active')}>
              <Icon size={21} strokeWidth={1.7} aria-hidden="true" /><span>{label}</span>
            </Link>
          ))}
        </nav>
        <p className="app-sidebar-footer">PamVet <span aria-hidden="true">·</span> Equipe</p>
      </aside>
      <header className="app-mobile-header">
        <Link to="/" className="app-brand" aria-label="Pam Laudos — início">
          <span className="app-brand-symbol"><Stethoscope size={22} strokeWidth={1.65} aria-hidden="true" /></span>
          <span>Pam Laudos</span>
        </Link>
      </header>
      <main id="app-content" className="app-main" tabIndex={-1}>
        {section.tabs && <nav className="app-section-tabs" aria-label={section.label}>
          {section.tabs.map(({ to, label, includes }) => (
            <Link key={to} to={to}
              aria-current={currentPath === to || includes?.includes(currentPath) ? 'page' : undefined}
              className={cn('app-section-tab', (currentPath === to || includes?.includes(currentPath)) && 'is-active')}>
              {label}
            </Link>
          ))}
        </nav>}
        {notice}
        <div className="app-content">{children}</div>
      </main>
      <BottomNav />
    </div>
  )
}
