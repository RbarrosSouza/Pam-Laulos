import { Outlet, useLocation } from 'react-router-dom'
import { AlertBanner } from '@/components/dashboard/AlertBanner'
import { AppFrame } from '@/components/layout/AppFrame'
import { useTheme } from '@/hooks/useTheme'
import { normalizeAppPath } from '@/components/layout/navigation'

export function Shell() {
  const { pathname } = useLocation()
  useTheme()
  // The approved document page keeps its own navigation and safe-area spacing.
  if (/^\/novos-exames\/[^/]+\/?$/.test(pathname)) return <Outlet />
  // Card alert banner removed from tracking as requested; kept only for /late if ever needed.
  const showsCardAlert = ['/late'].includes(normalizeAppPath(pathname))
  return <AppFrame notice={showsCardAlert ? <AlertBanner /> : undefined}><Outlet /></AppFrame>
}
