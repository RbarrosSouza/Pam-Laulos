import { useState, useRef } from 'react'
import { motion } from 'framer-motion'
import { Camera, Sun, Moon, Stethoscope, Check, Loader2 } from 'lucide-react'
import { useVets, type Vet } from '@/hooks/useVets'
import { useTheme } from '@/hooks/useTheme'
import { useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { fadeUp } from '@/lib/animations'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

export function Settings() {
  const { isDark, toggle } = useTheme()
  const { data: vets, isLoading } = useVets()

  return (
    <motion.div
      variants={fadeUp}
      initial="initial"
      animate="animate"
      exit="exit"
      className="space-y-6 max-w-xl mx-auto"
    >
      <h1 className="text-lg md:text-2xl font-bold text-[hsl(var(--foreground))] tracking-tight">
        Configurações
      </h1>

      {/* Theme toggle */}
      <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4">
        <button
          onClick={toggle}
          className="w-full flex items-center justify-between"
        >
          <div className="flex items-center gap-3">
            {isDark ? <Moon className="w-5 h-5 text-[hsl(var(--muted-foreground))]" /> : <Sun className="w-5 h-5 text-amber-500" />}
            <span className="text-sm font-medium text-[hsl(var(--foreground))]">
              {isDark ? 'Modo escuro' : 'Modo claro'}
            </span>
          </div>
          <div className={cn(
            'w-10 h-6 rounded-full transition-colors flex items-center px-0.5',
            isDark ? 'bg-[hsl(var(--primary))]' : 'bg-[hsl(var(--border))]'
          )}>
            <div className={cn(
              'w-5 h-5 rounded-full bg-white shadow-sm transition-transform',
              isDark ? 'translate-x-4' : 'translate-x-0'
            )} />
          </div>
        </button>
      </div>

      {/* Veterinários */}
      <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] overflow-hidden">
        <div className="px-4 py-3 border-b border-[hsl(var(--border))] bg-[hsl(var(--muted))]/30">
          <h2 className="text-sm font-semibold text-[hsl(var(--foreground))] flex items-center gap-2">
            <Stethoscope className="w-4 h-4" />
            Veterinários
          </h2>
        </div>

        {isLoading && (
          <div className="p-8 flex justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-[hsl(var(--muted-foreground))]" />
          </div>
        )}

        {vets?.map((vet) => (
          <VetRow key={vet.id} vet={vet} />
        ))}

        {!isLoading && vets?.length === 0 && (
          <div className="p-8 text-center text-sm text-[hsl(var(--muted-foreground))]">
            Nenhum veterinário cadastrado
          </div>
        )}
      </div>
    </motion.div>
  )
}

function VetRow({ vet }: { vet: Vet }) {
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setUploading(true)
    try {
      // Resize image client-side
      const resized = await resizeImage(file, 200)

      // Upload to Supabase Storage
      const path = `${vet.id}.jpg`
      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(path, resized, { upsert: true, contentType: 'image/jpeg' })

      if (uploadError) throw uploadError

      // Get public URL
      const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(path)
      const avatarUrl = urlData.publicUrl + '?t=' + Date.now()

      // Update vet record
      const { error: updateError } = await supabase
        .from('veterinarios')
        .update({ avatar_url: avatarUrl })
        .eq('id', vet.id)

      if (updateError) throw updateError

      // Invalidate caches
      queryClient.invalidateQueries({ queryKey: ['vets'] })
      queryClient.invalidateQueries({ queryKey: ['exam-cards'] })

      toast.success('Foto atualizada')
    } catch (err: any) {
      toast.error('Erro ao enviar foto: ' + (err.message || 'Tente novamente'))
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-[hsl(var(--border))]/50 last:border-0">
      {/* Avatar */}
      <button
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
        className="relative w-12 h-12 rounded-full shrink-0 overflow-hidden bg-[hsl(var(--muted))] flex items-center justify-center group cursor-pointer"
      >
        {vet.avatar_url ? (
          <img src={vet.avatar_url} alt={vet.nome} className="w-full h-full object-cover" />
        ) : (
          <Stethoscope className="w-5 h-5 text-[hsl(var(--muted-foreground))]" />
        )}
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          {uploading ? (
            <Loader2 className="w-4 h-4 text-white animate-spin" />
          ) : (
            <Camera className="w-4 h-4 text-white" />
          )}
        </div>
      </button>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleUpload}
      />

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-[hsl(var(--foreground))] truncate">{vet.nome}</p>
        <p className="text-xs text-[hsl(var(--muted-foreground))]">CRMV — acessar perfil</p>
      </div>

      {vet.avatar_url && (
        <Check className="w-4 h-4 text-green-500 shrink-0" />
      )}
    </div>
  )
}

async function resizeImage(file: File, maxSize: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      let w = img.width
      let h = img.height

      if (w > h) {
        if (w > maxSize) { h = (h * maxSize) / w; w = maxSize }
      } else {
        if (h > maxSize) { w = (w * maxSize) / h; h = maxSize }
      }

      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0, w, h)
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('Canvas toBlob failed')),
        'image/jpeg',
        0.85
      )
    }
    img.onerror = reject
    img.src = URL.createObjectURL(file)
  })
}
