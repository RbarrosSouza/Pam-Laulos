const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

// The UUID's 16 bytes, in their written order, encoded as unpadded base64url.
// Equivalent in n8n: Buffer.from(uuid.replaceAll('-', ''), 'hex').toString('base64url').
export function encodeExamDocumentId(documentId: string): string {
  if (typeof documentId !== 'string' || !uuidPattern.test(documentId)) throw new TypeError('UUID de exame inválido')
  const hex = documentId.replaceAll('-', '')
  const bytes = Array.from({ length: 16 }, (_, index) => parseInt(hex.slice(index * 2, index * 2 + 2), 16))
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export function decodeExamDocumentId(shortId: string | undefined): string | null {
  if (typeof shortId !== 'string' || !/^[A-Za-z0-9_-]{21}[AQgw]$/.test(shortId)) return null
  try {
    const bytes = atob(shortId.replaceAll('-', '+').replaceAll('_', '/') + '==')
    if (bytes.length !== 16) return null
    const hex = Array.from(bytes, character => character.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  } catch { return null }
}
