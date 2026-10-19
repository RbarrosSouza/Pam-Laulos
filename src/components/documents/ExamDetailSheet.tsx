import { useId, useRef, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ExamDetailSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: ReactNode
  wide?: boolean
  centered?: boolean
}

export function ExamDetailSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
  centered = false,
}: ExamDetailSheetProps) {
  const descriptionId = useId()
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const hasDescription = Boolean(description?.trim())

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="exam-detail-overlay" />
        <Dialog.Content
          className={cn('exam-detail-sheet', wide && 'exam-detail-sheet--wide', centered && 'exam-detail-sheet--centered')}
          aria-describedby={hasDescription ? descriptionId : undefined}
          onInteractOutside={(event) => {
            // Dismissing feedback is not a request to dismiss the editor behind
            // it. Sonner lives in its own portal outside this dialog.
            if (event.target instanceof Element && event.target.closest('[data-sonner-toaster]')) {
              event.preventDefault()
            }
          }}
          onOpenAutoFocus={() => {
            returnFocusRef.current = document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null
          }}
          onCloseAutoFocus={(event) => {
            // The opener lives outside Dialog.Trigger in this controlled sheet.
            const opener = returnFocusRef.current
            if (opener?.isConnected) {
              event.preventDefault()
              opener.focus({ preventScroll: true })
            }
          }}
        >
          <div className="exam-detail-sheet-handle" aria-hidden="true" />
          <header className="exam-detail-sheet-header">
            <div className="exam-detail-sheet-heading">
              <Dialog.Title className="exam-detail-sheet-title">{title}</Dialog.Title>
              {hasDescription && (
                <Dialog.Description id={descriptionId} className="exam-detail-sheet-description">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <button type="button" className="exam-detail-sheet-close" aria-label="Fechar">
                <X size={20} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </Dialog.Close>
          </header>
          <div className="exam-detail-sheet-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
