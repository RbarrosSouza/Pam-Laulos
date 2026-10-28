BEGIN;

DO $$ BEGIN
  IF to_regclass('public.exam_intake_document_hold') IS NULL
    OR to_regprocedure('public.release_exam_intake_hold(uuid,text,text)') IS NULL
    OR to_regprocedure('public.mark_exam_document_correction(uuid,uuid,bigint,text)') IS NULL THEN
    RAISE EXCEPTION 'Install the protected intake holds and clinical version guard before version review';
  END IF;
END $$;
CREATE TEMP TABLE exam_intake_review_release_before ON COMMIT DROP AS
SELECT proowner,proacl FROM pg_proc WHERE oid='public.release_exam_intake_hold(uuid,text,text)'::regprocedure;

CREATE FUNCTION public.get_exam_intake_version_review(p_document_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor uuid; current_doc public.exam_document; previous_doc public.exam_document; hold public.exam_intake_document_hold;
  previous_id uuid; walk_id uuid; walk_previous uuid; visited uuid[]:='{}'; depth integer:=0;
  allowed boolean; can_link boolean:=false; blocked text; decision jsonb; current_json jsonb; previous_json jsonb;
  item record; item_doc public.exam_document; item_json jsonb; group_state text;
BEGIN
  actor:=public.require_exam_document_member();
  SELECT * INTO STRICT current_doc FROM public.exam_document WHERE id=p_document_id;
  SELECT * INTO hold FROM public.exam_intake_document_hold WHERE document_id=current_doc.id;
  previous_id:=COALESCE(hold.previous_document_id,current_doc.previous_document_id);
  IF previous_id IS NOT NULL THEN SELECT * INTO previous_doc FROM public.exam_document WHERE id=previous_id; END IF;
  SELECT jsonb_build_object('reason_code',e.details->>'reason_code','reviewed_at',e.created_at) INTO decision
    FROM public.exam_document_event e WHERE e.document_id=current_doc.id AND e.event_type IN ('intake_version_reviewed','intake_version_review_inconclusive')
    ORDER BY e.created_at DESC,e.id DESC LIMIT 1;
  allowed:=EXISTS(SELECT 1 FROM public.exam_document_member WHERE user_id=actor AND active AND role IN ('admin','vet'))
    AND hold.state='held' AND hold.reason IN ('changed_content_review','historical_snapshot_unavailable')
    AND current_doc.canonical_document_id IS NULL AND current_doc.file_status='saved' AND current_doc.sha256 IS NOT NULL;
  IF hold.document_id IS NULL THEN blocked:='no_version_hold';
  ELSIF hold.state<>'held' THEN blocked:='version_already_reviewed';
  ELSIF hold.reason NOT IN ('changed_content_review','historical_snapshot_unavailable') THEN blocked:='hold_not_reviewable';
  ELSIF current_doc.canonical_document_id IS NOT NULL OR current_doc.file_status<>'saved' OR current_doc.sha256 IS NULL THEN blocked:='current_original_not_preserved';
  ELSIF previous_doc.id IS NULL OR previous_doc.id=current_doc.id THEN blocked:='previous_document_missing';
  ELSIF previous_doc.canonical_document_id IS NOT NULL OR previous_doc.file_status<>'saved' OR previous_doc.sha256 IS NULL THEN blocked:='previous_original_not_preserved';
  ELSIF current_doc.sha256=previous_doc.sha256 THEN blocked:='same_content';
  ELSIF current_doc.pet_id IS NOT NULL AND current_doc.pet_id IS DISTINCT FROM previous_doc.pet_id THEN blocked:='patient_conflict';
  ELSIF current_doc.pet_id IS NOT NULL THEN blocked:='current_patient_already_linked';
  ELSIF current_doc.previous_document_id IS NOT NULL THEN blocked:='current_previous_already_set';
  ELSIF previous_doc.pet_id IS NULL OR previous_doc.identification_status<>'confirmed' THEN blocked:='previous_patient_not_confirmed';
  ELSE
    walk_id:=previous_doc.id;
    WHILE walk_id IS NOT NULL LOOP
      IF walk_id=current_doc.id OR walk_id=ANY(visited) OR depth>=256 THEN blocked:='version_lineage_unresolved';EXIT; END IF;
      visited:=array_append(visited,walk_id);depth:=depth+1;
      SELECT previous_document_id INTO walk_previous FROM public.exam_document WHERE id=walk_id;
      IF NOT FOUND THEN blocked:='version_lineage_unresolved';EXIT; END IF;
      walk_id:=walk_previous;
    END LOOP;
    can_link:=blocked IS NULL;
  END IF;
  FOR item IN SELECT * FROM (VALUES('current',current_doc.id),('previous',previous_doc.id)) x(kind,id) LOOP
    IF item.id IS NULL THEN CONTINUE; END IF;
    SELECT * INTO STRICT item_doc FROM public.exam_document WHERE id=item.id;
    group_state:=CASE
      WHEN EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=item.id AND destination='group' AND status='sent') THEN 'sent'
      WHEN EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=item.id AND destination='group' AND status='uncertain') THEN 'uncertain'
      WHEN EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=item.id AND destination='group' AND status='submitted') THEN 'submitted'
      WHEN EXISTS(SELECT 1 FROM public.exam_intake_document_hold WHERE document_id=item.id AND state='held') THEN 'held'
      WHEN EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=item.id AND destination='group' AND status='reserved') THEN 'reserved'
      WHEN EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=item.id AND destination='group' AND status='failed') THEN 'failed'
      WHEN EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=item.id AND destination='group' AND status='waived') OR item_doc.group_exception_reason IS NOT NULL THEN 'waived'
      WHEN EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=item.id AND destination='group') THEN 'pending'
      ELSE 'not_queued' END;
    item_json:=jsonb_build_object('document_id',item_doc.id,'original_name',item_doc.original_name,'sha256',item_doc.sha256,'file_status',item_doc.file_status,'group_status',group_state);
    IF item.kind='current' THEN current_json:=item_json;ELSE previous_json:=item_json;END IF;
  END LOOP;
  RETURN jsonb_build_object('contract','exam_intake_version_review_v1','document_id',current_doc.id,
    'hold',CASE WHEN hold.document_id IS NULL THEN NULL ELSE jsonb_build_object('state',hold.state,'reason',hold.reason,'previous_document_id',hold.previous_document_id,'created_at',hold.created_at,'released_at',hold.released_at) END,
    'current',current_json,'previous',previous_json,'review_allowed',COALESCE(allowed,false),'can_link_previous',can_link,'blocking_reason',blocked,'decision',decision);
