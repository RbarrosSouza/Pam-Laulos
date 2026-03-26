import { Outlet, NavLink } from 'react-router-dom'
import {
  Stethoscope,
  LayoutDashboard,
  ListFilter,
  Sun,
  Moon,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react'
import { useState } from 'react'
import { AlertBanner } from '@/components/dashboard/AlertBanner'
import { BottomNav } from '@/components/layout/BottomNav'
import { useTheme } from '@/hooks/useTheme'
import { cn } from '@/lib/utils'

const navItems = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { to: '/tracking', label: 'Rastreamento', icon: ListFilter },
]

export function Shell() {
  const { isDark, toggle } = useTheme()
  const [isCollapsed, setIsCollapsed] = useState(() =>
    localStorage.getItem('pamvet-sidebar') === 'collapsed'
  )

  const toggleCollapse = () => {
    setIsCollapsed((v) => {
      const next = !v
      localStorage.setItem('pamvet-sidebar', next ? 'collapsed' : 'expanded')
      return next
    })
  }

  return (
    <div className="flex min-h-screen bg-[hsl(var(--background))]">

      {/* ── SIDEBAR DESKTOP ─────────────────────────────────────────── */}
      <aside
        className={cn(
          'fixed top-0 left-0 h-screen z-30 hidden md:flex flex-col',
          'bg-[hsl(var(--sidebar-bg))] border-r border-[hsl(var(--sidebar-border))]',
          'transition-[width] duration-200',
          isCollapsed ? 'w-14' : 'w-60'
        )}
      >
        {/* Logo */}
        <div
          className={cn(
            'flex items-center gap-2.5 h-14 shrink-0 px-3.5',
            isCollapsed && 'justify-center px-0'
          )}
        >
          <div className="w-7 h-7 rounded-lg bg-[hsl(var(--sidebar-accent))] flex items-center justify-center shrink-0">
            <Stethoscope className="w-3.5 h-3.5 text-white" />
          </div>
          {!isCollapsed && (
            <div className="flex flex-col leading-tight overflow-hidden">
              <span className="font-bold text-sm text-white tracking-tight">PamVet</span>
              <span className="text-[10px] text-[hsl(var(--sidebar-foreground))] truncate">
                Monitor de Exames
              </span>
            </div>
          )}
        </div>

        <div className="h-px bg-[hsl(var(--sidebar-border))] mx-3" />

        {/* Nav items */}
        <nav className="flex flex-col gap-0.5 p-2 flex-1 mt-1">
          {navItems.map(({ to, label, icon: Icon, exact }) => (
            <NavLink
              key={to}
              to={to}
              end={exact}
              title={isCollapsed ? label : undefined}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 px-2.5 py-2 rounded-lg text-sm font-medium',
                  'transition-all duration-150 border-l-[3px]',
                  isCollapsed && 'justify-center px-0 pl-0',
                  isActive
                    ? 'bg-[hsl(var(--sidebar-accent))]/15 text-[hsl(var(--sidebar-accent))] border-[hsl(var(--sidebar-accent))]'
                    : 'text-[hsl(var(--sidebar-foreground))] hover:text-white hover:bg-[hsl(var(--sidebar-muted))] border-transparent'
                )
              }
            >
              <Icon className="w-4 h-4 shrink-0" />
              {!isCollapsed && label}
            </NavLink>
          ))}
        </nav>

        {/* Dark mode toggle */}
        <div className="p-2 border-t border-[hsl(var(--sidebar-border))]">
          <button
            onClick={toggle}
            title={isDark ? 'Modo claro' : 'Modo escuro'}
            className={cn(
              'w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-sm font-medium',
              'text-[hsl(var(--sidebar-foreground))] hover:text-white hover:bg-[hsl(var(--sidebar-muted))]',
              'transition-all duration-150',
              isCollapsed && 'justify-center px-0'
            )}
            aria-label={isDark ? 'Modo claro' : 'Modo escuro'}
          >
            {isDark ? (
              <Sun className="w-4 h-4 shrink-0" />
            ) : (
              <Moon className="w-4 h-4 shrink-0" />
            )}
            {!isCollapsed && <span>{isDark ? 'Modo claro' : 'Modo escuro'}</span>}
          </button>
        </div>

        {/* Collapse toggle */}
        <button
          onClick={toggleCollapse}
          className={cn(
            'absolute -right-3 top-20 w-6 h-6 rounded-full z-10',
            'bg-[hsl(var(--sidebar-bg))] border border-[hsl(var(--sidebar-border))]',
            'flex items-center justify-center',
            'text-[hsl(var(--sidebar-foreground))] hover:text-white',
            'transition-colors duration-150'
          )}
          aria-label={isCollapsed ? 'Expandir sidebar' : 'Colapsar sidebar'}
        >
          {isCollapsed ? (
            <ChevronsRight className="w-3 h-3" />
          ) : (
            <ChevronsLeft className="w-3 h-3" />
          )}
        </button>
      </aside>

      {/* ── MOBILE HEADER (minimal) ────────────────────────────────── */}
      <header className="md:hidden fixed top-0 left-0 right-0 z-30 h-12 flex items-center justify-center bg-[hsl(var(--sidebar-bg))]">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-[hsl(var(--sidebar-accent))] flex items-center justify-center">
            <Stethoscope className="w-3 h-3 text-white" />
          </div>
          <span className="font-bold text-sm text-white tracking-tight">PamVet</span>
        </div>
      </header>

      {/* ── MAIN CONTENT ────────────────────────────────────────────── */}
      <main
        className={cn(
          'flex-1 min-h-screen transition-[margin-left] duration-200',
          'pt-12 pb-16 md:pt-0 md:pb-0',
          isCollapsed ? 'md:ml-14' : 'md:ml-60'
        )}
      >
        <AlertBanner />
        <div className="max-w-7xl mx-auto px-3 sm:px-6 py-4 md:py-8">
          <Outlet />
        </div>
      </main>

      {/* ── BOTTOM NAV (mobile only) ────────────────────────────────── */}
      <BottomNav />
    </div>
  )
}
