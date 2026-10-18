import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const repository = path.resolve(root, '../../..')

export default defineConfig({
  root,
  envDir: root,
  envPrefix: 'QA_PREVIEW_UNUSED_',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: '@/contexts/exam-auth', replacement: path.join(root, 'mock-auth.ts') },
      { find: '@/hooks/useExamDocuments', replacement: path.join(root, 'mock-documents.ts') },
      { find: '@/lib/supabase', replacement: path.join(root, 'blocked-backend.ts') },
      { find: '@', replacement: path.join(repository, 'src') },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 4182,
    strictPort: true,
    fs: { allow: [repository] },
    headers: {
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:4182; frame-src blob:; object-src 'none'",
    },
  },
})
