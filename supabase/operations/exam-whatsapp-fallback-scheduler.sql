-- Manual operations artifact. Do not add to the automatic migration runner.
-- Install as the database postgres role AFTER migration 44, with pg_cron,
-- pg_net, Vault and pgcrypto installed. This file never creates credentials.
-- Installation/reinstallation leaves this job INACTIVE. It does not change
-- another cron job, the source cutoff, pending PDFs, attempts, or delivery state.
--
-- Before activation:
-- 1. Store a random dedicated key (>=32 bytes) in Vault under
--    exam_whatsapp_fallback_trigger_key, using the secrets UI or a bound parameter
--    over an authorized connection. Put the identical value in Edge secret
--    EXAM_FALLBACK_TRIGGER_KEY. Never paste it into this file or SQL history.
-- 2. Optional Vault name exam_whatsapp_fallback_project_url must equal
--    https://jvgquuahsxepphhxmshk.supabase.co (no path/trailing slash).
-- 3. Deploy Edge auth.ts + nonce consumption and disable gateway JWT verification
--    for this function; its own Bearer/HMAC authentication remains mandatory.
-- 4. Configure the exact authorized source and explicit received_from cutoff in
--    exam_fallback_configuration; leave enabled=false until reviewed preflight.
-- 5. Preflight uses the dedicated Bearer key from a secure operator client, never
--    pg_net. Check the source, destination and synthetic delivery evidence first.
--
-- ACTIVATE (separate, explicit operation after steps above):
--   SELECT public.set_exam_fallback_schedule(true);
-- ROLLBACK / PAUSE (only this job + fallback flag; queue/bytes/receipts preserved):
--   SELECT public.set_exam_fallback_schedule(false);
-- Re-enable with the SAME cutoff to recover pending work; do not move it to now.
-- An already-started external request cannot be recalled by rollback. The
-- existing dispatch gate rechecks enabled before each POST; reconcile receipts.
--
-- Secret exposure review:
-- pg_net queues URL, body and request headers in net.http_request_queue; database
-- LOGIN roles can read them. Vault + SECURITY DEFINER alone does NOT hide a
-- Bearer header. This file sends only a signed, expiring, single-use trigger.
-- The permanent Vault key is used by HMAC in memory and is never a net argument.
-- Queue readers may race to invoke that same fixed run once; they cannot recover
-- the key, select recipients/content or mint another run. Nonce consumption is
-- atomic and service-only. A tampered/expired call fails closed.
-- net._http_response retains response headers/body (default >=6h), not request
-- headers. Edge responses must remain sanitized counts/codes, never secrets or
-- clinical content. Do not SELECT/print queue headers or response content during
-- routine verification. We do not alter unsupported pg_net grants/RLS/TTL.
-- Sources checked 2026-11-03:
-- https://supabase.com/kb/troubleshooting/database-roles-can-read-request-headers-queued-by-pg_net
-- https://supabase.com/docs/guides/database/vault
-- https://github.com/citusdata/pg_cron

BEGIN;
SET LOCAL statement_timeout = '30s';

