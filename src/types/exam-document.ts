export type DocumentFields = {
  pet_name?: string | null
  client_name?: string | null
  exam_type?: string | null
  exam_date?: string | null
  lab_name?: string | null
  species?: string | null
  requesting_vet_name?: string | null
  requesting_vet_crmv?: string | null
}

export interface DocumentSource {
  id: string
  channel?: string
  source_channel?: string
  account?: string
  received_at?: string
}

export interface DocumentDelivery {
  id: string
  destination: 'drive' | 'processing' | 'group' | 'nexus'
  status: string
  attempts: number
  last_error: string | null
  sent_at?: string | null
  external_id?: string | null
}

export interface DocumentItem {
  item_id?: string
  exam_item_id?: string
  exam_type?: string
  contacted_at?: string | null
  contacted_by?: string | null
  contact_channel?: string | null
  contact_note?: string | null
}

export interface ExamDocument {
  id: string
  display_code?: string
  version: number
  original_name: string
  received_at: string
  file_status: string
  identification_status: string
  drive_file_id: string | null
  drive_name: string | null
  extracted_data: DocumentFields
  confirmed_data: DocumentFields
  evidence: Record<string, unknown>
  review_reason: string | null
  pet_id: string | null
  assigned_to: string | null
  assigned_name?: string | null
  responsible_vet_id: string | null
  responsible_vet_name: string | null
  responsible_vet_avatar_url: string | null
  responsible_vet_source: 'manual' | 'pdf' | 'sale' | 'pdf_sale' | 'conflict' | null
  group_release_at: string | null
  group_exception_reason: string | null
  previous_document_id: string | null
  oldest_group_sent_at: string | null
  contact_status: string
  group_status: string
  nexus_status: string
  process_status: string
  completed: boolean
  sources: DocumentSource[]
  items: DocumentItem[]
  deliveries: DocumentDelivery[]
}

export interface DocumentCandidate {
  pet_id: string
  pet_name: string
  client_name: string
  client_code: string
  species?: string | null
  items?: { id: string; exam_card_id: string; exam_type: string; result_received: boolean }[]
}

export interface DocumentEvent {
  id: number
  event_type: string
  created_at: string
  actor_id?: string | null
  details?: Record<string, unknown>
}
