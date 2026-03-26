import { AlertTriangle, ChevronRight } from 'lucide-react'
import { useExamCardStats } from '@/hooks/useExamCardStats'
import { Link } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'

export function AlertBanner() {
  const { data: stats } = useExamCardStats()

  const count = stats?.total_atrasado ?? 0

  return (
    <AnimatePresence>
      {count > 0 && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.25 }}
        >
          <Link
            to="/tracking"
            className="flex items-center gap-3 bg-red-600 text-white px-4 sm:px-6 py-2.5 hover:bg-red-700 transition-colors group"
          >
            <AlertTriangle className="w-4 h-4 shrink-0 animate-pulse" />
            <span className="text-sm font-semibold">
              {count} card{count > 1 ? 's' : ''} atrasado{count > 1 ? 's' : ''} — exames prontos sem contato com o tutor
            </span>
            <ChevronRight className="w-4 h-4 ml-auto opacity-70 group-hover:translate-x-0.5 transition-transform" />
          </Link>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
