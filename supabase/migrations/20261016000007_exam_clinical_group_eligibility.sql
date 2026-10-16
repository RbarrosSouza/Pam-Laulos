-- Preserve every PDF, but send to the exam group only with clinical indication.
-- Sender familiarity is not patient evidence: forwarded reports retain the same
-- exact identity, documentary evidence and human-review checks as direct reports.
-- No activation, history rewrite or credential changes.
BEGIN;

CREATE OR REPLACE FUNCTION public.auto_link_exam_document(p_document_id uuid,p_extraction jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.exam_document; fields jsonb; evidence jsonb; tutor text; pet_name text;
  matches integer; matched_pet uuid; reason text; ev record;
BEGIN
  PERFORM public.require_exam_document_service();
  SELECT * INTO STRICT d FROM public.exam_document WHERE id=p_document_id FOR NO KEY UPDATE;
  IF d.pet_id IS NOT NULL OR d.canonical_document_id IS NOT NULL OR d.file_status<>'saved' OR d.confirmed_data<>'{}'::jsonb
    OR EXISTS(SELECT 1 FROM public.exam_document_event WHERE document_id=d.id AND event_type='reviewed' AND actor_id IS NOT NULL) THEN RETURN; END IF;
  fields:=p_extraction->'fields'; evidence:=COALESCE(p_extraction->'evidence','[]'::jsonb);
  tutor:=public.normalize_exam_identity(COALESCE(fields->>'client_name',fields->>'tutor_name'));
  pet_name:=public.normalize_exam_identity(fields->>'pet_name');
  IF p_extraction->>'classification' IS DISTINCT FROM 'exam' OR p_extraction->'single_patient' IS DISTINCT FROM 'true'::jsonb
    OR tutor='' OR pet_name='' OR NULLIF(trim(fields->>'exam_type'),'') IS NULL OR NULLIF(fields->>'exam_date','') IS NULL THEN
    RETURN;
  END IF;
  -- The worker validates quotes against the PDF pages; here identities must also have their own nonempty quoted evidence.
  FOR ev IN SELECT * FROM (VALUES ('client_name',tutor),('pet_name',pet_name),('exam_type',public.normalize_exam_identity(fields->>'exam_type'))) AS expected(field,value) LOOP
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(evidence) e
      WHERE (e->>'field'=ev.field OR (ev.field='client_name' AND e->>'field'='tutor_name'))
        AND e->>'page' ~ '^[1-9][0-9]*$'
        AND strpos(' '||public.normalize_exam_identity(regexp_replace(e->>'excerpt','[[:punct:]]',' ','g'))||' ',
          ' '||public.normalize_exam_identity(regexp_replace(ev.value,'[[:punct:]]',' ','g'))||' ')>0) THEN RETURN; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(evidence) e WHERE e->>'field'='exam_date'
    AND e->>'page' ~ '^[1-9][0-9]*$'
    AND public.exam_document_date_evidence_matches(e->>'excerpt',fields->>'exam_date')) THEN RETURN; END IF;
  IF (fields->>'exam_date')::date>current_date+1 THEN RETURN; END IF;
  -- Exact comparison only: no fuzzy names, substring search, guessed IDs or first-result selection.
  SELECT count(*),min(p.id::text)::uuid INTO matches,matched_pet
    FROM public.pets p JOIN public.clients c ON c."Código"=p.client_code
    WHERE public.normalize_exam_identity(p.name)=pet_name AND public.normalize_exam_identity(c."Nome")=tutor;
  IF matches<>1 THEN
    reason:=CASE WHEN matches=0 THEN 'Tutor e pet não encontrados juntos no cadastro. Selecione o paciente no Pam Laudos.'
      ELSE 'Mais de um cadastro corresponde ao tutor e pet. Selecione o paciente no Pam Laudos.' END;
    UPDATE public.exam_document SET identification_status='review',review_reason=reason WHERE id=d.id;
    PERFORM public.log_exam_document(d.id,'identification_pending',jsonb_build_object('reason',CASE WHEN matches=0 THEN 'no_exact_pair' ELSE 'ambiguous_exact_pair' END));
    RETURN;
  END IF;
  IF d.previous_document_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.exam_document WHERE id=d.previous_document_id AND pet_id IS DISTINCT FROM matched_pet) THEN RETURN; END IF;
  PERFORM public.apply_exam_document_link(d.id,matched_pet,'{}'::uuid[],d.version,
    fields||jsonb_build_object('client_name',COALESCE(fields->>'client_name',fields->>'tutor_name')),NULL,'automatic');
