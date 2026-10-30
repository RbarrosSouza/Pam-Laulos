import { useState, useSyncExternalStore } from 'react'
import type { ExamDocument } from '../src/types/exam-document'
if (!import.meta.env.DEV) throw new Error('Synthetic preview is DEV only')
const params = new URLSearchParams(location.search)
const mode = params.get('scenario') || 'new'
const linked = ['attached', 'pending', 'partial', 'contact-failure', 'read-failure'].includes(mode)
const fields = { pet_name: 'Luna', client_name: 'Marina Almeida', exam_type: 'Histopatológico', exam_date: '2026-10-29', lab_name: 'VetLab' }
const id = '10000000-0000-4000-8000-000000000001'
const previousId = '10000000-0000-4000-8000-000000000002'
const nexusDone = linked && mode !== 'pending'
let doc: ExamDocument = {
  id, display_code: 'EX-DEMO', version: 1, original_name: 'Laudo fictício.pdf', received_at: '2026-10-29T17:32:00Z', file_status: 'saved',
  identification_status: linked ? 'confirmed' : 'unidentified', drive_file_id: null, drive_name: null, extracted_data: fields, confirmed_data: linked ? fields : {}, evidence: {}, review_reason: null,
  pet_id: linked ? 'pet-demo' : null, assigned_to: null, responsible_vet_id: 'vet-demo', responsible_vet_name: 'Dra. Clara Lima', responsible_vet_avatar_url: null, responsible_vet_source: 'manual',
  group_release_at: null, group_exception_reason: null, previous_document_id: null, oldest_group_sent_at: '2026-10-29T17:32:00Z', contact_status: 'pending', group_status: mode === 'partial' ? 'pending' : 'sent', nexus_status: nexusDone ? 'completed' : linked ? 'pending' : 'awaiting_link', process_status: 'completed', completed: false,
  sources: [{ id: 'source-demo', channel: 'whatsapp', received_at: '2026-10-29T17:32:00Z' }],
  items: linked ? [{ exam_item_id: 'item-demo', exam_type: 'Histopatológico', contacted_at: null }] : [],
  deliveries: nexusDone ? [{ id: 'delivery-demo', destination: 'nexus', status: 'completed', attempts: 1, last_error: null }] : [],
}
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(listener => listener())
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
const snapshot = () => doc
const pause = (ms = 320) => new Promise(resolve => setTimeout(resolve, ms))
export const useExamAuth = () => ({ role: params.get('role') === 'reception' ? 'reception' : 'admin', membership: true, session: { user: { id: 'user-demo', email: 'demo@example.invalid', user_metadata: {} } } })
export const useVets = () => ({ data: [{ id: 'vet-demo', nome: 'Dra. Clara Lima', avatar_url: null }], isLoading: false, refetch: async () => ({}) })
export function useExamDocument() {
  const data = useSyncExternalStore(subscribe, snapshot)
  return { data, refetch: async () => { await pause(100); return mode === 'read-failure' ? { error: new Error('Falha simulada de leitura') } : { data: doc } } }
}
export const useDocumentCandidates = (search: string) => ({ data: [
  { pet_id: 'pet-demo', pet_name: 'Luna', client_name: 'Marina Almeida', client_code: 'DEMO', species: 'Canina', client_phone: '(00) 00000-4821', items: [{ id: 'item-demo', exam_type: 'Histopatológico', result_received: false }] },
  { pet_id: 'pet-demo-2', pet_name: 'Luna', client_name: 'Carla Mendes', client_code: 'DEMO-2', species: 'Felina', client_phone: '(00) 00000-9136', items: [] },
].filter(pet => `${pet.pet_name} ${pet.client_name}`.toLowerCase().includes(search.toLowerCase())), isLoading: false })
export const useDocumentEvents = () => ({ data: [], isLoading: false })
export function useDocumentAction() {
  const [isPending, setPending] = useState(false)
  return { isPending, mutateAsync: async ({ name, args }: { name: string; args: Record<string, unknown> }) => {
    setPending(true)
    try {
      await pause()
      if (name === 'record_exam_document_contact' && mode === 'contact-failure') throw new Error('Falha simulada: contato não salvo.')
      if (name === 'confirm_exam_document_link') {
        doc = { ...doc, version: doc.version + 1, pet_id: String(args.p_pet_id), confirmed_data: args.p_confirmed as typeof fields, identification_status: 'confirmed', nexus_status: 'pending', items: [{ exam_item_id: 'item-demo', exam_type: 'Histopatológico' }] }
        setTimeout(() => { doc = { ...doc, nexus_status: 'completed', deliveries: [{ id: 'delivery-demo', destination: 'nexus', status: 'completed', attempts: 1, last_error: null }] }; emit() }, 1200)
      } else if (name === 'review_exam_document') doc = { ...doc, version: doc.version + 1, confirmed_data: args.p_fields as typeof fields }
      else if (name === 'record_exam_document_contact') doc = { ...doc, version: doc.version + 1, contact_status: 'completed', items: doc.items.map(item => ({ ...item, contacted_at: new Date().toISOString(), contacted_by: 'user-demo', contact_channel: String(args.p_channel) })), completed: doc.nexus_status === 'completed' && doc.group_status === 'sent' }
      else if (name === 'set_exam_document_responsible_vet') doc = { ...doc, responsible_vet_id: String(args.p_veterinarian_id), version: doc.version + 1 }
      else throw new Error('Esta ação não faz parte da demonstração.')
      emit(); return { document: doc }
    } finally { setPending(false) }
  } }
}
export const supabase = { rpc: async (name: string) => {
  if (name !== 'get_exam_intake_version_review') throw new Error('RPC não simulada')
  return { error: null, data: {
    contract: 'exam_intake_version_review_v1', document_id: id,
    hold: { state: 'released', reason: 'changed_content_review', previous_document_id: previousId, created_at: '2026-10-29T17:32:00Z', released_at: null },
    current: { document_id: id, original_name: 'Laudo fictício.pdf', sha256: null, file_status: 'saved', group_status: doc.group_status },
    previous: mode === 'unavailable' ? null : { document_id: previousId, original_name: 'Laudo anterior fictício.pdf', sha256: null, file_status: 'saved', group_status: 'sent' },
    review_allowed: false, can_link_previous: false, blocking_reason: null, decision: null,
  } }
} }
export async function callDocumentService(action: string, args: { document_id?: string }) {
  if (action !== 'file') throw new Error('Somente PDFs fictícios estão disponíveis nesta prévia.')
  await pause()
  if (mode === 'pdf-failure') throw new Error('Falha simulada ao abrir o PDF.')
  // Small valid, inert PDF made locally. No clinical document or service request.
  const current = args.document_id === id
  const stream = `BT /F1 18 Tf 50 770 Td (VETLAB - DOCUMENTO FICTICIO) Tj 0 -50 Td /F1 13 Tf (Paciente: Luna) Tj 0 -25 Td (Tutora: Marina Almeida) Tj 0 -25 Td (Data: ${current ? '29' : '27'}/10/2026) Tj 0 -40 Td (PDF ${current ? 'atual' : 'anterior'} - teste de interface) Tj 0 -50 Td /F1 10 Tf (Sem dados ou resultados clinicos reais.) Tj ET`
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
  let pdf = '%PDF-1.4\n'; const offsets = [0]
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const start = pdf.length
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`
  return new Blob([pdf], { type: 'application/pdf' })
}
