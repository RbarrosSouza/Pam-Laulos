export type CardStatus = 'aguardando_lab' | 'exame_pronto' | 'contato_realizado' | 'atrasado'
export type AlertLevel = 'normal' | 'warning' | 'critical'
export type CardOrigin = 'venda' | 'email'

export interface ExamItem {
  id: string
  exam_card_id: string
  exam_type: string
  lab_name: string | null
  arquivo_url: string | null
  result_received: boolean
  result_received_at: string | null
  contacted: boolean
  contacted_at: string | null
  contacted_by: string | null
  sent_to_lab_at: string | null
  sent_to_lab_by: string | null
  shipment_id: string | null
}

export interface LabShipment {
  id: string
  lab_name: string | null
  sent_by: string
  sent_at: string
  items_count: number
  notes: string | null
  created_at: string
}

export interface ExamCard {
  id: string
  status: CardStatus
  alert_level: AlertLevel
  origin: CardOrigin
  is_orphan: boolean
  sale_id: string | null
  pet_name: string | null
  pet_species: string | null
  pet_breed: string | null
  client_name: string | null
  client_phone: string | null
  client_email: string | null
  vet_name: string | null
  vet_id: string | null
  vet_avatar_url: string | null
  items: ExamItem[]
  items_ready: number
  items_total: number
  hours_elapsed: number
  created_at: string
  updated_at: string
}

export interface ExamCardSummary {
  total_aguardando_lab: number
  total_exame_pronto: number
  total_atrasado: number
  total_contato_realizado: number
  total_orphans: number
  avg_contact_hours: number
}

export interface ExamCardLog {
  id: string
  exam_card_id: string
  previous_status: string | null
  new_status: string
  changed_by: string
  change_reason: string | null
  created_at: string
}
