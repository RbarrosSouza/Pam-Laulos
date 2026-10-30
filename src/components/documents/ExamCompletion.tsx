import { useEffect, useRef, useState, type CSSProperties } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Check, FileText, Link2, Loader2, Mail, Phone, X } from 'lucide-react'
import { WhatsappLogo } from '@phosphor-icons/react/dist/csr/WhatsappLogo'
import { getExamDetailProgress } from '@/lib/exam-detail-progress'
import type { ExamDocument } from '@/types/exam-document'

/** Animation is a receipt of persisted state; it never marks a delivery complete. */
export function ExamCompletion({ document: doc, onClose }: { document: ExamDocument | null; onClose: () => void }) {
  const [elapsed, setElapsed] = useState(0)
  const closeRef = useRef(onClose)
  const returnFocus = useRef<HTMLElement | null>(null)
  useEffect(() => { closeRef.current = onClose }, [onClose])
  useEffect(() => {
    if (!doc) return
    const started = Date.now()
    const tick = window.setInterval(() => setElapsed(Date.now() - started), 80)
    const close = window.setTimeout(() => closeRef.current(), 5520)
    return () => { window.clearInterval(tick); window.clearTimeout(close) }
  }, [doc])
  const progress = doc ? getExamDetailProgress(doc) : null
  const stages = [
    { label: progress?.originChannel === 'email' ? 'E-mail' : progress?.originChannel === 'whatsapp' ? 'WhatsApp' : 'Origem', icon: progress?.originChannel === 'email' ? Mail : progress?.originChannel === 'whatsapp' ? WhatsappLogo : FileText, done: !!progress?.originReceived },
    { label: 'Grupo', icon: WhatsappLogo, done: !!progress?.groupSent },
    { label: 'Cadastro', icon: Link2, done: !!progress?.nexusLinked },
    { label: 'Contato', icon: Phone, done: !!progress?.contactCompleted },
  ]
  const finished = !!doc && elapsed >= 3360
  const complete = finished && doc.completed && stages.every(stage => stage.done)
  const step = Math.min(3, Math.floor(elapsed / 800))
  const Icon = finished ? Check : doc ? stages[step].icon : Loader2
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}><Dialog.Portal>
    <Dialog.Overlay className={`finish-overlay${elapsed >= 5200 ? ' closing' : ''}`} />
    <Dialog.Content className={`finish-dialog${complete ? ' complete' : ''}${elapsed >= 5200 ? ' closing' : ''}`} onOpenAutoFocus={() => { returnFocus.current = document.activeElement as HTMLElement }} onCloseAutoFocus={event => { if (returnFocus.current?.isConnected) { event.preventDefault(); returnFocus.current.focus({ preventScroll: true }) } }}>
      <div className="finish-content"><Dialog.Close className="finish-close" aria-label="Fechar animação"><X size={18} /></Dialog.Close>
        <div className={`finish-orbit${finished ? ' settled' : ''}`} aria-hidden="true"><Icon key={finished ? 'done' : step} /></div>
        <div role="status" aria-live="polite" aria-atomic="true"><Dialog.Title>{!doc ? 'Salvando contato' : finished ? complete ? 'Card completo' : 'Contato registrado' : 'Conferindo etapas'}</Dialog.Title><Dialog.Description className="finish-caption">{!doc ? 'Aguarde a confirmação.' : finished ? complete ? 'Tudo certo por aqui.' : 'As etapas pendentes continuam na ficha.' : `${stages[step].label}${elapsed >= 680 + step * 800 ? stages[step].done ? ' · OK' : ' · Pendente' : ''}`}</Dialog.Description></div>
        <div className="finish-steps" aria-label="Etapas do card">{stages.map(({ label, icon: StageIcon, done }, index) => <div key={label} className={`finish-step${doc && elapsed >= 680 + index * 800 ? done ? ' done' : ' pending' : doc && step === index ? ' active' : ''}`}><span className="finish-step-icon" aria-hidden="true"><StageIcon aria-hidden="true" /></span><span>{label}</span><span className="sr-only">{doc && elapsed >= 680 + index * 800 ? done ? ': concluído' : ': pendente' : ': aguardando'}</span></div>)}</div>
        {complete && <div className="burst" aria-hidden="true">{Array.from({ length: 46 }, (_, n) => <i key={n} style={{ '--x': `${Math.cos(n / 46 * Math.PI * 2) * (100 + n % 5 * 22)}px`, '--y': `${Math.sin(n / 46 * Math.PI * 2) * (100 + n % 5 * 22) + 55}px`, '--r': `${(n % 2 ? -1 : 1) * (150 + n * 17)}deg`, '--color': ['#57884a', '#a7bd6d', '#d5b760', '#74ac8c', '#c0d3a1'][n % 5], '--delay': `${n % 4 * 20}ms` } as CSSProperties} />)}</div>}
      </div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}

/** Acknowledges the identity write; attachment continues independently. */
export function ExamRegistrationCompletion({ document: doc, onClose }: { document: ExamDocument | null; onClose: () => void }) {
  const [settled, setSettled] = useState(false)
  const [closing, setClosing] = useState(false)
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])
  useEffect(() => {
    if (!doc) return
    const done = window.setTimeout(() => setSettled(true), 650)
    const fade = window.setTimeout(() => setClosing(true), 2100)
    const close = window.setTimeout(() => closeRef.current(), 2420)
    return () => { window.clearTimeout(done); window.clearTimeout(fade); window.clearTimeout(close) }
  }, [doc])
  const attached = !!doc && getExamDetailProgress(doc).nexusLinked
  return <Dialog.Root open onOpenChange={open => { if (!open && doc) onClose() }}><Dialog.Portal>
    <Dialog.Overlay className={`finish-overlay${closing ? ' closing' : ''}`}/>
    <Dialog.Content className={`finish-dialog${closing ? ' closing' : ''}`} onEscapeKeyDown={event => { if (!doc) event.preventDefault() }} onPointerDownOutside={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}>
      <div className="finish-content">
        {doc && <Dialog.Close className="finish-close" aria-label="Fechar animação"><X size={18}/></Dialog.Close>}
        <div className={`finish-orbit${settled ? ' settled' : ''}`} aria-hidden="true">{settled ? <Check/> : <Link2/>}</div>
        <div role="status" aria-live="polite" aria-atomic="true"><Dialog.Title>{!doc ? 'Salvando cadastro' : settled ? doc.pet_id ? 'Cadastro conciliado' : 'Identificação salva' : 'Conferindo cadastro'}</Dialog.Title><Dialog.Description className="finish-caption">{!doc ? 'Aguarde a confirmação.' : !doc.pet_id ? 'Dados do exame salvos.' : attached ? 'Exame anexado ao cadastro.' : 'Anexação ao cadastro em andamento.'}</Dialog.Description></div>
      </div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}
