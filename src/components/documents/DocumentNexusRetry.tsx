import { useRef, useState } from 'react'
import { useDocumentAction } from '@/hooks/useExamDocuments'
import type { ExamDocument } from '@/types/exam-document'

export function DocumentNexusRetry({ doc, onReview }: { doc: ExamDocument; onReview: () => void }) {
  const action = useDocumentAction()
  const submitting = useRef(false)
  const [saving, setSaving] = useState(false)
  const [requested, setRequested] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const task = doc.deliveries.find(delivery => delivery.destination === 'nexus')
  const attached = doc.nexus_status === 'completed' || doc.deliveries.some(delivery => delivery.destination === 'nexus' && delivery.status === 'completed')
  const failed = task?.status === 'failed'
  const ready = !!doc.pet_id && doc.identification_status === 'confirmed' && !!doc.confirmed_data.exam_date && doc.file_status === 'saved'
  const requestKey = task ? `${doc.id}:${task.id}:${task.updated_at || task.attempts}` : ''
  const waiting = !!task && (['pending', 'reserved'].includes(task.status) || requested === requestKey)
  if (!task || attached || (!failed && !(waiting && ready))) return null

  const retry = async () => {
    if (!ready || !failed || waiting || submitting.current || action.isPending) return
    submitting.current = true
    setSaving(true)
    setError(null)
    try {
      await action.mutateAsync({ name: 'retry_exam_document_delivery', args: {
        p_delivery_id: task.id,
        p_reason: 'Retomada solicitada pela equipe na ficha após falha de anexação ao PAM Nexus.',
      } })
      setRequested(requestKey)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível solicitar a nova tentativa. Confira a situação e tente novamente.')
    } finally {
      submitting.current = false
      setSaving(false)
    }
  }

  return <aside className="exam-detail-nexus-retry" role={waiting ? 'status' : 'alert'} aria-label="Anexação ao PAM Nexus">
    <strong>{waiting ? 'Anexação ao PAM Nexus em andamento' : 'O exame ainda não foi anexado ao PAM Nexus'}</strong>
    <p>{waiting ? 'Aguarde a confirmação do arquivo. O Cadastro ficará verde quando a anexação terminar.' : ready ? 'A tentativa anterior falhou. Você pode solicitar uma nova tentativa por aqui.' : 'Confira o paciente, a data e o original salvo antes de tentar novamente.'}</p>
    {error && <p role="alert">{error}</p>}
    {!waiting && (ready ? <button type="button" className="exam-detail-primary" disabled={saving || action.isPending} aria-busy={saving} onClick={() => void retry()}>{saving ? 'Solicitando…' : 'Tentar anexar novamente'}</button> : <button type="button" className="exam-detail-primary" onClick={onReview}>Conferir cadastro</button>)}
  </aside>
}
