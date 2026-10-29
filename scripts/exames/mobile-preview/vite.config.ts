import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const repository = path.resolve(root, '../../..')
const previewPort = Number(process.env.QA_PREVIEW_PORT || 4182)

export default defineConfig({
  root,
  envDir: root,
  envPrefix: 'QA_PREVIEW_UNUSED_',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: '@/components/documents/DocumentVersionReview', replacement: path.join(root, 'mock-version-review.tsx') },
      { find: '@/contexts/exam-auth', replacement: path.join(root, 'mock-auth.ts') },
      { find: '@/hooks/useExamDocuments', replacement: path.join(root, 'mock-documents.ts') },
      { find: '@/hooks/useVets', replacement: path.join(root, 'mock-vets.ts') },
      { find: '@/lib/supabase', replacement: path.join(root, 'blocked-backend.ts') },
      { find: '@', replacement: path.join(repository, 'src') },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: previewPort,
    strictPort: true,
    fs: { allow: [repository] },
    headers: {
      'Content-Security-Policy': `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:${previewPort}; frame-src blob:; object-src 'none'`,
    },
  },
})
