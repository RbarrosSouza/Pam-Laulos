import { useEffect, useState } from 'react'
import { candidates, mutateFixture, refreshDocument, useFixtureDocument, useFixtureEvents, wait } from './store'
import type { DocumentCandidate } from '../../../src/types/exam-document'

export function useExamDocument() {
  const data = useFixtureDocument()
  return { data, error: null, isLoading: false, refetch: refreshDocument }
}
export function useDocumentEvents() {
  const data = useFixtureEvents()
  return { data, error: null, isLoading: false }
}
export function useDocumentCandidates(query: string) {
  const [result, setResult] = useState<{ data: DocumentCandidate[]; isLoading: boolean }>({ data: [], isLoading: false })
  useEffect(() => {
    let active = true
    void wait(120).then(() => {
      if (active) setResult({ data: query.trim().length < 2 ? [] : candidates.filter(candidate => `${candidate.pet_name} ${candidate.client_name}`.toLocaleLowerCase('pt-BR').includes(query.trim().toLocaleLowerCase('pt-BR'))), isLoading: false })
    })
    return () => { active = false }
  }, [query])
  return { ...result, error: null }
}
export function useDocumentAction() {
  const [isPending, setPending] = useState(false)
  return {
    isPending,
    mutateAsync: async ({ name, args }: { name: string; args: Record<string, unknown> }) => {
      setPending(true)
      try { return await mutateFixture(name, args) }
      finally { setPending(false) }
    },
  }
}
export async function callDocumentService(action: string) {
  await wait(200)
  if (action !== 'file') throw new Error('Serviço real bloqueado no preview local.')
  const content = 'BT /F1 18 Tf 40 760 Td (PDF FICTICIO - QA LOCAL) Tj 0 -32 Td (Luna - Helena Duarte) Tj 0 -32 Td (Hemograma - 17/10/2026) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = pdf.length
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return new Blob([pdf], { type: 'application/pdf' })
}
