import { useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { DashboardView } from '@/components/dashboard/DashboardView'
import type { HomeStage } from '@/components/dashboard/home-display'
import type { ExamCard, ExamCardSummary, ExamItem } from '@/types/exam-card'
import '@/components/tracking/tracking-workspace.css'

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()
const previewVets = ['Dra. Isabela Martins', 'Dra. Camila Ferreira', 'Dra. Patrícia Almeida']

function makePreviewCard(
  id: string,
  pet: string,
  tutor: string,
  status: HomeStage,
  hours: number,
  exams: { name: string; ready?: boolean }[],
  vet: string | null = previewVets[0],
): ExamCard {
  const items: ExamItem[] = exams.map((exam, index) => ({
    id: `${id}-item-${index + 1}`,
    exam_card_id: id,
    exam_type: exam.name,
    lab_name: 'Laboratório de exemplo',
    arquivo_url: null,
    result_received: exam.ready ?? status !== 'aguardando_lab',
    result_received_at: (exam.ready ?? status !== 'aguardando_lab') ? hoursAgo(2) : null,
    contacted: false,
    contacted_at: null,
    contacted_by: null,
    sent_to_lab_at: hoursAgo(hours + 3),
    sent_to_lab_by: 'Equipe de exemplo',
    shipment_id: null,
  }))

  return {
    id,
    pet_name: pet,
    pet_species: 'Canina',
    pet_breed: null,
    client_name: tutor,
    client_phone: null,
    client_email: null,
    vet_name: vet,
    vet_id: vet ? `home-preview-vet-${previewVets.indexOf(vet) + 1}` : null,
    vet_avatar_url: null,
    status,
    alert_level: status === 'no_grupo' && hours > 24 ? 'critical' : 'normal',
    origin: 'email',
    is_orphan: false,
    sale_id: null,
    items,
    items_ready: items.filter(item => item.result_received).length,
    items_total: items.length,
    hours_elapsed: hours,
    group_sent_at: status === 'no_grupo' ? hoursAgo(hours) : null,
    created_at: hoursAgo(hours + 6),
    updated_at: hoursAgo(1),
  }
}

function makePreviewQueues(): Record<HomeStage, ExamCard[]> {
  const noGroupDate = makePreviewCard('home-demo-group-8', 'Pipoca', 'Felipe Augusto Monteiro', 'no_grupo', 42, [{ name: 'Urinálise' }], previewVets[2])
  noGroupDate.group_sent_at = null
  noGroupDate.alert_level = 'normal'

  return {
    no_grupo: [
      makePreviewCard('home-demo-group-1', 'Luna', 'Helena Beatriz Oliveira Duarte', 'no_grupo', 31, [{ name: 'Hemograma completo' }, { name: 'Perfil renal' }]),
      makePreviewCard('home-demo-group-2', 'Thor', 'João Pedro Moreira', 'no_grupo', 27, [{ name: 'Ultrassonografia abdominal' }], previewVets[1]),
      makePreviewCard('home-demo-group-3', 'Nina', 'Mariana Costa Ribeiro', 'no_grupo', 19, [{ name: 'Radiografia de tórax' }], null),
      makePreviewCard('home-demo-group-4', 'Bento', 'Rafael Henrique Oliveira', 'no_grupo', 12, [{ name: 'Hemograma completo' }], previewVets[2]),
      makePreviewCard('home-demo-group-5', 'Amora', 'Ana Clara Ferreira Lima', 'no_grupo', 8, [{ name: 'Perfil hepático' }], previewVets[1]),
      makePreviewCard('home-demo-group-6', 'Mel', 'Juliana Beatriz Teixeira', 'no_grupo', 5, [{ name: 'Urocultura' }]),
      makePreviewCard('home-demo-group-7', 'Simba', 'Carlos Eduardo Nogueira', 'no_grupo', 2, [{ name: 'Parasitológico de fezes' }], previewVets[1]),
      noGroupDate,
    ],
    exame_pronto: [
      makePreviewCard('home-demo-ready-1', 'Mia', 'Clara Cristina Souza', 'exame_pronto', 4, [{ name: 'Ultrassonografia abdominal', ready: true }], previewVets[2]),
      makePreviewCard('home-demo-ready-2', 'Bob', 'Luís Fernando Albuquerque', 'exame_pronto', 7, [{ name: 'Hemograma completo', ready: true }, { name: 'Urocultura', ready: false }], previewVets[1]),
      makePreviewCard('home-demo-ready-3', 'Lola', 'Beatriz Carvalho Mendes', 'exame_pronto', 2, [{ name: 'Radiografia de pelve', ready: true }]),
    ],
    aguardando_lab: [
      makePreviewCard('home-demo-lab-1', 'Maya', 'Fernanda Cristina Lopes', 'aguardando_lab', 18, [{ name: 'Hemograma completo' }, { name: 'Perfil renal' }], previewVets[1]),
      makePreviewCard('home-demo-lab-2', 'Toby', 'Marcelo Vinícius Silva', 'aguardando_lab', 11, [{ name: 'Urinálise' }], previewVets[2]),
      makePreviewCard('home-demo-lab-3', 'Cacau', 'Renata Aparecida Santos', 'aguardando_lab', 3, [{ name: 'Citologia de pele' }]),
    ],
  }
}

const previewStats: ExamCardSummary = {
  total_no_grupo: 8,
  total_exame_pronto: 3,
  total_aguardando_lab: 3,
  total_atrasado: 2,
  total_contato_realizado: 26,
  total_orphans: 0,
  avg_contact_hours: 4.6,
}

/** Isolated DEV controller. Fixtures never import authentication, operational hooks or network clients. */
export function HomePreview() {
  const [cards] = useState(makePreviewQueues)
  const [openedCard, setOpenedCard] = useState<ExamCard | null>(null)
  const [notice, setNotice] = useState('')
  const openerRef = useRef<HTMLButtonElement | null>(null)
  const queues = Object.fromEntries(
    (Object.keys(cards) as HomeStage[]).map(stage => [stage, { cards: cards[stage], loading: false, error: null, refreshing: false }]),
  ) as Record<HomeStage, { cards: ExamCard[]; loading: boolean; error: unknown; refreshing: boolean }>

  const openCard = (card: ExamCard, opener: HTMLButtonElement) => {
    openerRef.current = opener
    setOpenedCard(card)
  }

  return <>
    <DashboardView stats={previewStats} summaryLoading={false} summaryError={null} queues={queues} refreshing={false}
      onRefresh={() => setNotice('Prévia atualizada. Nenhuma alteração real.')} onOpenCard={openCard} />
    <p className="sr-only" role="status">{notice}</p>
    <Dialog.Root open={Boolean(openedCard)} onOpenChange={open => { if (!open) setOpenedCard(null) }}>
      <Dialog.Portal>
        <Dialog.Overlay className="tracking-dialog-overlay" />
        <Dialog.Content className="tracking-filter-sheet" onCloseAutoFocus={event => {
          event.preventDefault()
          if (openerRef.current?.isConnected) openerRef.current.focus()
        }}>
          <header className="tracking-sheet-heading">
            <Dialog.Title>{openedCard?.pet_name || 'Paciente'}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="tracking-icon-button" aria-label="Fechar exame"><X size={20} aria-hidden="true" /></button>
            </Dialog.Close>
          </header>
          <div className="tracking-sheet-body">
            <p>{openedCard?.client_name || 'Tutor não informado'}</p>
            <ul>{openedCard?.items.map(item => <li key={item.id}>{item.exam_type}</li>)}</ul>
            <Dialog.Description>Prévia: nenhuma alteração real.</Dialog.Description>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>
}