END $$;
REVOKE ALL ON FUNCTION public.get_exam_intake_version_review(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_exam_intake_version_review(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.release_exam_intake_hold(p_document_id uuid,p_expected_sha256 text,p_reason_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor uuid; doc public.exam_document; hold public.exam_intake_document_hold; previous_id uuid; review jsonb; existing_decision text;
BEGIN
  actor:=public.require_exam_document_member(ARRAY['admin','vet']);
  IF p_reason_code IS NULL OR p_reason_code NOT IN ('clinical_complement_confirmed','clinical_correction_confirmed','inconclusive') THEN
    RAISE EXCEPTION 'INTAKE_VERSION_DECISION_INVALID' USING ERRCODE='22023';
  END IF;
  SELECT previous_document_id INTO previous_id FROM public.exam_intake_document_hold WHERE document_id=p_document_id;
  PERFORM 1 FROM public.exam_document WHERE id IN(p_document_id,previous_id) ORDER BY id FOR NO KEY UPDATE;
  SELECT * INTO STRICT doc FROM public.exam_document WHERE id=p_document_id;
  SELECT * INTO STRICT hold FROM public.exam_intake_document_hold WHERE document_id=doc.id FOR UPDATE;
  IF hold.previous_document_id IS DISTINCT FROM previous_id THEN RAISE EXCEPTION 'INTAKE_VERSION_HOLD_CHANGED' USING ERRCODE='40001';END IF;
  IF p_expected_sha256 IS NULL OR p_expected_sha256 !~ '^[a-f0-9]{64}$' OR doc.sha256 IS DISTINCT FROM p_expected_sha256
    OR doc.file_status<>'saved' OR doc.canonical_document_id IS NOT NULL OR hold.reason NOT IN ('changed_content_review','historical_snapshot_unavailable') THEN
    RAISE EXCEPTION 'INTAKE_VERSION_ORIGINAL_CHANGED' USING ERRCODE='40001';
  END IF;
  SELECT details->>'reason_code' INTO existing_decision FROM public.exam_document_event
    WHERE document_id=doc.id AND event_type IN ('intake_version_reviewed','intake_version_review_inconclusive')
    ORDER BY created_at DESC,id DESC LIMIT 1;
  IF hold.state='released' THEN
    IF p_reason_code IN ('clinical_complement_confirmed','clinical_correction_confirmed') AND existing_decision=p_reason_code
      AND doc.previous_document_id=hold.previous_document_id THEN
      RETURN jsonb_build_object('document_id',doc.id,'hold_released',true,'already_released',true);
    END IF;
    RAISE EXCEPTION 'INTAKE_VERSION_DECISION_ALREADY_RECORDED' USING ERRCODE='40001';
  END IF;
  IF p_reason_code='inconclusive' THEN
    IF existing_decision IS DISTINCT FROM p_reason_code THEN
      INSERT INTO public.exam_document_event(document_id,event_type,actor_id,details) VALUES(doc.id,'intake_version_review_inconclusive',actor,
        jsonb_build_object('reason_code',p_reason_code,'sha256',doc.sha256,'previous_document_id',hold.previous_document_id));
    END IF;
    RETURN jsonb_build_object('document_id',doc.id,'hold_released',false,'review_recorded',true);
  END IF;
  review:=public.get_exam_intake_version_review(doc.id);
  IF review->>'can_link_previous' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'INTAKE_VERSION_REVIEW_BLOCKED:%',review->>'blocking_reason' USING ERRCODE='23514';
  END IF;
  -- Reuse the existing clinical guard. It rejects an identified current patient,
  -- an unconfirmed previous patient, existing links, aliases, equal SHA and cycles.
  PERFORM public.mark_exam_document_correction(doc.id,hold.previous_document_id,doc.version,p_reason_code);
  SELECT * INTO STRICT doc FROM public.exam_document WHERE id=doc.id;
  IF doc.previous_document_id IS DISTINCT FROM hold.previous_document_id OR doc.sha256 IS DISTINCT FROM p_expected_sha256 THEN
    RAISE EXCEPTION 'INTAKE_VERSION_LINK_UNPROVEN' USING ERRCODE='40001';
  END IF;
  UPDATE public.exam_intake_document_hold SET state='released',released_at=now(),released_by=actor WHERE document_id=doc.id;
  INSERT INTO public.exam_document_event(document_id,event_type,actor_id,details) VALUES(doc.id,'intake_version_reviewed',actor,
    jsonb_build_object('reason_code',p_reason_code,'sha256',doc.sha256,'previous_document_id',hold.previous_document_id));
  UPDATE public.exam_intake_incident SET state='resolved',resolved_at=now() WHERE document_id=doc.id
    AND code IN ('linked_result_content_requires_review','historical_link_snapshot_unavailable') AND state<>'resolved';
  RETURN jsonb_build_object('document_id',doc.id,'hold_released',true,'previous_document_id',hold.previous_document_id);
END $$;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM exam_intake_review_release_before b JOIN pg_proc p ON p.oid='public.release_exam_intake_hold(uuid,text,text)'::regprocedure
    WHERE p.proowner<>b.proowner OR p.proacl IS DISTINCT FROM b.proacl) THEN RAISE EXCEPTION 'Version review release owner or ACL changed'; END IF;
END $$;

COMMIT;
