import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { ExamDocumentContent } from '../src/pages/ExamDocumentDetail'
import { useExamDocument } from './exam-workspace-mocks'
import '../src/index.css'
if (!import.meta.env.DEV) throw new Error('Synthetic preview is DEV only')
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
export function Preview() {
  const query = useExamDocument()
  return <><nav style={{ display: 'flex', gap: 16, padding: '12px 30px', background: '#e9ecdf', fontSize: 12, flexWrap: 'wrap' }} aria-label="Cenários de teste"><strong>BRANCH DE TESTE · Dados fictícios</strong>{[['new', 'Ficha'], ['review', 'Identificação pendente'], ['attached', 'Já anexado'], ['partial', 'Etapas pendentes'], ['contact-failure', 'Falha ao salvar'], ['read-failure', 'Falha de leitura'], ['pdf-failure', 'Falha de PDF'], ['unavailable', 'Anterior indisponível']].map(([value, title]) => <a key={value} href={`?scenario=${value}`}>{title}</a>)}</nav><ExamDocumentContent doc={query.data} refresh={query.refetch}/><Toaster/></>
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><BrowserRouter><Preview/></BrowserRouter></QueryClientProvider>)
