BEGIN;

CREATE OR REPLACE FUNCTION public.guard_exam_document_item_evidence()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_received boolean; v_contacted boolean; v_received_at timestamptz; v_contacted_at timestamptz; v_contacted_by text;
BEGIN
  IF EXISTS(SELECT 1 FROM public.exam_document_item WHERE exam_item_id=NEW.id) THEN
    SELECT EXISTS(SELECT 1 FROM public.exam_document_item di JOIN public.exam_document d ON d.id=di.document_id
      WHERE di.exam_item_id=NEW.id AND d.file_status='saved' AND d.identification_status='confirmed'),
      NOT EXISTS(SELECT 1 FROM public.exam_document_item WHERE exam_item_id=NEW.id AND contacted_at IS NULL),
      (SELECT min(d.received_at) FROM public.exam_document_item di JOIN public.exam_document d ON d.id=di.document_id WHERE di.exam_item_id=NEW.id),
      (SELECT max(contacted_at) FROM public.exam_document_item WHERE exam_item_id=NEW.id),
      (SELECT contacted_by::text FROM public.exam_document_item WHERE exam_item_id=NEW.id ORDER BY contacted_at DESC NULLS LAST LIMIT 1)
      INTO v_received,v_contacted,v_received_at,v_contacted_at,v_contacted_by;
    IF NEW.result_received IS DISTINCT FROM v_received OR NEW.result_received_at IS DISTINCT FROM v_received_at THEN
      RAISE EXCEPTION 'Recebimento exige documento preservado e vínculo confirmado';
    END IF;
    IF NEW.contacted IS DISTINCT FROM v_contacted OR NEW.contacted_at IS DISTINCT FROM (CASE WHEN v_contacted THEN v_contacted_at ELSE NULL END)
      OR NEW.contacted_by IS DISTINCT FROM (CASE WHEN v_contacted THEN v_contacted_by ELSE NULL END) THEN
      RAISE EXCEPTION 'Contato precisa ser registrado para cada documento/item';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_exam_document_item_evidence BEFORE UPDATE OF result_received,result_received_at,contacted,contacted_at,contacted_by ON public.exam_item
FOR EACH ROW EXECUTE FUNCTION public.guard_exam_document_item_evidence();

CREATE OR REPLACE FUNCTION public.set_exam_group_sent_at()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_document_based boolean; v_sent timestamptz;
BEGIN
  SELECT EXISTS(SELECT 1 FROM public.exam_document_item di JOIN public.exam_item i ON i.id=di.exam_item_id WHERE i.exam_card_id=NEW.id) INTO v_document_based;
  IF v_document_based THEN
    SELECT min(t.sent_at) INTO v_sent FROM public.exam_document_delivery t
      JOIN public.exam_document_item di ON di.document_id=t.document_id JOIN public.exam_item i ON i.id=di.exam_item_id
      WHERE i.exam_card_id=NEW.id AND t.destination='group' AND t.status='sent' AND di.contacted_at IS NULL;
    IF NEW.status='no_grupo' THEN
      IF v_sent IS NULL THEN RAISE EXCEPTION 'Envio ao grupo ainda não foi confirmado'; END IF;
      NEW.group_sent_at:=v_sent;
    ELSIF NEW.status='contato_realizado' THEN
      IF EXISTS(SELECT 1 FROM public.exam_item WHERE exam_card_id=NEW.id AND (NOT contacted OR NOT result_received)) OR
        EXISTS(SELECT 1 FROM public.exam_document_item di JOIN public.exam_item i ON i.id=di.exam_item_id WHERE i.exam_card_id=NEW.id AND di.contacted_at IS NULL) THEN
        RAISE EXCEPTION 'Ainda há resultados/contatos pendentes neste card';
      END IF;
    ELSIF NEW.status='exame_pronto' AND NOT EXISTS(SELECT 1 FROM public.exam_item WHERE exam_card_id=NEW.id AND result_received) THEN
      RAISE EXCEPTION 'Card sem resultado recebido';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status='no_grupo' THEN NEW.group_sent_at:=now(); END IF;
  ELSIF NEW.status='no_grupo' AND OLD.status IS DISTINCT FROM 'no_grupo' THEN NEW.group_sent_at:=now();
  ELSIF OLD.status='no_grupo' AND NEW.status NOT IN ('no_grupo','contato_realizado') THEN NEW.group_sent_at:=NULL;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_exam_group_sent_at ON public.exam_card;
