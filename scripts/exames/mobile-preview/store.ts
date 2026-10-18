import { useSyncExternalStore } from 'react'
import type { DocumentCandidate, DocumentEvent, DocumentFields, ExamDocument } from '../../../src/types/exam-document'
import { fixtureVets } from './mock-vets'

export const USER_ID = '11111111-1111-4111-8111-111111111111'
export const scenario = new URLSearchParams(window.location.search).get('scenario') || 'pending'
const now = Date.now()
const received = new Date(now - 18 * 60 * 60 * 1000 - 120000).toISOString()
const sent = new Date(now - 18 * 60 * 60 * 1000).toISOString()
const contacted = new Date(now - 600000).toISOString()
const linked = ['linked', 'complete', 'partial', 'error', 'reception'].includes(scenario)
const complete = scenario === 'complete'
const fields: DocumentFields = {
  pet_name: scenario === 'long' ? 'Luna Maria Estrela da Manhã' : 'Luna',
  client_name: scenario === 'long' ? 'Helena Beatriz Albuquerque de Oliveira Duarte' : 'Helena Duarte',
  exam_type: scenario === 'long' ? 'Hemograma completo com avaliação morfológica e contagem de reticulócitos' : 'Hemograma',
  exam_date: '2026-10-17', lab_name: 'Laboratório demonstração', species: 'Canina',
}

let document: ExamDocument = {
  id: 'aaaa1111-2222-4333-8444-555555555555', version: 1,
  original_name: 'Luna - Helena Duarte - Hemograma - 17-10-2026.pdf',
  received_at: received, file_status: 'saved', identification_status: linked ? 'confirmed' : 'pending',
  drive_file_id: 'local-fixture', drive_name: 'Luna - Helena Duarte - Hemograma - 17-10-2026.pdf',
  extracted_data: fields, confirmed_data: linked ? fields : {}, evidence: {}, review_reason: null,
  pet_id: linked ? 'pet-luna-fixture' : null,
  assigned_to: complete || scenario === 'partial' ? USER_ID : null,
  assigned_name: complete || scenario === 'partial' ? 'Dra. Isabela Martins' : null,
  group_release_at: sent, group_exception_reason: null, previous_document_id: null,
  oldest_group_sent_at: sent, contact_status: complete ? 'completed' : scenario === 'partial' ? 'partial' : 'pending',
  group_status: 'sent', nexus_status: linked ? 'completed' : 'awaiting_link',
  process_status: 'completed', completed: complete,
  sources: [{ id: 'fixture-email', channel: 'email', account: 'qa@example.invalid', received_at: received }],
  items: linked ? [{ exam_item_id: 'item-hemograma-fixture', exam_type: 'Hemograma', contacted_at: complete || scenario === 'partial' ? contacted : null, contacted_by: complete || scenario === 'partial' ? USER_ID : null, contact_channel: complete || scenario === 'partial' ? 'whatsapp' : null, contact_note: complete || scenario === 'partial' ? 'Contato fictício registrado para avaliação visual.' : null }] : [],
  deliveries: [
    { id: 'delivery-drive', destination: 'drive', status: 'completed', attempts: 1, last_error: null },
    { id: 'delivery-processing', destination: 'processing', status: 'completed', attempts: 1, last_error: null },
    { id: 'delivery-group', destination: 'group', status: 'sent', attempts: 1, last_error: null, sent_at: sent, external_id: 'fixture-message' },
    { id: 'delivery-nexus', destination: 'nexus', status: linked ? 'completed' : 'pending', attempts: linked ? 1 : 0, last_error: null },
  ],
}
if (scenario === 'partial') document.items.push({ exam_item_id: 'item-reticulocitos-fixture', exam_type: 'Reticulócitos', contacted_at: null })

let events: DocumentEvent[] = [
  { id: 3, event_type: 'delivery_completed', created_at: sent },
  { id: 2, event_type: 'file_saved', created_at: received },
  { id: 1, event_type: 'received', created_at: received },
]
const listeners = new Set<() => void>()
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
function publish(next: ExamDocument) { document = next; listeners.forEach(listener => listener()) }
export function useFixtureDocument() { return useSyncExternalStore(subscribe, () => document) }
export function useFixtureEvents() { return useSyncExternalStore(subscribe, () => events) }
export const wait = (milliseconds = 250) => new Promise(resolve => window.setTimeout(resolve, milliseconds))
export async function refreshDocument() { await wait(100); return { data: document, error: null } }

