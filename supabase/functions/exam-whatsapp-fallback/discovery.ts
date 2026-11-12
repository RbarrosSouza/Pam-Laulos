import type { CollectedOrigin } from './collector.ts';

type Json = Record<string, unknown>;
export const DISCOVERY_BATCH_SIZE = 100;
// Leave room for PostgreSQL's jsonb whitespace within the server's 512 KiB cap.
export const DISCOVERY_BATCH_BYTES = 256 * 1024;
export function originKey(source: { channel: unknown; account_id: unknown; message_id: unknown; attachment_id: unknown }): string {
  return JSON.stringify([source.channel, source.account_id, source.message_id, source.attachment_id]);
}

/** Both overlapping scans stay active; a later observation supplies the freshest authorized media. */
export function mergeDiscoveredOrigins(...pages: CollectedOrigin[][]): Map<string, CollectedOrigin> {
  const origins = new Map<string, CollectedOrigin>();
  for (const page of pages) for (const origin of page) origins.set(originKey(origin.source), origin);
  return origins;
}

/** URLs stay in liveOrigins. The database receives the original bounded source metadata only. */
export async function persistDiscoveredOrigins(origins: Map<string, CollectedOrigin>, rpc: (name: string, args: Json) => Promise<Json>, signal: AbortSignal): Promise<{ acknowledged: number; enqueued: number; unchanged: number }> {
  const totals = { acknowledged: 0, enqueued: 0, unchanged: 0 };
  let batch: CollectedOrigin['source'][] = [];
  let bytes = 2;
  async function flush(): Promise<void> {
    if (!batch.length) return;
    if (signal.aborted) throw new Error('fallback_run_deadline');
    const response = await rpc('enqueue_exam_fallback_sources', { p_sources: batch });
    // A lost/partial acknowledgement must leave the discovery cursor unchanged.
    if (response.acknowledged !== batch.length || !Number.isSafeInteger(response.enqueued) || !Number.isSafeInteger(response.unchanged)
      || Number(response.enqueued) < 0 || Number(response.unchanged) < 0
      || Number(response.enqueued) + Number(response.unchanged) > batch.length) throw new Error('fallback_discovery_ack_invalid');
    totals.acknowledged += batch.length;
    totals.enqueued += Number(response.enqueued);
    totals.unchanged += Number(response.unchanged);
    batch = []; bytes = 2;
  }
  for (const origin of origins.values()) {
    const size = new TextEncoder().encode(JSON.stringify(origin.source)).byteLength;
    if (size > 8192) throw new Error('fallback_discovery_source_too_large');
    if (batch.length >= DISCOVERY_BATCH_SIZE || bytes + size + 1 > DISCOVERY_BATCH_BYTES) await flush();
    batch.push(origin.source); bytes += size + 1;
  }
  await flush();
  return totals;
}
