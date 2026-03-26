import { useState, useRef, useEffect } from 'react'
import { DayPicker } from 'react-day-picker'
import { ptBR } from 'date-fns/locale'
import { format } from 'date-fns'
import { Calendar, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import 'react-day-picker/style.css'

interface DateRangePickerProps {
  from: string
  to: string
  onChange: (from: string, to: string) => void
}

export function DateRangePicker({ from, to, onChange }: DateRangePickerProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const selected = {
    from: from ? new Date(from + 'T00:00:00') : undefined,
    to: to ? new Date(to + 'T00:00:00') : undefined,
  }

  const hasRange = from || to

  const label = hasRange
    ? `${from ? format(new Date(from + 'T00:00:00'), 'dd/MM') : '...'} — ${to ? format(new Date(to + 'T00:00:00'), 'dd/MM') : '...'}`
    : 'Período'

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border transition-all',
          'focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]/40',
          hasRange
            ? 'border-[hsl(var(--primary))] text-[hsl(var(--foreground))] bg-[hsl(var(--accent))]/30'
            : 'border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] bg-[hsl(var(--card))] hover:border-[hsl(var(--primary))]/60'
        )}
      >
        <Calendar className="w-3.5 h-3.5" />
        <span className="text-xs font-medium">{label}</span>
        {hasRange && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onChange('', '')
              setOpen(false)
            }}
            className="ml-0.5 hover:text-[hsl(var(--foreground))]"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </button>

      {open && (
        <div className="absolute top-full mt-1 left-0 z-50 bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-xl shadow-lg p-3">
          <DayPicker
            mode="range"
            locale={ptBR}
            selected={selected.from ? selected : undefined}
            onSelect={(range) => {
              const f = range?.from ? format(range.from, 'yyyy-MM-dd') : ''
              const t = range?.to ? format(range.to, 'yyyy-MM-dd') : ''
              onChange(f, t)
              if (range?.from && range?.to) {
                setTimeout(() => setOpen(false), 200)
              }
            }}
            classNames={{
              root: 'text-sm',
              day: 'rdp-day',
              selected: 'bg-[hsl(var(--primary))] text-white rounded-md',
              range_start: 'bg-[hsl(var(--primary))] text-white rounded-l-md',
              range_end: 'bg-[hsl(var(--primary))] text-white rounded-r-md',
              range_middle: 'bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))]',
              today: 'font-bold text-[hsl(var(--primary))]',
              chevron: 'fill-[hsl(var(--foreground))]',
            }}
          />
        </div>
      )}
    </div>
  )
}