DO $$ BEGIN
  IF to_regclass('public.exam_fallback_configuration') IS NULL OR
    to_regclass('vault.decrypted_secrets') IS NULL OR
    to_regprocedure('extensions.hmac(bytea,bytea,text)') IS NULL OR
    to_regprocedure('extensions.digest(text,text)') IS NULL OR
    to_regprocedure('cron.schedule(text,text,text)') IS NULL OR
    to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') IS NULL THEN
    RAISE EXCEPTION 'Fallback scheduler prerequisites missing';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.exam_fallback_scheduler_nonce (
  nonce_sha256 text PRIMARY KEY CHECK(nonce_sha256 ~ '^[a-f0-9]{64}$'),
  issued_epoch bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  request_id bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.exam_fallback_scheduler_nonce ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.exam_fallback_scheduler_nonce FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.consume_exam_fallback_scheduler_trigger(p_nonce uuid,p_timestamp bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE accepted boolean := false;
BEGIN
  PERFORM public.require_exam_document_service();
  IF NOT EXISTS(SELECT 1 FROM public.exam_fallback_configuration WHERE singleton AND enabled)
    OR p_timestamp IS NULL OR p_nonce IS NULL
    OR p_timestamp < floor(extract(epoch FROM clock_timestamp()))-120
    OR p_timestamp > floor(extract(epoch FROM clock_timestamp()))+5 THEN
    RETURN jsonb_build_object('accepted',false);
  END IF;
  UPDATE public.exam_fallback_scheduler_nonce SET consumed_at=clock_timestamp()
  WHERE nonce_sha256=encode(extensions.digest(p_nonce::text,'sha256'),'hex')
    AND issued_epoch=p_timestamp AND consumed_at IS NULL AND expires_at>clock_timestamp()
  RETURNING true INTO accepted;
  RETURN jsonb_build_object('accepted',coalesce(accepted,false));
END $$;

CREATE OR REPLACE FUNCTION public.dispatch_exam_fallback_scheduled_run()
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE secret_key text; project_url text; nonce uuid; issued text; signature text;
  request_body jsonb := '{"action":"run"}'::jsonb; v_request_id bigint;
BEGIN
  -- Only EXECUTE grants authorize this entry point: postgres cron has no JWT.
  -- A fresh random nonce signs a fixed body. No caller-supplied URL or payload.
  IF NOT EXISTS(SELECT 1 FROM public.exam_fallback_configuration WHERE singleton AND enabled)
    THEN RETURN NULL; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('exam-whatsapp-fallback-scheduler',0))
    THEN RETURN NULL; END IF;
  DELETE FROM public.exam_fallback_scheduler_nonce WHERE expires_at<clock_timestamp()-interval '1 day';
  -- Avoid piling up equivalent triggers when the pg_net worker is behind.
  IF EXISTS(SELECT 1 FROM public.exam_fallback_scheduler_nonce
    WHERE consumed_at IS NULL AND expires_at>clock_timestamp()) THEN RETURN NULL; END IF;
  SELECT decrypted_secret INTO secret_key FROM vault.decrypted_secrets WHERE name='exam_whatsapp_fallback_trigger_key';
  IF secret_key IS NULL OR octet_length(secret_key)<32 OR length(secret_key)>1024 OR secret_key ~ E'[\r\n]'
    THEN RAISE EXCEPTION 'Fallback scheduler key unavailable'; END IF;
  SELECT decrypted_secret INTO project_url FROM vault.decrypted_secrets WHERE name='exam_whatsapp_fallback_project_url';
  project_url:=coalesce(project_url,'https://jvgquuahsxepphhxmshk.supabase.co');
  IF project_url<>'https://jvgquuahsxepphhxmshk.supabase.co'
    THEN RAISE EXCEPTION 'Fallback scheduler project mismatch'; END IF;
  nonce:=gen_random_uuid(); issued:=floor(extract(epoch FROM clock_timestamp()))::bigint::text;
  signature:=encode(extensions.hmac(convert_to(issued||E'\n'||nonce::text||E'\n'||request_body::text,'UTF8'),
    convert_to(secret_key,'UTF8'),'sha256'),'hex');
  INSERT INTO public.exam_fallback_scheduler_nonce(nonce_sha256,issued_epoch,expires_at)
    VALUES(encode(extensions.digest(nonce::text,'sha256'),'hex'),issued::bigint,to_timestamp(issued::bigint)+interval '120 seconds');
  SELECT net.http_post(url:=project_url||'/functions/v1/exam-whatsapp-fallback',body:=request_body,
    headers:=jsonb_build_object('Content-Type','application/json','x-exam-fallback-timestamp',issued,
      'x-exam-fallback-nonce',nonce::text,'x-exam-fallback-signature',signature),
    timeout_milliseconds:=90000) INTO v_request_id;
  UPDATE public.exam_fallback_scheduler_nonce SET request_id=v_request_id
    WHERE nonce_sha256=encode(extensions.digest(nonce::text,'sha256'),'hex');
  RETURN v_request_id;
END $$;

-- The name is unique for this owner. Refuse collisions instead of taking over a
-- job installed by a different owner/database or with another command.
DO $$ DECLARE job_id bigint; BEGIN
  IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='exam-whatsapp-fallback-minute' AND
    (username<>current_user OR database<>current_database() OR
     command<>'SELECT public.dispatch_exam_fallback_scheduled_run();')) THEN
    RAISE EXCEPTION 'Fallback scheduler job name collision';
  END IF;
  SELECT cron.schedule('exam-whatsapp-fallback-minute','* * * * *',
    'SELECT public.dispatch_exam_fallback_scheduled_run();') INTO job_id;
  PERFORM cron.alter_job(job_id,active:=false);
