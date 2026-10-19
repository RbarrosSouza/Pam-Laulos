import { House, Files, Package, CircleUserRound } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

type Section = {
  id: string
  to: string
  label: string
  icon: LucideIcon
  matches: (path: string) => boolean
  tabs?: { to: string; label: string; includes?: string[] }[]
}

export const APP_SECTIONS: Section[] = [
  { id: 'home', to: '/', label: 'Início', icon: House, matches: path => path === '/' },
  { id: 'exams', to: '/novos-exames', label: 'Exames', icon: Files,
    matches: path => path.startsWith('/novos-exames') || ['/tracking', '/late'].includes(path),
    tabs: [{ to: '/novos-exames', label: 'Recebidos' }, { to: '/tracking', label: 'Rastreamento', includes: ['/late'] }] },
  { id: 'samples', to: '/ship', label: 'Amostras', icon: Package,
    matches: path => ['/ship', '/shipments'].includes(path),
    tabs: [{ to: '/ship', label: 'Enviar amostras' }, { to: '/shipments', label: 'Histórico de envios' }] },
  { id: 'account', to: '/settings', label: 'Conta', icon: CircleUserRound, matches: path => path === '/settings' },
]

export function sectionForPath(path: string) {
  return APP_SECTIONS.find(section => section.matches(normalizeAppPath(path))) || APP_SECTIONS[0]
}

export function normalizeAppPath(path: string) { return path.replace(/\/+$/, '') || '/' }
