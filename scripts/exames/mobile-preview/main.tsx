import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import { ExamDocumentContent } from '../../../src/pages/ExamDocumentDetail'
import { refreshDocument, useFixtureDocument } from './store'
import '../../../src/index.css'

export function Preview() {
  const document = useFixtureDocument()
  return <BrowserRouter><ExamDocumentContent doc={document} refresh={refreshDocument} /><Toaster richColors position="top-center" /></BrowserRouter>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><Preview /></React.StrictMode>)
