BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
-- Optional, low-priority measurement. No trigger or write on clinical delivery.
CREATE TABLE public.exam_jev_observer_configuration (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 enabled boolean NOT NULL DEFAULT false,
 observe_after timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.exam_jev_observer_configuration DEFAULT VALUES;
CREATE TABLE public.exam_jev_observation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 document_id uuid NOT NULL REFERENCES public.exam_document(id) ON DELETE CASCADE,
 extraction_event_id bigint NOT NULL UNIQUE REFERENCES public.exam_document_event(id) ON DELETE CASCADE,
 document_sha256 text NOT NULL,observer_version text NOT NULL DEFAULT 'jev-routing-v1',
 status text NOT NULL CHECK(status IN ('reserved','started','completed','skipped','failed','uncertain')),
 worker text NOT NULL,lease_token uuid NOT NULL,lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,finished_at timestamptz,
 route text CHECK(route IN ('hopelab_parser_candidate','general_extraction','manual_review_candidate')),
 confidence double precision CHECK(confidence>=0 AND confidence<=1),
 cost_usd numeric CHECK(cost_usd>=0),duration_ms integer CHECK(duration_ms>=0 AND duration_ms<=180000),
 model text,error_code text,
 UNIQUE(document_id,document_sha256,observer_version)
);
ALTER TABLE public.exam_jev_observer_configuration ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_jev_observation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.exam_jev_observer_configuration,public.exam_jev_observation FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.exam_jev_observer_configuration,public.exam_jev_observation TO service_role;

CREATE FUNCTION public.exam_jev_primary_busy() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.exam_pipeline_worker WHERE lease_until>now())
 OR EXISTS(SELECT 1 FROM public.exam_document_delivery t JOIN public.exam_document d ON d.id=t.document_id
   WHERE d.deletion_state IS NULL AND d.canonical_document_id IS NULL AND (
     t.status='reserved' AND t.lease_until>now()
     OR t.status IN ('pending','failed') AND t.attempts<t.max_attempts AND t.next_attempt_at<=now()
       AND d.identification_status<>'not_exam'
       AND EXISTS(SELECT 1 FROM public.exam_document_configuration cfg WHERE t.destination=ANY(cfg.enabled_destinations))
       AND (t.destination='drive' OR t.destination='processing' AND d.file_status='saved'
         OR t.destination='group' AND public.exam_document_group_dispatch_snapshot(d.id)->'eligible'='true'::jsonb
         OR t.destination='nexus' AND d.file_status='saved' AND d.identification_status='confirmed' AND d.pet_id IS NOT NULL AND NULLIF(d.confirmed_data->>'exam_date','') IS NOT NULL)));
