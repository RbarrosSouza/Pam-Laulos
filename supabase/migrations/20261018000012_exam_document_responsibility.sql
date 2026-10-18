-- Clinical responsibility is independent from login, membership and the historical sale author.
-- Additive and prospective: no old document, delivery, account or clinical result is replayed.
BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.veterinarios') IS NULL OR to_regclass('public.sales_header') IS NULL
    OR to_regclass('public.v_exam_documents') IS NULL
    OR to_regprocedure('public.normalize_exam_match_name(text)') IS NULL
    OR to_regprocedure('public.auto_link_exam_document(uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Estrutura de exames/veterinárias não corresponde à revisão; instalação interrompida';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='exam_card' AND column_name='vet_id')
    OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='veterinarios' AND column_name='avatar_url') THEN
    RAISE EXCEPTION 'Catálogo clínico sem vet_id/avatar_url; instalação interrompida';
  END IF;
END;
$preflight$;

CREATE TABLE public.exam_document_responsibility (
  document_id uuid PRIMARY KEY REFERENCES public.exam_document(id) ON DELETE RESTRICT,
  veterinarian_id uuid REFERENCES public.veterinarios(id) ON DELETE RESTRICT,
  source text NOT NULL CHECK(source IN ('manual','pdf','sale','pdf_sale','conflict')),
  assigned_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  details jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(details)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(source<>'conflict' OR veterinarian_id IS NULL),
  CHECK((source='manual')=(assigned_by IS NOT NULL))
);
ALTER TABLE public.exam_document_responsibility ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.exam_document_responsibility FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.exam_document_responsibility TO authenticated;
GRANT ALL ON public.exam_document_responsibility TO service_role;
CREATE POLICY team_read ON public.exam_document_responsibility FOR SELECT TO authenticated USING(public.is_exam_document_member());

