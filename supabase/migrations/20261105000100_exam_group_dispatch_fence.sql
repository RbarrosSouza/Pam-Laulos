-- Faster workers must not send an extraction snapshot before processing finishes.
-- Preserve existing file/source/clinical/hold/cutoff guards and no-repeat semantics.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

CREATE OR REPLACE FUNCTION public.exam_fallback_primary_state(p_document_id uuid) RETURNS jsonb
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
  -- Immediate failover requires terminal evidence. Transient failures and retry
  -- cooldowns keep the shared start/idle/max-stall windows; no retry heartbeat
  -- counts as progress, so an indefinitely failing primary still releases safety.
  IF d.file_status='failed' THEN
    SELECT max(created_at) INTO source_failure FROM public.exam_document_event
      WHERE document_id=d.id AND event_type='source_failed' AND created_at>last_progress
        AND COALESCE(details->>'reason_code',details->>'error_code',details->>'code','') !~ '(busy|deferred)'
        AND COALESCE(details->>'error','') !~* '(primary_busy|primary_deferred|deferred)'
        AND details->'terminal'='true'::jsonb;
  END IF;
  SELECT greatest(source_failure,max(updated_at)) INTO last_failure FROM public.exam_document_delivery
    WHERE document_id=d.id AND destination IN ('drive','processing','group') AND status='failed'
      AND COALESCE(worker,'') NOT LIKE 'fallback:%' AND updated_at>last_progress
      AND attempts>=max_attempts;
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


