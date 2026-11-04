-- Preservation may run early; group dispatch is a last resort for a failed/stalled primary.
-- Neither retries, fallback preservation nor operational heartbeats count as advancement.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
ALTER TABLE public.exam_fallback_configuration
  ADD COLUMN primary_start_grace_seconds integer NOT NULL DEFAULT 600 CHECK(primary_start_grace_seconds BETWEEN 300 AND 3600),
  ADD COLUMN primary_idle_seconds integer NOT NULL DEFAULT 600 CHECK(primary_idle_seconds BETWEEN 300 AND 3600),
  ADD COLUMN primary_max_stall_seconds integer NOT NULL DEFAULT 1800 CHECK(primary_max_stall_seconds BETWEEN 600 AND 3600),
  ADD CONSTRAINT exam_fallback_primary_time_bounds CHECK(primary_max_stall_seconds>=primary_idle_seconds AND primary_max_stall_seconds>=primary_start_grace_seconds);

CREATE FUNCTION public.exam_fallback_primary_state(p_document_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.exam_document; cfg public.exam_fallback_configuration;
  last_progress timestamptz; last_failure timestamptz; source_failure timestamptz;
  active_lease public.exam_document_delivery; idle_for numeric; age_for numeric; reason text; eligible boolean:=false;
BEGIN
  PERFORM public.require_exam_document_service();
  SELECT * INTO STRICT d FROM public.exam_document WHERE id=p_document_id;
  SELECT * INTO STRICT cfg FROM public.exam_fallback_configuration WHERE singleton;
  -- These events are emitted after verified persistence/extraction. Never include
  -- source_reserved, updated_at, lease renewals, retries, human edits or fallback events.
  SELECT max(created_at) INTO last_progress FROM public.exam_document_event
    WHERE document_id=d.id AND (event_type IN ('file_saved','extraction_updated')
      OR (event_type='delivery_completed' AND details->>'destination'='processing'));
  last_progress:=greatest(d.received_at,last_progress);
  age_for:=greatest(0,extract(epoch FROM now()-d.received_at));
  idle_for:=greatest(0,extract(epoch FROM now()-last_progress));
  SELECT * INTO active_lease FROM public.exam_document_delivery
    WHERE document_id=d.id AND destination IN ('drive','processing') AND status='reserved' AND lease_until>now()
      AND COALESCE(worker,'') NOT LIKE 'fallback:%'
    ORDER BY lease_until DESC LIMIT 1;
  -- Legacy generic source_error is failure evidence only while the document still
  -- failed. A successful later file_saved invalidates it. Busy/deferred is not failure.
  IF d.file_status='failed' THEN
    SELECT max(created_at) INTO source_failure FROM public.exam_document_event
      WHERE document_id=d.id AND event_type='source_failed' AND created_at>last_progress
        AND COALESCE(details->>'reason_code',details->>'error_code',details->>'code','') !~ '(busy|deferred)'
        AND COALESCE(details->>'error','') !~* '(primary_busy|primary_deferred|deferred)';
  END IF;
  SELECT greatest(source_failure,max(updated_at)) INTO last_failure FROM public.exam_document_delivery
    WHERE document_id=d.id AND destination IN ('drive','processing','group') AND status='failed'
      AND COALESCE(worker,'') NOT LIKE 'fallback:%' AND updated_at>last_progress;
  IF active_lease.id IS NOT NULL AND idle_for<cfg.primary_max_stall_seconds THEN reason:='primary_active';
  ELSIF last_failure IS NOT NULL THEN eligible:=true; reason:='primary_failed';
  ELSIF age_for<cfg.primary_start_grace_seconds THEN reason:='primary_start_grace';
  ELSIF idle_for<cfg.primary_idle_seconds THEN reason:='primary_progress';
  ELSIF active_lease.id IS NOT NULL THEN eligible:=true; reason:='primary_stalled_max';
  ELSE eligible:=true; reason:='primary_stalled';
  END IF;
  RETURN jsonb_build_object('eligible',eligible,'reason',reason,'last_progress_at',last_progress,
    'last_failure_at',last_failure,'idle_seconds',floor(idle_for),'age_seconds',floor(age_for),
    'active_destination',active_lease.destination,'primary_lease_until',active_lease.lease_until,
    'start_grace_seconds',cfg.primary_start_grace_seconds,'idle_limit_seconds',cfg.primary_idle_seconds,'max_stall_seconds',cfg.primary_max_stall_seconds);
END $$;
REVOKE ALL ON FUNCTION public.exam_fallback_primary_state(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.exam_fallback_primary_state(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_exam_fallback_group(p_document_id uuid,p_worker text,p_min_age_seconds integer DEFAULT 120)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.exam_document; t public.exam_document_delivery; cfg public.exam_document_configuration; fallback public.exam_fallback_configuration; primary_state jsonb;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_worker IS NULL OR p_worker !~ '^fallback:[A-Za-z0-9_.:-]{1,140}$' OR p_min_age_seconds IS NULL OR p_min_age_seconds NOT BETWEEN 0 AND 3600 THEN RAISE EXCEPTION 'Invalid fallback claim'; END IF;
  SELECT * INTO STRICT d FROM public.exam_document WHERE id=p_document_id FOR NO KEY UPDATE;
  SELECT * INTO STRICT cfg FROM public.exam_document_configuration;
  SELECT * INTO STRICT fallback FROM public.exam_fallback_configuration WHERE singleton;
  PERFORM public.expire_exam_fallback_group_leases(d.id);
  IF NOT public.exam_fallback_group_eligible(d.id) THEN RETURN jsonb_build_object('claimed',false,'reason','ineligible'); END IF;
  IF d.received_at>now()-make_interval(secs=>greatest(p_min_age_seconds,fallback.minimum_age_seconds)) THEN
    RETURN jsonb_build_object('claimed',false,'reason','primary_grace');
  END IF;
  SELECT * INTO t FROM public.exam_document_delivery WHERE document_id=d.id AND destination='group' ORDER BY created_at,id LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('claimed',false,'reason','group_task_missing'); END IF;
  IF t.status NOT IN ('pending','failed') OR t.attempts>=t.max_attempts OR t.next_attempt_at>now()
    OR t.destination_key NOT IN ('default',cfg.group_destination_key) THEN
    RETURN jsonb_build_object('claimed',false,'reason','group_not_retryable','status',t.status);
  END IF;
  primary_state:=public.exam_fallback_primary_state(d.id);
  IF primary_state->'eligible'<>'true'::jsonb THEN
    RETURN jsonb_build_object('claimed',false,'reason',primary_state->>'reason','primary',primary_state);
  END IF;
  UPDATE public.exam_document_delivery SET status='reserved',worker=p_worker,lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',
    destination_key=cfg.group_destination_key,attempts=attempts+1,updated_at=now() WHERE id=t.id RETURNING * INTO t;
  PERFORM public.log_exam_document(d.id,'fallback_group_reserved',jsonb_build_object('delivery_id',t.id,'primary',primary_state));
  RETURN jsonb_build_object('claimed',true,'reason',primary_state->>'reason','primary',primary_state,'task',to_jsonb(t)||jsonb_build_object('document',to_jsonb(d),'configured_destination',cfg.group_destination_key,
    'notification_fields',public.exam_document_group_readiness(d.extracted_data,d.confirmed_data)->'fields'));
END $$;

CREATE OR REPLACE FUNCTION public.begin_exam_fallback_group_dispatch(p_delivery_id uuid,p_lease_token uuid,p_content_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.exam_document; t public.exam_document_delivery; doc_id uuid; cfg public.exam_document_configuration; primary_state jsonb;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_content_sha256 IS NULL OR p_content_sha256 !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid fallback content fingerprint'; END IF;
  SELECT document_id INTO STRICT doc_id FROM public.exam_document_delivery WHERE id=p_delivery_id;
  SELECT * INTO STRICT d FROM public.exam_document WHERE id=doc_id FOR NO KEY UPDATE;
  SELECT * INTO STRICT t FROM public.exam_document_delivery WHERE id=p_delivery_id FOR UPDATE;
  SELECT * INTO STRICT cfg FROM public.exam_document_configuration;
  IF t.lease_token IS DISTINCT FROM p_lease_token OR t.destination<>'group' OR t.worker !~ '^fallback:' THEN RAISE EXCEPTION 'Fallback dispatch fence invalid' USING ERRCODE='PT409'; END IF;
  IF t.status IN ('uncertain','submitted','sent') THEN RETURN jsonb_build_object('dispatch_allowed',false,'status',t.status); END IF;
  IF t.status<>'reserved' OR t.lease_until<=now() OR t.destination_key IS DISTINCT FROM cfg.group_destination_key
    OR NOT public.exam_fallback_group_eligible(d.id) THEN RAISE EXCEPTION 'Fallback dispatch no longer eligible' USING ERRCODE='PT409'; END IF;
  -- A primary worker can resume between the claim and the provider preflight.
  -- Recheck under the same document lock before consuming the one-shot POST grant.
  primary_state:=public.exam_fallback_primary_state(d.id);
  IF primary_state->'eligible'<>'true'::jsonb THEN
    UPDATE public.exam_document_delivery SET status='pending',worker=NULL,lease_token=NULL,lease_until=NULL,
      attempts=greatest(attempts-1,0),next_attempt_at=now(),updated_at=now() WHERE id=t.id;
    PERFORM public.log_exam_document(d.id,'fallback_group_deferred',jsonb_build_object('delivery_id',t.id,'primary',primary_state));
    RETURN jsonb_build_object('dispatch_allowed',false,'reason',primary_state->>'reason','primary',primary_state);
  END IF;
  UPDATE public.exam_document_delivery SET status='uncertain',last_error='Fallback submission started; reconcile before retry',lease_until=NULL,updated_at=now() WHERE id=t.id;
  PERFORM public.log_exam_document(d.id,'fallback_group_dispatch_started',jsonb_build_object('delivery_id',t.id,'lease_token',t.lease_token,'content_sha256',p_content_sha256,'primary',primary_state));
  RETURN jsonb_build_object('dispatch_allowed',true,'delivery_id',t.id,'document_id',d.id,'destination_key',t.destination_key,'sha256',d.sha256,'content_sha256',p_content_sha256);
END $$;

COMMIT;