CREATE FUNCTION public.normalize_exam_vet_name(p_value text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT trim(regexp_replace(public.normalize_exam_match_name(COALESCE(p_value,'')),'^(dr|dra|doutor|doutora)[.]?[[:space:]]+','','i'));
$$;
CREATE FUNCTION public.normalize_exam_vet_crmv(p_value text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE k text:=regexp_replace(replace(upper(COALESCE(p_value,'')),'CRMV',''),'[^A-Z0-9]','','g');
BEGIN
  IF k ~ '^[A-Z]{2}[0-9]+$' THEN RETURN k; END IF;
  IF k ~ '^[0-9]+[A-Z]{2}$' THEN RETURN right(k,2)||left(k,length(k)-2); END IF;
  RETURN NULL;
END;
$$;

-- The label must qualify this exact name, not another professional elsewhere
-- in the same quote. The worker separately proves that the quote is in the PDF.
CREATE FUNCTION public.exam_document_requester_evidence_matches(p_excerpt text,p_requester text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE quote text:=public.normalize_exam_match_name(p_excerpt); name text:=public.normalize_exam_match_name(p_requester);
  at integer; offset_at integer:=0; prefix text; next_char text;
BEGIN
  IF name='' THEN RETURN false; END IF;
  LOOP
    at:=strpos(substr(quote,offset_at+1),name); IF at=0 THEN RETURN false; END IF;
    at:=at+offset_at; prefix:=substr(quote,1,at-1); next_char:=substr(quote,at+length(name),1);
    IF prefix ~ '(^|[^[:alnum:]])(solicitante|requisitante|solicitad[oa][[:space:]]+por)[[:space:]]*[:=-]?[[:space:]]*((dr|dra|doutor|doutora)[.]?[[:space:]]+)?$'
      AND (next_char='' OR next_char !~ '[[:alnum:]]') THEN RETURN true; END IF;
    offset_at:=at;
  END LOOP;
END;
$$;

-- Uses the proven sale's patient/tutor, never "the latest sale" or a date window.
CREATE FUNCTION public.pending_exam_document_sale_items(p_document_id uuid,p_pet_id uuid,p_fields jsonb)
RETURNS uuid[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ids uuid[]; p public.pets; d public.exam_document; exam_day date;
BEGIN
  SELECT * INTO STRICT p FROM public.pets WHERE id=p_pet_id;
  SELECT * INTO STRICT d FROM public.exam_document WHERE id=p_document_id;
  p_fields:=COALESCE(p_fields,'{}')||COALESCE(d.confirmed_data,'{}');
  IF NULLIF(trim(p_fields->>'exam_type'),'') IS NULL OR NULLIF(p_fields->>'exam_date','') IS NULL THEN RETURN '{}'::uuid[]; END IF;
  exam_day:=(p_fields->>'exam_date')::date;
  IF exam_day>(d.received_at AT TIME ZONE 'America/Sao_Paulo')::date THEN RETURN '{}'::uuid[]; END IF;
  SELECT array_agg(i.id ORDER BY i.id) INTO ids
  FROM public.exam_item i JOIN public.exam_card c ON c.id=i.exam_card_id
  LEFT JOIN public.sales_header s ON lower(trim(c.sale_id))=s.id::text
  WHERE c.archived_at IS NULL AND NOT i.result_received
    AND public.normalize_exam_match_name(i.exam_type)=public.normalize_exam_match_name(p_fields->>'exam_type')
    AND (c.pet_id IS NULL OR c.pet_id=p.id) AND (c.client_code IS NULL OR c.client_code=p.client_code)
    AND NULLIF(trim(c.sale_id),'') IS NOT NULL
    AND ((s.id IS NOT NULL AND lower(trim(s.pet_id::text))=p.id::text AND s.customer_id::text=p.client_code
      AND COALESCE(lower(s.status),'') NOT IN ('cancelled','canceled','cancelada','cancelado')
      AND (s.sale_date IS NULL OR s.sale_date::date<=exam_day))
      OR (s.id IS NULL AND EXISTS(SELECT 1 FROM public.exam_tracking t
        WHERE lower(trim(t.sale_id))=lower(trim(c.sale_id)) AND t.origin='venda'
          AND lower(trim(t.pet_id::text))=p.id::text AND t.client_code=p.client_code
          AND (t.created_at IS NULL OR (t.created_at AT TIME ZONE 'America/Sao_Paulo')::date<=exam_day))))
    AND NOT EXISTS(SELECT 1 FROM public.exam_tracking t WHERE lower(trim(t.sale_id))=lower(trim(c.sale_id))
      AND ((t.pet_id IS NOT NULL AND lower(trim(t.pet_id::text))<>p.id::text)
        OR (t.client_code IS NOT NULL AND t.client_code<>p.client_code)))
    AND NOT EXISTS(SELECT 1 FROM public.exam_document_item di WHERE di.exam_item_id=i.id AND di.document_id<>p_document_id);
  RETURN COALESCE(ids,'{}'::uuid[]);
END;
$$;

-- Synchronize only operational card ownership. Sales and tracking retain the
-- original clinical author. Automatic changes may only fill an empty owner or
-- refresh a value previously written by this document; manual changes are explicit.
CREATE FUNCTION public.sync_exam_document_responsible_cards(p_document_id uuid,p_vet_id uuid,p_manual boolean,p_actor uuid,p_details jsonb,p_old_vet_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.exam_card; v public.veterinarios; snapshot jsonb; originals jsonb:=COALESCE(p_details->'card_original_vets','[]');
  synced jsonb:='[]'; owned boolean; changed boolean;
BEGIN
  IF p_vet_id IS NOT NULL THEN SELECT * INTO STRICT v FROM public.veterinarios WHERE id=p_vet_id AND ativo; END IF;
  FOR c IN SELECT card.* FROM public.exam_card card WHERE card.archived_at IS NULL
    AND EXISTS(SELECT 1 FROM public.exam_document_item di JOIN public.exam_item i ON i.id=di.exam_item_id
      WHERE di.document_id=p_document_id AND i.exam_card_id=card.id) ORDER BY card.id FOR UPDATE LOOP
    IF EXISTS(SELECT 1 FROM public.exam_document_item di JOIN public.exam_item i ON i.id=di.exam_item_id
      JOIN public.exam_document_responsibility r ON r.document_id=di.document_id
      WHERE i.exam_card_id=c.id AND di.document_id<>p_document_id
        AND (r.veterinarian_id IS NOT NULL OR r.source='manual') AND r.veterinarian_id IS DISTINCT FROM p_vet_id) THEN
      IF p_manual THEN RAISE EXCEPTION 'Card compartilhado com outro exame de responsável diferente; confira os documentos' USING ERRCODE='23514'; END IF;
      CONTINUE;
    END IF;
    IF p_manual THEN
      IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(originals) x WHERE x->>'card_id'=c.id::text) THEN
        originals:=originals||jsonb_build_array(jsonb_build_object('card_id',c.id,'vet_id',c.vet_id,'vet_name',c.vet_name));
      END IF;
      owned:=true;
    ELSE
      SELECT x INTO snapshot FROM jsonb_array_elements(COALESCE(p_details->'auto_synced_cards','[]')) x WHERE x->>'card_id'=c.id::text;
      owned:=(c.vet_id IS NULL AND NULLIF(trim(c.vet_name),'') IS NULL)
        OR (snapshot IS NOT NULL AND c.vet_id IS NOT DISTINCT FROM p_old_vet_id
          AND EXISTS(SELECT 1 FROM public.veterinarios oldvet WHERE oldvet.id=p_old_vet_id AND oldvet.nome=c.vet_name));
    END IF;
    IF NOT owned THEN CONTINUE; END IF;
    changed:=c.vet_id IS DISTINCT FROM p_vet_id OR c.vet_name IS DISTINCT FROM CASE WHEN p_vet_id IS NOT NULL THEN v.nome END;
    IF changed THEN
      UPDATE public.exam_card SET vet_id=p_vet_id,vet_name=CASE WHEN p_vet_id IS NOT NULL THEN v.nome END WHERE id=c.id;
      INSERT INTO public.exam_card_log(exam_card_id,previous_status,new_status,changed_by,change_reason)
        VALUES(c.id,c.status,c.status,COALESCE(p_actor::text,'system'),
          'Responsável operacional atualizado pelo documento '||p_document_id::text||'; origem clínica da venda preservada');
    END IF;
    IF NOT p_manual AND p_vet_id IS NOT NULL THEN synced:=synced||jsonb_build_array(jsonb_build_object('card_id',c.id,'vet_id',p_vet_id)); END IF;
  END LOOP;
  IF p_manual THEN RETURN (p_details-'auto_synced_cards')||jsonb_build_object('card_original_vets',originals); END IF;
  RETURN (p_details-'card_original_vets')||jsonb_build_object('auto_synced_cards',synced);
END;
$$;
CREATE FUNCTION public.unique_exam_document_sale_items(p_document_id uuid,p_pet_id uuid,p_fields jsonb)
RETURNS uuid[] LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ids uuid[]:=public.pending_exam_document_sale_items(p_document_id,p_pet_id,p_fields); locked_id uuid;
BEGIN
  IF cardinality(ids)<>1 THEN RETURN '{}'::uuid[]; END IF;
  locked_id:=ids[1];
  -- Serialize automatic claims of the same real item. A competing document
  -- rechecks eligibility after this lock, so it creates its own external result
  -- if the first document already received the pending item.
  PERFORM 1 FROM public.exam_item WHERE id=locked_id FOR UPDATE;
  IF NOT FOUND THEN RETURN '{}'::uuid[]; END IF;
  ids:=public.pending_exam_document_sale_items(p_document_id,p_pet_id,p_fields);
  RETURN CASE WHEN cardinality(ids)=1 AND ids[1]=locked_id THEN ids ELSE '{}'::uuid[] END;
END;
$$;

CREATE FUNCTION public.exam_document_responsibility_fields(p_document_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object('responsible_vet_id',r.veterinarian_id,'responsible_vet_name',v.nome,
    'responsible_vet_avatar_url',v.avatar_url,'responsible_vet_source',r.source)
  FROM (SELECT p_document_id AS id) d
  LEFT JOIN public.exam_document_responsibility r ON r.document_id=d.id
  LEFT JOIN public.veterinarios v ON v.id=r.veterinarian_id;
$$;

CREATE FUNCTION public.resolve_exam_document_responsible_vet(p_document_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.exam_document; old public.exam_document_responsibility; fields jsonb; evidence jsonb;
  requester text; crmv_key text; name_ids uuid[]; crmv_ids uuid[]; pdf_id uuid; sale_id uuid; selected_id uuid;
  pdf_present boolean:=false; conflict boolean:=false; source_kind text; ids uuid[]:='{}'; card record;
  header record; header_found boolean; header_ok boolean; tracking_proven boolean; card_proven boolean;
  tracking_ids uuid[]; card_ids uuid[]; card_vet_id uuid; card_vet_name text; candidates uuid[]; candidate uuid;
  details jsonb:='{}'; synced_details jsonb; exam_day date; received_day date; quote text;
BEGIN
  SELECT * INTO STRICT d FROM public.exam_document WHERE id=p_document_id FOR NO KEY UPDATE;
  SELECT * INTO old FROM public.exam_document_responsibility WHERE document_id=d.id;
  IF old.source='manual' THEN
    synced_details:=public.sync_exam_document_responsible_cards(d.id,old.veterinarian_id,true,old.assigned_by,old.details,old.veterinarian_id);
    IF synced_details IS DISTINCT FROM old.details THEN UPDATE public.exam_document_responsibility SET details=synced_details,updated_at=now() WHERE document_id=d.id; END IF;
    RETURN;
  END IF;
  IF d.assigned_to IS NOT NULL THEN RETURN; END IF;
  fields:=COALESCE(d.extracted_data,'{}')||COALESCE(d.confirmed_data,'{}'); evidence:=COALESCE(d.evidence,'[]');
  received_day:=(d.received_at AT TIME ZONE 'America/Sao_Paulo')::date;
  IF NULLIF(fields->>'exam_date','') IS NOT NULL THEN exam_day:=(fields->>'exam_date')::date; END IF;
  requester:=NULLIF(trim(d.extracted_data->>'requesting_vet_name'),'');
  pdf_present:=d.canonical_document_id IS NULL AND d.identification_status<>'not_exam' AND requester IS NOT NULL
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(evidence) e WHERE e->>'field'='requesting_vet_name'
      AND e->>'page' ~ '^[1-9][0-9]*$' AND public.exam_document_requester_evidence_matches(e->>'excerpt',requester));
  IF pdf_present THEN
    SELECT array_agg(id ORDER BY id) INTO name_ids FROM public.veterinarios
      WHERE ativo AND public.normalize_exam_vet_name(nome)=public.normalize_exam_vet_name(requester);
    IF cardinality(name_ids)=1 THEN pdf_id:=name_ids[1]; END IF;
    SELECT e->>'excerpt' INTO quote FROM jsonb_array_elements(evidence) e WHERE e->>'field'='requesting_vet_crmv'
      AND e->>'page' ~ '^[1-9][0-9]*$' AND length(e->>'excerpt')<=500
      AND public.exam_document_requester_evidence_matches(e->>'excerpt',requester)
      AND strpos(public.normalize_exam_match_name(e->>'excerpt'),public.normalize_exam_match_name(d.extracted_data->>'requesting_vet_crmv'))
        >strpos(public.normalize_exam_match_name(e->>'excerpt'),public.normalize_exam_match_name(requester))
      AND public.normalize_exam_match_name(e->>'excerpt') !~ '(laudante|radiologista|assinado|signatario|responsavel[[:space:]]+tecnico|responsavel[[:space:]]+(pelo|do)[[:space:]]+laudo)' LIMIT 1;
    IF quote IS NOT NULL THEN crmv_key:=public.normalize_exam_vet_crmv(d.extracted_data->>'requesting_vet_crmv'); END IF;
    IF crmv_key IS NOT NULL THEN
      SELECT array_agg(id ORDER BY id) INTO crmv_ids FROM public.veterinarios WHERE ativo AND public.normalize_exam_vet_crmv(crmv)=crmv_key;
      IF cardinality(crmv_ids)=1 AND crmv_ids[1]=ANY(COALESCE(name_ids,'{}')) THEN pdf_id:=crmv_ids[1];
      ELSE conflict:=true; END IF;
    END IF;
    IF pdf_id IS NULL THEN conflict:=true; END IF;
    details:=details||jsonb_build_object('pdf_candidates',COALESCE(to_jsonb(name_ids),'[]'::jsonb));
  END IF;
  IF d.canonical_document_id IS NULL AND d.identification_status<>'not_exam' THEN
  FOR card IN SELECT DISTINCT c.* FROM public.exam_document_item di JOIN public.exam_item i ON i.id=di.exam_item_id
    JOIN public.exam_card c ON c.id=i.exam_card_id WHERE di.document_id=d.id AND c.archived_at IS NULL ORDER BY c.id LOOP
    candidates:='{}'; header_ok:=false; tracking_proven:=false;
    IF (card.pet_id IS NOT NULL AND card.pet_id IS DISTINCT FROM d.pet_id)
      OR (card.client_code IS NOT NULL AND card.client_code IS DISTINCT FROM d.client_code) THEN conflict:=true; CONTINUE; END IF;
    SELECT s.* INTO header FROM public.sales_header s WHERE s.id::text=lower(trim(card.sale_id)); header_found:=FOUND;
    IF header_found THEN
      IF lower(trim(header.pet_id::text)) IS DISTINCT FROM d.pet_id::text OR header.customer_id::text IS DISTINCT FROM d.client_code
        OR COALESCE(lower(header.status),'') IN ('cancelled','canceled','cancelada','cancelado')
        OR (header.sale_date IS NOT NULL AND (header.sale_date::date>received_day OR (exam_day IS NOT NULL AND header.sale_date::date>exam_day))) THEN
        conflict:=true; CONTINUE;
      END IF;
      header_ok:=true;
      IF NULLIF(trim(header.veterinarian_id::text),'') IS NOT NULL THEN
        SELECT id INTO candidate FROM public.veterinarios WHERE ativo AND id::text=lower(trim(header.veterinarian_id::text));
        IF candidate IS NULL THEN conflict:=true; ELSE candidates:=array_append(candidates,candidate); END IF;
      END IF;
    END IF;
    IF NULLIF(trim(card.sale_id),'') IS NOT NULL AND EXISTS(SELECT 1 FROM public.exam_tracking t WHERE lower(trim(t.sale_id))=lower(trim(card.sale_id))
      AND ((t.pet_id IS NOT NULL AND lower(trim(t.pet_id::text)) IS DISTINCT FROM d.pet_id::text)
        OR (t.client_code IS NOT NULL AND t.client_code IS DISTINCT FROM d.client_code))) THEN conflict:=true; CONTINUE; END IF;
    SELECT EXISTS(SELECT 1 FROM public.exam_tracking t WHERE lower(trim(t.sale_id))=lower(trim(card.sale_id)) AND t.origin='venda'
      AND lower(trim(t.pet_id::text))=d.pet_id::text AND t.client_code=d.client_code
      AND (t.created_at IS NULL OR (t.created_at AT TIME ZONE 'America/Sao_Paulo')::date<=LEAST(COALESCE(exam_day,received_day),received_day))) INTO tracking_proven;
    SELECT array_agg(DISTINCT v.id ORDER BY v.id) INTO tracking_ids FROM public.exam_tracking t JOIN public.veterinarios v
      ON v.ativo AND v.id::text=lower(trim(t.veterinario_id::text)) WHERE lower(trim(t.sale_id))=lower(trim(card.sale_id)) AND t.origin='venda'
      AND lower(trim(t.pet_id::text))=d.pet_id::text AND (t.client_code=d.client_code OR (header_ok AND t.client_code IS NULL))
      AND (t.created_at IS NULL OR (t.created_at AT TIME ZONE 'America/Sao_Paulo')::date<=LEAST(COALESCE(exam_day,received_day),received_day));
    IF (header_ok OR tracking_proven) AND EXISTS(SELECT 1 FROM public.exam_tracking t WHERE lower(trim(t.sale_id))=lower(trim(card.sale_id)) AND t.origin='venda'
      AND lower(trim(t.pet_id::text))=d.pet_id::text AND (t.client_code=d.client_code OR (header_ok AND t.client_code IS NULL))
      AND NULLIF(trim(t.veterinario_id::text),'') IS NOT NULL
      AND (t.created_at IS NULL OR (t.created_at AT TIME ZONE 'America/Sao_Paulo')::date<=LEAST(COALESCE(exam_day,received_day),received_day))
      AND NOT EXISTS(SELECT 1 FROM public.veterinarios v WHERE v.ativo AND v.id::text=lower(trim(t.veterinario_id::text)))) THEN conflict:=true; END IF;
    candidates:=candidates||COALESCE(tracking_ids,'{}');
    card_proven:=header_ok OR tracking_proven OR (card.origin='venda' AND card.pet_id=d.pet_id AND card.client_code=d.client_code);
    card_vet_id:=card.vet_id; card_vet_name:=card.vet_name;
    -- Do not turn this document's previous automatic card synchronization into
    -- independent evidence for its own next extraction.
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(old.details->'auto_synced_cards','[]')) x
      WHERE x->>'card_id'=card.id::text AND x->>'vet_id'=card.vet_id::text)
      AND EXISTS(SELECT 1 FROM public.veterinarios v WHERE v.id=card.vet_id AND v.nome=card.vet_name) THEN card_vet_id:=NULL; card_vet_name:=NULL; END IF;
    IF card_proven AND card_vet_id IS NOT NULL THEN
      IF EXISTS(SELECT 1 FROM public.veterinarios WHERE id=card_vet_id AND ativo) THEN candidates:=array_append(candidates,card_vet_id); ELSE conflict:=true; END IF;
      -- The legacy picker can change only vet_name. A stale ID must not hide
      -- the different professional that the team sees on that card.
      IF NULLIF(trim(card_vet_name),'') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.veterinarios v
        WHERE v.id=card_vet_id AND public.normalize_exam_vet_name(v.nome)=public.normalize_exam_vet_name(card_vet_name)) THEN conflict:=true; END IF;
    ELSIF card_proven AND NULLIF(trim(card_vet_name),'') IS NOT NULL THEN
      SELECT array_agg(id ORDER BY id) INTO card_ids FROM public.veterinarios WHERE ativo
        AND public.normalize_exam_vet_name(nome)=public.normalize_exam_vet_name(card_vet_name);
      IF cardinality(card_ids)=1 THEN candidates:=array_append(candidates,card_ids[1]); ELSE conflict:=true; END IF;
    END IF;
    FOR candidate IN SELECT DISTINCT x FROM unnest(candidates) x ORDER BY x LOOP IF NOT candidate=ANY(ids) THEN ids:=array_append(ids,candidate); END IF; END LOOP;
  END LOOP;
  SELECT COALESCE(array_agg(x ORDER BY x),'{}') INTO ids FROM unnest(ids) x;
  IF cardinality(ids)=1 THEN sale_id:=ids[1]; ELSIF cardinality(ids)>1 THEN conflict:=true; END IF;
  IF d.pet_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.exam_document_item di JOIN public.exam_item i ON i.id=di.exam_item_id
    JOIN public.exam_card c ON c.id=i.exam_card_id WHERE di.document_id=d.id AND c.sale_id IS NOT NULL)
    AND cardinality(public.pending_exam_document_sale_items(d.id,d.pet_id,fields))>1 THEN conflict:=true; END IF;
  IF pdf_id IS NOT NULL AND sale_id IS NOT NULL AND pdf_id<>sale_id THEN conflict:=true; END IF;
  END IF;
  selected_id:=CASE WHEN conflict THEN NULL ELSE COALESCE(sale_id,pdf_id) END;
  IF selected_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.exam_document_item own_link JOIN public.exam_item own_item ON own_item.id=own_link.exam_item_id
    JOIN public.exam_item other_item ON other_item.exam_card_id=own_item.exam_card_id
    JOIN public.exam_document_item other_link ON other_link.exam_item_id=other_item.id
    JOIN public.exam_document_responsibility r ON r.document_id=other_link.document_id
    WHERE own_link.document_id=d.id AND other_link.document_id<>d.id
      AND (r.veterinarian_id IS NOT NULL OR r.source='manual') AND r.veterinarian_id IS DISTINCT FROM selected_id) THEN conflict:=true; selected_id:=NULL; END IF;
  source_kind:=CASE WHEN conflict THEN 'conflict' WHEN pdf_id IS NOT NULL AND sale_id IS NOT NULL THEN 'pdf_sale'
    WHEN sale_id IS NOT NULL THEN 'sale' WHEN pdf_id IS NOT NULL THEN 'pdf' END;
  details:=details||jsonb_build_object('sale_candidates',to_jsonb(ids),'auto_synced_cards',COALESCE(old.details->'auto_synced_cards','[]'));
  details:=public.sync_exam_document_responsible_cards(d.id,selected_id,false,NULL,details,old.veterinarian_id);
  IF source_kind IS NULL THEN
    IF old.document_id IS NOT NULL THEN DELETE FROM public.exam_document_responsibility WHERE document_id=d.id;
      PERFORM public.log_exam_document(d.id,'responsible_vet_resolved',jsonb_build_object('veterinarian_id',NULL,'source',NULL,'cleared',true)); END IF;
    RETURN;
  END IF;
  IF old.veterinarian_id IS NOT DISTINCT FROM selected_id AND old.source IS NOT DISTINCT FROM source_kind AND old.details=details THEN RETURN; END IF;
  INSERT INTO public.exam_document_responsibility(document_id,veterinarian_id,source,details)
    VALUES(d.id,selected_id,source_kind,details) ON CONFLICT(document_id) DO UPDATE
    SET veterinarian_id=EXCLUDED.veterinarian_id,source=EXCLUDED.source,assigned_by=NULL,details=EXCLUDED.details,updated_at=now();
  PERFORM public.log_exam_document(d.id,'responsible_vet_resolved',jsonb_build_object('veterinarian_id',selected_id,'source',source_kind));
