import { Toaster } from 'sonner'
import './app-toaster.css'

// Keep feedback away from the bottom actions, without a blocking overlay.
export function AppToaster() {
  return <Toaster
    className="app-notifications"
    position="top-center"
    closeButton
    duration={3500}
    visibleToasts={1}
    containerAriaLabel="Notificações"
    toastOptions={{
      closeButtonAriaLabel: 'Fechar notificação',
      style: { fontFamily: 'DM Sans, sans-serif' },
    }}
  />
}
