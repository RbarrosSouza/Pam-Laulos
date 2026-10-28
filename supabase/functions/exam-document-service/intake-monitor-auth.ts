type Env = (name: string) => string | undefined;
type Equal = (left: string, right: string) => boolean;
type Json = Record<string, unknown>;
const monitorActions = new Set(['intake_health', 'intake_status', 'intake_alert_reserve', 'intake_alert_begin', 'intake_alert_result']);
function refuse(code: string, status: number): never {
  throw Object.assign(new Error(code), { status });
}

export function authenticateExamIntakeMonitor(authorization: string, get: Env, equal: Equal): boolean {
  const secret = get('EXAM_INTAKE_MONITOR_API_KEY');
  if (!secret) return false;
  if (!/^[a-f0-9]{64}$/i.test(secret)) return false;
  const ingestion = get('EXAM_INGESTION_API_KEY');
  if (ingestion && equal(secret, ingestion)) return false;
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1]
    || (/^[a-f0-9]{64}$/i.test(authorization) ? authorization : '');
  return Boolean(token && equal(token, secret));
}

export function authorizeExamIntakeMonitorAction(isMonitor: boolean, action: string, multipart: boolean): void {
  if (isMonitor && (multipart || !monitorActions.has(action))) refuse('INTAKE_MONITOR_ACTION_FORBIDDEN', 403);
}

export function filterExamIntakeMonitorResult(action: string, result: unknown, isMonitor: boolean): unknown {
  if (action === 'intake_status') {
    if (!result || typeof result !== 'object' || Array.isArray(result)) refuse('INTAKE_MONITOR_STATUS_INVALID', 503);
    const status: Json = { ...(result as Json) };
    delete status.authorization_scope;
    if (isMonitor) status.authorization_scope = 'intake_monitor';
    return status;
  }
  if (isMonitor && action === 'intake_alert_reserve') {
    const value = result as Json;
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.claimed !== 'boolean') refuse('INTAKE_MONITOR_RESERVATION_INVALID', 503);
    if (!value.claimed) return { claimed: false, ...(value.paused === true ? { paused: true } : {}) };
    const alert = value.alert as Json, incident = value.incident as Json;
    if (!alert || !incident) refuse('INTAKE_MONITOR_RESERVATION_INVALID', 503);
    return { claimed: true, alert: { id: alert.id, lease_token: alert.lease_token, destination_key: alert.destination_key }, incident: { stage: incident.stage, code: incident.code } };
  }
  return result;
}
