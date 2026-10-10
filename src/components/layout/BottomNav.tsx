import { NavLink } from 'react-router-dom'
import { LayoutDashboard, ListFilter, Package, FileText, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'

const tabs = [
  { to: '/', icon: LayoutDashboard, exact: true },
  { to: '/tracking', icon: ListFilter },
  { to: '/ship', icon: Package, center: true },
  { to: '/novos-exames', icon: FileText },
  { to: '/settings', icon: Settings },
]

export function BottomNav() {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 md:hidden bg-[hsl(var(--card))] border-t border-[hsl(var(--border))] pb-[env(safe-area-inset-bottom)]">
      <div className="flex items-center justify-around h-14">
        {tabs.map(({ to, icon: Icon, exact, center }) =>
          center ? (
            <NavLink
              key={to}
              aria-label={to === '/ship' ? 'Enviar amostras' : to}
              to={to}
              className={({ isActive }) => cn(
                'flex items-center justify-center w-12 h-12 rounded-2xl -mt-5 shadow-lg transition-all',
                isActive
                  ? 'bg-[hsl(var(--primary))] text-white scale-105'
                  : 'bg-[hsl(var(--foreground))] text-[hsl(var(--background))]'
              )}
            >
              <Icon className="w-5 h-5" />
            </NavLink>
          ) : (
            <NavLink
              key={to}
              aria-label={to === '/novos-exames' ? 'Novos exames' : to === '/' ? 'Dashboard' : to === '/tracking' ? 'Rastreamento' : 'Configurações'}
              to={to}
              end={exact}
              className={({ isActive }) => cn(
                'flex flex-col items-center justify-center w-14 h-full transition-colors',
                isActive
                  ? 'text-[hsl(var(--primary))]'
                  : 'text-[hsl(var(--muted-foreground))]'
              )}
            >
              {({ isActive }) => (
                <>
                  <Icon className="w-5 h-5" />
                  {isActive && <span className="w-1 h-1 rounded-full bg-[hsl(var(--primary))] mt-1" />}
                </>
              )}
            </NavLink>
          )
        )}
      </div>
    </nav>
  )
}
