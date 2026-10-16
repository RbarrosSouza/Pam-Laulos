import { Link, Navigate, useParams } from 'react-router-dom'
import { decodeExamDocumentId } from '@/lib/exam-document-short-link'

export function ExamShortLink() {
  const { shortId } = useParams<{ shortId: string }>()
  const documentId = decodeExamDocumentId(shortId)
  if (documentId) return <Navigate to={`/novos-exames/${documentId}`} replace />
  return (
    <section role="alert" className="max-w-lg mx-auto py-12 space-y-3">
      <h1 className="text-xl font-semibold">Link de exame inválido</h1>
      <p className="text-sm text-[hsl(var(--muted-foreground))]">Confira se o endereço foi copiado por completo.</p>
      <Link to="/novos-exames" className="text-sm underline">Ir para novos exames</Link>
    </section>
  )
}
