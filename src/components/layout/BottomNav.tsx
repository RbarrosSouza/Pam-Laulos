import { Link, useLocation } from 'react-router-dom'
import { APP_SECTIONS, sectionForPath } from '@/components/layout/navigation'
import { cn } from '@/lib/utils'

export function BottomNav() {
  const { pathname } = useLocation()
  const active = sectionForPath(pathname)
  return (
    <nav className="app-bottom-nav" aria-label="Navegação principal no celular">
      {APP_SECTIONS.map(({ id, to, label, icon: Icon }) => (
        <Link key={id} to={to} aria-current={active.id === id ? 'page' : undefined}
          className={cn('app-bottom-link', active.id === id && 'is-active')}>
          <span className="app-bottom-icon"><Icon size={22} strokeWidth={1.7} aria-hidden="true" /></span>
          <span>{label}</span>
        </Link>
      ))}
    </nav>
  )
}
