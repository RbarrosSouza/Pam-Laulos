-- Disable only automatic cooldown. Preserve cron activity, source cutoff, queues,
-- leases, originals, receipts and the health history for diagnosis/re-enablement.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='10s';
UPDATE public.exam_fallback_runtime SET backpressure_enabled=false WHERE singleton;
COMMIT;
-- To re-enable after review: UPDATE public.exam_fallback_runtime SET backpressure_enabled=true WHERE singleton;
