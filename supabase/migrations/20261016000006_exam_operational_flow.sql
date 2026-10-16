-- Operational intake, reusing the existing document/delivery contracts.
-- Installation does not activate collection or change legacy importer permissions.
BEGIN;

ALTER TABLE public.exam_document_configuration ADD COLUMN ingestion_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.exam_document ADD COLUMN link_method text NOT NULL DEFAULT 'manual' CHECK(link_method IN ('manual','automatic'));
ALTER TABLE public.exam_document_item ADD COLUMN confirmation_method text NOT NULL DEFAULT 'manual' CHECK(confirmation_method IN ('manual','automatic'));
ALTER TABLE public.exam_document_item ALTER COLUMN confirmed_by DROP NOT NULL;
ALTER TABLE public.exam_document_item ADD CONSTRAINT exam_document_item_confirmation_actor
  CHECK ((confirmation_method='manual' AND confirmed_by IS NOT NULL) OR (confirmation_method='automatic' AND confirmed_by IS NULL));

-- Keep the human author requirement for manual links; automatic links have an explicit method, never a fabricated user.
DO $$
DECLARE c record; n integer:=0;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='public.exam_document'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%identification_status%'
    AND pg_get_constraintdef(oid) LIKE '%link_confirmed_by%' LOOP
    EXECUTE format('ALTER TABLE public.exam_document DROP CONSTRAINT %I',c.conname); n:=n+1;
  END LOOP;
  IF n<>1 THEN RAISE EXCEPTION 'Contrato de confirmação do documento divergiu'; END IF;
END;
$$;
ALTER TABLE public.exam_document ADD CONSTRAINT exam_document_confirmation_actor
  CHECK (identification_status<>'confirmed' OR (pet_id IS NOT NULL AND link_confirmed_at IS NOT NULL
    AND ((link_method='manual' AND link_confirmed_by IS NOT NULL) OR (link_method='automatic' AND link_confirmed_by IS NULL))));

-- A permanent operational switch replaces the first-admin installation barrier.
-- The service boundary and all table/RPC grants remain unchanged.
CREATE OR REPLACE FUNCTION public.guard_exam_document_admin_phase_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.require_exam_document_service();
  IF NOT EXISTS(SELECT 1 FROM public.exam_document_configuration WHERE singleton AND ingestion_enabled) THEN
    RAISE EXCEPTION 'Recebimento de novos exames pausado' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_exam_document_admin_phase_insert() FROM PUBLIC,anon,authenticated,service_role;
-- The trigger is already installed in the administrative migration. IF NOT EXISTS keeps upgrades from older supported installations safe.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.exam_document'::regclass AND tgname='guard_exam_document_admin_phase_insert' AND NOT tgisinternal) THEN
    CREATE TRIGGER guard_exam_document_admin_phase_insert BEFORE INSERT ON public.exam_document
      FOR EACH ROW EXECUTE FUNCTION public.guard_exam_document_admin_phase_insert();
  END IF;
