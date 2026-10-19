// Separate Vite DEV entry. Never imported by the app, built as a route, or connected to data.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation, Link } from 'react-router-dom'
import { Package, ArrowLeft } from 'lucide-react'
import { LoginView } from '@/components/auth/LoginView'
import { AppFrame } from '@/components/layout/AppFrame'
import { DocumentQueue } from '@/components/documents/DocumentQueue'
import { TrackingPreview } from '@/design/TrackingPreview'
import { SamplesPreview } from '@/design/SamplesPreview'
import type { DocumentFilter } from '@/hooks/useExamDocuments'
import type { ExamDocument } from '@/types/exam-document'
import '@fontsource/dm-sans/latin-400.css'
import '@fontsource/dm-sans/latin-500.css'
import '@fontsource/dm-sans/latin-600.css'
import '@fontsource/dm-sans/latin-700.css'
import '@fontsource/manrope/latin-800.css'
import './index.css'
import './design-preview.css'

const now = Date.now()
const date = (hours: number) => new Date(now - hours * 3_600_000).toISOString()
const base: ExamDocument = {
  id: '10000000-0000-4000-8000-000000000001', version: 1, original_name: 'Exame de exemplo.pdf', received_at: date(18),
  file_status: 'saved', identification_status: 'confirmed', drive_file_id: null, drive_name: null,
  extracted_data: { pet_name: 'Luna', client_name: 'Helena Beatriz Oliveira Duarte', exam_type: 'Hemograma completo', exam_date: '2026-10-18' },
  confirmed_data: {}, evidence: {}, review_reason: null, pet_id: '10000000-0000-4000-8000-000000000011', assigned_to: null,
  responsible_vet_id: '10000000-0000-4000-8000-000000000021', responsible_vet_name: 'Dra. Exemplo', responsible_vet_avatar_url: null,
  responsible_vet_source: 'manual', group_release_at: date(18), group_exception_reason: null, previous_document_id: null,
  oldest_group_sent_at: date(18), contact_status: 'pending', group_status: 'sent', nexus_status: 'completed', process_status: 'completed', completed: false,
  sources: [{ id: 'source-demo-1', channel: 'email', received_at: date(18) }], items: [{ item_id: 'item-demo-1', contacted_at: null }], deliveries: [],
}
const examples: ExamDocument[] = [
  base,
  { ...base, id: '10000000-0000-4000-8000-000000000002', extracted_data: { pet_name: 'Thor', client_name: 'João Pereira', exam_type: 'Ultrassonografia abdominal', exam_date: '2026-10-18' }, pet_id: null, identification_status: 'review', contact_status: 'completed', nexus_status: 'awaiting_link', items: [{ item_id: 'item-demo-2', contacted_at: date(1) }], oldest_group_sent_at: date(3), sources: [{ id: 'source-demo-2', channel: 'whatsapp', received_at: date(3) }] },
  { ...base, id: '10000000-0000-4000-8000-000000000003', extracted_data: { pet_name: 'Mia', client_name: 'Clara Souza', exam_type: 'Urinálise', exam_date: '2026-10-17' }, completed: true, contact_status: 'completed', items: [{ item_id: 'item-demo-3', contacted_at: date(2) }] },
]
export function PreviewLogin() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  return <LoginView email={email} password={password} onEmailChange={setEmail} onPasswordChange={setPassword} error={error}
    onSubmit={event => { event.preventDefault(); setError('Prévia visual: nenhum acesso foi enviado.') }} />
}
export function PreviewContent() {
  const { pathname } = useLocation()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<DocumentFilter>('open')
  const [page, setPage] = useState(0)
  if (pathname === '/tracking') return <TrackingPreview />
  if (pathname === '/ship' || pathname === '/shipments') return <SamplesPreview />
  if (pathname === '/novos-exames') {
    const filtered = examples.filter(doc => {
      const term = search.toLocaleLowerCase('pt-BR')
      const matchesSearch = Object.values(doc.extracted_data).join(' ').toLocaleLowerCase('pt-BR').includes(term)
      const matchesFilter = filter === 'all' || filter === 'completed' ? filter === 'all' || doc.completed
        : filter === 'review' ? doc.identification_status === 'review'
          : filter === 'unassigned' ? !doc.responsible_vet_id && !doc.assigned_to && !doc.completed
            : filter === 'group_failed' ? ['failed', 'uncertain'].includes(doc.group_status)
              : filter === 'contact' ? doc.contact_status !== 'completed'
                : filter === 'nexus' ? doc.nexus_status !== 'completed' : !doc.completed
      return matchesSearch && matchesFilter
    })
    return <DocumentQueue documents={filtered} total={filtered.length} page={page} pageSize={25} loading={false} error={false} refreshing={false}
      search={search} filter={filter} onSearchChange={value => { setSearch(value); setPage(0) }} onFilterChange={value => { setFilter(value); setPage(0) }} onRefresh={() => {}} onPageChange={setPage} />
  }
  const titles: Record<string, string> = { '/': 'Início', '/tracking': 'Rastreamento', '/ship': 'Enviar amostras', '/shipments': 'Histórico de envios', '/settings': 'Conta' }
  return <section className="study-preserved">
    {pathname.startsWith('/novos-exames/') && <Link to="/novos-exames"><ArrowLeft size={18} />Voltar aos recebidos</Link>}
    <h1>{titles[pathname] || 'Detalhe do exame'}</h1>
    <div><Package size={28} strokeWidth={1.4} /><h2>Funcionalidade preservada</h2><p>Nesta prévia, avalie a navegação. O conteúdo desta tela será refinado na próxima etapa.</p></div>
  </section>
}
export function PreviewApplication({ initialPath = '/novos-exames' }: { initialPath?: string }) { return <MemoryRouter initialEntries={[initialPath]}><AppFrame><PreviewContent /></AppFrame></MemoryRouter> }
export function PreviewBoard() {
  const [screen, setScreen] = useState(new URLSearchParams(window.location.search).get('screen') || 'app')
  const [device, setDevice] = useState('mobile')
  return <main className="study-board">
    <header className="study-toolbar"><div><h1>Pam Laudos <span>Estudo 01</span></h1><p>Prévia local · dados fictícios</p></div>
      <div className="study-controls"><div className="study-segments" aria-label="Tela da prévia">{[['login', 'Login'], ['app', 'Recebidos'], ['tracking', 'Rastreamento'], ['samples', 'Amostras'], ['shipments', 'Histórico']].map(([id, label]) => <button key={id} aria-pressed={screen === id} onClick={() => setScreen(id)}>{label}</button>)}</div>
        <div className="study-segments" aria-label="Tamanho da prévia">{[['mobile', 'Celular'], ['desktop', 'Web']].map(([id, label]) => <button key={id} aria-pressed={device === id} onClick={() => setDevice(id)}>{label}</button>)}</div></div>
    </header>
    <div className={`study-device ${device}`}><iframe key={`${screen}-${device}`} title={`Prévia ${screen === 'login' ? 'do login' : 'da aplicação'} em ${device === 'mobile' ? 'celular' : 'web'}`} src={`/design-preview.html?frame=${screen}`} /></div>
  </main>
}
const frame = new URLSearchParams(window.location.search).get('frame')
if (import.meta.env.DEV) createRoot(document.getElementById('root')!).render(frame === 'login' ? <PreviewLogin /> : frame && ['app', 'tracking', 'samples', 'shipments'].includes(frame) ? <PreviewApplication initialPath={frame === 'tracking' ? '/tracking' : frame === 'samples' ? '/ship' : frame === 'shipments' ? '/shipments' : '/novos-exames'} /> : <PreviewBoard />)
