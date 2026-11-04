const encoder = new TextEncoder();
function equal(a: string, b: string): boolean {
  const left = encoder.encode(a), right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

/** Authenticates bytes only. HMAC callers must also consume their issued nonce in
 * consume_exam_fallback_scheduler_trigger before running; this check alone is
 * deliberately not described as replay protection. Never log headers or key. */
export async function authenticateFallbackRequest(
  request: Request, key: string | undefined, bodyText: string, nowMs = Date.now(),
): Promise<boolean> {
  if (request.method !== 'POST' || !key || encoder.encode(key).length < 32 || key.length > 1024 ||
    /[\r\n]/.test(key) || encoder.encode(bodyText).length > 1024 || !Number.isFinite(nowMs)) return false;
  const authorization = request.headers.get('Authorization');
  if (authorization !== null) return equal(authorization, 'Bearer ' + key);
  const timestamp = request.headers.get('x-exam-fallback-timestamp') || '';
  const nonce = request.headers.get('x-exam-fallback-nonce') || '';
  const signature = request.headers.get('x-exam-fallback-signature') || '';
  if (!/^[1-9][0-9]{9}$/.test(timestamp) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(nonce) ||
    !/^[a-f0-9]{64}$/.test(signature)) return false;
  const age = nowMs - Number(timestamp) * 1000;
  if (age < -5000 || age > 120000) return false;
  try {
    const body: unknown = JSON.parse(bodyText);
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).length !== 1 || (body as {action?: unknown}).action !== 'run') return false;
    const signingKey = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const signatureBytes = Uint8Array.from(signature.match(/../g)!, byte => parseInt(byte, 16));
    return await crypto.subtle.verify('HMAC', signingKey, signatureBytes, encoder.encode(`${timestamp}\n${nonce}\n${bodyText}`));
  } catch { return false; }
}
