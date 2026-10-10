import { useDeferredValue, useState } from 'react'
import { Link } from 'react-router-dom'
import { FilePlus2, FileText, RefreshCw, Search, Loader2, ChevronLeft, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import { useExamDocuments, callDocumentService, DOCUMENT_PAGE_SIZE } from '@/hooks/useExamDocuments'
import type { DocumentFilter } from '@/hooks/useExamDocuments'
import { documentDisplayId, documentIsOverdue, documentLabel } from '@/lib/document-status'
import { DocumentBadge } from '@/components/documents/DocumentBadge'
import { cn } from '@/lib/utils'
import { useExamAuth } from '@/contexts/exam-auth'
import { supabase } from '@/lib/supabase'

const FILTERS: { value: DocumentFilter; label: string }[] = [
  { value: 'open', label: 'Em andamento' }, { value: 'review', label: 'Conferir identificação' },
  { value: 'unassigned', label: 'Sem responsável' }, { value: 'group_failed', label: 'Envio com pendência' },
  { value: 'contact', label: 'Aguardando contato' }, { value: 'nexus', label: 'Pendente no Nexus' },
  { value: 'completed', label: 'Concluídos' }, { value: 'all', label: 'Todos' },
]
const inputClass = 'rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--card))] px-3 py-2 text-sm'

export function NewExams() {
  const auth = useExamAuth()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<DocumentFilter>('open')
  const [page, setPage] = useState(0)
  const [showUpload, setShowUpload] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadKey, setUploadKey] = useState(() => crypto.randomUUID())
  const query = useExamDocuments(useDeferredValue(search), filter, page)
  const client = useQueryClient()
  const total = query.data?.count || 0
  const documents = query.data?.documents || []

  const upload = async () => {
    if (!file || uploading) return
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) { toast.error('Selecione um arquivo PDF.'); return }
    if (file.size > 20 * 1024 * 1024) { toast.error('O PDF deve ter até 20 MB.'); return }
    setUploading(true)
    try {
      await callDocumentService('upload', { message_id: uploadKey }, file)
      toast.success('PDF recebido. O armazenamento e o processamento aparecem nesta lista.')
      setFile(null); setShowUpload(false); setUploadKey(crypto.randomUUID()); setPage(0)
      await client.invalidateQueries({ queryKey: ['exam-documents'] })
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Não foi possível receber o PDF.') }
    finally { setUploading(false) }
  }

  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="text-2xl font-bold tracking-tight">Novos exames</h1><p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">Confira os PDFs recebidos e acompanhe o que falta fazer.</p><p className="mt-2 text-xs text-[hsl(var(--muted-foreground))]">{auth.session?.user.email} · <button className="underline" onClick={() => { void supabase.auth.signOut({ scope: 'local' }).then(({ error }) => { if (error) toast.error('Não foi possível sair. Tente novamente.') }).catch(() => toast.error('Não foi possível sair. Tente novamente.')) }}>Sair</button></p></div>
      <div className="flex gap-2"><button type="button" aria-label="Atualizar exames" onClick={() => void query.refetch()} className={cn(inputClass, 'flex items-center gap-2')}><RefreshCw className={cn('w-4 h-4', query.isFetching && 'animate-spin')} /><span className="hidden sm:inline">Atualizar</span></button><button type="button" onClick={() => setShowUpload(v => !v)} className="flex items-center gap-2 rounded-lg bg-[hsl(var(--primary))] px-4 py-2 text-sm font-medium text-white"><FilePlus2 className="w-4 h-4" />Adicionar PDF</button></div>
    </div>
    {showUpload && <section className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 space-y-3"><h2 className="font-semibold">Exame recebido pelo WhatsApp ou outro canal</h2><p className="text-sm text-[hsl(var(--muted-foreground))]">Envie o PDF original. A identificação pode ser conferida depois do recebimento.</p><div className="flex flex-wrap gap-3 items-center"><input aria-label="Arquivo PDF" disabled={uploading} type="file" accept="application/pdf,.pdf" onChange={e => { setFile(e.target.files?.[0] || null); setUploadKey(crypto.randomUUID()) }} className="max-w-full text-sm" /><button type="button" disabled={!file || uploading} onClick={() => void upload()} className="rounded-lg bg-[hsl(var(--primary))] px-4 py-2 text-white text-sm disabled:opacity-50 flex gap-2 items-center">{uploading && <Loader2 className="w-4 h-4 animate-spin" />}Receber PDF</button><button type="button" disabled={uploading} className="text-sm px-2 py-2" onClick={() => setShowUpload(false)}>Cancelar</button></div></section>}
    <div className="flex flex-wrap gap-3"><label className="relative flex-1 min-w-48"><span className="sr-only">Buscar por tutor, pet ou arquivo</span><Search className="absolute top-2.5 left-3 w-4 h-4 text-[hsl(var(--muted-foreground))]" /><input className={cn(inputClass, 'pl-9 w-full')} placeholder="Tutor, pet ou arquivo…" value={search} onChange={e => { setSearch(e.target.value); setPage(0) }} /></label><select aria-label="Filtrar exames" value={filter} onChange={e => { setFilter(e.target.value as DocumentFilter); setPage(0) }} className={inputClass}>{FILTERS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}</select></div>
    {query.isLoading ? <div className="py-16 flex items-center justify-center gap-2"><Loader2 className="w-5 h-5 animate-spin" />Carregando exames…</div> : query.error ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 dark:bg-red-950/20 p-5 text-sm"><p>Não foi possível carregar os documentos. Confira sua conexão e tente novamente.</p><button type="button" onClick={() => void query.refetch()} className="underline mt-2">Tentar novamente</button></div> : documents.length === 0 ? <div className="rounded-xl border border-dashed border-[hsl(var(--border))] py-16 text-center"><FileText className="w-9 h-9 mx-auto mb-3 text-[hsl(var(--muted-foreground))]" /><p className="font-medium">Nenhum exame nesta lista</p><p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">Os PDFs recebidos aparecem aqui. Você também pode adicionar um arquivo.</p></div> : <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] overflow-hidden"><div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]"><tr>{['Exame e paciente', 'Recebido', 'Identificação', 'Drive', 'Grupo', 'Contato', 'PAM Nexus'].map(label => <th key={label} className="px-4 py-3 text-left font-medium whitespace-nowrap">{label}</th>)}</tr></thead><tbody>{documents.map(doc => <tr key={doc.id} className={cn('border-t border-[hsl(var(--border))] hover:bg-[hsl(var(--muted))]/40', documentIsOverdue(doc) && 'bg-red-50/60 dark:bg-red-950/20')}><td className="px-4 py-3 min-w-56"><Link className="font-semibold text-[hsl(var(--primary))] hover:underline" to={`/novos-exames/${doc.id}`}>{documentLabel(doc, 'pet_name')} · {documentLabel(doc, 'exam_type')}</Link><p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{documentLabel(doc, 'client_name')} · {documentDisplayId(doc.id)}</p>{documentIsOverdue(doc) && <p className="text-xs text-red-600 mt-1">Há mais de 24h no grupo, sem contato</p>}</td><td className="px-4 py-3 whitespace-nowrap text-xs">{new Date(doc.received_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</td><td className="px-4 py-3"><DocumentBadge status={doc.identification_status} /></td><td className="px-4 py-3"><DocumentBadge status={doc.file_status} /></td><td className="px-4 py-3"><DocumentBadge status={doc.group_status} /></td><td className="px-4 py-3"><DocumentBadge status={doc.contact_status} /></td><td className="px-4 py-3"><DocumentBadge status={doc.nexus_status === 'completed' ? 'attached' : doc.nexus_status} /></td></tr>)}</tbody></table></div></div>}
    {!query.error && <div className="flex justify-between items-center text-sm text-[hsl(var(--muted-foreground))]"><span>{total} documento{total === 1 ? '' : 's'}</span><div className="flex gap-3 items-center"><button type="button" aria-label="Página anterior" disabled={page === 0} className="p-2 rounded-lg border disabled:opacity-30" onClick={() => setPage(v => v - 1)}><ChevronLeft className="w-4 h-4" /></button><span>{page + 1} / {Math.max(1, Math.ceil(total / DOCUMENT_PAGE_SIZE))}</span><button type="button" aria-label="Próxima página" disabled={(page + 1) * DOCUMENT_PAGE_SIZE >= total} className="p-2 rounded-lg border disabled:opacity-30" onClick={() => setPage(v => v + 1)}><ChevronRight className="w-4 h-4" /></button></div></div>}
  </div>
}
