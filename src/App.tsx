import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AnimatePresence } from 'framer-motion'
import { Shell } from '@/components/layout/Shell'
import { Dashboard } from '@/pages/Dashboard'
import { Tracking } from '@/pages/Tracking'
import { Settings } from '@/pages/Settings'
import { ShipSamples } from '@/pages/ShipSamples'
import { LateExams } from '@/pages/LateExams'
import { ShipmentHistory } from '@/pages/ShipmentHistory'
import { NewExams } from '@/pages/NewExams'
import { ExamDocumentDetail } from '@/pages/ExamDocumentDetail'
import { SignIn } from '@/pages/SignIn'
import { ExamAuthProvider } from '@/contexts/ExamAuthProvider'
import { RequireExamAccess } from '@/components/documents/RequireExamAccess'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 2 },
  },
})

function AnimatedRoutes() {
  const location = useLocation()
  return (
    <AnimatePresence mode="wait">
      <Routes location={location} key={location.pathname}>
        <Route path="/entrar" element={<SignIn />} />
        <Route element={<RequireExamAccess><Shell /></RequireExamAccess>}>
          <Route path="/novos-exames" element={<NewExams />} />
          <Route path="/novos-exames/:documentId" element={<ExamDocumentDetail />} />
          <Route path="/" element={<Dashboard />} />
          <Route path="/tracking" element={<Tracking />} />
          <Route path="/ship" element={<ShipSamples />} />
          <Route path="/shipments" element={<ShipmentHistory />} />
          <Route path="/late" element={<LateExams />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Routes>
    </AnimatePresence>
  )
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ExamAuthProvider><BrowserRouter>
        <AnimatedRoutes />
      </BrowserRouter></ExamAuthProvider>
    </QueryClientProvider>
  )
}

export default App
