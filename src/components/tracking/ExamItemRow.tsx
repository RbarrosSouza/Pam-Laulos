import { useState } from 'react'
import { Phone, CheckCircle2, FlaskConical, Pencil, Trash2, Check, X, Package } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useUpdateItem, useDeleteItem } from '@/hooks/useExamCardMutations'
import type { ExamItem } from '@/types/exam-card'

interface ExamItemRowProps {
  item: ExamItem
  cardId?: string
  onContactClick?: (item: ExamItem) => void
  compact?: boolean
}

export function ExamItemRow({ item, cardId, onContactClick, compact = false }: ExamItemRowProps) {
  const [editing, setEditing] = useState(false)
  const [examType, setExamType] = useState(item.exam_type)
  const [labName, setLabName] = useState(item.lab_name ?? '')
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const updateItem = useUpdateItem()
  const deleteItem = useDeleteItem()

  const isContacted = item.contacted
  const isReady = item.result_received
  const isWaiting = !item.result_received

  async function handleSaveEdit() {
    try {
      await updateItem.mutateAsync({
        id: item.id,
        exam_type: examType.trim() || item.exam_type,
        lab_name: labName.trim() || null,
      })
      toast.success('Exame atualizado')
      setEditing(false)
    } catch {
      toast.error('Erro ao atualizar exame')
    }
  }

  async function handleDelete() {
    try {
      await deleteItem.mutateAsync(item.id)
      toast.success('Exame removido')
    } catch {
      toast.error('Erro ao remover exame')
    }
  }

  // Inline edit mode
  if (editing) {
    return (
      <div className="flex items-center gap-2 py-1">
        <input
          autoFocus
          type="text"
          value={examType}
          onChange={(e) => setExamType(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSaveEdit()}
          className={cn(
            'flex-1 h-7 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))]',
            'px-2 text-xs text-[hsl(var(--foreground))] focus:outline-none',
            'focus:ring-1 focus:ring-[hsl(var(--primary))]/50',
            'placeholder:text-[hsl(var(--muted-foreground))]/40'
          )}
        />
        <input
          type="text"
          placeholder="Lab"
          value={labName}
          onChange={(e) => setLabName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSaveEdit()}
          className={cn(
            'w-20 h-7 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))]',
            'px-2 text-xs text-[hsl(var(--foreground))] focus:outline-none',
            'focus:ring-1 focus:ring-[hsl(var(--primary))]/50',
            'placeholder:text-[hsl(var(--muted-foreground))]/40'
          )}
        />
        <button
          onClick={handleSaveEdit}
          disabled={updateItem.isPending}
          className="w-6 h-6 flex items-center justify-center rounded text-green-600 hover:bg-green-50 dark:hover:bg-green-950/30 transition-all disabled:opacity-40"
        >
          <Check className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => { setEditing(false); setExamType(item.exam_type); setLabName(item.lab_name ?? '') }}
          className="w-6 h-6 flex items-center justify-center rounded text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))] transition-all"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    )
  }

  // Delete confirm mode
  if (showDeleteConfirm) {
    return (
      <div className="flex items-center gap-2 py-1">
        <span className="flex-1 text-xs text-[hsl(var(--muted-foreground))]">
          Remover <strong className="text-[hsl(var(--foreground))]">{item.exam_type}</strong>?
        </span>
        <button
          onClick={handleDelete}
          disabled={deleteItem.isPending}
          className="h-6 px-2.5 rounded text-xs font-semibold bg-red-500 text-white hover:bg-red-600 disabled:opacity-40 transition-all"
        >
          Sim
        </button>
        <button
          onClick={() => setShowDeleteConfirm(false)}
          className="h-6 px-2 rounded text-xs text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))] transition-all"
        >
          Não
        </button>
      </div>
    )
  }

  return (
    <div className={cn('flex items-center gap-2 group', compact ? 'py-0.5' : 'py-1')}>
      {/* Checkbox visual */}
      <div className="shrink-0">
        {isReady ? (
          <span className="w-4 h-4 rounded border-2 border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10 flex items-center justify-center">
            <span className="w-2 h-2 rounded-sm bg-[hsl(var(--primary))]" />
          </span>
        ) : (
          <span className="w-4 h-4 rounded border-2 border-[hsl(var(--border))] bg-transparent block" />
        )}
      </div>

      {/* Exam name */}
      <span
        className={cn(
          'flex-1 text-xs truncate',
          isWaiting
            ? 'text-[hsl(var(--muted-foreground))]'
            : 'text-[hsl(var(--foreground))]'
        )}
      >
        {item.exam_type}
      </span>

      {/* Edit/Delete actions — only in detail (non-compact) with cardId */}
      {!compact && cardId && (
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={(e) => { e.stopPropagation(); setEditing(true) }}
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-[hsl(var(--muted))] transition-all"
            title="Editar exame"
          >
            <Pencil className="w-3 h-3 text-[hsl(var(--muted-foreground))]" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(true) }}
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-red-50 dark:hover:bg-red-950/30 transition-all"
            title="Remover exame"
          >
            <Trash2 className="w-3 h-3 text-[hsl(var(--muted-foreground))] hover:text-red-500" />
          </button>
        </div>
      )}

      {/* Shipped icon */}
      {item.sent_to_lab_at && (
        <span title={`Enviado por ${item.sent_to_lab_by || '—'}`}>
          <Package className="w-3.5 h-3.5 text-[hsl(var(--primary))] shrink-0" />
        </span>
      )}

      {/* Action icon (contact / ready / waiting) */}
      {isContacted ? (
        <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />
      ) : isReady ? (
        onContactClick ? (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onContactClick(item)
            }}
            className="w-5 h-5 flex items-center justify-center rounded-full hover:bg-[hsl(var(--accent))] transition-colors group/phone shrink-0"
            aria-label="Registrar contato"
          >
            <Phone className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))] group-hover/phone:text-[hsl(var(--primary))] transition-colors" />
          </button>
        ) : (
          <Phone className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))] shrink-0" />
        )
      ) : (
        <FlaskConical className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))] shrink-0" />
      )}

      {/* Lab chip — only in non-compact mode */}
      {!compact && item.lab_name && (
        <span className="text-[10px] text-[hsl(var(--muted-foreground))] hidden sm:block truncate max-w-[72px]">
          {item.lab_name}
        </span>
      )}
    </div>
  )
}
