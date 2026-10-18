import { scenario, USER_ID } from './store'

const auth = {
  role: scenario === 'reception' ? 'reception' : 'vet',
  membership: { user_id: USER_ID, active: true },
  session: {
    user: {
      id: USER_ID,
      email: 'isabela@example.invalid',
      user_metadata: { full_name: 'Dra. Isabela Martins' },
    },
  },
}

export function useExamAuth() { return auth }