$$;
REVOKE ALL ON FUNCTION public.exam_jev_primary_busy() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.reserve_exam_jev_observation(p_worker text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cfg public.exam_jev_observer_configuration; candidate record; observation public.exam_jev_observation;
BEGIN
 PERFORM public.require_exam_document_service();
 IF p_worker IS NULL OR p_worker!~'^[A-Za-z0-9_.:-]{1,160}$' THEN RAISE EXCEPTION 'Observer worker invalid' USING ERRCODE='PT400'; END IF;
 SELECT * INTO STRICT cfg FROM public.exam_jev_observer_configuration FOR UPDATE;
 IF NOT cfg.enabled THEN RETURN jsonb_build_object('task',NULL,'paused',true); END IF;
 -- One attempt per extraction event, including crashes and unknown responses.
 UPDATE public.exam_jev_observation SET status=CASE WHEN status='started' THEN 'uncertain' ELSE 'failed' END,
   error_code='lease_expired_no_retry',lease_until=NULL,finished_at=now()
   WHERE status IN ('reserved','started') AND lease_until<=now();
 IF EXISTS(SELECT 1 FROM public.exam_jev_observation WHERE status IN ('reserved','started') AND lease_until>now())
   OR public.exam_jev_primary_busy() THEN RETURN jsonb_build_object('task',NULL,'busy',true); END IF;
 SELECT e.id AS event_id,d.id AS document_id,d.drive_file_id,d.sha256,d.size_bytes INTO candidate
 FROM public.exam_document_event e JOIN public.exam_document d ON d.id=e.document_id
 WHERE e.event_type='extraction_updated' AND e.created_at>=cfg.observe_after
   AND d.file_status='saved' AND d.size_bytes BETWEEN 1 AND 2097152 AND d.drive_file_id IS NOT NULL
   AND d.deletion_state IS NULL AND d.canonical_document_id IS NULL AND d.identification_status<>'not_exam'
   AND EXISTS(SELECT 1 FROM public.exam_document_delivery t WHERE t.document_id=d.id AND t.destination='processing' AND t.status='completed')
   AND NOT EXISTS(SELECT 1 FROM public.exam_document_event newer WHERE newer.document_id=d.id AND newer.event_type='extraction_updated' AND newer.id>e.id)
   AND NOT EXISTS(SELECT 1 FROM public.exam_jev_observation done WHERE done.document_id=d.id AND done.document_sha256=d.sha256 AND done.observer_version='jev-routing-v1')
 ORDER BY e.id LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('task',NULL); END IF;
 INSERT INTO public.exam_jev_observation(document_id,extraction_event_id,document_sha256,status,worker,lease_token,lease_until)
 VALUES(candidate.document_id,candidate.event_id,candidate.sha256,'reserved',p_worker,gen_random_uuid(),now()+interval '3 minutes') RETURNING * INTO observation;
 RETURN jsonb_build_object('task',to_jsonb(observation)||jsonb_build_object('document',jsonb_build_object(
   'id',candidate.document_id,'drive_file_id',candidate.drive_file_id,'sha256',candidate.sha256,'size_bytes',candidate.size_bytes)));
END;
$$;

CREATE FUNCTION public.begin_exam_jev_observation(p_observation_id uuid,p_lease_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE observation public.exam_jev_observation; reason text;
BEGIN
 PERFORM public.require_exam_document_service();
 SELECT * INTO STRICT observation FROM public.exam_jev_observation WHERE id=p_observation_id FOR UPDATE;
 IF observation.lease_token IS DISTINCT FROM p_lease_token THEN RAISE EXCEPTION 'Observer fence invalid' USING ERRCODE='PT409'; END IF;
 IF observation.status<>'reserved' THEN RETURN jsonb_build_object('allowed',false,'reason','already_attempted'); END IF;
 IF observation.lease_until<=now() THEN reason:='lease_expired_no_retry';
 ELSIF NOT (SELECT enabled FROM public.exam_jev_observer_configuration) THEN reason:='observer_paused';
 ELSIF public.exam_jev_primary_busy() THEN reason:='primary_preempted';
 ELSIF NOT EXISTS(SELECT 1 FROM public.exam_document d WHERE d.id=observation.document_id AND d.deletion_state IS NULL AND d.canonical_document_id IS NULL AND d.identification_status<>'not_exam')
   OR EXISTS(SELECT 1 FROM public.exam_document_event e WHERE e.document_id=observation.document_id AND e.event_type='extraction_updated' AND e.id>observation.extraction_event_id) THEN reason:='document_changed'; END IF;
 IF reason IS NOT NULL THEN
   UPDATE public.exam_jev_observation SET status='skipped',error_code=reason,lease_until=NULL,finished_at=now() WHERE id=observation.id;
   RETURN jsonb_build_object('allowed',false,'reason',reason);
 END IF;
 UPDATE public.exam_jev_observation SET status='started',started_at=now() WHERE id=observation.id;
 RETURN jsonb_build_object('allowed',true,'observation_id',observation.id);
END;
$$;

CREATE FUNCTION public.complete_exam_jev_observation(p_observation_id uuid,p_lease_token uuid,p_outcome jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE observation public.exam_jev_observation; result_status text:=p_outcome->>'status';
BEGIN
 PERFORM public.require_exam_document_service();
 SELECT * INTO STRICT observation FROM public.exam_jev_observation WHERE id=p_observation_id FOR UPDATE;
 IF observation.lease_token IS DISTINCT FROM p_lease_token THEN RAISE EXCEPTION 'Observer fence invalid' USING ERRCODE='PT409'; END IF;
 IF observation.status NOT IN ('reserved','started') THEN RETURN jsonb_build_object('recorded',true,'already_finished',true,'status',observation.status); END IF;
 IF observation.lease_until<=now() THEN RAISE EXCEPTION 'Observer lease expired' USING ERRCODE='PT409'; END IF;
 IF result_status IS NULL OR result_status NOT IN ('completed','skipped','failed','uncertain') THEN RAISE EXCEPTION 'Observer result invalid' USING ERRCODE='PT400'; END IF;
 IF result_status='completed' AND (observation.status<>'started' OR p_outcome->>'model' IS NULL
   OR p_outcome->>'model'!~'^typesafe/jev-1[.]14(-[0-9]{8})?$'
   OR p_outcome->>'route' IS NULL OR p_outcome->>'route' NOT IN ('hopelab_parser_candidate','general_extraction','manual_review_candidate')
   OR jsonb_typeof(p_outcome->'confidence') IS DISTINCT FROM 'number'
   OR (p_outcome->>'confidence')::double precision NOT BETWEEN 0 AND 1) THEN RAISE EXCEPTION 'Observer decision invalid' USING ERRCODE='PT400'; END IF;
 IF p_outcome->>'error_code' IS NOT NULL AND p_outcome->>'error_code'!~'^[A-Za-z0-9_:-]{1,100}$' THEN RAISE EXCEPTION 'Observer error code invalid' USING ERRCODE='PT400'; END IF;
 UPDATE public.exam_jev_observation SET status=result_status,finished_at=now(),lease_until=NULL,
   route=CASE WHEN result_status='completed' THEN p_outcome->>'route' END,
   confidence=CASE WHEN result_status='completed' THEN (p_outcome->>'confidence')::double precision END,
   cost_usd=CASE WHEN result_status='completed' AND jsonb_typeof(p_outcome->'cost_usd')='number' THEN (p_outcome->>'cost_usd')::numeric END,
   duration_ms=(p_outcome->>'duration_ms')::integer,
   model=CASE WHEN result_status='completed' THEN p_outcome->>'model' END,error_code=p_outcome->>'error_code'
 WHERE id=observation.id;
 RETURN jsonb_build_object('recorded',true,'status',result_status);
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_exam_jev_observation(text),public.begin_exam_jev_observation(uuid,uuid),public.complete_exam_jev_observation(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_exam_jev_observation(text),public.begin_exam_jev_observation(uuid,uuid),public.complete_exam_jev_observation(uuid,uuid,jsonb) TO service_role;
COMMIT;
