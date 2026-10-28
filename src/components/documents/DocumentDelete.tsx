import { useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { callDocumentService } from '@/hooks/useExamDocuments'
import type { ExamDocument } from '@/types/exam-document'

export function DocumentDelete({ doc, backTarget, onCancel, onPendingChange }: {
  doc: ExamDocument
  backTarget: string
  onCancel: () => void
  onPendingChange: (pending: boolean) => void
}) {
  const [confirmation, setConfirmation] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const pendingRef = useRef(false)
  const client = useQueryClient()
  const navigate = useNavigate()

  const finish = () => {
    client.removeQueries({ queryKey: ['exam-document'] })
    for (const key of ['exam-documents', 'exam-document-events', 'exam-cards', 'exam-card', 'exam-card-logs', 'exam-card-stats', 'intake-panel-v2', 'exam-intake-exam-failures-v1']) {
      void client.invalidateQueries({ queryKey: [key] })
    }
    toast.success('Ficha excluída.')
    navigate(backTarget, { replace: true })
  }

  const verify = async () => {
    const result = await callDocumentService('delete_status', { document_id: doc.id })
    if (result.state === 'deleted') { finish(); return true }
    if (result.state === 'deleting') setError('A exclusão foi iniciada, mas ainda não terminou. Confira a situação novamente ou retome a exclusão.')
    else if (result.state === 'active') setError('A ficha ainda não foi excluída. Você pode tentar novamente.')
    else setError('Não foi possível confirmar a exclusão desta ficha. Atualize a página.')
    return false
  }

  const check = async () => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true); setChecking(true); onPendingChange(true)
    try { await verify() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível conferir a exclusão.') }
    finally { pendingRef.current = false; setPending(false); setChecking(false); onPendingChange(false) }
  }

  const remove = async () => {
    if (confirmation !== 'DELETAR' || pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    onPendingChange(true)
    setError(null)
    try {
      const result = await callDocumentService('delete', { document_id: doc.id, confirmation, expected_version: doc.version })
      if (result.state !== 'deleted') throw new Error('Exclusão ainda não confirmada. Tente novamente.')
      finish()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível excluir a ficha. Tente novamente.')
      // A lost response can hide a committed deletion. Reconcile by reading;
      // never submit a second destructive request automatically.
      if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'DOCUMENT_SERVICE_TIMEOUT') {
        setChecking(true)
        try { await verify() } catch { /* Keep the original unconfirmed-result message. */ }
      }
    } finally {
      pendingRef.current = false
      setPending(false)
      setChecking(false)
      onPendingChange(false)
    }
  }

  return <div className="exam-detail-delete">
    <p>A ficha e seus dados serão excluídos permanentemente do Pam Laudos. O arquivo no Google Drive não será apagado. Esta ação não pode ser desfeita.</p>
    <label htmlFor="delete-confirmation">Para confirmar, digite <strong>DELETAR</strong></label>
    <input id="delete-confirmation" value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" disabled={pending} />
    {error && <p role="alert" className="exam-detail-delete-error">{error}</p>}
    <button type="button" className="exam-detail-delete-confirm" disabled={confirmation !== 'DELETAR' || pending} onClick={() => void remove()}>
      {pending && !checking && <Loader2 size={18} className="animate-spin" aria-hidden="true" />}{pending && !checking ? 'Excluindo…' : 'Excluir ficha'}
    </button>
    <button type="button" className="exam-detail-delete-check" disabled={pending} onClick={() => void check()}>{checking ? 'Conferindo situação…' : 'Conferir situação'}</button>
    <button type="button" className="exam-detail-delete-cancel" disabled={pending} onClick={onCancel}>Cancelar</button>
  </div>
}
