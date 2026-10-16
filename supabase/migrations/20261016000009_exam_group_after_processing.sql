-- Wait for the actual PDF processing and all four identification fields before
-- reserving a group notification. No historical task is reopened or resent.
BEGIN;

-- Internal pure projection: partial confirmation inherits only absent keys.
-- Explicit human null/blank overrides extraction and leaves that field pending.
CREATE OR REPLACE FUNCTION public.exam_document_group_readiness(p_extracted jsonb,p_confirmed jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE fields jsonb:='{}'; missing text[]:='{}'; k text; label text; value text; checked_date date;
BEGIN
  FOR k,label IN SELECT * FROM (VALUES ('pet_name','pet'),('client_name','tutor'),
    ('exam_type','tipo de exame'),('exam_date','data de realização')) AS required(field,label) LOOP
    -- Key presence is intentional: an explicit human null/blank rejects the
    -- extracted value. Only an absent confirmation key may fall back.
    IF p_confirmed ? k THEN
      value:=CASE WHEN jsonb_typeof(p_confirmed->k)='string' THEN NULLIF(trim(p_confirmed->>k),'') END;
    ELSIF k='client_name' AND p_confirmed ? 'tutor_name' THEN
      value:=CASE WHEN jsonb_typeof(p_confirmed->'tutor_name')='string' THEN NULLIF(trim(p_confirmed->>'tutor_name'),'') END;
    ELSE
      value:=CASE WHEN jsonb_typeof(p_extracted->k)='string' THEN NULLIF(trim(p_extracted->>k),'') END;
      IF value IS NULL AND k='client_name' AND jsonb_typeof(p_extracted->'tutor_name')='string' THEN
        value:=NULLIF(trim(p_extracted->>'tutor_name'),'');
      END IF;
    END IF;
    IF value IS NOT NULL AND k<>'exam_date' AND value !~ '[[:alnum:]]' THEN value:=NULL; END IF;
    IF value IS NOT NULL AND k='exam_date' THEN
      IF value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN value:=NULL;
      ELSE
        BEGIN
          checked_date:=value::date;
          IF to_char(checked_date,'YYYY-MM-DD')<>value THEN value:=NULL; END IF;
        EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN value:=NULL;
        END;
      END IF;
    END IF;
    IF value IS NULL THEN missing:=array_append(missing,label); END IF;
    fields:=fields||jsonb_build_object(k,value);
  END LOOP;
  RETURN jsonb_build_object('fields',fields,'ready',cardinality(missing)=0,'missing',to_jsonb(missing),
    'reason',CASE WHEN cardinality(missing)>0 THEN
      'Dados pendentes para envio ao grupo: '||array_to_string(missing,', ')||'. Confira o PDF e complete a identificação no Pam Laudos.' END);
END;
$$;
REVOKE ALL ON FUNCTION public.exam_document_group_readiness(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.update_exam_document_extraction(p_document_id uuid,p_extraction jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_doc public.exam_document; v_class text; v_release boolean; v_task public.exam_document_delivery; v_human_review boolean; v_readiness jsonb;
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
  v_readiness:=public.exam_document_group_readiness(p_extraction->'fields',v_doc.confirmed_data);
  v_release := v_class='exam' AND COALESCE((p_extraction->>'single_patient')::boolean,false)
    AND NULLIF(trim(p_extraction->'fields'->>'pet_name'),'') IS NOT NULL
    AND NULLIF(trim(COALESCE(p_extraction->'fields'->>'client_name',p_extraction->'fields'->>'tutor_name')),'') IS NOT NULL;
  -- A processing lease never supersedes a later explicit human review, including empty fields/not_exam.
  v_human_review:=EXISTS(SELECT 1 FROM public.exam_document_event WHERE document_id=v_doc.id AND event_type='reviewed' AND actor_id IS NOT NULL);
  UPDATE public.exam_document SET extracted_data=p_extraction->'fields',evidence=COALESCE(p_extraction->'evidence','[]'),
    extractor_version=p_extraction->>'extractor_version',drive_name=COALESCE(p_extraction->>'drive_name',drive_name),
    identification_status=CASE WHEN v_human_review THEN identification_status WHEN identification_status='confirmed' THEN 'confirmed' WHEN v_class='not_exam' THEN 'not_exam' WHEN v_release THEN 'suggested' ELSE 'review' END,
    review_reason=CASE WHEN v_human_review THEN review_reason ELSE COALESCE(NULLIF(trim(p_extraction->>'review_reason'),''),
      CASE WHEN v_class<>'not_exam' THEN v_readiness->>'reason' END) END,
    group_release_at=CASE WHEN v_human_review THEN group_release_at WHEN v_class<>'not_exam' THEN COALESCE(group_release_at,now()) ELSE NULL END
    WHERE id=v_doc.id RETURNING * INTO v_doc;
  IF NOT v_human_review AND v_class<>'not_exam' THEN INSERT INTO public.exam_document_delivery(document_id,destination) SELECT v_doc.id,'group' WHERE NOT EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=v_doc.id AND destination='group') AND NOT EXISTS(SELECT 1 FROM public.exam_document WHERE id=v_doc.id AND group_exception_reason IS NOT NULL) ON CONFLICT DO NOTHING; END IF;
  PERFORM public.log_exam_document(v_doc.id,'extraction_updated',jsonb_build_object('classification',v_class,'extractor_version',v_doc.extractor_version,'released',v_release AND NOT v_human_review,'human_review_preserved',v_human_review));
  IF NOT v_human_review THEN PERFORM public.auto_link_exam_document(v_doc.id,p_extraction); END IF;
  SELECT * INTO STRICT v_doc FROM public.exam_document WHERE id=v_doc.id;
  RETURN jsonb_build_object('document_id',v_doc.id,'document',to_jsonb(v_doc));
END;
$$;

CREATE OR REPLACE FUNCTION public.review_exam_document(p_document_id uuid,p_expected_version bigint,p_fields jsonb,p_classification text DEFAULT 'exam',p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_doc public.exam_document; v_release boolean; v_readiness jsonb;
BEGIN
  PERFORM public.require_exam_document_member();
  SELECT * INTO STRICT v_doc FROM public.exam_document WHERE id=p_document_id FOR NO KEY UPDATE;
  IF v_doc.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'Documento mudou; atualize a tela' USING ERRCODE='40001'; END IF;
  IF p_classification IS NULL OR p_classification NOT IN ('exam','review','not_exam') OR jsonb_typeof(p_fields) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Conferência inválida'; END IF;
  IF p_classification<>'exam' AND NULLIF(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'Motivo obrigatório'; END IF;
  IF (EXISTS(SELECT 1 FROM public.exam_document_item WHERE document_id=v_doc.id AND contacted_at IS NOT NULL)
    OR EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=v_doc.id AND destination='nexus' AND status='completed'))
    AND ((v_doc.confirmed_data IS DISTINCT FROM p_fields AND NOT (public.exam_document_fields_fill_only(v_doc.confirmed_data,p_fields)
      AND NOT EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=v_doc.id AND destination='nexus' AND status='completed'))) OR p_classification<>'exam') THEN
    RAISE EXCEPTION 'Resultado já usado no contato/cadastro: registre uma nova versão corrigida'; END IF;
  IF NULLIF(p_fields->>'exam_date','') IS NOT NULL THEN PERFORM (p_fields->>'exam_date')::date; END IF;
  IF v_doc.pet_id IS NOT NULL AND p_classification='not_exam' THEN RAISE EXCEPTION 'Resultado vinculado deve ser revisado, nunca descartado'; END IF;
  v_readiness:=public.exam_document_group_readiness(v_doc.extracted_data,p_fields);
  v_release:=p_classification='exam' AND v_doc.file_status='saved' AND NULLIF(trim(p_fields->>'pet_name'),'') IS NOT NULL AND NULLIF(trim(COALESCE(p_fields->>'client_name',p_fields->>'tutor_name')),'') IS NOT NULL;
  UPDATE public.exam_document SET confirmed_data=p_fields,review_reason=COALESCE(NULLIF(trim(p_reason),''),
      CASE WHEN p_classification<>'not_exam' THEN v_readiness->>'reason' END),
    identification_status=CASE WHEN pet_id IS NOT NULL THEN 'confirmed' WHEN p_classification='not_exam' THEN 'not_exam' WHEN v_release THEN 'suggested' ELSE 'review' END,
    group_release_at=CASE WHEN p_classification<>'not_exam' AND v_doc.file_status='saved' THEN COALESCE(group_release_at,now()) ELSE NULL END WHERE id=v_doc.id RETURNING * INTO v_doc;
  IF p_classification<>'not_exam' AND v_doc.file_status='saved' THEN INSERT INTO public.exam_document_delivery(document_id,destination) SELECT v_doc.id,'group' WHERE NOT EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=v_doc.id AND destination='group') AND NOT EXISTS(SELECT 1 FROM public.exam_document WHERE id=v_doc.id AND group_exception_reason IS NOT NULL) ON CONFLICT DO NOTHING; END IF;
  IF v_doc.pet_id IS NOT NULL AND NULLIF(p_fields->>'exam_date','') IS NOT NULL THEN INSERT INTO public.exam_document_delivery(document_id,destination) VALUES(v_doc.id,'nexus') ON CONFLICT DO NOTHING; END IF;
  PERFORM public.log_exam_document(v_doc.id,'reviewed',jsonb_build_object('classification',p_classification,'reason',p_reason));
  RETURN to_jsonb(v_doc);
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
        -- Processing includes PDF reading, Drive rename and extraction persistence.
        -- Neither a subject hint nor a review can overtake that completed stage.
        AND EXISTS(SELECT 1 FROM public.exam_document_delivery processing
          WHERE processing.document_id=d.id AND processing.destination='processing' AND processing.status='completed')
        AND (public.exam_document_group_readiness(d.extracted_data,d.confirmed_data)->>'ready')::boolean
        -- Clinical evidence or explicit human review is still required. A matching
        -- patient is not required; subject metadata alone never releases a PDF.
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
          ELSE false
        END
        AND v_config.notification_cutoff IS NOT NULL AND d.received_at>=v_config.notification_cutoff AND NULLIF(v_config.group_destination_key,'') IS NOT NULL
        AND t.destination_key IN ('default',v_config.group_destination_key)))
      AND (p_destination<>'nexus' OR (d.identification_status='confirmed' AND d.pet_id IS NOT NULL AND NULLIF(d.confirmed_data->>'exam_date','') IS NOT NULL))
    ORDER BY t.created_at FOR UPDATE OF t SKIP LOCKED LIMIT p_limit
  ), claimed AS (
    UPDATE public.exam_document_delivery t SET status='reserved',worker=p_worker,lease_token=gen_random_uuid(),lease_until=now()+interval '10 minutes',
      destination_key=CASE WHEN t.destination='group' AND t.destination_key='default' THEN v_config.group_destination_key ELSE t.destination_key END,
      attempts=attempts+1,updated_at=now() FROM candidates WHERE t.id=candidates.id RETURNING t.*
  ) SELECT COALESCE(jsonb_agg(to_jsonb(c)||jsonb_build_object('document',to_jsonb(d),'configured_destination',v_config.group_destination_key,
        'notification_fields',CASE WHEN c.destination='group' THEN public.exam_document_group_readiness(d.extracted_data,d.confirmed_data)->'fields' END)),'[]') INTO v_tasks
      FROM claimed c JOIN public.exam_document d ON d.id=c.document_id;
  RETURN jsonb_build_object('tasks',v_tasks,'paused',false);
END;
$$;
-- Existing worker/member RPC grants and all operational settings are preserved.
COMMIT;
