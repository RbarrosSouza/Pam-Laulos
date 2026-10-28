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
  const pendingRef = useRef(false)
  const client = useQueryClient()
  const navigate = useNavigate()

  const remove = async () => {
    if (confirmation !== 'DELETAR' || pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    onPendingChange(true)
    setError(null)
    try {
      const result = await callDocumentService('delete', { document_id: doc.id, confirmation, expected_version: doc.version })
      if (result.state !== 'deleted') throw new Error('Exclusão ainda não confirmada. Tente novamente.')
      // Remove the detail cache before returning to the listing, and refresh all
      // affected views so the deleted record cannot linger in the interface.
      client.removeQueries({ queryKey: ['exam-document'] })
      for (const key of ['exam-documents', 'exam-document-events', 'exam-cards', 'exam-card', 'exam-card-logs', 'exam-card-stats', 'intake-panel-v2']) {
        void client.invalidateQueries({ queryKey: [key] })
      }
      toast.success('Ficha excluída.')
      navigate(backTarget, { replace: true })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível excluir a ficha. Tente novamente.')
    } finally {
      pendingRef.current = false
      setPending(false)
      onPendingChange(false)
    }
  }

  return <div className="exam-detail-delete">
    <p>A ficha e seus dados serão excluídos permanentemente do Pam Laudos. O arquivo no Google Drive não será apagado. Esta ação não pode ser desfeita.</p>
    <label htmlFor="delete-confirmation">Para confirmar, digite <strong>DELETAR</strong></label>
    <input id="delete-confirmation" value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" disabled={pending} />
    {error && <p role="alert" className="exam-detail-delete-error">{error}</p>}
    <button type="button" className="exam-detail-delete-confirm" disabled={confirmation !== 'DELETAR' || pending} onClick={() => void remove()}>
      {pending && <Loader2 size={18} className="animate-spin" aria-hidden="true" />}{pending ? 'Excluindo…' : 'Excluir ficha'}
    </button>
    <button type="button" className="exam-detail-delete-cancel" disabled={pending} onClick={onCancel}>Cancelar</button>
  </div>
}