END $$;
ALTER TABLE public.exam_document ENABLE ALWAYS TRIGGER guard_exam_document_admin_phase_insert;

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
    SELECT to_jsonb(c) INTO v_client FROM public.clients c WHERE "Código"=v_pet.client_code LIMIT 1;
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
    IF v_card.sale_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.exam_tracking t WHERE t.sale_id=v_card.sale_id AND t.pet_id IS NOT NULL AND t.pet_id<>v_pet.id) THEN
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
      'method',CASE WHEN p_method='automatic' THEN 'exact_client_pet_v1' ELSE 'manual' END,
      'extracted_names',CASE WHEN p_method='automatic' THEN jsonb_build_object('client_name',p_confirmed->>'client_name','pet_name',p_confirmed->>'pet_name') ELSE NULL END));
  RETURN jsonb_build_object('document_id',v_doc.id,'document',to_jsonb(v_doc),'item_ids',p_item_ids);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_exam_document_link(uuid,uuid,uuid[],bigint,jsonb,uuid,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.confirm_exam_document_link(p_document_id uuid,p_pet_id uuid,p_item_ids uuid[],p_expected_version bigint,p_confirmed jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  RETURN public.apply_exam_document_link(p_document_id,p_pet_id,p_item_ids,p_expected_version,p_confirmed,
    public.require_exam_document_member(),'manual');
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_exam_document_link(uuid,uuid,uuid[],bigint,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.confirm_exam_document_link(uuid,uuid,uuid[],bigint,jsonb) TO authenticated;

CREATE FUNCTION public.normalize_exam_identity(p_value text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT lower(regexp_replace(btrim(COALESCE(p_value,'')),'[[:space:]]+',' ','g'));
$$;
REVOKE ALL ON FUNCTION public.normalize_exam_identity(text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.exam_document_date_evidence_matches(p_excerpt text,p_date text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM regexp_matches(p_excerpt,'(?:^|[^[:alnum:]])([0-9]{4}-[0-9]{2}-[0-9]{2})(?:$|[^[:alnum:]])','g') m WHERE m[1]=p_date)
    OR EXISTS(SELECT 1 FROM regexp_matches(p_excerpt,'(?:^|[^[:alnum:]])([0-9]{1,2})([./-])([0-9]{1,2})\2([0-9]{4})(?:$|[^[:alnum:]])','g') m
      WHERE m[4]||'-'||lpad(m[3],2,'0')||'-'||lpad(m[1],2,'0')=p_date);
$$;
REVOKE ALL ON FUNCTION public.exam_document_date_evidence_matches(text,text) FROM PUBLIC,anon,authenticated,service_role;

-- Called only from the verified extraction RPC under its existing processing lease.
CREATE FUNCTION public.auto_link_exam_document(p_document_id uuid,p_extraction jsonb)
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
  IF EXISTS(SELECT 1 FROM public.exam_document_source WHERE document_id=d.id AND metadata->>'unknown_sender'='true') THEN RETURN; END IF;
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
REVOKE ALL ON FUNCTION public.auto_link_exam_document(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.confirm_exam_document_file(p_document_id uuid,p_file jsonb,p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_doc public.exam_document; v_task public.exam_document_delivery;
BEGIN
  PERFORM public.require_exam_document_service();
  SELECT * INTO STRICT v_doc FROM public.exam_document WHERE id=p_document_id FOR NO KEY UPDATE;
  IF v_doc.file_status='saved' THEN
    IF v_doc.drive_file_id IS DISTINCT FROM p_file->>'drive_file_id' OR v_doc.sha256 IS DISTINCT FROM lower(p_file->>'sha256')
      OR v_doc.size_bytes IS DISTINCT FROM (p_file->>'size_bytes')::bigint THEN RAISE EXCEPTION 'Arquivo já salvo diverge da confirmação'; END IF;
    RETURN jsonb_build_object('document_id',v_doc.id,'already_saved',true,'document',to_jsonb(v_doc));
  END IF;
  SELECT * INTO STRICT v_task FROM public.exam_document_delivery WHERE document_id=v_doc.id AND destination='drive' FOR UPDATE;
  IF v_task.lease_token IS DISTINCT FROM p_lease_token OR v_task.status<>'reserved' OR v_task.lease_until<=now() THEN
    RAISE EXCEPTION 'Reserva de armazenamento inválida/expirada' USING ERRCODE='40001';
  END IF;
  IF NULLIF(v_doc.drive_file_id,'') IS NULL OR v_doc.drive_file_id IS DISTINCT FROM p_file->>'drive_file_id'
    OR v_doc.sha256 IS DISTINCT FROM lower(p_file->>'sha256') OR v_doc.size_bytes IS DISTINCT FROM (p_file->>'size_bytes')::bigint THEN
    RAISE EXCEPTION 'Confirmação não corresponde ao arquivo reservado' USING ERRCODE='23514';
  END IF;
  UPDATE public.exam_document SET file_status='saved',drive_folder_id=COALESCE(p_file->>'drive_folder_id',drive_folder_id),
    drive_name=COALESCE(p_file->>'drive_name',original_name),group_release_at=COALESCE(group_release_at,now()) WHERE id=v_doc.id RETURNING * INTO v_doc;
  UPDATE public.exam_document_delivery SET status='completed',completed_at=now(),lease_until=NULL,external_id=v_doc.drive_file_id,updated_at=now() WHERE id=v_task.id;
  INSERT INTO public.exam_document_delivery(document_id,destination) VALUES(v_doc.id,'processing') ON CONFLICT DO NOTHING;
  INSERT INTO public.exam_document_delivery(document_id,destination) SELECT v_doc.id,'group'
    WHERE v_doc.identification_status<>'not_exam' AND v_doc.group_exception_reason IS NULL
      AND NOT EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=v_doc.id AND destination='group') ON CONFLICT DO NOTHING;
  PERFORM public.log_exam_document(v_doc.id,'file_saved',jsonb_build_object('drive_file_id',v_doc.drive_file_id,'sha256',v_doc.sha256,'size_bytes',v_doc.size_bytes));
  RETURN jsonb_build_object('document_id',v_doc.id,'document',to_jsonb(v_doc));
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
    AND NOT EXISTS(SELECT 1 FROM public.exam_document_source WHERE document_id=v_doc.id AND COALESCE((metadata->>'unknown_sender')::boolean,false))
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

CREATE OR REPLACE FUNCTION public.review_exam_document(p_document_id uuid,p_expected_version bigint,p_fields jsonb,p_classification text DEFAULT 'exam',p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_doc public.exam_document; v_release boolean;
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
  v_release:=p_classification='exam' AND v_doc.file_status='saved' AND NULLIF(trim(p_fields->>'pet_name'),'') IS NOT NULL AND NULLIF(trim(COALESCE(p_fields->>'client_name',p_fields->>'tutor_name')),'') IS NOT NULL;
  UPDATE public.exam_document SET confirmed_data=p_fields,review_reason=p_reason,
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
    WHERE t.destination=p_destination AND t.status IN ('pending','failed') AND t.attempts<t.max_attempts AND t.next_attempt_at<=now()
      AND d.canonical_document_id IS NULL AND d.identification_status<>'not_exam'
      AND (p_destination='drive' OR d.file_status='saved')
      AND (p_destination<>'group' OR (d.group_release_at IS NOT NULL
        AND d.group_exception_reason IS NULL
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
-- No existing documents are released, no history is rewritten, no destination is activated.
COMMIT;
