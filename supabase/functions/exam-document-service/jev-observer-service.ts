type Json = Record<string, unknown>;
type Rpc = (name: string, args: Json) => Promise<unknown>;
export const jevObserverActions = new Set(['jev_observe_reserve', 'jev_observe_begin', 'jev_observe_result']);
export async function runJevObserverAction(action: string, payload: Json, rpc: Rpc, uuid: (value: unknown) => string) {
  const invalid = (): never => { throw Object.assign(new Error('JEV_OBSERVER_REQUEST_INVALID'), { status: 400 }); };
  if (action === 'jev_observe_reserve') {
    if (typeof payload.worker !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(payload.worker)) invalid();
    return rpc('reserve_exam_jev_observation', { p_worker: payload.worker });
  }
  if (!jevObserverActions.has(action)) invalid();
  const args: Json = { p_observation_id: uuid(payload.observation_id), p_lease_token: uuid(payload.lease_token) };
  if (action === 'jev_observe_begin') return rpc('begin_exam_jev_observation', args);
  if (!payload.outcome || typeof payload.outcome !== 'object' || Array.isArray(payload.outcome)) invalid();
  const source = payload.outcome as Json;
  // Never store provider bodies, request text, patient fields or credentials.
  args.p_outcome = Object.fromEntries(['status', 'route', 'confidence', 'cost_usd', 'duration_ms', 'model', 'error_code']
    .filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]));
  return rpc('complete_exam_jev_observation', args);
}