CREATE TRIGGER trg_exam_group_sent_at BEFORE INSERT OR UPDATE OF status,group_sent_at ON public.exam_card FOR EACH ROW EXECUTE FUNCTION public.set_exam_group_sent_at();

-- New versions reopen contact without erasing older document contact evidence.
CREATE OR REPLACE FUNCTION public.handle_exam_item_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_total integer; v_ready integer; v_contacted integer; v_old text; v_new text; v_doc boolean; v_sent timestamptz;
BEGIN
  SELECT count(*),count(*) FILTER(WHERE result_received),count(*) FILTER(WHERE contacted) INTO v_total,v_ready,v_contacted
    FROM public.exam_item WHERE exam_card_id=NEW.exam_card_id;
  SELECT status INTO v_old FROM public.exam_card WHERE id=NEW.exam_card_id;
  SELECT EXISTS(SELECT 1 FROM public.exam_document_item di JOIN public.exam_item i ON i.id=di.exam_item_id WHERE i.exam_card_id=NEW.exam_card_id) INTO v_doc;
  IF v_contacted=v_total AND v_total>0 THEN v_new:='contato_realizado';
  ELSIF v_doc THEN
    SELECT min(t.sent_at) INTO v_sent FROM public.exam_document_delivery t JOIN public.exam_document_item di ON di.document_id=t.document_id
      JOIN public.exam_item i ON i.id=di.exam_item_id WHERE i.exam_card_id=NEW.exam_card_id AND t.destination='group' AND t.status='sent' AND di.contacted_at IS NULL;
    v_new:=CASE WHEN v_sent IS NOT NULL THEN 'no_grupo' WHEN v_ready>0 THEN 'exame_pronto' ELSE 'aguardando_lab' END;
  ELSIF v_ready>0 AND v_old='aguardando_lab' THEN v_new:='exame_pronto';
  ELSE v_new:=v_old;
  END IF;
  IF v_old IS DISTINCT FROM v_new THEN
    UPDATE public.exam_card SET status=v_new,resolved_at=CASE WHEN v_new='contato_realizado' THEN now() ELSE NULL END WHERE id=NEW.exam_card_id;
    INSERT INTO public.exam_card_log(exam_card_id,previous_status,new_status,changed_by,change_reason)
      VALUES(NEW.exam_card_id,v_old,v_new,'system','Situação recalculada a partir dos itens e documentos');
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.move_exam_card(p_card_id uuid,p_from_status text,p_to_status text,p_moved_by text DEFAULT 'reception',p_contacted_by text DEFAULT NULL)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_actor uuid; v_status text; v_document_based boolean;
BEGIN
  v_actor:=public.require_exam_document_member();
  IF p_to_status NOT IN ('aguardando_lab','exame_pronto','no_grupo','contato_realizado') THEN RAISE EXCEPTION 'Situação inválida'; END IF;
  SELECT status INTO v_status FROM public.exam_card WHERE id=p_card_id AND archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN json_build_object('success',false,'error','Card não encontrado'); END IF;
  IF v_status=p_to_status THEN RETURN json_build_object('success',true,'already_there',true,'status',v_status); END IF;
  IF v_status<>p_from_status THEN RETURN json_build_object('success',false,'error','Status mudou durante a operação','current_status',v_status); END IF;
  SELECT EXISTS(SELECT 1 FROM public.exam_document_item di JOIN public.exam_item i ON i.id=di.exam_item_id WHERE i.exam_card_id=p_card_id) INTO v_document_based;
  IF NOT v_document_based THEN
    IF p_to_status='exame_pronto' THEN UPDATE public.exam_item SET result_received=true,result_received_at=COALESCE(result_received_at,now()) WHERE exam_card_id=p_card_id AND NOT result_received;
    ELSIF p_to_status='contato_realizado' THEN UPDATE public.exam_item SET contacted=true,contacted_at=COALESCE(contacted_at,now()),contacted_by=COALESCE(p_contacted_by,v_actor::text) WHERE exam_card_id=p_card_id;
    END IF;
  END IF;
  UPDATE public.exam_card SET status=p_to_status WHERE id=p_card_id;
  INSERT INTO public.exam_card_log(exam_card_id,previous_status,new_status,changed_by,change_reason)
    VALUES(p_card_id,p_from_status,p_to_status,v_actor::text,CASE WHEN v_document_based THEN 'Movido sem inventar evidência dos documentos' ELSE 'Movido via drag-and-drop (legado)' END);
  RETURN json_build_object('success',true,'card_id',p_card_id,'from_status',p_from_status,'to_status',p_to_status);
