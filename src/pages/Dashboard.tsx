import { useRef, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { CockpitDashboard } from '@/components/dashboard/CockpitDashboard'
import {HomeIntakeIssues} from '@/components/dashboard/HomeIntakeIssues'
import { TrackingDetail } from '@/components/tracking/TrackingDetail'
import { useRealtimeExams } from '@/hooks/useRealtimeExams'
import type { ExamCard } from '@/types/exam-card'

export function Dashboard() {
  const [selectedCard, setSelectedCard] = useState<ExamCard | null>(null)
  const opener = useRef<HTMLButtonElement | null>(null)
  useRealtimeExams()

  return (
    <>
      <CockpitDashboard
        beforeQueues={<HomeIntakeIssues/>}
        onOpenCard={(card, button) => {
          opener.current = button
          setSelectedCard(card)
        }}
      />
      <AnimatePresence>
        {selectedCard && (
          <TrackingDetail
            card={selectedCard}
            onClose={() => {
              setSelectedCard(null)
              if (opener.current?.isConnected) opener.current.focus({ preventScroll: true })
            }}
          />
        )}
      </AnimatePresence>
    </>
  )
}
