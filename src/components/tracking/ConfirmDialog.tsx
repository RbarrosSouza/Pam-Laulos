import { AlertTriangle, X } from 'lucide-react'
import { motion } from 'framer-motion'
import { dialogVariants, overlayVariants } from '@/lib/animations'
import { cn } from '@/lib/utils'

interface ConfirmDialogProps {
  title: string
  description: string
  confirmLabel?: string
  loading?: boolean
  onConfirm: () => void
  onClose: () => void
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel = 'Excluir',
  loading = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  return (
    <motion.div
      variants={overlayVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <motion.div
        variants={dialogVariants}
        className="bg-[hsl(var(--card))] rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-0 flex items-start justify-between gap-3">
          <div className="w-10 h-10 rounded-xl bg-red-100 dark:bg-red-900/30 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5 text-red-500" />
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))] transition-all shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          <h3 className="text-base font-semibold text-[hsl(var(--foreground))] mb-1">{title}</h3>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">{description}</p>
        </div>

        {/* Footer */}
        <div className="px-5 pb-5 flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="h-9 px-4 rounded-lg text-sm font-medium text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))] transition-all"
          >
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={cn(
              'h-9 px-4 rounded-lg text-sm font-semibold',
              'bg-red-500 text-white hover:bg-red-600',
              'transition-all disabled:opacity-50 disabled:cursor-not-allowed'
            )}
          >
            {loading ? 'Excluindo…' : confirmLabel}
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}