END;
$$;

CREATE OR REPLACE FUNCTION public.merge_exam_cards(p_target_card_id uuid,p_source_card_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_actor uuid; v_target public.exam_card; v_source public.exam_card; v_moved integer; v_pet_count integer;
  v_total integer; v_ready integer; v_contacted integer; v_status text; v_sent timestamptz;
BEGIN
  v_actor:=public.require_exam_document_member();
  IF p_target_card_id=p_source_card_id THEN RETURN json_build_object('success',false,'error','Cards devem ser diferentes'); END IF;
  PERFORM 1 FROM public.exam_card WHERE id IN(p_target_card_id,p_source_card_id) ORDER BY id FOR UPDATE;
  SELECT * INTO STRICT v_target FROM public.exam_card WHERE id=p_target_card_id AND archived_at IS NULL;
  SELECT * INTO STRICT v_source FROM public.exam_card WHERE id=p_source_card_id AND archived_at IS NULL;
  SELECT count(DISTINCT pet_id) INTO v_pet_count FROM (
    SELECT v_target.pet_id AS pet_id UNION SELECT v_source.pet_id
    UNION SELECT d.pet_id FROM public.exam_document d JOIN public.exam_document_item di ON di.document_id=d.id
      JOIN public.exam_item i ON i.id=di.exam_item_id WHERE i.exam_card_id IN(p_target_card_id,p_source_card_id)
  ) x WHERE pet_id IS NOT NULL;
  IF v_pet_count>1 OR (v_source.client_code IS NOT NULL AND v_target.client_code IS NOT NULL AND v_source.client_code<>v_target.client_code) THEN
    RAISE EXCEPTION 'Não é permitido fundir pacientes/tutores diferentes'; END IF;
  UPDATE public.exam_item SET exam_card_id=p_target_card_id WHERE exam_card_id=p_source_card_id;
  GET DIAGNOSTICS v_moved=ROW_COUNT;
  -- Source and its audit log remain archived. No document, item or old contact is deduplicated by name.
  UPDATE public.exam_card SET archived_at=now() WHERE id=p_source_card_id;
  UPDATE public.exam_card SET pet_id=COALESCE(pet_id,v_source.pet_id),client_code=COALESCE(client_code,v_source.client_code),is_orphan=false WHERE id=p_target_card_id;
  SELECT count(*),count(*) FILTER(WHERE result_received),count(*) FILTER(WHERE contacted) INTO v_total,v_ready,v_contacted
    FROM public.exam_item WHERE exam_card_id=p_target_card_id;
  SELECT min(t.sent_at) INTO v_sent FROM public.exam_document_delivery t JOIN public.exam_document_item di ON di.document_id=t.document_id
    JOIN public.exam_item i ON i.id=di.exam_item_id WHERE i.exam_card_id=p_target_card_id AND t.destination='group' AND t.status='sent' AND di.contacted_at IS NULL;
  v_status:=CASE WHEN v_total>0 AND v_total=v_contacted AND v_total=v_ready THEN 'contato_realizado' WHEN v_sent IS NOT NULL THEN 'no_grupo'
    WHEN v_ready>0 THEN 'exame_pronto' ELSE 'aguardando_lab' END;
  UPDATE public.exam_card SET status=v_status,resolved_at=CASE WHEN v_status='contato_realizado' THEN COALESCE(resolved_at,now()) ELSE NULL END WHERE id=p_target_card_id;
  INSERT INTO public.exam_card_log(exam_card_id,previous_status,new_status,changed_by,change_reason)
    VALUES(p_target_card_id,v_target.status,v_status,v_actor::text,'Fusão preservando histórico; card origem '||p_source_card_id::text);
  RETURN json_build_object('success',true,'target_card_id',p_target_card_id,'items_moved',v_moved,'items_deduped',0,'new_status',v_status);
END;
$$;

-- Sales originate in PAM Nexus, whose users may not work in the document queue.
-- Keep the existing insert trigger operational without granting those users direct
-- access to the monitor tables or document evidence.
DO $$
BEGIN
  IF to_regprocedure('public.bridge_tracking_to_card()') IS NOT NULL THEN
    ALTER FUNCTION public.bridge_tracking_to_card() SECURITY DEFINER;
    ALTER FUNCTION public.bridge_tracking_to_card() SET search_path = public, pg_temp;
    REVOKE ALL ON FUNCTION public.bridge_tracking_to_card() FROM PUBLIC,anon,authenticated;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_exam_cards(p_card_ids uuid[])
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_actor uuid; v_card public.exam_card; v_archived integer:=0; v_deleted integer:=0;
BEGIN
  v_actor:=public.require_exam_document_member();
  IF cardinality(COALESCE(p_card_ids,'{}'))=0 THEN RETURN json_build_object('success',false,'error','Nenhum exame selecionado'); END IF;
  FOR v_card IN SELECT * FROM public.exam_card WHERE id=ANY(p_card_ids) ORDER BY id FOR UPDATE LOOP
    IF EXISTS(SELECT 1 FROM public.exam_document_item di JOIN public.exam_item i ON i.id=di.exam_item_id WHERE i.exam_card_id=v_card.id) THEN
      UPDATE public.exam_card SET archived_at=COALESCE(archived_at,now()) WHERE id=v_card.id;
      INSERT INTO public.exam_card_log(exam_card_id,previous_status,new_status,changed_by,change_reason)
        VALUES(v_card.id,v_card.status,v_card.status,v_actor::text,'Card arquivado; documentos, contatos e histórico preservados');
      v_archived:=v_archived+1;
    ELSE DELETE FROM public.exam_card WHERE id=v_card.id; v_deleted:=v_deleted+1;
    END IF;
  END LOOP;
  RETURN json_build_object('success',true,'deleted',v_deleted,'archived',v_archived);
END;
$$;

-- Prevent direct REST delete from bypassing the archival RPC or deleting audit trails.
CREATE OR REPLACE FUNCTION public.guard_exam_card_document_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.exam_document_item di JOIN public.exam_item i ON i.id=di.exam_item_id WHERE i.exam_card_id=OLD.id) THEN
    RAISE EXCEPTION 'Card com documentos deve ser arquivado, nunca excluído'; END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER guard_exam_card_document_delete BEFORE DELETE ON public.exam_card FOR EACH ROW EXECUTE FUNCTION public.guard_exam_card_document_delete();

