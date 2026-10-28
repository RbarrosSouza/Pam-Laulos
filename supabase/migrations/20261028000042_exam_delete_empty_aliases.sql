-- Delete empty deduplication aliases with their canonical ficha; keep real versions protected.
BEGIN;
DO $patch$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('public.begin_exam_document_deletion(uuid,bigint,uuid,text)'::regprocedure) INTO definition;
 IF position($old$  -- This scope intentionally excludes established patient records and shared versions.$old$ in definition)=0 THEN RAISE EXCEPTION 'Deletion function changed; review migration 42'; END IF;
 definition:=replace(definition,$old$  -- This scope intentionally excludes established patient records and shared versions.$old$,$new$  -- Only empty deduplication shells belong to this deletion; real versions stay protected.
  FOR rec IN SELECT id FROM public.exam_document WHERE canonical_document_id=d.id ORDER BY id FOR UPDATE LOOP NULL; END LOOP;
  IF EXISTS(SELECT 1 FROM public.exam_document x WHERE x.canonical_document_id=d.id AND (
    x.previous_document_id IS NOT NULL OR
    x.pet_id IS NOT NULL OR
    x.storage_bucket IS NOT NULL OR
    x.storage_path IS NOT NULL OR
    x.staging_bucket IS NOT NULL OR
    x.staging_path IS NOT NULL OR
    x.drive_file_id IS NOT NULL OR
    x.extracted_data <> '{}'::jsonb OR
    x.confirmed_data <> '{}'::jsonb OR
    EXISTS(SELECT 1 FROM public.exam_document_source WHERE document_id=x.id) OR
    EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=x.id) OR
    EXISTS(SELECT 1 FROM public.exam_document_item WHERE document_id=x.id) OR
    EXISTS(SELECT 1 FROM public.exam_document_responsibility WHERE document_id=x.id) OR
    EXISTS(SELECT 1 FROM public.exam_intake_snapshot WHERE document_id=x.id) OR
    EXISTS(SELECT 1 FROM public.exam_intake_document_hold WHERE document_id=x.id) OR
    EXISTS(SELECT 1 FROM public.exam_intake_receipt WHERE document_id=x.id) OR
    EXISTS(SELECT 1 FROM public.exam_intake_incident WHERE document_id=x.id) OR
    EXISTS(SELECT 1 FROM public.exames WHERE exam_document_id=x.id) OR
    EXISTS(SELECT 1 FROM public.exam_document WHERE previous_document_id=x.id OR canonical_document_id=x.id))) THEN
    RAISE EXCEPTION 'Cópia vinculada com dados próprios exige revisão antes da exclusão' USING ERRCODE='40001';
  END IF;
  -- This scope intentionally excludes established patient records and shared versions.$new$);
 IF position($old$WHERE canonical_document_id=d.id OR previous_document_id=d.id)$old$ in definition)=0 THEN RAISE EXCEPTION 'Deletion function changed; review migration 42'; END IF;
 definition:=replace(definition,$old$WHERE canonical_document_id=d.id OR previous_document_id=d.id)$old$,$new$WHERE previous_document_id=d.id)$new$);
 IF position($old$  UPDATE public.exam_document SET deletion_state='deleting' WHERE id=d.id;$old$ in definition)=0 THEN RAISE EXCEPTION 'Deletion function changed; review migration 42'; END IF;
 definition:=replace(definition,$old$  UPDATE public.exam_document SET deletion_state='deleting' WHERE id=d.id;$old$,$new$  UPDATE public.exam_document SET deletion_state='deleting' WHERE id=d.id;
  PERFORM set_config('exam_document.delete_internal','on',true);
  UPDATE public.exam_document SET deletion_state='deleting' WHERE canonical_document_id=d.id AND deletion_state IS NULL;
  PERFORM set_config('exam_document.delete_internal','off',true);$new$);
 EXECUTE definition;
 SELECT pg_get_functiondef('public.finish_exam_document_deletion(uuid,uuid,text)'::regprocedure) INTO definition;
 IF position($old$  DELETE FROM public.exam_document_event WHERE document_id=d.id;$old$ in definition)=0 THEN RAISE EXCEPTION 'Deletion function changed; review migration 42'; END IF;
 definition:=replace(definition,$old$  DELETE FROM public.exam_document_event WHERE document_id=d.id;$old$,$new$  DELETE FROM public.exam_document_event WHERE document_id=d.id OR document_id IN (SELECT id FROM public.exam_document WHERE canonical_document_id=d.id);$new$);
 IF position($old$  UPDATE public.exam_document SET deletion_state='deleted',original_name='Ficha excluída',file_status='pending',identification_status='not_exam',$old$ in definition)=0 THEN RAISE EXCEPTION 'Deletion function changed; review migration 42'; END IF;
 definition:=replace(definition,$old$  UPDATE public.exam_document SET deletion_state='deleted',original_name='Ficha excluída',file_status='pending',identification_status='not_exam',$old$,$new$  UPDATE public.exam_document SET deletion_state='deleted',original_name='Ficha excluída',extracted_data='{}',confirmed_data='{}',evidence='[]',review_reason=NULL,client_code=NULL,assigned_to=NULL WHERE canonical_document_id=d.id AND deletion_state='deleting';
  UPDATE public.exam_document SET deletion_state='deleted',original_name='Ficha excluída',file_status='pending',identification_status='not_exam',$new$);
 EXECUTE definition;
END $patch$;
COMMIT;
