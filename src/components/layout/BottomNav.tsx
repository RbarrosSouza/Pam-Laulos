import { NavLink } from 'react-router-dom'
import { LayoutDashboard, FlaskConical, Moon, Sun } from 'lucide-react'
import { useTheme } from '@/hooks/useTheme'
import { cn } from '@/lib/utils'

export function BottomNav() {
  const { theme, toggle } = useTheme()

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 md:hidden bg-[hsl(var(--card))] border-t border-[hsl(var(--border))] pb-[env(safe-area-inset-bottom)]">
      <div className="flex items-center justify-around h-14">
        <NavLink
          to="/"
          end
          className={({ isActive }) => cn(
            'flex flex-col items-center justify-center w-16 h-full transition-colors',
            isActive
              ? 'text-[hsl(var(--primary))]'
              : 'text-[hsl(var(--muted-foreground))]'
          )}
        >
          {({ isActive }) => (
            <>
              <LayoutDashboard className="w-5 h-5" />
              {isActive && <span className="w-1 h-1 rounded-full bg-[hsl(var(--primary))] mt-1" />}
            </>
          )}
        </NavLink>

        <NavLink
          to="/tracking"
          className={({ isActive }) => cn(
            'flex flex-col items-center justify-center w-16 h-full transition-colors',
            isActive
              ? 'text-[hsl(var(--primary))]'
              : 'text-[hsl(var(--muted-foreground))]'
          )}
        >
          {({ isActive }) => (
            <>
              <FlaskConical className="w-5 h-5" />
              {isActive && <span className="w-1 h-1 rounded-full bg-[hsl(var(--primary))] mt-1" />}
            </>
          )}
        </NavLink>

        <button
          onClick={toggle}
          className="flex flex-col items-center justify-center w-16 h-full text-[hsl(var(--muted-foreground))] transition-colors"
          aria-label="Alternar tema"
        >
          {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        </button>
      </div>
    </nav>
  )
}
