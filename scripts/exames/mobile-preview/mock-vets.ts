export const fixtureVets = [
  { id: 'bbbb1111-2222-4333-8444-555555555551', nome: 'Dra. Isabela Martins', avatar_url: null },
  { id: 'bbbb1111-2222-4333-8444-555555555552', nome: 'Dra. Camila Souza', avatar_url: null },
  { id: 'bbbb1111-2222-4333-8444-555555555553', nome: 'Dra. Patrícia Lima', avatar_url: null },
]

export function useVets() {
  return { data: fixtureVets, isLoading: false, error: null, refetch: async () => ({ data: fixtureVets }) }
}
