-- Keep the minute schedule, but stop starting work during a dependency outage.
-- This migration never schedules/pauses cron or changes intake/delivery state.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

ALTER TABLE public.exam_fallback_runtime
 ADD COLUMN backpressure_enabled boolean NOT NULL DEFAULT true,
 ADD COLUMN failure_count integer NOT NULL DEFAULT 0 CHECK(failure_count>=0),
 ADD COLUMN cooldown_until timestamptz,
 ADD COLUMN last_failure_at timestamptz,
 ADD COLUMN last_healthy_at timestamptz,
 ADD COLUMN active_scheduler_request_id bigint;

-- A clean installation may not have installed the optional scheduler yet.
-- Creating its journal does not install/enable cron or create an HTTP request.
CREATE TABLE IF NOT EXISTS public.exam_fallback_scheduler_nonce (
 nonce_sha256 text PRIMARY KEY CHECK(nonce_sha256 ~ '^[a-f0-9]{64}$'),
 issued_epoch bigint NOT NULL,expires_at timestamptz NOT NULL,
 consumed_at timestamptz,request_id bigint,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.exam_fallback_scheduler_nonce
 ADD COLUMN health_observed_at timestamptz,
 ADD COLUMN health_outcome text CHECK(health_outcome IN ('healthy','transient_failure','neutral'));
ALTER TABLE public.exam_fallback_scheduler_nonce ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.exam_fallback_scheduler_nonce FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX exam_fallback_nonce_expiry_idx ON public.exam_fallback_scheduler_nonce(expires_at);
CREATE INDEX exam_fallback_nonce_request_idx ON public.exam_fallback_scheduler_nonce(request_id,created_at DESC) WHERE request_id IS NOT NULL;
CREATE INDEX exam_fallback_nonce_created_idx ON public.exam_fallback_scheduler_nonce(created_at DESC) WHERE request_id IS NOT NULL;

CREATE FUNCTION public.exam_fallback_transient_failure(p_code text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(p_code=ANY(ARRAY[
  'fallback_backend_unavailable','fallback_backend_timeout',
  'whatsapp_source_request_failed','whatsapp_request_timeout'
 ]),false)
$$;
REVOKE ALL ON FUNCTION public.exam_fallback_transient_failure(text) FROM PUBLIC,anon,authenticated,service_role;

-- Internal only. Both the checkpoint and scheduler serialize on the singleton,
-- then mark the same request once, preventing a failed callback being counted twice.
CREATE FUNCTION public.apply_exam_fallback_health(p_health text,p_error_code text,p_request_id bigint,p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.exam_fallback_runtime; observed timestamptz; nonce_hash text; base_seconds integer; delay_seconds integer;
BEGIN
 IF p_health IS NULL OR p_health NOT IN ('healthy','transient_failure','neutral') OR p_at IS NULL
   OR (p_health='healthy' AND p_error_code IS NOT NULL)
   OR (p_health='transient_failure' AND NOT (public.exam_fallback_transient_failure(p_error_code)
    OR coalesce(p_error_code=ANY(ARRAY['fallback_scheduler_http_unavailable','fallback_scheduler_transport_failed','fallback_scheduler_response_missing']),false))) THEN
   RAISE EXCEPTION 'Invalid fallback health outcome' USING ERRCODE='22023';
 END IF;
 SELECT * INTO STRICT r FROM public.exam_fallback_runtime WHERE singleton FOR UPDATE;
 IF p_request_id IS NOT NULL THEN
  SELECT health_observed_at,nonce_sha256 INTO observed,nonce_hash FROM public.exam_fallback_scheduler_nonce
   WHERE request_id=p_request_id ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Fallback scheduler request unknown' USING ERRCODE='PT409'; END IF;
  IF observed IS NOT NULL THEN RETURN jsonb_build_object('recorded',false,'failure_count',r.failure_count,'cooldown_until',r.cooldown_until); END IF;
  UPDATE public.exam_fallback_scheduler_nonce SET health_observed_at=p_at,health_outcome=p_health WHERE nonce_sha256=nonce_hash;
 END IF;
 IF r.backpressure_enabled AND p_health='transient_failure' THEN
  base_seconds:=least(900,60*power(2,least(r.failure_count,4))::integer);
  -- Positive jitter never retries before the nominal delay; total pause caps at 15m.
  delay_seconds:=least(900,base_seconds+floor(random()*least(16,base_seconds/10+1))::integer);
  UPDATE public.exam_fallback_runtime SET failure_count=least(failure_count+1,1000000),
   cooldown_until=p_at+make_interval(secs=>delay_seconds),last_failure_at=p_at,last_error_code=p_error_code
   WHERE singleton RETURNING * INTO r;
 ELSIF r.backpressure_enabled AND p_health='healthy' THEN
  UPDATE public.exam_fallback_runtime SET failure_count=0,cooldown_until=NULL,last_healthy_at=p_at,last_error_code=NULL
   WHERE singleton RETURNING * INTO r;
 END IF;
 RETURN jsonb_build_object('recorded',true,'failure_count',r.failure_count,'cooldown_until',r.cooldown_until);
END $$;
REVOKE ALL ON FUNCTION public.apply_exam_fallback_health(text,text,bigint,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.consume_exam_fallback_scheduler_trigger(p_nonce uuid,p_timestamp bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE accepted boolean:=false; request bigint;
BEGIN
 PERFORM public.require_exam_document_service();
 IF NOT EXISTS(SELECT 1 FROM public.exam_fallback_configuration WHERE singleton AND enabled)
   OR p_timestamp IS NULL OR p_nonce IS NULL
   OR p_timestamp<floor(extract(epoch FROM clock_timestamp()))-120
   OR p_timestamp>floor(extract(epoch FROM clock_timestamp()))+5 THEN RETURN jsonb_build_object('accepted',false); END IF;
 UPDATE public.exam_fallback_scheduler_nonce SET consumed_at=clock_timestamp()
 WHERE nonce_sha256=encode(extensions.digest(p_nonce::text,'sha256'),'hex') AND issued_epoch=p_timestamp
   AND consumed_at IS NULL AND health_observed_at IS NULL AND expires_at>clock_timestamp()
 RETURNING true,request_id INTO accepted,request;
 RETURN jsonb_build_object('accepted',coalesce(accepted,false),'request_id',request);
END $$;
REVOKE ALL ON FUNCTION public.consume_exam_fallback_scheduler_trigger(uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.consume_exam_fallback_scheduler_trigger(uuid,bigint) TO service_role;

CREATE FUNCTION public.claim_exam_fallback_run_health(p_worker text,p_max_seconds integer DEFAULT 100,p_scheduler_request_id bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.exam_fallback_runtime; cfg public.exam_fallback_configuration; request bigint; at_time timestamptz:=clock_timestamp();
BEGIN
 PERFORM public.require_exam_document_service();
 IF p_worker IS NULL OR p_worker !~ '^fallback:[A-Za-z0-9_.:-]{1,140}$' OR p_max_seconds IS NULL OR p_max_seconds NOT BETWEEN 20 AND 120 THEN RAISE EXCEPTION 'Invalid fallback run'; END IF;
 SELECT * INTO STRICT cfg FROM public.exam_fallback_configuration WHERE singleton;
 IF NOT cfg.enabled THEN RETURN jsonb_build_object('claimed',false,'reason','disabled'); END IF;
 SELECT * INTO STRICT r FROM public.exam_fallback_runtime WHERE singleton FOR UPDATE;
 IF r.run_until>at_time THEN RETURN jsonb_build_object('claimed',false,'reason','run_active'); END IF;
 IF r.backpressure_enabled AND r.cooldown_until>at_time THEN
  RETURN jsonb_build_object('claimed',false,'reason','backend_cooldown','failure_count',r.failure_count,'cooldown_until',r.cooldown_until);
 END IF;
 -- The new Edge explicitly distinguishes a signed scheduled request from a
 -- Bearer/manual call. A manual probe must not consume another request's outcome.
 request:=p_scheduler_request_id;
 IF request IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.exam_fallback_scheduler_nonce
   WHERE request_id=request AND consumed_at<=at_time AND expires_at>at_time AND health_observed_at IS NULL) THEN
  RAISE EXCEPTION 'Fallback scheduler request fence changed' USING ERRCODE='PT409';
 END IF;
 UPDATE public.exam_fallback_runtime SET worker=p_worker,run_token=gen_random_uuid(),
  run_until=at_time+make_interval(secs=>p_max_seconds),last_started_at=at_time,active_scheduler_request_id=request
  WHERE singleton RETURNING * INTO r;
 RETURN jsonb_build_object('claimed',true,'run_token',r.run_token,'run_until',r.run_until,'config',to_jsonb(cfg),'scan',r.scan,
  'failure_count',r.failure_count,'cooldown_until',r.cooldown_until);
END $$;
REVOKE ALL ON FUNCTION public.claim_exam_fallback_run_health(text,integer,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_exam_fallback_run_health(text,integer,bigint) TO service_role;

-- Old Edge requests did not provide an ID. Keep their lease/nonce semantics
-- during the short SQL-first rollout; the new Edge uses the explicit API above.
CREATE OR REPLACE FUNCTION public.claim_exam_fallback_run(p_worker text,p_max_seconds integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE request bigint;
BEGIN
 PERFORM public.require_exam_document_service();
 SELECT request_id INTO request FROM public.exam_fallback_scheduler_nonce
 WHERE consumed_at<=clock_timestamp() AND expires_at>clock_timestamp() AND health_observed_at IS NULL AND request_id IS NOT NULL
 ORDER BY consumed_at DESC,created_at DESC LIMIT 1;
 RETURN public.claim_exam_fallback_run_health(p_worker,p_max_seconds,request);
END $$;

CREATE FUNCTION public.checkpoint_exam_fallback_run_health(p_run_token uuid,p_state jsonb,p_completed boolean,
 p_error_code text DEFAULT NULL,p_health text DEFAULT 'neutral',p_scheduler_request_id bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.exam_fallback_runtime; request bigint; health jsonb; at_time timestamptz:=clock_timestamp();
BEGIN
 PERFORM public.require_exam_document_service();
 IF NOT public.valid_exam_fallback_scan(p_state) OR p_completed IS NULL
  OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z][a-z0-9_]{0,95}$')
  OR (p_completed AND p_error_code IS NOT NULL) THEN RAISE EXCEPTION 'Invalid fallback checkpoint metadata'; END IF;
 IF p_health='transient_failure' AND NOT public.exam_fallback_transient_failure(p_error_code) THEN
  RAISE EXCEPTION 'Invalid fallback transient failure' USING ERRCODE='22023';
 END IF;
 SELECT * INTO STRICT r FROM public.exam_fallback_runtime WHERE singleton FOR UPDATE;
 IF r.run_token IS DISTINCT FROM p_run_token OR r.run_until IS NULL OR r.run_until<=at_time THEN
  RAISE EXCEPTION 'Fallback run fence expired' USING ERRCODE='PT409';
 END IF;
 request:=coalesce(p_scheduler_request_id,r.active_scheduler_request_id);
 IF request IS NOT NULL AND (request IS DISTINCT FROM r.active_scheduler_request_id OR NOT EXISTS(
   SELECT 1 FROM public.exam_fallback_scheduler_nonce WHERE request_id=request AND consumed_at<=r.last_started_at AND expires_at>r.last_started_at
  )) THEN RAISE EXCEPTION 'Fallback scheduler request fence changed' USING ERRCODE='PT409'; END IF;
 health:=public.apply_exam_fallback_health(p_health,p_error_code,request,at_time);
 UPDATE public.exam_fallback_runtime SET scan=CASE WHEN p_completed THEN '{}'::jsonb ELSE p_state END,
  last_checkpoint_at=at_time,last_completed_at=CASE WHEN p_completed THEN at_time ELSE last_completed_at END,
  last_error_code=p_error_code,run_until=NULL,active_scheduler_request_id=NULL WHERE singleton RETURNING * INTO r;
 RETURN jsonb_build_object('recorded',true,'completed',p_completed,'scan',r.scan,'health',health,
  'failure_count',r.failure_count,'cooldown_until',r.cooldown_until);
END $$;
REVOKE ALL ON FUNCTION public.checkpoint_exam_fallback_run_health(uuid,jsonb,boolean,text,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.checkpoint_exam_fallback_run_health(uuid,jsonb,boolean,text,text,bigint) TO service_role;

-- Compatibility for the previous Edge deployment: only explicit infrastructure
-- failures pause the circuit; a healthy partial scan is still a successful probe.
CREATE OR REPLACE FUNCTION public.checkpoint_exam_fallback_run(p_run_token uuid,p_state jsonb,p_completed boolean,p_error_code text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE code text:=p_error_code;
BEGIN
 IF code=ANY(ARRAY['fallback_rpc_failed','fallback_schema_unavailable','fallback_operational_config_unavailable','fallback_group_state_unavailable','fallback_failure_record_unavailable']) THEN
  code:='fallback_backend_unavailable';
 END IF;
 RETURN public.checkpoint_exam_fallback_run_health(p_run_token,p_state,p_completed,code,
  CASE WHEN code IS NULL THEN 'healthy' WHEN public.exam_fallback_transient_failure(code) THEN 'transient_failure' ELSE 'neutral' END,NULL);
END $$;

CREATE FUNCTION public.reconcile_exam_fallback_scheduler_health() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n public.exam_fallback_scheduler_nonce; response_code integer; timed_out boolean; transport_error boolean; response_found boolean:=false;
 at_time timestamptz:=clock_timestamp(); code text; r public.exam_fallback_runtime;
BEGIN
 SELECT * INTO STRICT r FROM public.exam_fallback_runtime WHERE singleton FOR UPDATE;
 IF NOT r.backpressure_enabled THEN RETURN false; END IF;
 -- Only the most recent request can govern new dispatch. Never replay historical
-- responses after recovery or infer health from response bodies/headers.
 SELECT * INTO n FROM public.exam_fallback_scheduler_nonce WHERE request_id IS NOT NULL ORDER BY created_at DESC,request_id DESC LIMIT 1;
 IF NOT FOUND OR n.health_observed_at IS NOT NULL THEN RETURN false; END IF;
 IF to_regclass('net._http_response') IS NOT NULL THEN
  -- pg_net's existing created index bounds this lookup to the request's window.
  SELECT status_code,coalesce(h.timed_out,false),h.error_msg IS NOT NULL INTO response_code,timed_out,transport_error
  FROM net._http_response h WHERE h.id=n.request_id AND h.created>=n.created_at-interval '1 minute' ORDER BY h.created DESC LIMIT 1;
  response_found:=FOUND;
 END IF;
 IF response_found THEN
  IF timed_out OR transport_error THEN code:='fallback_scheduler_transport_failed';
  ELSIF response_code=429 OR response_code>=500 THEN code:='fallback_scheduler_http_unavailable';
  END IF;
 ELSIF n.expires_at+interval '1 minute'>at_time THEN
  RETURN true; -- one pending request, including a consumed nonce awaiting response
 ELSE code:='fallback_scheduler_response_missing';
 END IF;
 PERFORM public.apply_exam_fallback_health(CASE WHEN code IS NULL THEN 'neutral' ELSE 'transient_failure' END,code,n.request_id,at_time);
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.reconcile_exam_fallback_scheduler_health() FROM PUBLIC,anon,authenticated,service_role;

-- CREATE OR REPLACE preserves the installed function owner and ACL. Unlike the
-- optional operations installer this does not alter cron.job or enabled flags.
CREATE OR REPLACE FUNCTION public.dispatch_exam_fallback_scheduled_run()
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE secret_key text; project_url text; nonce uuid; issued text; signature text;
 request_body jsonb:='{"action":"run"}'::jsonb; v_request_id bigint; pending boolean; r public.exam_fallback_runtime;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.exam_fallback_configuration WHERE singleton AND enabled) THEN RETURN NULL; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('exam-whatsapp-fallback-scheduler',0)) THEN RETURN NULL; END IF;
 pending:=public.reconcile_exam_fallback_scheduler_health();
 SELECT * INTO STRICT r FROM public.exam_fallback_runtime WHERE singleton;
 -- Bounded maintenance also runs while the circuit is open; keep its active nonce.
 DELETE FROM public.exam_fallback_scheduler_nonce n USING (
  SELECT nonce_sha256 FROM public.exam_fallback_scheduler_nonce
  WHERE expires_at<clock_timestamp()-interval '1 day'
   AND (r.active_scheduler_request_id IS NULL OR request_id IS DISTINCT FROM r.active_scheduler_request_id)
  ORDER BY expires_at LIMIT 1000
 ) old WHERE n.nonce_sha256=old.nonce_sha256;
 IF pending OR r.run_until>clock_timestamp() OR (r.backpressure_enabled AND r.cooldown_until>clock_timestamp()) THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM public.exam_fallback_scheduler_nonce WHERE consumed_at IS NULL AND health_observed_at IS NULL AND expires_at>clock_timestamp()) THEN RETURN NULL; END IF;
 SELECT decrypted_secret INTO secret_key FROM vault.decrypted_secrets WHERE name='exam_whatsapp_fallback_trigger_key';
 IF secret_key IS NULL OR octet_length(secret_key)<32 OR length(secret_key)>1024 OR secret_key ~ E'[\r\n]' THEN RAISE EXCEPTION 'Fallback scheduler key unavailable'; END IF;
 SELECT decrypted_secret INTO project_url FROM vault.decrypted_secrets WHERE name='exam_whatsapp_fallback_project_url';
 project_url:=coalesce(project_url,'https://jvgquuahsxepphhxmshk.supabase.co');
 IF project_url<>'https://jvgquuahsxepphhxmshk.supabase.co' THEN RAISE EXCEPTION 'Fallback scheduler project mismatch'; END IF;
 nonce:=gen_random_uuid();issued:=floor(extract(epoch FROM clock_timestamp()))::bigint::text;
 signature:=encode(extensions.hmac(convert_to(issued||E'\n'||nonce::text||E'\n'||request_body::text,'UTF8'),convert_to(secret_key,'UTF8'),'sha256'),'hex');
 INSERT INTO public.exam_fallback_scheduler_nonce(nonce_sha256,issued_epoch,expires_at)
 VALUES(encode(extensions.digest(nonce::text,'sha256'),'hex'),issued::bigint,to_timestamp(issued::bigint)+interval '120 seconds');
 SELECT net.http_post(url:=project_url||'/functions/v1/exam-whatsapp-fallback',body:=request_body,
  headers:=jsonb_build_object('Content-Type','application/json','x-exam-fallback-timestamp',issued,'x-exam-fallback-nonce',nonce::text,'x-exam-fallback-signature',signature),timeout_milliseconds:=90000) INTO v_request_id;
 UPDATE public.exam_fallback_scheduler_nonce SET request_id=v_request_id WHERE nonce_sha256=encode(extensions.digest(nonce::text,'sha256'),'hex');
 RETURN v_request_id;
END $$;
REVOKE ALL ON FUNCTION public.dispatch_exam_fallback_scheduled_run() FROM PUBLIC,anon,authenticated;

COMMIT;