END $$;

CREATE OR REPLACE FUNCTION public.set_exam_fallback_schedule(p_enabled boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job_id bigint; secret_key text; project_url text;
BEGIN
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'Fallback scheduler enabled value required'; END IF;
  SELECT jobid INTO STRICT job_id FROM cron.job WHERE jobname='exam-whatsapp-fallback-minute'
    AND username=current_user AND database=current_database()
    AND command='SELECT public.dispatch_exam_fallback_scheduled_run();';
  IF p_enabled THEN
    SELECT decrypted_secret INTO secret_key FROM vault.decrypted_secrets WHERE name='exam_whatsapp_fallback_trigger_key';
    SELECT decrypted_secret INTO project_url FROM vault.decrypted_secrets WHERE name='exam_whatsapp_fallback_project_url';
    IF secret_key IS NULL OR octet_length(secret_key)<32 OR length(secret_key)>1024 OR secret_key ~ E'[\r\n]'
      OR coalesce(project_url,'https://jvgquuahsxepphhxmshk.supabase.co')<>'https://jvgquuahsxepphhxmshk.supabase.co'
      THEN RAISE EXCEPTION 'Fallback scheduler secrets invalid'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.exam_fallback_configuration WHERE singleton
      AND source_account_id ~ '^chatwoot:[1-9][0-9]*:inbox:[1-9][0-9]*$'
      AND source_conversation_id ~ '^[1-9][0-9]*$' AND received_from IS NOT NULL)
      THEN RAISE EXCEPTION 'Fallback scheduler source scope incomplete'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.exam_document_configuration WHERE singleton
      AND ingestion_enabled AND 'group'=ANY(enabled_destinations) AND notification_cutoff IS NOT NULL
      AND nullif(group_destination_key,'') IS NOT NULL)
      THEN RAISE EXCEPTION 'Fallback scheduler group scope incomplete'; END IF;
  END IF;
  UPDATE public.exam_fallback_configuration SET enabled=p_enabled WHERE singleton;
  PERFORM cron.alter_job(job_id,schedule:='* * * * *',active:=p_enabled);
  RETURN jsonb_build_object('enabled',p_enabled,'job_id',job_id,'schedule','* * * * *');
END $$;

REVOKE ALL ON FUNCTION public.consume_exam_fallback_scheduler_trigger(uuid,bigint),
  public.dispatch_exam_fallback_scheduled_run(),public.set_exam_fallback_schedule(boolean)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.consume_exam_fallback_scheduler_trigger(uuid,bigint),
  public.dispatch_exam_fallback_scheduled_run(),public.set_exam_fallback_schedule(boolean)
  TO service_role;
COMMIT;

-- Safe verification (no key, signature, PDF identity or response content):
-- SELECT jobid,jobname,schedule,active FROM cron.job WHERE jobname='exam-whatsapp-fallback-minute';
-- SELECT enabled,minimum_age_seconds FROM public.exam_fallback_configuration WHERE singleton;
-- SELECT last_started_at,last_checkpoint_at,last_error_code FROM public.exam_fallback_runtime WHERE singleton;
-- SELECT r.status_code,r.timed_out,r.created FROM net._http_response r
-- JOIN public.exam_fallback_scheduler_nonce n ON n.request_id=r.id ORDER BY r.created DESC LIMIT 10;
-- A successful cron row only proves enqueueing. Verify HTTP status, runtime
-- checkpoints, preserved originals and provider receipts separately.
