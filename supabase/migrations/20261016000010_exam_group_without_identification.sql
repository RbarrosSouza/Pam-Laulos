-- Preserve PDF delivery independently of complete identification or clinical linkage.
-- Keep clinical candidacy/rejection, file integrity, destination, cutoff and replay guards.
-- No existing delivery or operational configuration is changed.
BEGIN;

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
      'Dados pendentes de identificação: '||array_to_string(missing,', ')||'. Confira o PDF e complete a identificação no Pam Laudos.' END);
END;
$$;
REVOKE ALL ON FUNCTION public.exam_document_group_readiness(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

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
        -- Give extraction a short opportunity to provide names, never an indefinite gate.
        -- The group task is created only after the original PDF is preserved.
        AND (t.created_at<=now()-interval '5 minutes'
          OR EXISTS(SELECT 1 FROM public.exam_document_delivery processing
            WHERE processing.document_id=d.id AND processing.destination='processing'
              AND processing.status IN ('completed','failed','waived')))
        -- Keep the mixed-mailbox filter. Missing fields and an ambiguous review
        -- are not rejection; only an explicit not-exam decision rejects a PDF.
        AND CASE
          WHEN human_decision.event_type='link_confirmed' THEN true
          WHEN human_decision.event_type='reviewed' AND human_decision.details->>'classification'='not_exam' THEN false
          WHEN human_decision.event_type='reviewed' AND human_decision.details->>'classification'='exam' THEN true
          WHEN extraction.details->>'classification'='not_exam' THEN false
          ELSE EXISTS(SELECT 1 FROM public.exam_document_source source
              WHERE source.document_id=d.id AND source.metadata->'exam_candidate'='true'::jsonb)
            OR (extraction.details->>'classification' IN ('exam','review')
              AND NULLIF(trim(d.extracted_data->>'exam_type'),'') IS NOT NULL
              AND EXISTS(SELECT 1 FROM jsonb_array_elements(d.evidence) ev
                WHERE ev->>'field'='exam_type' AND ev->>'page' ~ '^[1-9][0-9]*$'
                  AND strpos(' '||public.normalize_exam_identity(regexp_replace(ev->>'excerpt','[[:punct:]]',' ','g'))||' ',
                    ' '||public.normalize_exam_identity(regexp_replace(d.extracted_data->>'exam_type','[[:punct:]]',' ','g'))||' ')>0))
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
-- Existing privileges are retained; the helper remains private.
COMMIT;
