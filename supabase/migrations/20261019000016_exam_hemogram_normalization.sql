-- Commercial Hemograma may be derived only from the three proven sections of
-- one patient report. Approved Creatinina/Ureia combinations also require their
-- real headings. Keep excerpts, matching, delivery and human guards.
-- No existing extraction, contact, original, task or configuration is rewritten.
BEGIN;

CREATE FUNCTION public.exam_document_exam_component_heading(p_excerpt text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE line text; matched text[];
  column_pattern text:='(?:resultados?|valor(?:es)?(?:[[:space:]]+de[[:space:]]+referencia)?|referencia|unidades?|parametros?|serie[[:space:]]+(?:vermelha|branca)|relativo|absoluto|valor[[:space:]]+(?:rel|abs)[.][[:space:]]+ref[.])';
BEGIN
  IF p_excerpt IS NULL THEN RETURN NULL; END IF;
  line:=public.normalize_exam_match_name(normalize(p_excerpt,NFKC));
  -- The worker also checks the surrounding PDF section (current versus history,
  -- cancellation or absent results); this helper receives only its literal line.
  IF line ~ '(^|[^[:alnum:]])((nao([[:space:]]+(foi|foram|sera|serao|ha|houve|e|sao))?([[:space:]]+possivel)?|sem)[[:space:]]+(realiz(ad[oa]s?|acao|ar)|solicitad[oa]s?|resultados?|dados|material)|cancelad[oa]|pendente|anteriores?|historic[oa]s?|bibliografic[oa]s?)($|[^[:alnum:]])' THEN RETURN NULL; END IF;
  matched:=regexp_match(line,'^(?:(?:[0-9]{1,2}|[ivx]{1,5})[[:space:]]*[.)–—-]?[[:space:]]+)?(eritrograma|leucograma|plaquetograma|creatinina|ureia)[[:space:]]*(?:[:–—-][[:space:]]*)?(?:'||column_pattern||'(?:(?:[[:space:]]+|[[:space:]]*[|][[:space:]]*)'||column_pattern||')*)?$');
  RETURN matched[1];
END;
$$;

CREATE FUNCTION public.exam_document_exam_type_evidence_matches(p_exam_type text,p_evidence jsonb,p_single_patient boolean)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE literal_type text; sections text[]; required_sections text[];
BEGIN
  IF jsonb_typeof(p_evidence) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  literal_type:=public.normalize_exam_identity(regexp_replace(p_exam_type,'[[:punct:]]',' ','g'));
  IF literal_type='' THEN RETURN false; END IF;
  -- Retain the previous literal evidence rule for every type, including an
  -- explicitly printed Hemograma. The new single-patient gate is derivation-only.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_evidence) e
    WHERE e->>'field'='exam_type' AND e->>'page' ~ '^[1-9][0-9]*$'
      AND jsonb_typeof(e->'excerpt')='string'
      AND strpos(' '||public.normalize_exam_identity(regexp_replace(e->>'excerpt','[[:punct:]]',' ','g'))||' ',' '||literal_type||' ')>0) THEN RETURN true; END IF;
  IF p_single_patient IS DISTINCT FROM true THEN RETURN false; END IF;
  required_sections:=CASE public.normalize_exam_match_name(p_exam_type)
    WHEN 'hemograma' THEN ARRAY['eritrograma','leucograma','plaquetograma']
    WHEN 'hemograma + creatinina' THEN ARRAY['creatinina','eritrograma','leucograma','plaquetograma']
    WHEN 'hemograma + ureia' THEN ARRAY['eritrograma','leucograma','plaquetograma','ureia']
    WHEN 'hemograma + creatinina + ureia' THEN ARRAY['creatinina','eritrograma','leucograma','plaquetograma','ureia'] END;
  IF required_sections IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_evidence) e
    WHERE e->>'field'='exam_type' AND (e->>'page' IS NULL OR e->>'page' !~ '^[1-9][0-9]*$'
      OR jsonb_typeof(e->'excerpt') IS DISTINCT FROM 'string' OR public.exam_document_exam_component_heading(e->>'excerpt') IS NULL)) THEN RETURN false; END IF;
  SELECT array_agg(DISTINCT public.exam_document_exam_component_heading(e->>'excerpt') ORDER BY public.exam_document_exam_component_heading(e->>'excerpt')) INTO sections
    FROM jsonb_array_elements(p_evidence) e
    WHERE e->>'field'='exam_type' AND e->>'page' ~ '^[1-9][0-9]*$' AND jsonb_typeof(e->'excerpt')='string';
  RETURN COALESCE(sections=required_sections,false);
END;
$$;
REVOKE ALL ON FUNCTION public.exam_document_exam_component_heading(text),
  public.exam_document_exam_type_evidence_matches(text,jsonb,boolean) FROM PUBLIC,anon,authenticated,service_role;

-- Patch only the existing evidence predicates and event metadata. Fail rather
-- than install a stale replacement if any deployed contract differs.
DO $patch$
DECLARE definition text; marker text; changed text;
BEGIN
  definition:=pg_get_functiondef('public.auto_link_exam_document(uuid,jsonb)'::regprocedure);
  marker:=$old$('client_name',tutor),('pet_name',pet_name),('exam_type',public.normalize_exam_identity(fields->>'exam_type'))$old$;
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'Contrato da evidência no vínculo mudou; revisão obrigatória'; END IF;
  changed:=replace(definition,marker,$new$('client_name',tutor),('pet_name',pet_name)$new$);
  marker:='  -- The worker validates quotes against the PDF pages; here identities must also have their own nonempty quoted evidence.';
  IF (length(changed)-length(replace(changed,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'Marcador do vínculo mudou; revisão obrigatória'; END IF;
  changed:=replace(changed,marker,$new$  IF NOT public.exam_document_exam_type_evidence_matches(fields->>'exam_type',evidence,p_extraction->'single_patient'='true'::jsonb) THEN RETURN; END IF;
$new$||marker);
  EXECUTE changed;

  definition:=pg_get_functiondef('public.update_exam_document_extraction(uuid,jsonb)'::regprocedure);
  marker:=$old$jsonb_build_object('classification',v_class,'extractor_version',v_doc.extractor_version$old$;
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'Contrato do evento de extração mudou; revisão obrigatória'; END IF;
  EXECUTE replace(definition,marker,$new$jsonb_build_object('classification',v_class,'single_patient',p_extraction->'single_patient'='true'::jsonb,'extractor_version',v_doc.extractor_version$new$);

  definition:=pg_get_functiondef('public.reserve_exam_document_delivery(text,text,integer)'::regprocedure);
  marker:=$old$AND EXISTS(SELECT 1 FROM jsonb_array_elements(d.evidence) ev
                WHERE ev->>'field'='exam_type' AND ev->>'page' ~ '^[1-9][0-9]*$'
                  AND strpos(' '||public.normalize_exam_identity(regexp_replace(ev->>'excerpt','[[:punct:]]',' ','g'))||' ',
                    ' '||public.normalize_exam_identity(regexp_replace(d.extracted_data->>'exam_type','[[:punct:]]',' ','g'))||' ')>0)$old$;
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'Contrato da evidência na reserva mudou; revisão obrigatória'; END IF;
  EXECUTE replace(definition,marker,$new$AND public.exam_document_exam_type_evidence_matches(d.extracted_data->>'exam_type',d.evidence,extraction.details->'single_patient'='true'::jsonb)$new$);
END;
$patch$;
COMMIT;