END;
$$;

CREATE FUNCTION public.set_exam_document_responsible_vet(p_document_id uuid,p_veterinarian_id uuid,p_expected_version bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor uuid; d public.exam_document; vet public.veterinarios; old public.exam_document_responsibility; originals jsonb; card record;
BEGIN
  actor:=public.require_exam_document_member();
  SELECT * INTO STRICT d FROM public.exam_document WHERE id=p_document_id FOR NO KEY UPDATE;
  IF d.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'Documento mudou; atualize a tela' USING ERRCODE='40001'; END IF;
  IF d.canonical_document_id IS NOT NULL OR d.identification_status='not_exam' THEN RAISE EXCEPTION 'Documento não disponível para atribuição' USING ERRCODE='22023'; END IF;
  IF p_veterinarian_id IS NOT NULL THEN
    SELECT * INTO vet FROM public.veterinarios WHERE id=p_veterinarian_id AND ativo;
    IF NOT FOUND THEN RAISE EXCEPTION 'Veterinária não encontrada ou inativa' USING ERRCODE='22023'; END IF;
  END IF;
  SELECT * INTO old FROM public.exam_document_responsibility WHERE document_id=d.id;
  IF old.source='manual' AND old.veterinarian_id IS NOT DISTINCT FROM p_veterinarian_id THEN
    RETURN jsonb_build_object('document_id',d.id,'version',d.version)||public.exam_document_responsibility_fields(d.id);
  END IF;
  originals:=public.sync_exam_document_responsible_cards(d.id,p_veterinarian_id,true,actor,COALESCE(old.details,'{}'),old.veterinarian_id);
  INSERT INTO public.exam_document_responsibility(document_id,veterinarian_id,source,assigned_by,details)
    VALUES(d.id,p_veterinarian_id,'manual',actor,originals)
    ON CONFLICT(document_id) DO UPDATE SET veterinarian_id=EXCLUDED.veterinarian_id,source='manual',assigned_by=actor,
      details=EXCLUDED.details,updated_at=now();
  UPDATE public.exam_document SET updated_at=now() WHERE id=d.id RETURNING * INTO d;
  PERFORM public.log_exam_document(d.id,'responsible_vet_assigned',jsonb_build_object('veterinarian_id',p_veterinarian_id,'source','manual'));
  RETURN jsonb_build_object('document_id',d.id,'version',d.version)||public.exam_document_responsibility_fields(d.id);
END;
$$;

CREATE FUNCTION public.refresh_exam_document_responsibility()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME='exam_document' THEN PERFORM public.resolve_exam_document_responsible_vet(NEW.id);
  ELSE PERFORM public.resolve_exam_document_responsible_vet(NEW.document_id); END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER resolve_extracted_exam_vet AFTER UPDATE OF extracted_data,evidence ON public.exam_document
FOR EACH ROW WHEN(OLD.extracted_data IS DISTINCT FROM NEW.extracted_data OR OLD.evidence IS DISTINCT FROM NEW.evidence)
EXECUTE FUNCTION public.refresh_exam_document_responsibility();
CREATE TRIGGER resolve_linked_exam_vet AFTER INSERT ON public.exam_document_item
FOR EACH ROW EXECUTE FUNCTION public.refresh_exam_document_responsibility();

-- Preserve the exact deployed view columns and function guards. Only the new
-- fields/unique proven item argument are appended, without importing stale SQL.
DO $patch$
DECLARE definition text; marker text; changed text; projection text;
BEGIN
  definition:=pg_get_viewdef('public.v_exam_documents'::regclass,true);
  definition:=regexp_replace(trim(definition),';[[:space:]]*$','');
  SELECT string_agg(CASE WHEN attname='contact_status' THEN 'CASE WHEN previous.contact_status=''completed'' THEN ''completed'' WHEN previous.assigned_to IS NOT NULL OR r.veterinarian_id IS NOT NULL THEN ''assigned'' ELSE ''pending'' END AS contact_status' ELSE 'previous.'||quote_ident(attname) END,',' ORDER BY attnum) INTO projection FROM pg_attribute WHERE attrelid='public.v_exam_documents'::regclass AND attnum>0 AND NOT attisdropped;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_exam_documents WITH(security_invoker=true) AS SELECT '||projection||',r.veterinarian_id AS responsible_vet_id,v.nome AS responsible_vet_name,v.avatar_url AS responsible_vet_avatar_url,r.source AS responsible_vet_source FROM ('||definition||') previous LEFT JOIN public.exam_document_responsibility r ON r.document_id=previous.id LEFT JOIN public.veterinarios v ON v.id=r.veterinarian_id';
  definition:=pg_get_functiondef('public.auto_link_exam_document(uuid,jsonb)'::regprocedure);
  marker:='public.apply_exam_document_link(d.id,matched_pet,''{}''::uuid[],d.version,';
  IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Contrato do vínculo automático mudou; revisão obrigatória'; END IF;
  changed:=replace(definition,marker,'public.apply_exam_document_link(d.id,matched_pet,public.unique_exam_document_sale_items(d.id,matched_pet,fields),d.version,');
  EXECUTE changed;
  definition:=pg_get_functiondef('public.reserve_exam_document_delivery(text,text,integer)'::regprocedure);
  marker:='''document'',to_jsonb(d),';
  IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Contrato da reserva de entregas mudou; revisão obrigatória'; END IF;
  EXECUTE replace(definition,marker,'''document'',to_jsonb(d)||public.exam_document_responsibility_fields(d.id),');
END;
$patch$;

REVOKE ALL ON FUNCTION public.normalize_exam_vet_name(text),public.normalize_exam_vet_crmv(text),
 public.exam_document_requester_evidence_matches(text,text),public.sync_exam_document_responsible_cards(uuid,uuid,boolean,uuid,jsonb,uuid),
 public.pending_exam_document_sale_items(uuid,uuid,jsonb),public.unique_exam_document_sale_items(uuid,uuid,jsonb),
 public.exam_document_responsibility_fields(uuid),public.resolve_exam_document_responsible_vet(uuid),public.refresh_exam_document_responsibility()
FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.set_exam_document_responsible_vet(uuid,uuid,bigint) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.set_exam_document_responsible_vet(uuid,uuid,bigint) TO authenticated;
COMMIT;
