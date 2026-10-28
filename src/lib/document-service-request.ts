type SessionResult = { data: { session: { access_token: string } | null } }
type Dependencies = {
  getSession: () => Promise<SessionResult>
  fetch: typeof fetch
  url: string
  apiKey: string
  timeoutMs?: number
  authTimeoutMs?: number
}

export class DocumentServiceTimeoutError extends Error {
  readonly code: string
  constructor(auth: boolean) {
    super(auth
      ? 'Não foi possível confirmar sua sessão. Atualize a página e entre novamente se necessário.'
      : 'O serviço demorou a responder. A exclusão ainda precisa de confirmação.')
    this.code = auth ? 'DOCUMENT_AUTH_TIMEOUT' : 'DOCUMENT_SERVICE_TIMEOUT'
  }
}

// The deadline includes session acquisition and response-body reading. A session
// released after the deadline must never start a delayed destructive request.
export async function requestDocumentDeletion(action: 'delete' | 'delete_status', payload: Record<string, unknown>, deps: Dependencies) {
  const controller = new AbortController()
  let authPending = true
  const timeout = () => controller.abort(new DocumentServiceTimeoutError(authPending))
  let timer = setTimeout(timeout, deps.authTimeoutMs ?? 8000)
  let rejectAbort: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason)
    controller.signal.addEventListener('abort', rejectAbort, { once: true })
  })
  const request = async () => {
    const { data: { session } } = await deps.getSession()
    controller.signal.throwIfAborted()
    if (!session) throw new Error('Entre novamente para continuar.')
    authPending = false
    clearTimeout(timer)
    timer = setTimeout(timeout, deps.timeoutMs ?? (action === 'delete_status' ? 8000 : 30000))
    const response = await deps.fetch(deps.url, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${session.access_token}`, apikey: deps.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, payload }),
    })
    const result = await response.json().catch(() => null)
    controller.signal.throwIfAborted()
    if (!response.ok || !result || result.error || result.success === false) {
      throw new Error(result?.error || 'Não foi possível confirmar a exclusão. Confira a situação da ficha.')
    }
    return result as { state: string }
  }
  try {
    return await Promise.race([request(), aborted])
  } finally {
    clearTimeout(timer)
    controller.signal.removeEventListener('abort', rejectAbort)
  }
}