CREATE OR REPLACE FUNCTION public.guard_nexus_document_exam()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_doc public.exam_document;
BEGIN
  IF TG_OP='DELETE' OR TG_OP='UPDATE' THEN
    IF OLD.exam_document_id IS NOT NULL AND auth.role() IS DISTINCT FROM 'service_role' THEN
      RAISE EXCEPTION 'Revisões de exames automatizados devem preservar original e histórico'; END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  END IF;
  IF NEW.exam_document_id IS NULL AND (NEW.storage_bucket IS NOT NULL OR NEW.storage_path IS NOT NULL) AND auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Referência privada exige documento de origem confirmado pelo serviço'; END IF;
  IF NEW.exam_document_id IS NOT NULL THEN
    PERFORM public.require_exam_document_service();
    SELECT * INTO STRICT v_doc FROM public.exam_document WHERE id=NEW.exam_document_id;
    IF NEW.pet_id<>v_doc.pet_id OR v_doc.identification_status<>'confirmed' OR NEW.storage_bucket IS DISTINCT FROM 'exam_documents_private'
      OR NEW.storage_path IS DISTINCT FROM v_doc.pet_id::text||'/'||v_doc.id::text||'/original.pdf'
      OR NEW.data_exame IS DISTINCT FROM (v_doc.confirmed_data->>'exam_date')::date THEN
      RAISE EXCEPTION 'Paciente, data ou referência privada divergem do documento'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_nexus_document_exam BEFORE INSERT OR UPDATE OR DELETE ON public.exames FOR EACH ROW EXECUTE FUNCTION public.guard_nexus_document_exam();