CREATE FUNCTION public.exam_document_primary_group_state(p_document_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.exam_document; primary_state jsonb;
BEGIN
 PERFORM public.require_exam_document_service();
 SELECT * INTO STRICT d FROM public.exam_document WHERE id=p_document_id;
 IF d.extractor_version IS NOT NULL AND EXISTS(SELECT 1 FROM public.exam_document_delivery
   WHERE document_id=d.id AND destination='processing' AND status='completed') THEN
   RETURN jsonb_build_object('eligible',true,'reason','processing_completed');
 END IF;
 primary_state:=public.exam_fallback_primary_state(d.id);
 RETURN primary_state;
END $$;
REVOKE ALL ON FUNCTION public.exam_document_primary_group_state(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.exam_document_primary_group_state(uuid) TO service_role;

-- Surgical replacement retains deployed clinical evidence and human-review rules.
DO $patch$
DECLARE definition text; marker text;
BEGIN
 definition:=pg_get_functiondef('public.reserve_exam_document_delivery(text,text,integer)'::regprocedure);
 marker:=$old$(t.created_at<=now()-interval '5 minutes'
          OR EXISTS(SELECT 1 FROM public.exam_document_delivery processing
            WHERE processing.document_id=d.id AND processing.destination='processing'
              AND processing.status IN ('completed','failed','waived')))$old$;
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
   RAISE EXCEPTION 'Review current group reservation before pipeline migration';
 END IF;
 definition:=replace(definition,marker,$new$(public.exam_document_primary_group_state(d.id)->'eligible'='true'::jsonb)$new$);
 definition:=replace(definition,'-- Give extraction a short opportunity to provide names, never an indefinite gate.',
   '-- Processing commits first; only the shared terminal/stall policy can bypass it.');
 marker:='d.canonical_document_id IS NULL';
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'Review canonical reservation filter before pipeline migration'; END IF;
 definition:=replace(definition,marker,marker||' AND d.deletion_state IS NULL');
 EXECUTE definition;
 -- Once a dispatch grant is consumed, a transport error is uncertain, never a
 -- retryable failed submission. Existing submitted/reaction contracts stay intact.
 definition:=pg_get_functiondef('public.complete_exam_document_delivery(uuid,uuid,jsonb)'::regprocedure);
 marker:=$old$IF v_task.status='submitted' AND v_status='failed'$old$;
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
   RAISE EXCEPTION 'Review current completion fence before pipeline migration';
 END IF;
 EXECUTE replace(definition,marker,$new$IF v_task.status IN ('submitted','uncertain') AND v_status='failed'$new$);
END $patch$;

CREATE FUNCTION public.exam_group_presentation_revision(p_document jsonb,p_fields jsonb,p_destination text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT md5(jsonb_build_object('id',p_document->'id','received_at',p_document->'received_at','sha256',p_document->'sha256','size_bytes',p_document->'size_bytes',
   'fields',p_fields,'responsible_vet_id',p_document->'responsible_vet_id','responsible_vet_name',p_document->'responsible_vet_name',
   'responsible_vet_source',p_document->'responsible_vet_source','destination',p_destination)::text);
$$;
REVOKE ALL ON FUNCTION public.exam_group_presentation_revision(jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.exam_document_group_dispatch_snapshot(p_document_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.exam_document; cfg public.exam_document_configuration; human_decision record;
 extraction jsonb; primary_state jsonb; document jsonb; clinical boolean;
BEGIN
 PERFORM public.require_exam_document_service();
 SELECT * INTO STRICT d FROM public.exam_document WHERE id=p_document_id;
 SELECT * INTO STRICT cfg FROM public.exam_document_configuration;
 IF d.canonical_document_id IS NOT NULL OR d.deletion_state IS NOT NULL OR d.identification_status='not_exam'
   OR d.file_status<>'saved' OR d.group_release_at IS NULL OR d.group_exception_reason IS NOT NULL
   OR NOT 'group'=ANY(cfg.enabled_destinations) OR cfg.notification_cutoff IS NULL OR d.received_at<cfg.notification_cutoff
   OR NULLIF(cfg.group_destination_key,'') IS NULL OR EXISTS(SELECT 1 FROM public.exam_intake_document_hold h
     WHERE h.document_id=d.id AND h.state='held' AND h.reason NOT IN ('changed_content_review','historical_snapshot_unavailable')) THEN
   RETURN jsonb_build_object('eligible',false,'reason','document_ineligible');
 END IF;
 SELECT event_type,details INTO human_decision FROM public.exam_document_event
   WHERE document_id=d.id AND actor_id IS NOT NULL AND event_type IN ('reviewed','link_confirmed') ORDER BY id DESC LIMIT 1;
 SELECT details INTO extraction FROM public.exam_document_event WHERE document_id=d.id AND event_type='extraction_updated' ORDER BY id DESC LIMIT 1;
 clinical:=CASE WHEN human_decision.event_type='link_confirmed' THEN true
   WHEN human_decision.event_type='reviewed' AND human_decision.details->>'classification'='not_exam' THEN false
   WHEN human_decision.event_type='reviewed' AND human_decision.details->>'classification'='exam' THEN true
   WHEN extraction->>'classification'='not_exam' THEN false
   ELSE EXISTS(SELECT 1 FROM public.exam_document_source WHERE document_id=d.id AND metadata->'exam_candidate'='true'::jsonb)
     OR (extraction->>'classification' IN ('exam','review') AND NULLIF(trim(d.extracted_data->>'exam_type'),'') IS NOT NULL
       AND public.exam_document_exam_type_evidence_matches(d.extracted_data->>'exam_type',d.evidence,extraction->'single_patient'='true'::jsonb)) END;
 IF clinical IS DISTINCT FROM true THEN RETURN jsonb_build_object('eligible',false,'reason','clinical_candidacy_missing'); END IF;
 primary_state:=public.exam_document_primary_group_state(d.id);
 IF primary_state->'eligible' IS DISTINCT FROM 'true'::jsonb THEN RETURN primary_state; END IF;
 document:=to_jsonb(d)||public.exam_document_responsibility_fields(d.id);
 RETURN jsonb_build_object('eligible',true,'reason',primary_state->>'reason','primary',primary_state,
   'document',document,'configured_destination',cfg.group_destination_key,
   'notification_fields',public.exam_document_group_readiness(d.extracted_data,d.confirmed_data)->'fields',
   'presentation_revision',public.exam_group_presentation_revision(document,public.exam_document_group_readiness(d.extracted_data,d.confirmed_data)->'fields',cfg.group_destination_key));
END $$;
REVOKE ALL ON FUNCTION public.exam_document_group_dispatch_snapshot(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.prepare_exam_group_dispatch(p_delivery_id uuid,p_lease_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.exam_document; t public.exam_document_delivery; doc_id uuid; snapshot jsonb;
BEGIN
 PERFORM public.require_exam_document_service();
 SELECT document_id INTO STRICT doc_id FROM public.exam_document_delivery WHERE id=p_delivery_id;
 SELECT * INTO STRICT d FROM public.exam_document WHERE id=doc_id FOR NO KEY UPDATE;
 SELECT * INTO STRICT t FROM public.exam_document_delivery WHERE id=p_delivery_id FOR UPDATE;
 IF t.destination<>'group' OR t.lease_token IS DISTINCT FROM p_lease_token OR COALESCE(t.worker,'') LIKE 'fallback:%' THEN
   RAISE EXCEPTION 'Group preparation fence invalid' USING ERRCODE='PT409';
 END IF;
 IF d.deletion_state IS NOT NULL THEN RETURN jsonb_build_object('dispatch_ready',false,'reason','document_deleted'); END IF;
 IF t.status IN ('submitted','uncertain','sent') THEN RETURN jsonb_build_object('dispatch_ready',false,'reason','dispatch_already_started','status',t.status); END IF;
 IF t.status<>'reserved' OR t.lease_until IS NULL OR t.lease_until<=now() THEN
   RAISE EXCEPTION 'Group preparation lease expired' USING ERRCODE='PT409';
 END IF;
 snapshot:=public.exam_document_group_dispatch_snapshot(d.id);
 IF snapshot->'eligible' IS DISTINCT FROM 'true'::jsonb OR t.destination_key IS DISTINCT FROM snapshot->>'configured_destination' THEN
   UPDATE public.exam_document_delivery SET status='pending',worker=NULL,lease_token=NULL,lease_until=NULL,
     attempts=greatest(attempts-1,0),next_attempt_at=now()+interval '1 minute',updated_at=now() WHERE id=t.id;
   PERFORM public.log_exam_document(d.id,'primary_group_deferred',jsonb_build_object('delivery_id',t.id,'reason',snapshot->>'reason'));
   RETURN jsonb_build_object('dispatch_ready',false,'reason',COALESCE(snapshot->>'reason','destination_changed'));
 END IF;
 RETURN jsonb_build_object('dispatch_ready',true,'presentation_revision',snapshot->>'presentation_revision',
   'task',to_jsonb(t)||jsonb_build_object('document',snapshot->'document','configured_destination',snapshot->'configured_destination',
   'notification_fields',snapshot->'notification_fields'),'primary',snapshot->'primary');
END $$;

CREATE FUNCTION public.begin_exam_group_dispatch(p_delivery_id uuid,p_lease_token uuid,p_presentation_revision text,p_content_sha256 text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t public.exam_document_delivery; d public.exam_document; doc_id uuid; snapshot jsonb;
BEGIN
 PERFORM public.require_exam_document_service();
 IF p_content_sha256 IS NULL OR p_content_sha256 !~ '^[a-f0-9]{64}$' OR p_presentation_revision IS NULL OR p_presentation_revision !~ '^[a-f0-9]{32}$' THEN
   RAISE EXCEPTION 'Invalid group dispatch fingerprint';
 END IF;
 SELECT document_id INTO STRICT doc_id FROM public.exam_document_delivery WHERE id=p_delivery_id;
 SELECT * INTO STRICT d FROM public.exam_document WHERE id=doc_id FOR NO KEY UPDATE;
 SELECT * INTO STRICT t FROM public.exam_document_delivery WHERE id=p_delivery_id FOR UPDATE;
 IF t.destination<>'group' OR t.lease_token IS DISTINCT FROM p_lease_token OR COALESCE(t.worker,'') LIKE 'fallback:%' THEN
   RAISE EXCEPTION 'Group dispatch fence invalid' USING ERRCODE='PT409';
 END IF;
 IF d.deletion_state IS NOT NULL THEN RETURN jsonb_build_object('dispatch_allowed',false,'reason','document_deleted'); END IF;
 IF t.status IN ('submitted','uncertain','sent') THEN RETURN jsonb_build_object('dispatch_allowed',false,'reason','dispatch_already_started','status',t.status); END IF;
 IF t.status<>'reserved' OR t.lease_until IS NULL OR t.lease_until<=now() THEN
   RAISE EXCEPTION 'Group dispatch lease expired' USING ERRCODE='PT409';
 END IF;
 snapshot:=public.exam_document_group_dispatch_snapshot(d.id);
 IF snapshot->'eligible' IS DISTINCT FROM 'true'::jsonb OR t.destination_key IS DISTINCT FROM snapshot->>'configured_destination'
   OR p_presentation_revision IS DISTINCT FROM snapshot->>'presentation_revision' THEN
   UPDATE public.exam_document_delivery SET status='pending',worker=NULL,lease_token=NULL,lease_until=NULL,
     attempts=greatest(attempts-1,0),next_attempt_at=now()+interval '1 minute',updated_at=now() WHERE id=t.id;
   PERFORM public.log_exam_document(d.id,'primary_group_deferred',jsonb_build_object('delivery_id',t.id,'reason',
     CASE WHEN snapshot->'eligible'='true'::jsonb THEN 'presentation_changed' ELSE snapshot->>'reason' END));
   RETURN jsonb_build_object('dispatch_allowed',false,'reason',CASE WHEN snapshot->'eligible'='true'::jsonb THEN 'presentation_changed' ELSE snapshot->>'reason' END);
 END IF;
 UPDATE public.exam_document_delivery SET status='uncertain',last_error='Primary submission started; reconcile before retry',lease_until=NULL,updated_at=now() WHERE id=t.id;
 PERFORM public.log_exam_document(d.id,'primary_group_dispatch_started',jsonb_build_object('delivery_id',t.id,'lease_token',t.lease_token,
   'content_sha256',p_content_sha256,'presentation_revision',p_presentation_revision,'primary',snapshot->'primary'));
 RETURN jsonb_build_object('dispatch_allowed',true,'delivery_id',t.id,'document_id',d.id,'destination_key',t.destination_key,
   'sha256',d.sha256,'presentation_revision',p_presentation_revision,'content_sha256',p_content_sha256);
END $$;
REVOKE ALL ON FUNCTION public.prepare_exam_group_dispatch(uuid,uuid), public.begin_exam_group_dispatch(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_exam_group_dispatch(uuid,uuid), public.begin_exam_group_dispatch(uuid,uuid,text,text) TO service_role;
COMMIT;
