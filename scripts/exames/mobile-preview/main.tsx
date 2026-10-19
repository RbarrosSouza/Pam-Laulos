import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AppToaster } from '../../../src/components/AppToaster'
import { ExamDocumentContent } from '../../../src/pages/ExamDocumentDetail'
import { refreshDocument, useFixtureDocument } from './store'
import './preview.css'

export function Preview() {
  const document = useFixtureDocument()
  return <BrowserRouter><ExamDocumentContent doc={document} refresh={refreshDocument} /><AppToaster /></BrowserRouter>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><Preview /></React.StrictMode>)
