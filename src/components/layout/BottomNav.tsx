import { NavLink } from 'react-router-dom'
import { LayoutDashboard, FlaskConical, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'

const tabs = [
  { to: '/', icon: LayoutDashboard, exact: true },
  { to: '/tracking', icon: FlaskConical },
  { to: '/settings', icon: Settings },
]

export function BottomNav() {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 md:hidden bg-[hsl(var(--card))] border-t border-[hsl(var(--border))] pb-[env(safe-area-inset-bottom)]">
      <div className="flex items-center justify-around h-14">
        {tabs.map(({ to, icon: Icon, exact }) => (
          <NavLink
            key={to}
            to={to}
            end={exact}
            className={({ isActive }) => cn(
              'flex flex-col items-center justify-center w-16 h-full transition-colors',
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
        ))}
      </div>
    </nav>
  )
}