END;
$$;

CREATE OR REPLACE FUNCTION public.update_exam_document_extraction(p_document_id uuid,p_extraction jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_doc public.exam_document; v_class text; v_release boolean; v_task public.exam_document_delivery; v_human_review boolean;
BEGIN
  PERFORM public.require_exam_document_service();
  SELECT * INTO STRICT v_doc FROM public.exam_document WHERE id=p_document_id FOR NO KEY UPDATE;
  IF v_doc.file_status<>'saved' THEN RAISE EXCEPTION 'Preserve o original antes de extrair'; END IF;
  SELECT * INTO STRICT v_task FROM public.exam_document_delivery WHERE id=(p_extraction->>'delivery_id')::uuid AND document_id=v_doc.id AND destination='processing' FOR UPDATE;
  IF v_task.status<>'reserved' OR v_task.lease_token::text IS DISTINCT FROM p_extraction->>'lease_token' OR v_task.lease_until<=now() THEN
    RAISE EXCEPTION 'Reserva de processamento inválida/expirada' USING ERRCODE='40001'; END IF;
  IF jsonb_typeof(p_extraction->'fields') IS DISTINCT FROM 'object' OR jsonb_typeof(COALESCE(p_extraction->'evidence','[]'))<>'array' THEN
    RAISE EXCEPTION 'Extração deve conter fields objeto e evidence lista'; END IF;
  v_class := p_extraction->>'classification';
  IF v_class NOT IN ('exam','review','not_exam') OR v_class IS NULL OR NULLIF(p_extraction->>'extractor_version','') IS NULL THEN RAISE EXCEPTION 'Classificação e versão do extrator obrigatórias'; END IF;
  -- Parse dates only when explicitly supplied. Impossible dates fail; absence remains NULL.
  IF NULLIF(p_extraction->'fields'->>'exam_date','') IS NOT NULL THEN PERFORM (p_extraction->'fields'->>'exam_date')::date; END IF;
  v_release := v_class='exam' AND COALESCE((p_extraction->>'single_patient')::boolean,false)
    AND NULLIF(trim(p_extraction->'fields'->>'pet_name'),'') IS NOT NULL
    AND NULLIF(trim(COALESCE(p_extraction->'fields'->>'client_name',p_extraction->'fields'->>'tutor_name')),'') IS NOT NULL;
  -- A processing lease never supersedes a later explicit human review, including empty fields/not_exam.
  v_human_review:=EXISTS(SELECT 1 FROM public.exam_document_event WHERE document_id=v_doc.id AND event_type='reviewed' AND actor_id IS NOT NULL);
  UPDATE public.exam_document SET extracted_data=p_extraction->'fields',evidence=COALESCE(p_extraction->'evidence','[]'),
    extractor_version=p_extraction->>'extractor_version',drive_name=COALESCE(p_extraction->>'drive_name',drive_name),
    identification_status=CASE WHEN v_human_review THEN identification_status WHEN identification_status='confirmed' THEN 'confirmed' WHEN v_class='not_exam' THEN 'not_exam' WHEN v_release THEN 'suggested' ELSE 'review' END,
    review_reason=CASE WHEN v_human_review THEN review_reason ELSE p_extraction->>'review_reason' END,
    group_release_at=CASE WHEN v_human_review THEN group_release_at WHEN v_class<>'not_exam' THEN COALESCE(group_release_at,now()) ELSE NULL END
    WHERE id=v_doc.id RETURNING * INTO v_doc;
  IF NOT v_human_review AND v_class<>'not_exam' THEN INSERT INTO public.exam_document_delivery(document_id,destination) SELECT v_doc.id,'group' WHERE NOT EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=v_doc.id AND destination='group') AND NOT EXISTS(SELECT 1 FROM public.exam_document WHERE id=v_doc.id AND group_exception_reason IS NOT NULL) ON CONFLICT DO NOTHING; END IF;
  PERFORM public.log_exam_document(v_doc.id,'extraction_updated',jsonb_build_object('classification',v_class,'extractor_version',v_doc.extractor_version,'released',v_release AND NOT v_human_review,'human_review_preserved',v_human_review));
  IF NOT v_human_review THEN PERFORM public.auto_link_exam_document(v_doc.id,p_extraction); END IF;
  SELECT * INTO STRICT v_doc FROM public.exam_document WHERE id=v_doc.id;
  RETURN jsonb_build_object('document_id',v_doc.id,'document',to_jsonb(v_doc));
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_exam_document_delivery(p_destination text,p_worker text,p_limit integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_config public.exam_document_configuration; v_tasks jsonb;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_destination NOT IN ('drive','processing','group','nexus') OR NULLIF(p_worker,'') IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'Reserva inválida'; END IF;
  SELECT * INTO STRICT v_config FROM public.exam_document_configuration;
  IF NOT p_destination=ANY(v_config.enabled_destinations) THEN RETURN jsonb_build_object('tasks','[]'::jsonb,'paused',true); END IF;
  WITH candidates AS (
    SELECT t.id FROM public.exam_document_delivery t JOIN public.exam_document d ON d.id=t.document_id
    LEFT JOIN LATERAL (
      SELECT e.event_type,e.details FROM public.exam_document_event e
      WHERE e.document_id=d.id AND e.actor_id IS NOT NULL AND e.event_type IN ('reviewed','link_confirmed')
      ORDER BY e.id DESC LIMIT 1
    ) human_decision ON true
    LEFT JOIN LATERAL (
      SELECT e.details FROM public.exam_document_event e
      WHERE e.document_id=d.id AND e.event_type='extraction_updated'
      ORDER BY e.id DESC LIMIT 1
    ) extraction ON true
    WHERE t.destination=p_destination AND t.status IN ('pending','failed') AND t.attempts<t.max_attempts AND t.next_attempt_at<=now()
      AND d.canonical_document_id IS NULL AND d.identification_status<>'not_exam'
      AND (p_destination='drive' OR d.file_status='saved')
      AND (p_destination<>'group' OR (d.group_release_at IS NOT NULL
        AND d.group_exception_reason IS NULL
        -- Clinical evidence gates the group, not a matching patient record.
        -- A later human decision overrides earlier hints/extraction; absent one,
        -- an explicit extraction review rejects the early subject hint.
        AND CASE
          WHEN human_decision.event_type='link_confirmed' THEN true
          WHEN human_decision.event_type='reviewed' THEN human_decision.details->>'classification'='exam'
          WHEN extraction.details IS NOT NULL THEN
            extraction.details->>'classification'='exam'
            AND NULLIF(trim(d.extracted_data->>'exam_type'),'') IS NOT NULL
            AND EXISTS(SELECT 1 FROM jsonb_array_elements(d.evidence) ev
              WHERE ev->>'field'='exam_type' AND ev->>'page' ~ '^[1-9][0-9]*$'
                AND strpos(' '||public.normalize_exam_identity(regexp_replace(ev->>'excerpt','[[:punct:]]',' ','g'))||' ',
                  ' '||public.normalize_exam_identity(regexp_replace(d.extracted_data->>'exam_type','[[:punct:]]',' ','g'))||' ')>0)
          ELSE EXISTS(SELECT 1 FROM public.exam_document_source s
            WHERE s.document_id=d.id AND s.metadata->'exam_candidate'='true'::jsonb)
        END
        AND v_config.notification_cutoff IS NOT NULL AND d.received_at>=v_config.notification_cutoff AND NULLIF(v_config.group_destination_key,'') IS NOT NULL
        AND t.destination_key IN ('default',v_config.group_destination_key)))
      AND (p_destination<>'nexus' OR (d.identification_status='confirmed' AND d.pet_id IS NOT NULL AND NULLIF(d.confirmed_data->>'exam_date','') IS NOT NULL))
    ORDER BY t.created_at FOR UPDATE OF t SKIP LOCKED LIMIT p_limit
  ), claimed AS (
    UPDATE public.exam_document_delivery t SET status='reserved',worker=p_worker,lease_token=gen_random_uuid(),lease_until=now()+interval '10 minutes',
      destination_key=CASE WHEN t.destination='group' AND t.destination_key='default' THEN v_config.group_destination_key ELSE t.destination_key END,
      attempts=attempts+1,updated_at=now() FROM candidates WHERE t.id=candidates.id RETURNING t.*
  ) SELECT COALESCE(jsonb_agg(to_jsonb(c)||jsonb_build_object('document',to_jsonb(d),'configured_destination',v_config.group_destination_key)),'[]') INTO v_tasks
      FROM claimed c JOIN public.exam_document d ON d.id=c.document_id;
  RETURN jsonb_build_object('tasks',v_tasks,'paused',false);
END;
$$;
REVOKE ALL ON FUNCTION public.auto_link_exam_document(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
-- Existing service-only RPC grants are preserved by CREATE OR REPLACE.
COMMIT;
