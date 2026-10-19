import { FlaskConical, FileCheck2, MessageCircle, CircleCheck } from 'lucide-react'
import type { CardOrigin, CardStatus } from '@/types/exam-card'

export const TRACKING_STAGES = [
  { status: 'aguardando_lab', label: 'Aguardando lab', Icon: FlaskConical },
  { status: 'exame_pronto', label: 'Exame pronto', Icon: FileCheck2 },
  { status: 'no_grupo', label: 'No grupo', Icon: MessageCircle },
  { status: 'contato_realizado', label: 'Contato realizado', Icon: CircleCheck },
] as const

export const TRACKING_STAGE_LABELS: Record<CardStatus, string> = {
  aguardando_lab: 'Aguardando lab',
  exame_pronto: 'Exame pronto',
  no_grupo: 'No grupo',
  contato_realizado: 'Contato realizado',
}

export const TRACKING_ORIGIN_LABELS: Record<CardOrigin, string> = {
  venda: 'Venda',
  email: 'E-mail',
  whatsapp: 'WhatsApp',
  manual: 'Manual',
}
