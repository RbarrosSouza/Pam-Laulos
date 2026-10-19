-- An observation is optional. Keep the existing contact evidence, authorization,
-- item projection and contact_recorded event consumed by the reaction outbox.
-- No historical contact is rewritten and no reaction/destination is activated.
BEGIN;

CREATE OR REPLACE FUNCTION public.record_exam_document_contact(p_document_id uuid,p_item_ids uuid[],p_channel text,p_note text DEFAULT NULL,p_contacted_at timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_actor uuid; v_doc public.exam_document; v_id uuid; v_note text;
BEGIN
  v_actor:=public.require_exam_document_member(ARRAY['admin','vet']);
  SELECT * INTO STRICT v_doc FROM public.exam_document WHERE id=p_document_id FOR NO KEY UPDATE;
  IF v_doc.identification_status<>'confirmed' OR v_doc.file_status<>'saved' THEN RAISE EXCEPTION 'Confirme o paciente e preserve o resultado antes do contato'; END IF;
  IF p_channel IS NULL OR p_channel NOT IN ('whatsapp','phone','email','in_person') OR p_contacted_at IS NULL
    OR p_contacted_at>now()+interval '5 minutes' OR p_contacted_at<v_doc.received_at THEN RAISE EXCEPTION 'Canal e data de contato válidos são obrigatórios'; END IF;
  IF cardinality(COALESCE(p_item_ids,'{}'))=0 OR EXISTS(SELECT 1 FROM unnest(p_item_ids) x WHERE NOT EXISTS(SELECT 1 FROM public.exam_document_item WHERE document_id=v_doc.id AND exam_item_id=x)) THEN
    RAISE EXCEPTION 'Selecione somente itens abrangidos por este documento'; END IF;
  -- Preserve meaningful text exactly; normalize every entirely blank note,
  -- including tabs/newlines, without changing previously recorded evidence.
  v_note:=CASE WHEN p_note IS NULL OR p_note ~ '^[[:space:]]*$' THEN NULL ELSE p_note END;
  FOREACH v_id IN ARRAY p_item_ids LOOP
    UPDATE public.exam_document_item SET contacted_by=v_actor,contacted_at=p_contacted_at,contact_channel=p_channel,contact_note=v_note
      WHERE document_id=v_doc.id AND exam_item_id=v_id AND contacted_at IS NULL;
    UPDATE public.exam_item SET contacted=NOT EXISTS(SELECT 1 FROM public.exam_document_item WHERE exam_item_id=v_id AND contacted_at IS NULL),
      contacted_at=CASE WHEN NOT EXISTS(SELECT 1 FROM public.exam_document_item WHERE exam_item_id=v_id AND contacted_at IS NULL) THEN (SELECT max(contacted_at) FROM public.exam_document_item WHERE exam_item_id=v_id) ELSE NULL END,
      contacted_by=CASE WHEN NOT EXISTS(SELECT 1 FROM public.exam_document_item WHERE exam_item_id=v_id AND contacted_at IS NULL) THEN (SELECT contacted_by::text FROM public.exam_document_item WHERE exam_item_id=v_id ORDER BY contacted_at DESC LIMIT 1) ELSE NULL END WHERE id=v_id;
  END LOOP;
  UPDATE public.exam_document SET assigned_to=COALESCE(assigned_to,v_actor) WHERE id=v_doc.id RETURNING * INTO v_doc;
  PERFORM public.log_exam_document(v_doc.id,'contact_recorded',jsonb_build_object('item_ids',p_item_ids,'channel',p_channel,'contacted_at',p_contacted_at));
  RETURN jsonb_build_object('document_id',v_doc.id,'document',to_jsonb(v_doc));
END;
$$;
-- CREATE OR REPLACE retains this function's existing owner and EXECUTE grants.
COMMIT;
