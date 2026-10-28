import { lazy, Suspense, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AnimatePresence, MotionConfig } from 'framer-motion'
import { Shell } from '@/components/layout/Shell'
import { RouteBoundary } from '@/components/layout/RouteBoundary'
const Dashboard = lazy(() => import('@/pages/Dashboard').then(module => ({ default: module.Dashboard })))
const IntakeReceipts = lazy(() => import('@/pages/IntakeReceipts').then(module => ({ default: module.IntakeReceipts })))
const Tracking = lazy(() => import('@/pages/Tracking').then(module => ({ default: module.Tracking })))
const Settings = lazy(() => import('@/pages/Settings').then(module => ({ default: module.Settings })))
const ShipSamples = lazy(() => import('@/pages/ShipSamples').then(module => ({ default: module.ShipSamples })))
const LateExams = lazy(() => import('@/pages/LateExams').then(module => ({ default: module.LateExams })))
const ShipmentHistory = lazy(() => import('@/pages/ShipmentHistory').then(module => ({ default: module.ShipmentHistory })))
const NewExams = lazy(() => import('@/pages/NewExams').then(module => ({ default: module.NewExams })))
const ExamDocumentDetail = lazy(() => import('@/pages/ExamDocumentDetail').then(module => ({ default: module.ExamDocumentDetail })))
import { ExamShortLink } from '@/pages/ExamShortLink'
import { SignIn } from '@/pages/SignIn'
import { ExamAuthProvider } from '@/contexts/ExamAuthProvider'
import { RequireExamAccess } from '@/components/documents/RequireExamAccess'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 2 },
  },
})

function Page({ children }: { children: ReactNode }) {
  return <RouteBoundary><Suspense fallback={<div role="status" className="py-16 text-center text-sm text-[hsl(var(--muted-foreground))]">Carregando…</div>}>{children}</Suspense></RouteBoundary>
}

function AnimatedRoutes() {
  const location = useLocation()
  return (
    <AnimatePresence mode="wait">
      <Routes location={location} key={location.pathname}>
        <Route path="/entrar" element={<SignIn />} />
        <Route element={<RequireExamAccess><Shell /></RequireExamAccess>}>
          <Route path="/e/:shortId" element={<ExamShortLink />} />
          <Route path="/novos-exames" element={<Page><NewExams /></Page>} />
          <Route path="/novos-exames/:documentId" element={<Page><ExamDocumentDetail /></Page>} />
          <Route path="/" element={<Page><Dashboard /></Page>} />
          <Route path="/recebimentos" element={<Page><IntakeReceipts /></Page>} />
          <Route path="/tracking" element={<Page><Tracking /></Page>} />
          <Route path="/ship" element={<Page><ShipSamples /></Page>} />
          <Route path="/shipments" element={<Page><ShipmentHistory /></Page>} />
          <Route path="/late" element={<Page><LateExams /></Page>} />
          <Route path="/settings" element={<Page><Settings /></Page>} />
        </Route>
      </Routes>
    </AnimatePresence>
  )
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user"><ExamAuthProvider><BrowserRouter>
        <AnimatedRoutes />
      </BrowserRouter></ExamAuthProvider></MotionConfig>
    </QueryClientProvider>
  )
}

export default App
