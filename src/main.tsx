import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppToaster } from '@/components/AppToaster'
import '@fontsource/dm-sans/latin-400.css'
import '@fontsource/dm-sans/latin-500.css'
import '@fontsource/dm-sans/latin-600.css'
import '@fontsource/dm-sans/latin-700.css'
import '@fontsource/manrope/latin-800.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <AppToaster />
  </StrictMode>,
)