CREATE POLICY restrict_document_exames_to_team ON public.exames AS RESTRICTIVE FOR ALL TO anon,authenticated
USING(exam_document_id IS NULL OR public.is_exam_document_member()) WITH CHECK(exam_document_id IS NULL);

CREATE OR REPLACE VIEW public.v_exam_cards WITH (security_invoker=true) AS
SELECT c.id,c.status,
  CASE WHEN c.status='no_grupo' AND COALESCE(dt.oldest_pending_group_at,c.group_sent_at)<now()-interval '24 hours' THEN 'critical' ELSE 'normal' END AS alert_level,
  c.origin,c.is_orphan,c.sale_id,c.pet_name,c.pet_species,c.pet_breed,c.client_name,c.client_phone,c.client_email,c.vet_name,
  COALESCE(json_agg(json_build_object('id',i.id,'exam_card_id',i.exam_card_id,'exam_type',i.exam_type,'lab_name',i.lab_name,
    'document_ids',(SELECT COALESCE(json_agg(di.document_id ORDER BY d.received_at,d.id),'[]'::json) FROM public.exam_document_item di JOIN public.exam_document d ON d.id=di.document_id WHERE di.exam_item_id=i.id),
    'arquivo_url',i.arquivo_url,'result_received',i.result_received,'result_received_at',i.result_received_at,'contacted',i.contacted,
    'contacted_at',i.contacted_at,'contacted_by',i.contacted_by,'sent_to_lab_at',i.sent_to_lab_at,'sent_to_lab_by',i.sent_to_lab_by,'shipment_id',i.shipment_id)
    ORDER BY i.created_at) FILTER(WHERE i.id IS NOT NULL),'[]'::json) AS items,
  count(i.id) FILTER(WHERE i.result_received) AS items_ready,count(i.id) AS items_total,
  round((extract(epoch FROM(now()-c.created_at))/3600)::numeric,1) AS hours_elapsed,c.created_at,c.updated_at,
  COALESCE(dt.oldest_pending_group_at,c.group_sent_at) AS group_sent_at
FROM public.exam_card c LEFT JOIN public.exam_item i ON i.exam_card_id=c.id
LEFT JOIN LATERAL(SELECT min(t.sent_at) AS oldest_pending_group_at FROM public.exam_document_delivery t
  JOIN public.exam_document_item di ON di.document_id=t.document_id JOIN public.exam_item ii ON ii.id=di.exam_item_id
  WHERE ii.exam_card_id=c.id AND t.destination='group' AND t.status='sent' AND di.contacted_at IS NULL) dt ON true