export const candidates: DocumentCandidate[] = [
  { pet_id: 'pet-luna-fixture', pet_name: 'Luna', client_name: 'Helena Duarte', client_code: 'QA-01', species: 'Canina', items: [{ id: 'item-hemograma-fixture', exam_card_id: 'card-fixture', exam_type: 'Hemograma', result_received: false }] },
  { pet_id: 'pet-nina-fixture', pet_name: 'Nina', client_name: 'Mariana Souza', client_code: 'QA-02', species: 'Felina', items: [] },
]

export async function mutateFixture(name: string, args: Record<string, unknown>) {
  await wait(350)
  if (scenario === 'error') throw new Error('Não foi possível salvar. Falha simulada de conexão; nenhuma alteração foi gravada.')
  const next = structuredClone(document)
  if (args.p_expected_version !== undefined && args.p_expected_version !== next.version) throw new Error('A identificação mudou. Recarregue os dados antes de confirmar.')
  let eventType = name
  if (name === 'set_exam_document_responsible_vet') {
    const vet = fixtureVets.find(vet => vet.id === args.p_veterinarian_id)
    if (!vet) throw new Error('Veterinário indisponível.')
    next.responsible_vet_id = vet.id
    next.responsible_vet_name = vet.nome
    next.responsible_vet_avatar_url = vet.avatar_url
    next.responsible_vet_source = 'manual'
    eventType = 'responsible_vet_assigned'
  } else if (name === 'assign_exam_document') {
    next.assigned_to = String(args.p_assignee_id)
    next.assigned_name = 'Dra. Isabela Martins'
    eventType = 'assigned'
  } else if (name === 'review_exam_document') {
    next.confirmed_data = args.p_fields as DocumentFields
    next.identification_status = args.p_classification === 'exam' ? next.pet_id ? 'confirmed' : 'pending' : String(args.p_classification)
    next.review_reason = args.p_reason ? String(args.p_reason) : null
    eventType = 'reviewed'
  } else if (name === 'confirm_exam_document_link') {
    next.pet_id = String(args.p_pet_id)
    next.confirmed_data = args.p_confirmed as DocumentFields
    next.identification_status = 'confirmed'
    next.nexus_status = 'pending'
    const ids = args.p_item_ids as string[]
    next.items = (ids.length ? ids : ['item-hemograma-fixture']).map(id => ({ exam_item_id: id, exam_type: next.confirmed_data.exam_type || 'Exame externo', contacted_at: null }))
    eventType = 'link_confirmed'
    window.setTimeout(() => {
      const attached = structuredClone(document)
      attached.nexus_status = 'completed'
      attached.deliveries = attached.deliveries.map(delivery => delivery.destination === 'nexus' ? { ...delivery, status: 'completed', attempts: 1 } : delivery)
      attached.completed = attached.contact_status === 'completed'
      publish(attached)
    }, 900)
  } else if (name === 'record_exam_document_contact') {
    if (!next.pet_id || !(args.p_note as string)?.trim()) throw new Error('Paciente e anotação são obrigatórios.')
    const ids = args.p_item_ids as string[]
    next.items = next.items.map(item => ids.includes(item.exam_item_id || item.item_id || '') ? { ...item, contacted_at: String(args.p_contacted_at), contacted_by: USER_ID, contact_channel: String(args.p_channel), contact_note: String(args.p_note) } : item)
    next.contact_status = next.items.length > 0 && next.items.every(item => item.contacted_at) ? 'completed' : 'partial'
    next.completed = next.contact_status === 'completed' && next.nexus_status === 'completed'
    eventType = 'contact_recorded'
  } else if (name === 'retry_exam_document_delivery') {
    next.deliveries = next.deliveries.map(delivery => delivery.id === args.p_delivery_id ? { ...delivery, status: 'pending', last_error: null } : delivery)
  } else if (name === 'mark_exam_document_correction') {
    next.previous_document_id = String(args.p_previous_document_id)
    eventType = 'correction_linked'
  } else {
    throw new Error(`Ação fora do escopo deste fixture: ${name}`)
  }
  next.version += 1
  events = [{ id: events.length + 1, event_type: eventType, created_at: new Date().toISOString(), actor_id: USER_ID }, ...events]
  publish(next)
  return { document: next }
}
