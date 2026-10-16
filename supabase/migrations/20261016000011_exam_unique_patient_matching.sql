-- Patient matching remains documentary and unique. A PDF with only the tutor's
-- complete first name may match one exact pet + tutor pair, never a substring.
-- Legacy exam_tracking.pet_id is text in production; compare it without an
-- unsafe UUID cast. No old document, clinical result or delivery is replayed.
BEGIN;

CREATE FUNCTION public.normalize_exam_match_name(p_value text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
  SELECT translate(public.normalize_exam_identity(normalize(p_value,NFC)),
    'áàâãäåéèêëíìîïóòôõöúùûüçñ','aaaaaaeeeeiiiiooooouuuucn');
$$;
REVOKE ALL ON FUNCTION public.normalize_exam_match_name(text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.apply_exam_document_link(p_document_id uuid,p_pet_id uuid,p_item_ids uuid[],p_expected_version bigint,p_confirmed jsonb,p_actor uuid,p_method text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_actor uuid; v_doc public.exam_document; v_pet public.pets; v_item public.exam_item; v_card public.exam_card;
  v_id uuid; v_card_id uuid; v_origin text; v_client jsonb; v_date date; v_existing_ids uuid[]; v_inserted integer;
BEGIN
  IF p_method NOT IN ('manual','automatic') OR p_method IS NULL THEN RAISE EXCEPTION 'Método de vínculo inválido'; END IF;
  IF p_method='automatic' THEN
    PERFORM public.require_exam_document_service();
    IF p_actor IS NOT NULL THEN RAISE EXCEPTION 'Vínculo automático não tem autor humano'; END IF;
  ELSE
    IF p_actor IS DISTINCT FROM public.require_exam_document_member() THEN RAISE EXCEPTION 'Autor do vínculo inválido'; END IF;
  END IF;
  v_actor:=p_actor;
  SELECT * INTO STRICT v_doc FROM public.exam_document WHERE id=p_document_id FOR NO KEY UPDATE;
  IF v_doc.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'Documento mudou; atualize a tela' USING ERRCODE='40001'; END IF;
  IF v_doc.file_status<>'saved' OR v_doc.canonical_document_id IS NOT NULL THEN RAISE EXCEPTION 'Original ainda não foi salvo'; END IF;
  IF v_doc.pet_id IS NOT NULL AND v_doc.pet_id<>p_pet_id THEN RAISE EXCEPTION 'Documento já vinculado a outro paciente'; END IF;
  IF v_doc.previous_document_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.exam_document WHERE id=v_doc.previous_document_id AND pet_id IS NOT NULL AND pet_id<>p_pet_id) THEN
    RAISE EXCEPTION 'Correção deve pertencer ao mesmo paciente da versão anterior'; END IF;
  SELECT * INTO STRICT v_pet FROM public.pets WHERE id=p_pet_id;
  IF jsonb_typeof(p_confirmed) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Dados confirmados obrigatórios'; END IF;
  SELECT to_jsonb(c) INTO v_client FROM public.clients c WHERE "Código"=v_pet.client_code LIMIT 1;
  SELECT array_agg(exam_item_id ORDER BY exam_item_id) INTO v_existing_ids FROM public.exam_document_item WHERE document_id=v_doc.id;
  IF cardinality(COALESCE(p_item_ids,'{}'::uuid[]))=0 AND v_existing_ids IS NOT NULL THEN p_item_ids:=v_existing_ids; END IF;
  IF v_doc.pet_id IS NOT NULL AND (EXISTS(SELECT 1 FROM public.exam_document_item WHERE document_id=v_doc.id AND contacted_at IS NOT NULL)
    OR EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=v_doc.id AND destination='nexus' AND status='completed'))
    AND ((v_doc.confirmed_data IS DISTINCT FROM p_confirmed AND NOT (public.exam_document_fields_fill_only(v_doc.confirmed_data,p_confirmed)
      AND NOT EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=v_doc.id AND destination='nexus' AND status='completed')))
      OR v_existing_ids IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(p_item_ids) x)) THEN
    RAISE EXCEPTION 'Resultado já usado no contato/cadastro: registre uma nova versão corrigida';
  END IF;
  IF v_doc.pet_id=p_pet_id AND v_doc.confirmed_data=p_confirmed AND v_existing_ids IS NOT DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(p_item_ids) x) THEN
    RETURN jsonb_build_object('document_id',v_doc.id,'document',to_jsonb(v_doc),'item_ids',v_existing_ids,'already_linked',true);
  END IF;
  IF NULLIF(p_confirmed->>'exam_date','') IS NOT NULL THEN v_date:=(p_confirmed->>'exam_date')::date; END IF;
  -- No date is invented; Nexus task remains blocked until the team confirms the clinical date.
  IF cardinality(COALESCE(p_item_ids,'{}'::uuid[]))=0 THEN
    IF NULLIF(trim(p_confirmed->>'exam_type'),'') IS NULL THEN RAISE EXCEPTION 'Tipo do exame necessário para criar resultado externo'; END IF;
    SELECT channel INTO v_origin FROM public.exam_document_source WHERE document_id=v_doc.id ORDER BY created_at LIMIT 1;
    INSERT INTO public.exam_card(pet_id,client_code,pet_name,pet_species,pet_breed,client_name,client_phone,client_email,status,origin,is_orphan)
    VALUES(v_pet.id,v_pet.client_code,v_pet.name,v_pet.species,v_pet.breed,v_client->>'Nome',v_client->>'Celular',v_client->>'E-mail','exame_pronto',COALESCE(v_origin,'manual'),false)
      RETURNING id INTO v_card_id;
    INSERT INTO public.exam_item(exam_card_id,exam_type,lab_name) VALUES(v_card_id,p_confirmed->>'exam_type',p_confirmed->>'lab_name') RETURNING id INTO v_id;
    p_item_ids:=ARRAY[v_id];
  END IF;
  IF cardinality(p_item_ids)<> (SELECT count(DISTINCT x) FROM unnest(p_item_ids) x) THEN RAISE EXCEPTION 'Itens repetidos'; END IF;
  FOREACH v_id IN ARRAY p_item_ids LOOP
    SELECT * INTO STRICT v_item FROM public.exam_item WHERE id=v_id FOR UPDATE;
    SELECT * INTO STRICT v_card FROM public.exam_card WHERE id=v_item.exam_card_id FOR UPDATE;
    IF v_card.archived_at IS NOT NULL OR (v_card.pet_id IS NOT NULL AND v_card.pet_id<>v_pet.id)
      OR (v_card.client_code IS NOT NULL AND v_card.client_code<>v_pet.client_code) THEN
      RAISE EXCEPTION 'Item pertence a outro paciente/tutor ou card arquivado' USING ERRCODE='23514';
    END IF;
    IF EXISTS(SELECT 1 FROM public.exam_document_item di JOIN public.exam_document d ON d.id=di.document_id WHERE di.exam_item_id=v_id AND d.pet_id<>v_pet.id) THEN
      RAISE EXCEPTION 'Item já contém documento de outro paciente'; END IF;
    IF v_card.sale_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.exam_tracking t WHERE t.sale_id=v_card.sale_id AND t.pet_id IS NOT NULL AND lower(trim(t.pet_id::text))<>v_pet.id::text) THEN
      RAISE EXCEPTION 'Venda vinculada a outro paciente'; END IF;
    UPDATE public.exam_card SET pet_id=v_pet.id,client_code=v_pet.client_code WHERE id=v_card.id;
  END LOOP;
  UPDATE public.exam_document SET pet_id=v_pet.id,client_code=v_pet.client_code,confirmed_data=p_confirmed,
    identification_status='confirmed',link_method=p_method,link_confirmed_by=v_actor,link_confirmed_at=COALESCE(link_confirmed_at,now()),
    group_release_at=COALESCE(group_release_at,now()),review_reason=NULL WHERE id=v_doc.id RETURNING * INTO v_doc;
  FOREACH v_id IN ARRAY p_item_ids LOOP
    INSERT INTO public.exam_document_item(document_id,exam_item_id,confirmed_by,confirmation_method) VALUES(v_doc.id,v_id,v_actor,p_method) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_inserted=ROW_COUNT;
    IF v_inserted>0 THEN
      UPDATE public.exam_item SET result_received=true,result_received_at=(SELECT min(d.received_at) FROM public.exam_document d JOIN public.exam_document_item di ON di.document_id=d.id WHERE di.exam_item_id=v_id),
        contacted=false,contacted_at=NULL,contacted_by=NULL WHERE id=v_id;
    END IF;
  END LOOP;
  INSERT INTO public.exam_document_delivery(document_id,destination) SELECT v_doc.id,'group' WHERE NOT EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=v_doc.id AND destination='group') AND NOT EXISTS(SELECT 1 FROM public.exam_document WHERE id=v_doc.id AND group_exception_reason IS NOT NULL) ON CONFLICT DO NOTHING;
  IF v_date IS NOT NULL THEN INSERT INTO public.exam_document_delivery(document_id,destination) VALUES(v_doc.id,'nexus') ON CONFLICT DO NOTHING; END IF;
  INSERT INTO public.exam_document_event(document_id,event_type,actor_id,details) VALUES
    (v_doc.id,CASE WHEN p_method='automatic' THEN 'link_auto_confirmed' ELSE 'link_confirmed' END,p_actor,
    jsonb_build_object('pet_id',v_pet.id,'client_code',v_pet.client_code,'item_ids',p_item_ids,
      'method',CASE WHEN p_method='automatic' THEN 'unique_client_pet_v2' ELSE 'manual' END,
      'matching_rule',CASE WHEN p_method='automatic' THEN CASE
        WHEN public.normalize_exam_match_name(COALESCE(p_confirmed->>'client_name',p_confirmed->>'tutor_name'))=public.normalize_exam_match_name(v_client->>'Nome')
          THEN 'exact_full_name' ELSE 'unique_first_name' END END,
      'extracted_names',CASE WHEN p_method='automatic' THEN jsonb_build_object('client_name',p_confirmed->>'client_name','pet_name',p_confirmed->>'pet_name') ELSE NULL END));
  RETURN jsonb_build_object('document_id',v_doc.id,'document',to_jsonb(v_doc),'item_ids',p_item_ids);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_exam_document_link(uuid,uuid,uuid[],bigint,jsonb,uuid,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.auto_link_exam_document(p_document_id uuid,p_extraction jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.exam_document; fields jsonb; evidence jsonb; tutor text; pet_name text;
  matches integer; matched_pet uuid; reason text; ev record; tutor_key text; pet_key text;
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
  -- Match the complete pet name. Only a single-token tutor name may match
  -- the complete first name; multi-token names still require a full match.
  -- Count every eligible pair together: an exact row does not hide ambiguity.
  tutor_key:=public.normalize_exam_match_name(tutor);
  pet_key:=public.normalize_exam_match_name(pet_name);
  SELECT count(*),min(p.id::text)::uuid INTO matches,matched_pet
    FROM public.pets p JOIN public.clients c ON c."Código"=p.client_code
    WHERE public.normalize_exam_match_name(p.name)=pet_key
      AND (public.normalize_exam_match_name(c."Nome")=tutor_key
        OR (strpos(tutor_key,' ')=0 AND split_part(public.normalize_exam_match_name(c."Nome"),' ',1)=tutor_key));
  IF matches<>1 THEN
    reason:=CASE WHEN matches=0 THEN 'Tutor e pet não encontrados juntos no cadastro. Selecione o paciente no Pam Laudos.'
      ELSE 'Mais de um cadastro corresponde ao tutor e pet. Selecione o paciente no Pam Laudos.' END;
    UPDATE public.exam_document SET identification_status='review',review_reason=reason WHERE id=d.id;
    PERFORM public.log_exam_document(d.id,'identification_pending',jsonb_build_object('reason',CASE WHEN matches=0 THEN 'no_client_pet_pair' ELSE 'ambiguous_client_pet_pair' END));
    RETURN;
  END IF;
  IF d.previous_document_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.exam_document WHERE id=d.previous_document_id AND pet_id IS DISTINCT FROM matched_pet) THEN RETURN; END IF;
  PERFORM public.apply_exam_document_link(d.id,matched_pet,'{}'::uuid[],d.version,
    fields||jsonb_build_object('client_name',COALESCE(fields->>'client_name',fields->>'tutor_name')),NULL,'automatic');
END;
$$;

-- Existing RPC grants, confirmation checks and clinical-attachment guards remain unchanged.
COMMIT;