WHERE c.archived_at IS NULL GROUP BY c.id,dt.oldest_pending_group_at;
REVOKE ALL ON public.v_exam_cards FROM anon;
GRANT SELECT ON public.v_exam_cards TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.move_exam_card(uuid,text,text,text,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.merge_exam_cards(uuid,uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.delete_exam_cards(uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.move_exam_card(uuid,text,text,text,text),public.merge_exam_cards(uuid,uuid),public.delete_exam_cards(uuid[]) TO authenticated;
REVOKE ALL ON FUNCTION public.get_exam_card_summary() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_exam_card_summary() TO authenticated;
REVOKE UPDATE,DELETE ON public.exam_card_log FROM authenticated;

-- The legacy matcher remains available only to its backend caller during migration.
-- Its name-based logic is never an anonymous/authenticated way around the new RLS.
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='receive_email_result' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_exam_document_correction(p_document_id uuid,p_previous_document_id uuid,p_expected_version bigint,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_doc public.exam_document; v_previous public.exam_document;
BEGIN
  PERFORM public.require_exam_document_member();
  IF p_document_id=p_previous_document_id OR NULLIF(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'Versões diferentes e motivo obrigatório'; END IF;
  PERFORM 1 FROM public.exam_document WHERE id IN(p_document_id,p_previous_document_id) ORDER BY id FOR NO KEY UPDATE;
  SELECT * INTO STRICT v_doc FROM public.exam_document WHERE id=p_document_id;
  SELECT * INTO STRICT v_previous FROM public.exam_document WHERE id=p_previous_document_id;
  IF v_doc.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'Documento mudou; atualize a tela' USING ERRCODE='40001'; END IF;
  IF v_doc.canonical_document_id IS NOT NULL OR v_previous.canonical_document_id IS NOT NULL OR v_doc.file_status<>'saved' OR v_previous.file_status<>'saved'
    OR v_doc.sha256=v_previous.sha256 OR v_doc.pet_id IS NOT NULL OR v_doc.previous_document_id IS NOT NULL
    OR v_previous.pet_id IS NULL OR v_previous.identification_status<>'confirmed' THEN
    RAISE EXCEPTION 'Correção exige versão anterior com paciente confirmado e novo arquivo com bytes diferentes ainda sem vínculo'; END IF;
  -- The new version cannot create a cycle: it has no links and cannot appear in the older ancestry.
  IF EXISTS(WITH RECURSIVE versions AS(SELECT id,previous_document_id FROM public.exam_document WHERE id=v_previous.id
    UNION ALL SELECT d.id,d.previous_document_id FROM public.exam_document d JOIN versions v ON d.id=v.previous_document_id)
    SELECT 1 FROM versions WHERE id=v_doc.id) THEN RAISE EXCEPTION 'Ciclo de versões inválido'; END IF;
  UPDATE public.exam_document SET previous_document_id=v_previous.id WHERE id=v_doc.id RETURNING * INTO v_doc;
  PERFORM public.log_exam_document(v_doc.id,'correction_linked',jsonb_build_object('previous_document_id',v_previous.id,'reason',p_reason));
  RETURN to_jsonb(v_doc);
END;
$$;
REVOKE ALL ON FUNCTION public.mark_exam_document_correction(uuid,uuid,bigint,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.mark_exam_document_correction(uuid,uuid,bigint,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.release_exam_document_group(p_document_id uuid,p_expected_version bigint,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_doc public.exam_document;
BEGIN
  PERFORM public.require_exam_document_member();
  SELECT * INTO STRICT v_doc FROM public.exam_document WHERE id=p_document_id FOR NO KEY UPDATE;
  IF v_doc.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'Documento mudou; atualize a tela' USING ERRCODE='40001'; END IF;
  IF v_doc.file_status<>'saved' OR v_doc.identification_status NOT IN ('suggested','confirmed') OR NULLIF(trim(p_reason),'') IS NULL THEN
    RAISE EXCEPTION 'Conferência de paciente, arquivo preservado e justificativa obrigatórios'; END IF;
  UPDATE public.exam_document SET group_release_at=COALESCE(group_release_at,now()) WHERE id=v_doc.id;
  INSERT INTO public.exam_document_delivery(document_id,destination) SELECT v_doc.id,'group' WHERE NOT EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=v_doc.id AND destination='group') AND NOT EXISTS(SELECT 1 FROM public.exam_document WHERE id=v_doc.id AND group_exception_reason IS NOT NULL) ON CONFLICT DO NOTHING;
  PERFORM public.log_exam_document(v_doc.id,'group_released',jsonb_build_object('reason',p_reason));
  RETURN jsonb_build_object('document_id',v_doc.id);
END;
$$;
REVOKE ALL ON FUNCTION public.release_exam_document_group(uuid,bigint,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.release_exam_document_group(uuid,bigint,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.confirm_exam_document_group_delivery(p_document_id uuid,p_expected_version bigint,p_external_id text,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_doc public.exam_document; v_task public.exam_document_delivery;
BEGIN
  PERFORM public.require_exam_document_member(ARRAY['admin','vet']);
  SELECT * INTO STRICT v_doc FROM public.exam_document WHERE id=p_document_id FOR NO KEY UPDATE;
  IF v_doc.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'Documento mudou; atualize a tela' USING ERRCODE='40001'; END IF;
  IF NULLIF(trim(p_external_id),'') IS NULL OR NULLIF(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'ID da mensagem e conferência do arquivo no grupo obrigatórios'; END IF;
  SELECT * INTO STRICT v_task FROM public.exam_document_delivery WHERE document_id=v_doc.id AND destination='group' ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF v_task.status NOT IN ('submitted','uncertain','sent') OR (v_task.external_id IS NOT NULL AND v_task.external_id<>p_external_id) THEN
    RAISE EXCEPTION 'Mensagem não corresponde ao envio a conferir'; END IF;
  IF v_task.status='sent' THEN RETURN jsonb_build_object('task',to_jsonb(v_task),'already_confirmed',true); END IF;
  UPDATE public.exam_document_delivery SET status='sent',external_id=p_external_id,external_status='human_confirmed',
    sent_at=COALESCE(sent_at,submitted_at,now()),lease_until=NULL,last_error=NULL,updated_at=now() WHERE id=v_task.id RETURNING * INTO v_task;
  PERFORM public.log_exam_document(v_doc.id,'group_human_confirmed',jsonb_build_object('delivery_id',v_task.id,'external_id',p_external_id,'reason',p_reason));
  UPDATE public.exam_card c SET status=CASE WHEN c.status='exame_pronto' THEN 'no_grupo' ELSE c.status END
    WHERE EXISTS(SELECT 1 FROM public.exam_document_item di JOIN public.exam_item i ON i.id=di.exam_item_id WHERE di.document_id=v_doc.id AND di.contacted_at IS NULL AND i.exam_card_id=c.id);
  RETURN jsonb_build_object('task',to_jsonb(v_task));
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_exam_document_group_delivery(uuid,bigint,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.confirm_exam_document_group_delivery(uuid,bigint,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_exam_document_source_error(p_document_id uuid,p_error text,p_review_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_doc public.exam_document;
BEGIN
  PERFORM public.require_exam_document_service();
  IF NULLIF(trim(p_error),'') IS NULL THEN RAISE EXCEPTION 'Descrição de falha obrigatória'; END IF;
  SELECT * INTO STRICT v_doc FROM public.exam_document WHERE id=p_document_id FOR NO KEY UPDATE;
  IF v_doc.file_status='saved' THEN RAISE EXCEPTION 'Não é permitido degradar um original já preservado'; END IF;
  UPDATE public.exam_document SET file_status='failed',identification_status='review',review_reason=left(COALESCE(p_review_reason,p_error),1000)
    WHERE id=v_doc.id RETURNING * INTO v_doc;
  PERFORM public.log_exam_document(v_doc.id,'source_failed',jsonb_build_object('error',left(p_error,1000)));
  RETURN jsonb_build_object('document_id',v_doc.id,'document',to_jsonb(v_doc));
END;
$$;
REVOKE ALL ON FUNCTION public.record_exam_document_source_error(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_exam_document_source_error(uuid,text,text) TO service_role;

COMMIT;
