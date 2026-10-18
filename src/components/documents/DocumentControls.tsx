import { useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { useExamAuth } from '@/contexts/exam-auth'
import { useDocumentAction } from '@/hooks/useExamDocuments'
import { documentDisplayId } from '@/lib/document-status'
import type { ExamDocument } from '@/types/exam-document'

const inputClass = 'w-full rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--card))] px-3 py-2 text-sm'
const buttonClass = 'rounded-lg border border-[hsl(var(--border))] px-3 py-2 text-sm disabled:opacity-50'
const channels: Record<string, string> = { email: 'Email', manual: 'Envio manual', whatsapp: 'WhatsApp', phone: 'Telefone', in_person: 'Presencial' }

export function DocumentProvenance({ doc }: { doc: ExamDocument }) {
  const auth = useExamAuth()
  return <section className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 space-y-4"><h2 className="font-semibold">Origem e atendimento</h2><p className="text-sm">Responsável: {doc.responsible_vet_id ? doc.responsible_vet_name || 'Veterinária definida' : doc.assigned_to === auth.session?.user.id ? auth.session?.user.email || 'Você' : doc.assigned_to ? doc.assigned_name || `Usuário ${doc.assigned_to.slice(0, 8)}` : 'Ainda não definido'}</p><ul className="space-y-2">{doc.sources.map(source => <li key={source.id} className="text-sm">{channels[source.channel || source.source_channel || ''] || 'Canal não informado'}{source.received_at && <span className="text-xs text-[hsl(var(--muted-foreground))]"> · {new Date(source.received_at).toLocaleString('pt-BR')}</span>}</li>)}</ul>{doc.items.filter(item => item.contacted_at).map(item => <div key={item.exam_item_id || item.item_id} className="border-t border-[hsl(var(--border))] pt-3 text-sm space-y-1"><p className="font-medium">{item.exam_type || 'Exame'} · {channels[item.contact_channel || ''] || 'Contato'}</p><p className="whitespace-pre-wrap break-words">{item.contact_note}</p><p className="text-xs text-[hsl(var(--muted-foreground))]">{new Date(item.contacted_at!).toLocaleString('pt-BR')} · {item.contacted_by === auth.session?.user.id ? auth.session?.user.email || 'Você' : `Usuário ${item.contacted_by?.slice(0, 8) || 'registrado'}`}</p></div>)}</section>
}

export function DocumentCorrection({ doc }: { doc: ExamDocument }) {
  const action = useDocumentAction()
  const [previous, setPrevious] = useState('')
  const [reason, setReason] = useState('')
  if (doc.previous_document_id) return null
  const match = previous.trim().match(/(?:^|\/novos-exames\/)([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:[?#].*)?$/i)
  const previousId = match?.[1]
  const save = async () => {
    try { await action.mutateAsync({ name: 'mark_exam_document_correction', args: { p_document_id: doc.id, p_previous_document_id: previousId, p_expected_version: doc.version, p_reason: reason.trim() } }); toast.success('Nova versão ligada ao original. Confira o paciente e os itens abaixo.') }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Não foi possível ligar as versões.') }
  }
  return <section className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 space-y-3"><h2 className="font-semibold">Versão corrigida</h2><p className="text-sm text-[hsl(var(--muted-foreground))]">Se este PDF corrige outro exame, ligue ao documento anterior antes de confirmar o paciente. O arquivo e o atendimento anteriores serão preservados.</p>{doc.pet_id ? <p className="text-sm">Este documento já foi vinculado. Adicione o novo PDF corrigido em Novos exames para registrar outra versão.</p> : <><label className="block text-sm space-y-1"><span>Link ou ID completo do documento anterior</span><input className={inputClass} value={previous} onChange={e => setPrevious(e.target.value)} placeholder="Cole o link de Novos exames do original" /></label>{previousId && <Link className="text-sm underline" to={`/novos-exames/${previousId}`} target="_blank" rel="noopener noreferrer">Conferir original {documentDisplayId(previousId)}</Link>}<label className="block text-sm space-y-1"><span>Motivo da correção</span><textarea className={inputClass} value={reason} onChange={e => setReason(e.target.value)} /></label><button className={buttonClass} disabled={action.isPending || !previousId || previousId === doc.id || !reason.trim() || doc.file_status !== 'saved'} onClick={() => void save()}>Ligar ao exame anterior</button></>}</section>
}

export function DocumentGroupConfirmation({ doc }: { doc: ExamDocument }) {
  const auth = useExamAuth()
  const action = useDocumentAction()
  const delivery = doc.deliveries.find(item => item.destination === 'group' && ['submitted', 'uncertain'].includes(item.status))
  const [externalId, setExternalId] = useState('')
  const [reason, setReason] = useState('')
  const [checked, setChecked] = useState(false)
  const [exception, setException] = useState('')
  const sending = doc.deliveries.some(item => item.destination === 'group' && ['reserved', 'submitted', 'uncertain'].includes(item.status))
  const run = async (name: string, args: Record<string, unknown>, message: string) => {
    try { await action.mutateAsync({ name, args }); toast.success(message); setChecked(false); setReason(''); setException('') }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Não foi possível registrar.') }
  }
  if (!delivery && auth.role !== 'admin') return null
  return <section className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 space-y-3"><h2 className="font-semibold">Conferência do aviso ao grupo</h2>{delivery && (auth.role === 'admin' || auth.role === 'vet') && <><p className="text-sm">Use quando a API não confirmou o envio e você conferiu a mensagem com o PDF no grupo correto.</p><label className="block text-sm space-y-1"><span>ID da mensagem no Chatwoot</span><input className={inputClass} value={delivery.external_id || externalId} readOnly={!!delivery.external_id} onChange={e => setExternalId(e.target.value)} /></label><label className="block text-sm space-y-1"><span>Evidência da conferência</span><textarea className={inputClass} value={reason} onChange={e => setReason(e.target.value)} placeholder="Grupo, horário e conferência do PDF enviado." /></label><label className="flex gap-2 text-sm items-start"><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} />Conferi pessoalmente o PDF e a mensagem no grupo destinado aos exames.</label><button className={buttonClass} disabled={action.isPending || !checked || !(delivery.external_id || externalId.trim()) || !reason.trim()} onClick={() => void run('confirm_exam_document_group_delivery', { p_document_id: doc.id, p_expected_version: doc.version, p_external_id: delivery.external_id || externalId.trim(), p_reason: reason.trim() }, 'Entrega conferida pela equipe. O contato com tutor continua separado.')}>Registrar entrega conferida</button></>}{auth.role === 'admin' && !doc.group_exception_reason && doc.group_status !== 'sent' && <details className="text-sm"><summary className="cursor-pointer">Dispensar aviso com justificativa</summary><p className="text-xs my-2 text-[hsl(var(--muted-foreground))]">Registre uma exceção operacional quando o aviso ao grupo não for necessário.</p>{sending && <p className="text-xs my-2 text-amber-700">Há um envio em andamento ou sem confirmação. Confira e reconcilie essa tentativa antes de dispensar o aviso.</p>}<label className="block"><span className="sr-only">Justificativa para dispensar aviso</span><textarea className={inputClass} value={exception} onChange={e => setException(e.target.value)} /></label><button className={`${buttonClass} mt-2`} disabled={action.isPending || sending || !exception.trim()} onClick={() => void run('confirm_exam_document_group_exception', { p_document_id: doc.id, p_reason: exception.trim() }, 'Exceção de aviso registrada.')}>Registrar exceção</button></details>}</section>
}
