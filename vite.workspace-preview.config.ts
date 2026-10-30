import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// Explicitly local and synthetic. This config cannot produce a deployable build.
export default defineConfig(({ command }) => {
  if (command !== 'serve') throw new Error('A prévia da ficha funciona somente em desenvolvimento local.')
  const root = import.meta.dirname
  const mock = path.join(root, 'dev/exam-workspace-mocks.ts')
  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: [
      ...['@/hooks/useExamDocuments', '@/hooks/useVets', '@/contexts/exam-auth', '@/lib/supabase'].map(find => ({ find, replacement: mock })),
      { find: '@', replacement: path.join(root, 'src') },
    ] },
    server: { host: '127.0.0.1', port: 4390, strictPort: true },
  }
})
