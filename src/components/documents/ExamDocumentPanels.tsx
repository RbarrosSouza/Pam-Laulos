import { useEffect, useState, useDeferredValue } from 'react'
import { Download, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { useExamAuth } from '@/contexts/exam-auth'
import { callDocumentService, useDocumentAction, useDocumentCandidates, useDocumentEvents } from '@/hooks/useExamDocuments'
import { DocumentBadge } from '@/components/documents/DocumentBadge'
import { documentEditSnapshot } from '@/lib/document-status'
import type { DocumentCandidate, DocumentFields, ExamDocument } from '@/types/exam-document'

const inputClass = 'w-full rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--card))] px-3 py-2 text-sm'
const buttonClass = 'rounded-lg bg-[hsl(var(--primary))] px-4 py-2 text-sm font-medium text-white disabled:opacity-50'
const sectionClass = 'rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 space-y-4'
const fieldLabels: [keyof DocumentFields, string][] = [['client_name', 'Tutor'], ['pet_name', 'Pet'], ['exam_type', 'Tipo do exame'], ['exam_date', 'Data do exame'], ['lab_name', 'Laboratório']]
const destinationLabels: Record<string, string> = { drive: 'Cópia no Drive', processing: 'Leitura do PDF', group: 'Aviso ao grupo', nexus: 'Anexação no PAM Nexus' }
const eventLabels: Record<string, string> = { received: 'Documento recebido', file_saved: 'Original salvo', extracted: 'Dados extraídos', extraction_updated: 'Dados extraídos', reviewed: 'Conferência registrada', link_confirmed: 'Cadastro confirmado', link_auto_confirmed: 'Cadastro identificado automaticamente', identification_pending: 'Cadastro pendente de seleção', assigned: 'Responsável definido', responsible_vet_assigned: 'Veterinária responsável definida', responsible_vet_resolved: 'Identificação da veterinária responsável', contact_recorded: 'Contato registrado', correction_linked: 'Versão corrigida vinculada', group_released: 'Aviso ao grupo liberado', group_confirmed_by_team: 'Entrega conferida pela equipe', delivery_completed: 'Etapa atualizada', retry_requested: 'Nova tentativa solicitada', group_exception: 'Exceção de grupo registrada' }

export function DocumentPreview({ doc }: { doc: ExamDocument }) {
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    void callDocumentService('file', { document_id: doc.id }).then(result => {
      if (cancelled) return
      objectUrl = URL.createObjectURL(result as Blob)
      setUrl(objectUrl)
    }).catch(err => {
      if (!cancelled) setError(err instanceof Error ? err.message : 'PDF indisponível.')
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [doc.id, attempt])
  return <section className="space-y-4">
    <p className="text-sm break-words">{doc.drive_name || doc.original_name}</p>
    {loading && <p role="status" className="py-8 text-center">Abrindo PDF…</p>}
    {error && <div role="alert" className="space-y-3"><p>{error}</p><button className={buttonClass} onClick={() => { setLoading(true); setError(null); setAttempt(value => value + 1) }}>Tentar novamente</button></div>}
    {url && <><div className="flex flex-wrap gap-4"><a className="inline-flex gap-2 items-center text-sm underline min-h-11" href={url} download={doc.drive_name || doc.original_name}><Download className="w-4 h-4" />Baixar PDF</a><a className="inline-flex gap-2 items-center text-sm underline min-h-11" href={url} target="_blank" rel="noopener noreferrer"><ExternalLink className="w-4 h-4" />Abrir em outra aba</a></div><iframe title="PDF original do exame" src={url} className="w-full h-[65vh] rounded-lg border border-[hsl(var(--border))]" /></>}
  </section>
}

export function DocumentForm({ doc, mode, onContactSaved }: { doc: ExamDocument; mode: 'identity' | 'patient' | 'contact'; onContactSaved?: () => Promise<void> }) {
  const auth = useExamAuth()
  const action = useDocumentAction()
  const [fields, setFields] = useState<DocumentFields>(() => ({ ...doc.extracted_data, ...doc.confirmed_data }))
  const [editingSnapshot, setEditingSnapshot] = useState(() => documentEditSnapshot(doc))
  const [classification, setClassification] = useState(() => ['review', 'not_exam'].includes(doc.identification_status) ? doc.identification_status : 'exam')
  const canContact = auth.role === 'vet' || auth.role === 'admin'
  const locked = doc.deliveries.some(delivery => delivery.destination === 'nexus' && delivery.status === 'completed')
  const stale = editingSnapshot !== documentEditSnapshot(doc)
  const [reason, setReason] = useState('')
  const [search, setSearch] = useState(() => doc.confirmed_data.pet_name || doc.extracted_data.pet_name || '')
  const candidates = useDocumentCandidates(useDeferredValue(mode === 'patient' ? search : ''))
  const [selected, setSelected] = useState<DocumentCandidate | null>(null)
  const [itemIds, setItemIds] = useState<string[]>([])
  const [confirmed, setConfirmed] = useState(false)
  const [contactIds, setContactIds] = useState<string[]>(() => doc.items.filter(item => !item.contacted_at).map(item => item.exam_item_id || item.item_id || '').filter(Boolean))
  const [channel, setChannel] = useState('whatsapp')
  const [note, setNote] = useState('')
  const run = async (name: string, args: Record<string, unknown>, message: string) => {
    try {
      const result = await action.mutateAsync({ name, args })
      const saved = result?.document || result
      if (['review_exam_document', 'confirm_exam_document_link'].includes(name) && saved?.version) setEditingSnapshot(documentEditSnapshot({ ...doc, ...saved }))
      toast.success(message)
      if (name === 'record_exam_document_contact') await onContactSaved?.()
    }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Não foi possível salvar.') }
  }
  const toggle = (values: string[], id: string) => values.includes(id) ? values.filter(value => value !== id) : [...values, id]
  const items = doc.items.map(item => ({ ...item, id: item.exam_item_id || item.item_id || '' })).filter(item => item.id)

  const identityPanel = <section className={sectionClass}><h2 className="font-semibold">Conferir identificação</h2>{stale && <div role="status" className="text-sm rounded-lg bg-amber-50 dark:bg-amber-950/20 p-3 space-y-2"><p>A identificação foi atualizada em outra etapa. Seus campos foram preservados. Recarregue os dados antes de confirmar.</p><button className="underline" onClick={() => { setFields({ ...doc.extracted_data, ...doc.confirmed_data }); setClassification(['review', 'not_exam'].includes(doc.identification_status) ? doc.identification_status : 'exam'); setReason(doc.review_reason || ''); setSelected(null); setItemIds([]); setConfirmed(false); setEditingSnapshot(documentEditSnapshot(doc)) }}>Recarregar identificação</button></div>}{locked && <p className="text-sm text-[hsl(var(--muted-foreground))]">Os dados já foram anexados ao cadastro. Uma alteração exige nova versão do exame.</p>}<div className="grid sm:grid-cols-2 gap-3">{fieldLabels.map(([field, label]) => <label key={field} className="space-y-1 text-sm"><span>{label}</span><input type={field === 'exam_date' ? 'date' : 'text'} className={inputClass} disabled={locked} value={fields[field] || ''} onChange={e => setFields(current => ({ ...current, [field]: e.target.value || null }))} /></label>)}</div><label className="block text-sm space-y-1"><span>Classificação</span><select className={inputClass} disabled={locked} value={classification} onChange={e => setClassification(e.target.value)}><option value="exam">É um exame</option><option value="review">Precisa de conferência</option>{!doc.pet_id && <option value="not_exam">Não é exame</option>}</select></label>{classification !== 'exam' && <label className="block text-sm space-y-1"><span>Motivo da classificação</span><textarea className={inputClass} value={reason} onChange={e => setReason(e.target.value)} /></label>}<p className="text-xs text-[hsl(var(--muted-foreground))]">Use a data que consta no exame.</p><button type="button" disabled={action.isPending || locked || stale || (classification !== 'exam' && !reason.trim())} className={buttonClass} onClick={() => void run('review_exam_document', { p_document_id: doc.id, p_expected_version: doc.version, p_fields: fields, p_classification: classification, p_reason: reason || null }, 'Conferência salva.')}>{classification === 'exam' ? 'Salvar identificação' : 'Salvar conferência'}</button></section>
  const patientPanel = <section className={sectionClass}><h2 className="font-semibold">{doc.pet_id ? 'Cadastro do paciente' : 'Selecionar paciente'}</h2>{doc.pet_id ? <p className="text-sm">{doc.nexus_status === 'completed' ? 'Exame anexado ao cadastro no PAM Nexus.' : fields.exam_date ? 'Cadastro identificado. A anexação no PAM Nexus será feita automaticamente; acompanhe em Etapas e pendências.' : 'Cadastro identificado. Preencha a data do exame e salve a identificação para concluir a anexação automática.'}</p> : <><p className="text-sm text-[hsl(var(--muted-foreground))]">Busque o pet ou tutor e confira no PDF.</p><label className="block"><span className="sr-only">Buscar cadastro do tutor ou pet</span><input className={inputClass} value={search} placeholder="Nome do tutor ou pet (mínimo 2 letras)" onChange={e => { setSearch(e.target.value); setSelected(null); setItemIds([]); setConfirmed(false) }} /></label>{candidates.isLoading && <p className="text-sm">Buscando…</p>}{candidates.error && <p role="alert" className="text-sm text-red-600">Não foi possível buscar os cadastros.</p>}{!candidates.isLoading && search.trim().length >= 2 && candidates.data?.length === 0 && <p className="text-sm">Nenhum cadastro encontrado. Confira a grafia ou cadastre o paciente no PAM Nexus.</p>}<div className="max-h-56 overflow-auto space-y-2" role="radiogroup" aria-label="Cadastros encontrados">{candidates.data?.map(candidate => <label key={candidate.pet_id} className="flex gap-3 items-start rounded-lg border border-[hsl(var(--border))] p-3 text-sm"><input type="radio" name="patient" checked={selected?.pet_id === candidate.pet_id} onChange={() => { setSelected(candidate); setItemIds([]); setConfirmed(false); setFields(current => ({ ...current, pet_name: candidate.pet_name, client_name: candidate.client_name, species: candidate.species })) }} /><span><strong>{candidate.pet_name}</strong> · {candidate.species || 'Espécie não informada'}<br />Tutor: {candidate.client_name}</span></label>)}</div>{selected && <div className="space-y-3"><p className="text-sm font-medium">Itens do rastreamento</p>{selected.items?.map(item => <label key={item.id} className="flex gap-2 items-center text-sm"><input type="checkbox" checked={itemIds.includes(item.id)} onChange={() => setItemIds(current => toggle(current, item.id))} />{item.exam_type}{item.result_received ? ' · já possui resultado' : ''}</label>)}<p className="text-xs text-[hsl(var(--muted-foreground))]">Sem selecionar itens, o exame será adicionado como resultado externo. Tipo e data podem ser conferidos abaixo.</p><label className="flex gap-2 items-start text-sm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />Conferi o PDF e confirmo que pertence a {selected.pet_name}, tutor {selected.client_name}, e aos itens selecionados.</label><button type="button" className={buttonClass} disabled={!confirmed || !fields.exam_type || stale || doc.file_status !== 'saved' || action.isPending} onClick={() => void run('confirm_exam_document_link', { p_document_id: doc.id, p_pet_id: selected.pet_id, p_item_ids: itemIds, p_expected_version: doc.version, p_confirmed: fields }, fields.exam_date ? 'Cadastro confirmado. A anexação será feita automaticamente.' : 'Cadastro confirmado. Preencha a data e salve a identificação para concluir a anexação automática.')}>{fields.exam_date ? 'Confirmar cadastro e anexar' : 'Confirmar cadastro'}</button>{doc.file_status !== 'saved' && <p className="text-xs text-amber-700">A confirmação fica disponível depois de salvar o original no Drive.</p>}</div>}</>}</section>
  const contactPanel = <section className={sectionClass}><h2 className="font-semibold">Registrar contato</h2><DocumentBadge status={doc.contact_status} />{doc.file_status !== 'saved' && <p role="status" className="text-sm">Aguarde o original ser salvo para registrar o contato.</p>}{!canContact && <p className="text-sm text-[hsl(var(--muted-foreground))]">O registro de contato é feito por uma veterinária ou pela gestão.</p>}{doc.contact_status === 'completed' ? <p className="text-sm">Contato registrado para todos os itens deste documento.</p> : !doc.pet_id ? <p className="text-sm text-[hsl(var(--muted-foreground))]">Confirme o paciente antes de registrar o contato.</p> : <><p className="text-sm text-[hsl(var(--muted-foreground))]">Selecione os exames abordados e registre o combinado.</p>{items.map(item => <label key={item.id} className="flex gap-2 text-sm items-center"><input type="checkbox" disabled={!!item.contacted_at} checked={!!item.contacted_at || contactIds.includes(item.id)} onChange={() => setContactIds(current => toggle(current, item.id))} />{item.exam_type || 'Exame'}{item.contacted_at && ' · contato realizado'}</label>)}<label className="block text-sm space-y-1"><span>Canal do contato</span><select className={inputClass} value={channel} onChange={e => setChannel(e.target.value)}><option value="whatsapp">WhatsApp</option><option value="phone">Telefone</option><option value="email">Email</option><option value="in_person">Presencial</option></select></label><label className="block text-sm space-y-1"><span>Anotação do contato</span><textarea className={inputClass} rows={3} value={note} onChange={e => setNote(e.target.value)} placeholder="Registre o contato realizado e o encaminhamento combinado." /></label><button type="button" className={buttonClass} disabled={!canContact || action.isPending || doc.file_status !== 'saved' || contactIds.length === 0 || !note.trim()} onClick={() => void run('record_exam_document_contact', { p_document_id: doc.id, p_item_ids: contactIds, p_channel: channel, p_note: note.trim(), p_contacted_at: new Date().toISOString() }, 'Contato registrado.')}>Registrar contato realizado</button></>}</section>
  return <div className="exam-detail-form space-y-4">{mode === 'identity' ? identityPanel : mode === 'contact' ? contactPanel : <>{patientPanel}<details open={!fields.exam_type || !fields.exam_date || stale}><summary>Conferir dados do exame</summary>{identityPanel}</details></>}</div>
}

export function DocumentSteps({ doc }: { doc: ExamDocument }) {
  const action = useDocumentAction()
  const [retryReason, setRetryReason] = useState('')
  const retry = async (id: string) => {
    try { await action.mutateAsync({ name: 'retry_exam_document_delivery', args: { p_delivery_id: id, p_reason: retryReason } }); toast.success('Nova tentativa solicitada.'); setRetryReason('') }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Não foi possível repetir.') }
  }
  return <section className={sectionClass}><h2 className="font-semibold">Etapas e pendências</h2>{doc.deliveries.map(delivery => <div key={delivery.id} className="border-t border-[hsl(var(--border))] pt-3 space-y-2"><div className="flex justify-between items-center gap-2"><span className="text-sm">{destinationLabels[delivery.destination] || delivery.destination}</span><DocumentBadge status={delivery.destination === 'nexus' && delivery.status === 'completed' ? 'attached' : delivery.status} /></div>{delivery.last_error && <p className="text-xs text-red-600 break-words">{delivery.last_error}</p>}{delivery.status === 'uncertain' && <p className="text-xs text-amber-700">Confira a entrega antes de tentar reenviar. A automação vai buscar confirmação.</p>}{delivery.status === 'failed' && <div className="space-y-2"><label className="block"><span className="sr-only">Motivo para tentar novamente</span><input className={inputClass} value={retryReason} onChange={e => setRetryReason(e.target.value)} placeholder="Correção realizada antes de repetir" /></label><button type="button" className={buttonClass} disabled={action.isPending || !retryReason.trim()} onClick={() => void retry(delivery.id)}>Tentar esta etapa novamente</button></div>}</div>)}{!doc.deliveries.length && <p className="text-sm text-[hsl(var(--muted-foreground))]">Nenhuma tarefa registrada.</p>}{doc.group_exception_reason && <p className="text-xs">Aviso ao grupo dispensado: {doc.group_exception_reason}</p>}</section>
}

export function DocumentHistory({ id }: { id: string }) {
  const events = useDocumentEvents(id)
  return <section className={sectionClass}><h2 className="font-semibold">Histórico</h2>{events.isLoading ? <p className="text-sm">Carregando…</p> : events.error ? <p role="alert" className="text-sm text-red-600">Não foi possível carregar o histórico.</p> : <ol className="space-y-3">{events.data?.map(event => <li key={event.id} className="text-sm"><p>{eventLabels[event.event_type] || event.event_type}</p><p className="text-xs text-[hsl(var(--muted-foreground))]">{new Date(event.created_at).toLocaleString('pt-BR')}{event.actor_id && ' · ação registrada pela equipe'}</p></li>)}</ol>}</section>
}
