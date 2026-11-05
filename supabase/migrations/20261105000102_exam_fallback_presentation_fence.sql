-- The safety sender may use identified fields only from a fresh, fenced snapshot.
-- Legacy three-argument dispatch remains available for its generic PDF caption.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
CREATE FUNCTION public.exam_fallback_group_dispatch_snapshot(p_document_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.exam_document; cfg public.exam_document_configuration; primary_state jsonb; document jsonb; fields jsonb;
BEGIN
 PERFORM public.require_exam_document_service();
 SELECT * INTO STRICT d FROM public.exam_document WHERE id=p_document_id;
 SELECT * INTO STRICT cfg FROM public.exam_document_configuration;
 IF NOT public.exam_fallback_group_eligible(d.id) THEN RETURN jsonb_build_object('eligible',false,'reason','fallback_document_ineligible'); END IF;
 primary_state:=public.exam_fallback_primary_state(d.id);
 IF primary_state->'eligible' IS DISTINCT FROM 'true'::jsonb THEN RETURN primary_state; END IF;
 document:=to_jsonb(d)||public.exam_document_responsibility_fields(d.id);
 fields:=public.exam_document_group_readiness(d.extracted_data,d.confirmed_data)->'fields';
 RETURN jsonb_build_object('eligible',true,'reason',primary_state->>'reason','primary',primary_state,'document',document,
   'configured_destination',cfg.group_destination_key,'notification_fields',fields,
   'presentation_revision',public.exam_group_presentation_revision(document,fields,cfg.group_destination_key));
END $$;
REVOKE ALL ON FUNCTION public.exam_fallback_group_dispatch_snapshot(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.prepare_exam_fallback_group_dispatch(p_delivery_id uuid,p_lease_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.exam_document; t public.exam_document_delivery; doc_id uuid; snapshot jsonb;
BEGIN
 PERFORM public.require_exam_document_service();
 SELECT document_id INTO STRICT doc_id FROM public.exam_document_delivery WHERE id=p_delivery_id;
 SELECT * INTO STRICT d FROM public.exam_document WHERE id=doc_id FOR NO KEY UPDATE;
 SELECT * INTO STRICT t FROM public.exam_document_delivery WHERE id=p_delivery_id FOR UPDATE;
 IF t.destination<>'group' OR t.lease_token IS DISTINCT FROM p_lease_token OR COALESCE(t.worker,'') !~ '^fallback:' THEN
   RAISE EXCEPTION 'Fallback preparation fence invalid' USING ERRCODE='PT409';
 END IF;
 IF d.deletion_state IS NOT NULL THEN RETURN jsonb_build_object('dispatch_ready',false,'reason','document_deleted'); END IF;
 IF t.status IN ('submitted','uncertain','sent') THEN RETURN jsonb_build_object('dispatch_ready',false,'reason','dispatch_already_started','status',t.status); END IF;
 IF t.status<>'reserved' OR t.lease_until IS NULL OR t.lease_until<=now() THEN RAISE EXCEPTION 'Fallback preparation lease expired' USING ERRCODE='PT409'; END IF;
 snapshot:=public.exam_fallback_group_dispatch_snapshot(d.id);
 IF snapshot->'eligible' IS DISTINCT FROM 'true'::jsonb OR t.destination_key IS DISTINCT FROM snapshot->>'configured_destination' THEN
   UPDATE public.exam_document_delivery SET status='pending',worker=NULL,lease_token=NULL,lease_until=NULL,
     attempts=greatest(attempts-1,0),next_attempt_at=now()+interval '1 minute',updated_at=now() WHERE id=t.id;
   PERFORM public.log_exam_document(d.id,'fallback_group_deferred',jsonb_build_object('delivery_id',t.id,'reason',COALESCE(snapshot->>'reason','destination_changed'),'primary',snapshot->'primary'));
   RETURN jsonb_build_object('dispatch_ready',false,'reason',COALESCE(snapshot->>'reason','destination_changed'));
 END IF;
 RETURN jsonb_build_object('dispatch_ready',true,'presentation_revision',snapshot->>'presentation_revision','primary',snapshot->'primary',
   'task',to_jsonb(t)||jsonb_build_object('document',snapshot->'document','configured_destination',snapshot->'configured_destination','notification_fields',snapshot->'notification_fields'));
END $$;
CREATE FUNCTION public.begin_exam_fallback_group_dispatch_v2(p_delivery_id uuid,p_lease_token uuid,p_presentation_revision text,p_content_sha256 text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.exam_document; t public.exam_document_delivery; doc_id uuid; snapshot jsonb; result jsonb;
BEGIN
 PERFORM public.require_exam_document_service();
 IF p_content_sha256 IS NULL OR p_content_sha256 !~ '^[a-f0-9]{64}$' OR p_presentation_revision IS NULL OR p_presentation_revision !~ '^[a-f0-9]{32}$' THEN RAISE EXCEPTION 'Invalid fallback presentation fingerprint'; END IF;
 SELECT document_id INTO STRICT doc_id FROM public.exam_document_delivery WHERE id=p_delivery_id;
 SELECT * INTO STRICT d FROM public.exam_document WHERE id=doc_id FOR NO KEY UPDATE;
 SELECT * INTO STRICT t FROM public.exam_document_delivery WHERE id=p_delivery_id FOR UPDATE;
 IF t.destination<>'group' OR t.lease_token IS DISTINCT FROM p_lease_token OR COALESCE(t.worker,'') !~ '^fallback:' THEN RAISE EXCEPTION 'Fallback dispatch fence invalid' USING ERRCODE='PT409'; END IF;
 IF d.deletion_state IS NOT NULL THEN RETURN jsonb_build_object('dispatch_allowed',false,'reason','document_deleted'); END IF;
 IF t.status IN ('submitted','uncertain','sent') THEN RETURN jsonb_build_object('dispatch_allowed',false,'reason','dispatch_already_started','status',t.status); END IF;
 IF t.status<>'reserved' OR t.lease_until IS NULL OR t.lease_until<=now() THEN RAISE EXCEPTION 'Fallback dispatch lease expired' USING ERRCODE='PT409'; END IF;
 snapshot:=public.exam_fallback_group_dispatch_snapshot(d.id);
 IF snapshot->'eligible' IS DISTINCT FROM 'true'::jsonb OR t.destination_key IS DISTINCT FROM snapshot->>'configured_destination'
   OR p_presentation_revision IS DISTINCT FROM snapshot->>'presentation_revision' THEN
   UPDATE public.exam_document_delivery SET status='pending',worker=NULL,lease_token=NULL,lease_until=NULL,
     attempts=greatest(attempts-1,0),next_attempt_at=now()+interval '1 minute',updated_at=now() WHERE id=t.id;
   PERFORM public.log_exam_document(d.id,'fallback_group_deferred',jsonb_build_object('delivery_id',t.id,'reason',
     CASE WHEN snapshot->'eligible'='true'::jsonb THEN 'presentation_changed' ELSE snapshot->>'reason' END,'primary',snapshot->'primary'));
   RETURN jsonb_build_object('dispatch_allowed',false,'reason',CASE WHEN snapshot->'eligible'='true'::jsonb THEN 'presentation_changed' ELSE snapshot->>'reason' END);
 END IF;
 -- Reuse the original one-shot fence under the same document/delivery locks.
 -- No claim, source scope, preservation proof or primary-priority rule is bypassed.
 result:=public.begin_exam_fallback_group_dispatch(p_delivery_id,p_lease_token,p_content_sha256);
 IF result->'dispatch_allowed'='true'::jsonb THEN
   PERFORM public.log_exam_document(d.id,'fallback_group_presentation_fenced',jsonb_build_object('delivery_id',t.id,'lease_token',t.lease_token,'presentation_revision',p_presentation_revision));
 END IF;
 RETURN result||jsonb_build_object('presentation_revision',p_presentation_revision);
END $$;
REVOKE ALL ON FUNCTION public.prepare_exam_fallback_group_dispatch(uuid,uuid),public.begin_exam_fallback_group_dispatch_v2(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_exam_fallback_group_dispatch(uuid,uuid),public.begin_exam_fallback_group_dispatch_v2(uuid,uuid,text,text) TO service_role;
COMMIT;
