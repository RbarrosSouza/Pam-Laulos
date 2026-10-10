import { createContext, useContext } from 'react'
import type { Session } from '@supabase/supabase-js'

export interface ExamAuthState {
  session: Session | null
  loading: boolean
  membership: boolean
  role: 'admin' | 'vet' | 'reception' | null
  membershipError: string | null
  refreshMembership: () => Promise<void>
}
export const ExamAuthContext = createContext<ExamAuthState | null>(null)
export function useExamAuth() {
  const value = useContext(ExamAuthContext)
  if (!value) throw new Error('ExamAuthProvider não disponível')
  return value
}
