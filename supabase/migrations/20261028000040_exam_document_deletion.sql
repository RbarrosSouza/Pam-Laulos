-- Permanent deletion of an unlinked PamLaudos intake record. The provider's
-- original (Drive/mail/WhatsApp) is outside this operation. Keep only the
-- origin/content identifiers required to prevent a collector replay.
BEGIN;
ALTER TABLE public.exam_document ADD COLUMN deletion_state text CHECK (deletion_state IN ('deleting','deleted'));


CREATE FUNCTION public.exam_deleted_source_identity(p_metadata jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb) FROM jsonb_each(p_metadata)
 WHERE key IN ('provider','gmail_part_id','mailbox','gmail_message_id','hopelab_notice_protocol','link_sha256');
$$;
REVOKE ALL ON FUNCTION public.exam_deleted_source_identity(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.exam_deleted_source_identity(jsonb) TO service_role;

CREATE FUNCTION public.exam_document_deletion_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE doc_id uuid; state text;
BEGIN
  IF TG_TABLE_NAME='exam_document' THEN
    IF TG_OP='UPDATE' AND OLD.deletion_state IS NOT NULL AND current_setting('exam_document.delete_internal',true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'Ficha em exclusão ou excluída' USING ERRCODE='40001';
    END IF;
    FOR doc_id IN SELECT unnest(ARRAY[NEW.canonical_document_id,NEW.previous_document_id]) LOOP
      SELECT deletion_state INTO state FROM public.exam_document WHERE id=doc_id FOR KEY SHARE;
      IF state IS NOT NULL AND current_setting('exam_document.delete_internal',true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'Ficha em exclusão ou excluída' USING ERRCODE='40001';
      END IF;
    END LOOP;
    RETURN NEW;
  ELSIF TG_TABLE_NAME='exam_document_staging_operation' THEN
    SELECT document_id INTO doc_id FROM public.exam_document_source WHERE id=NEW.source_id;
  ELSE
    doc_id:=NEW.document_id;
  END IF;
  -- Synchronize with the deletion transaction before allowing a new external task.
  SELECT deletion_state INTO state FROM public.exam_document WHERE id=doc_id FOR KEY SHARE;
  IF state IS NOT NULL AND current_setting('exam_document.delete_internal',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Ficha em exclusão ou excluída' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER exam_deletion_document_guard BEFORE INSERT OR UPDATE ON public.exam_document FOR EACH ROW EXECUTE FUNCTION public.exam_document_deletion_guard();
CREATE TRIGGER exam_deletion_delivery_guard BEFORE INSERT OR UPDATE ON public.exam_document_delivery FOR EACH ROW EXECUTE FUNCTION public.exam_document_deletion_guard();
CREATE TRIGGER exam_deletion_staging_guard BEFORE INSERT OR UPDATE ON public.exam_document_staging_operation FOR EACH ROW EXECUTE FUNCTION public.exam_document_deletion_guard();
CREATE TRIGGER exam_deletion_item_guard BEFORE INSERT OR UPDATE ON public.exam_document_item FOR EACH ROW EXECUTE FUNCTION public.exam_document_deletion_guard();
CREATE TRIGGER exam_deletion_source_guard BEFORE INSERT OR UPDATE ON public.exam_document_source FOR EACH ROW EXECUTE FUNCTION public.exam_document_deletion_guard();

CREATE FUNCTION public.exam_deleted_receipt_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE doc_id uuid; state text;
BEGIN
  doc_id:=COALESCE(NEW.document_id,CASE WHEN TG_OP='UPDATE' THEN OLD.document_id ELSE NULL END);
  SELECT deletion_state INTO state FROM public.exam_document WHERE id=doc_id FOR KEY SHARE;
  IF state IS NOT NULL
    AND current_setting('exam_document.delete_internal',true) IS DISTINCT FROM 'on'
    AND NOT (NEW.disposition='excluded' AND NEW.reason_code='user_deleted') THEN
    RAISE EXCEPTION 'Origem excluída pelo usuário' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER exam_deletion_receipt_guard BEFORE INSERT OR UPDATE ON public.exam_intake_receipt FOR EACH ROW EXECUTE FUNCTION public.exam_deleted_receipt_guard();

CREATE FUNCTION public.exam_deleted_alert_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE doc_id uuid; receipt uuid; state text;
BEGIN
  IF TG_TABLE_NAME='exam_intake_incident' THEN doc_id:=NEW.document_id; receipt:=NEW.receipt_id;
  ELSE SELECT document_id,receipt_id INTO doc_id,receipt FROM public.exam_intake_incident WHERE id=NEW.incident_id; END IF;
  IF doc_id IS NULL AND receipt IS NOT NULL THEN SELECT document_id INTO doc_id FROM public.exam_intake_receipt WHERE id=receipt; END IF;
  SELECT deletion_state INTO state FROM public.exam_document WHERE id=doc_id FOR KEY SHARE;
  IF state IS NOT NULL AND current_setting('exam_document.delete_internal',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Ficha em exclusão ou excluída' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER exam_deletion_incident_guard BEFORE INSERT OR UPDATE ON public.exam_intake_incident FOR EACH ROW EXECUTE FUNCTION public.exam_deleted_alert_guard();
CREATE TRIGGER exam_deletion_alert_guard BEFORE INSERT OR UPDATE ON public.exam_intake_alert_outbox FOR EACH ROW EXECUTE FUNCTION public.exam_deleted_alert_guard();

CREATE FUNCTION public.exam_document_is_visible(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM public.exam_document WHERE id=p_id AND deletion_state IS DISTINCT FROM 'deleted');
$$;
REVOKE ALL ON FUNCTION public.exam_document_is_visible(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.exam_document_is_visible(uuid) TO authenticated,service_role;
-- Restrictive policies compose with the existing team policies. Service-role
-- bypass is intentional for recovery and collector deduplication.
CREATE POLICY exam_document_not_deleted ON public.exam_document AS RESTRICTIVE FOR SELECT TO authenticated
  USING (deletion_state IS DISTINCT FROM 'deleted');
CREATE POLICY exam_document_source_not_deleted ON public.exam_document_source AS RESTRICTIVE FOR SELECT TO authenticated
  USING (public.exam_document_is_visible(document_id));
CREATE POLICY exam_document_event_not_deleted ON public.exam_document_event AS RESTRICTIVE FOR SELECT TO authenticated
  USING (public.exam_document_is_visible(document_id));
CREATE POLICY exam_document_delivery_not_deleted ON public.exam_document_delivery AS RESTRICTIVE FOR SELECT TO authenticated
  USING (public.exam_document_is_visible(document_id));
CREATE POLICY exam_document_item_not_deleted ON public.exam_document_item AS RESTRICTIVE FOR SELECT TO authenticated
  USING (public.exam_document_is_visible(document_id));

CREATE FUNCTION public.begin_exam_document_deletion(p_id uuid,p_version bigint,p_actor uuid,p_confirmation text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.exam_document; rec record;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_confirmation IS DISTINCT FROM 'DELETAR' OR NOT EXISTS(SELECT 1 FROM public.exam_document_member WHERE user_id=p_actor AND active) THEN
    RAISE EXCEPTION 'Confirmação ou autorização inválida' USING ERRCODE='42501';
  END IF;
  SELECT * INTO STRICT d FROM public.exam_document WHERE id=p_id FOR UPDATE;
  IF d.deletion_state='deleted' THEN RETURN jsonb_build_object('state','deleted'); END IF;
  IF d.deletion_state='deleting' THEN
    RETURN jsonb_build_object('state','deleting','storage_bucket',d.storage_bucket,'storage_path',d.storage_path,'staging_bucket',d.staging_bucket,'staging_path',d.staging_path);
  END IF;
  IF d.version IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'Ficha alterada; atualize a página' USING ERRCODE='40001'; END IF;
  -- This scope intentionally excludes established patient records and shared versions.
  IF d.pet_id IS NOT NULL OR d.canonical_document_id IS NOT NULL OR d.previous_document_id IS NOT NULL
    OR EXISTS(SELECT 1 FROM public.exam_document WHERE canonical_document_id=d.id OR previous_document_id=d.id)
    OR EXISTS(SELECT 1 FROM public.exam_document_item WHERE document_id=d.id)
    OR EXISTS(SELECT 1 FROM public.exames WHERE exam_document_id=d.id)
    OR EXISTS(SELECT 1 FROM public.exam_intake_snapshot WHERE previous_document_id=d.id OR (document_id=d.id AND previous_document_id IS NOT NULL))
    OR EXISTS(SELECT 1 FROM public.exam_intake_document_hold WHERE previous_document_id=d.id OR (document_id=d.id AND previous_document_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'Ficha vinculada a paciente, exame ou outra versão exige revisão antes da exclusão' USING ERRCODE='40001';
  END IF;
  -- Lock the queue rows before checking, so a worker cannot claim between the
  -- check and the state change. Never assume expired/uncertain work is harmless.
  FOR rec IN SELECT id FROM public.exam_document_delivery WHERE document_id=d.id ORDER BY id FOR UPDATE LOOP NULL; END LOOP;
  FOR rec IN SELECT a.id FROM public.exam_intake_alert_outbox a JOIN public.exam_intake_incident i ON i.id=a.incident_id LEFT JOIN public.exam_intake_receipt r ON r.id=i.receipt_id WHERE i.document_id=d.id OR r.document_id=d.id ORDER BY a.id FOR UPDATE OF a LOOP NULL; END LOOP;
  IF EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=d.id AND (status IN ('reserved','submitted','uncertain') OR (destination IN ('group','nexus') AND status IN ('sent','completed'))))
    OR EXISTS(SELECT 1 FROM public.exam_document_staging_operation o JOIN public.exam_document_source s ON s.id=o.source_id WHERE s.document_id=d.id AND o.status IN ('started','uncertain'))
    OR EXISTS(SELECT 1 FROM public.exam_intake_alert_outbox a JOIN public.exam_intake_incident i ON i.id=a.incident_id LEFT JOIN public.exam_intake_receipt r ON r.id=i.receipt_id WHERE (i.document_id=d.id OR r.document_id=d.id) AND a.status IN ('reserved','started','submitted','uncertain')) THEN
    RAISE EXCEPTION 'Ficha em processamento ou já enviada; aguarde revisão antes de excluir' USING ERRCODE='40001';
  END IF;
  IF (d.storage_bucket IS NOT NULL AND (d.storage_bucket<>'exam_documents_private' OR d.storage_path NOT LIKE '%/'||d.id::text||'/original.pdf' OR EXISTS(SELECT 1 FROM public.exam_document x WHERE x.id<>d.id AND ((x.storage_bucket=d.storage_bucket AND x.storage_path=d.storage_path) OR (x.staging_bucket=d.storage_bucket AND x.staging_path=d.storage_path))) OR EXISTS(SELECT 1 FROM public.exames x WHERE x.storage_bucket=d.storage_bucket AND x.storage_path=d.storage_path)))
    OR (d.staging_bucket IS NOT NULL AND (d.staging_bucket<>'exam_documents_staging' OR d.staging_path<>d.id::text||'/original.pdf' OR EXISTS(SELECT 1 FROM public.exam_document x WHERE x.id<>d.id AND ((x.staging_bucket=d.staging_bucket AND x.staging_path=d.staging_path) OR (x.storage_bucket=d.staging_bucket AND x.storage_path=d.staging_path))) OR EXISTS(SELECT 1 FROM public.exames x WHERE x.storage_bucket=d.staging_bucket AND x.storage_path=d.staging_path))) THEN
    RAISE EXCEPTION 'Arquivo compartilhado ou localização não reconhecida; revisão necessária' USING ERRCODE='40001';
  END IF;
  UPDATE public.exam_document_delivery SET status='waived',lease_token=NULL,lease_until=NULL,updated_at=now()
    WHERE document_id=d.id AND status IN ('pending','failed');
  UPDATE public.exam_intake_alert_outbox a SET status='cancelled',updated_at=now()
    FROM public.exam_intake_incident i LEFT JOIN public.exam_intake_receipt r ON r.id=i.receipt_id
    WHERE a.incident_id=i.id AND (i.document_id=d.id OR r.document_id=d.id) AND a.status IN ('blocked','pending','failed');
  UPDATE public.exam_intake_incident i SET state='resolved',resolved_at=COALESCE(resolved_at,now()),document_id=NULL
    WHERE i.document_id=d.id OR EXISTS(SELECT 1 FROM public.exam_intake_receipt r WHERE r.id=i.receipt_id AND r.document_id=d.id);
  UPDATE public.exam_intake_receipt SET disposition='excluded',reason_code='user_deleted',sha256=NULL,size_bytes=NULL
    WHERE document_id=d.id;
  UPDATE public.exam_document SET deletion_state='deleting' WHERE id=d.id;
  RETURN jsonb_build_object('state','deleting','storage_bucket',d.storage_bucket,'storage_path',d.storage_path,'staging_bucket',d.staging_bucket,'staging_path',d.staging_path);
END $$;

CREATE FUNCTION public.finish_exam_document_deletion(p_id uuid,p_actor uuid,p_confirmation text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.exam_document;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_confirmation IS DISTINCT FROM 'DELETAR' OR NOT EXISTS(SELECT 1 FROM public.exam_document_member WHERE user_id=p_actor AND active) THEN
    RAISE EXCEPTION 'Confirmação ou autorização inválida' USING ERRCODE='42501'; END IF;
  SELECT * INTO STRICT d FROM public.exam_document WHERE id=p_id FOR UPDATE;
  IF d.deletion_state='deleted' THEN RETURN jsonb_build_object('state','deleted'); END IF;
  IF d.deletion_state IS DISTINCT FROM 'deleting' THEN RAISE EXCEPTION 'Exclusão não iniciada' USING ERRCODE='40001'; END IF;
  IF EXISTS(SELECT 1 FROM storage.objects WHERE (bucket_id=d.storage_bucket AND name=d.storage_path) OR (bucket_id=d.staging_bucket AND name=d.staging_path)) THEN
    RAISE EXCEPTION 'Arquivo ainda existe no armazenamento; tente novamente' USING ERRCODE='40001'; END IF;
  PERFORM set_config('exam_document.delete_internal','on',true);
  UPDATE public.exam_intake_alert_outbox a SET status='cancelled',updated_at=now()
    FROM public.exam_intake_incident i LEFT JOIN public.exam_intake_receipt r ON r.id=i.receipt_id
    WHERE a.incident_id=i.id AND (i.document_id=d.id OR r.document_id=d.id) AND a.status IN ('blocked','pending','failed');
  UPDATE public.exam_intake_incident i SET state='resolved',resolved_at=COALESCE(resolved_at,now()),document_id=NULL
    WHERE i.document_id=d.id OR EXISTS(SELECT 1 FROM public.exam_intake_receipt r WHERE r.id=i.receipt_id AND r.document_id=d.id);
  UPDATE public.exam_intake_receipt SET disposition='excluded',reason_code='user_deleted',sha256=NULL,size_bytes=NULL
    WHERE document_id=d.id;
  DELETE FROM public.exam_intake_snapshot WHERE document_id=d.id;
  DELETE FROM public.exam_intake_document_hold WHERE document_id=d.id;
  IF to_regclass('public.exam_intake_receipt_detail') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.exam_intake_receipt_detail WHERE receipt_id IN (SELECT id FROM public.exam_intake_receipt WHERE document_id=$1)' USING d.id;
  END IF;
  DELETE FROM public.exam_document_event WHERE document_id=d.id;
  DELETE FROM public.exam_document_responsibility WHERE document_id=d.id;
  DELETE FROM public.exam_document_delivery WHERE document_id=d.id;
  UPDATE public.exam_document_source SET metadata=public.exam_deleted_source_identity(metadata) WHERE document_id=d.id;
  UPDATE public.exam_document SET deletion_state='deleted',original_name='Ficha excluída',file_status='pending',identification_status='not_exam',
    drive_file_id=NULL,drive_folder_id=NULL,drive_name=NULL,staging_bucket=NULL,staging_path=NULL,storage_bucket=NULL,storage_path=NULL,
    extracted_data='{}',confirmed_data='{}',evidence='[]',extractor_version=NULL,review_reason=NULL,client_code=NULL,assigned_to=NULL,
    group_release_at=NULL,group_exception_reason=NULL WHERE id=d.id;
  RETURN jsonb_build_object('state','deleted');
END $$;
REVOKE ALL ON FUNCTION public.begin_exam_document_deletion(uuid,bigint,uuid,text),public.finish_exam_document_deletion(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.begin_exam_document_deletion(uuid,bigint,uuid,text),public.finish_exam_document_deletion(uuid,uuid,text) TO service_role;

-- Preserve the original lookup's strict origin matching; only replace the
-- public result for an already verified, deliberately deleted origin.
ALTER FUNCTION public.lookup_exam_intake_sources(text,jsonb) RENAME TO lookup_exam_intake_sources_before_deletion;
CREATE FUNCTION public.lookup_exam_intake_sources(p_collector_id text,p_identities jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE original jsonb; item jsonb; items jsonb:='[]'::jsonb;
BEGIN
  PERFORM public.require_exam_document_service();
  original:=public.lookup_exam_intake_sources_before_deletion(p_collector_id,p_identities);
  FOR item IN SELECT value FROM jsonb_array_elements(original->'items') LOOP
    IF item->>'source_document_id' IS NOT NULL AND EXISTS(SELECT 1 FROM public.exam_document WHERE id=(item->>'source_document_id')::uuid AND deletion_state IS NOT NULL) THEN
      item:=(item-ARRAY['source_id','source_document_id','document_id','sha256','size_bytes','file_status','canonical_file_preserved','group_status'])
        ||jsonb_build_object('status','excluded','reason','user_deleted');
    END IF;
    items:=items||jsonb_build_array(item);
  END LOOP;
  RETURN jsonb_set(original,'{items}',items);
END $$;
REVOKE ALL ON FUNCTION public.lookup_exam_intake_sources(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_exam_intake_sources(text,jsonb) TO service_role;

-- Suppress a newly observed copy of the same content before upload. Only an
-- untouched provisional record can be collapsed; uncertain staging, clinical
-- links and notice snapshots stay blocked for human review.
ALTER FUNCTION public.stage_exam_document_file(uuid,jsonb,text) RENAME TO stage_exam_document_file_before_deletion;
CREATE FUNCTION public.stage_exam_document_file(p_document_id uuid,p_file jsonb,p_worker text DEFAULT 'ingestion')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE fingerprint text; bytes bigint; tomb public.exam_document; candidate public.exam_document; source_ids uuid[]; rec record;
BEGIN
  PERFORM public.require_exam_document_service();
  fingerprint:=lower(p_file->>'sha256');
  IF fingerprint IS NULL OR fingerprint !~ '^[a-f0-9]{64}$' OR COALESCE(p_file->>'size_bytes','') !~ '^[0-9]{1,12}$' THEN
    RETURN public.stage_exam_document_file_before_deletion(p_document_id,p_file,p_worker);
  END IF;
  bytes:=(p_file->>'size_bytes')::bigint;
  IF bytes<1 OR bytes>(SELECT max_file_bytes FROM public.exam_document_configuration) THEN
    RETURN public.stage_exam_document_file_before_deletion(p_document_id,p_file,p_worker);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(fingerprint||':'||bytes,0));
  SELECT * INTO tomb FROM public.exam_document WHERE sha256=fingerprint AND size_bytes=bytes AND canonical_document_id IS NULL AND deletion_state IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN public.stage_exam_document_file_before_deletion(p_document_id,p_file,p_worker); END IF;
  SELECT * INTO STRICT candidate FROM public.exam_document WHERE id=p_document_id FOR UPDATE;
  IF candidate.id=tomb.id THEN
    RETURN jsonb_build_object('document_id',tomb.id,'state','deleted','excluded',true,'claimed',false,'upload_required',false);
  END IF;
  IF candidate.deletion_state IS NOT NULL OR candidate.pet_id IS NOT NULL OR candidate.canonical_document_id IS NOT NULL OR candidate.previous_document_id IS NOT NULL
    OR candidate.drive_file_id IS NOT NULL OR candidate.storage_bucket IS NOT NULL OR candidate.staging_bucket IS NOT NULL
    OR EXISTS(SELECT 1 FROM public.exam_document WHERE canonical_document_id=candidate.id OR previous_document_id=candidate.id)
    OR EXISTS(SELECT 1 FROM public.exam_document_item WHERE document_id=candidate.id)
    OR EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=candidate.id)
    OR EXISTS(SELECT 1 FROM public.exam_intake_document_hold WHERE previous_document_id=candidate.id OR (document_id=candidate.id AND previous_document_id IS NOT NULL))
    OR EXISTS(SELECT 1 FROM public.exam_document_staging_operation o JOIN public.exam_document_source s ON s.id=o.source_id WHERE s.document_id=candidate.id AND o.status<>'reported')
    OR EXISTS(SELECT 1 FROM public.exam_intake_snapshot WHERE document_id=candidate.id OR previous_document_id=candidate.id) THEN
    RAISE EXCEPTION 'Cópia de ficha excluída exige revisão antes de reprocessar' USING ERRCODE='40001';
  END IF;
  SELECT array_agg(id) INTO source_ids FROM public.exam_document_source WHERE document_id=candidate.id;
  FOR rec IN SELECT r.id FROM public.exam_intake_receipt r JOIN public.exam_collection_cursor c ON c.collector_id=r.collector_id
    JOIN public.exam_document_source s ON s.id=ANY(source_ids) AND s.account_id=c.scope_manifest->>'account_id' AND s.message_id=r.message_id AND s.attachment_id=r.attachment_id
    ORDER BY r.id FOR UPDATE OF r LOOP NULL; END LOOP;
  IF EXISTS(SELECT 1 FROM public.exam_intake_receipt r JOIN public.exam_collection_cursor c ON c.collector_id=r.collector_id
    JOIN public.exam_document_source s ON s.id=ANY(source_ids) AND s.account_id=c.scope_manifest->>'account_id' AND s.message_id=r.message_id AND s.attachment_id=r.attachment_id
    WHERE (r.document_id IS NOT NULL AND r.document_id<>candidate.id) OR (r.source_id IS NOT NULL AND r.source_id<>s.id)) THEN
    RAISE EXCEPTION 'Origem vinculada a outro documento; revisão necessária' USING ERRCODE='40001'; END IF;
  FOR rec IN SELECT a.id FROM public.exam_intake_alert_outbox a JOIN public.exam_intake_incident i ON i.id=a.incident_id JOIN public.exam_intake_receipt r ON r.id=i.receipt_id
    JOIN public.exam_collection_cursor c ON c.collector_id=r.collector_id JOIN public.exam_document_source s ON s.id=ANY(source_ids) AND s.account_id=c.scope_manifest->>'account_id' AND s.message_id=r.message_id AND s.attachment_id=r.attachment_id
    ORDER BY a.id FOR UPDATE OF a LOOP NULL; END LOOP;
  IF EXISTS(SELECT 1 FROM public.exam_intake_alert_outbox a JOIN public.exam_intake_incident i ON i.id=a.incident_id JOIN public.exam_intake_receipt r ON r.id=i.receipt_id
    JOIN public.exam_collection_cursor c ON c.collector_id=r.collector_id JOIN public.exam_document_source s ON s.id=ANY(source_ids) AND s.account_id=c.scope_manifest->>'account_id' AND s.message_id=r.message_id AND s.attachment_id=r.attachment_id
    WHERE a.status IN ('reserved','started','submitted','uncertain')) THEN
    RAISE EXCEPTION 'Alerta da origem em andamento; revisão necessária' USING ERRCODE='40001'; END IF;
  PERFORM set_config('exam_document.delete_internal','on',true);
  UPDATE public.exam_intake_alert_outbox a SET status='cancelled',updated_at=now() FROM public.exam_intake_incident i JOIN public.exam_intake_receipt r ON r.id=i.receipt_id
    JOIN public.exam_collection_cursor c ON c.collector_id=r.collector_id JOIN public.exam_document_source s ON s.id=ANY(source_ids) AND s.account_id=c.scope_manifest->>'account_id' AND s.message_id=r.message_id AND s.attachment_id=r.attachment_id
    WHERE a.incident_id=i.id AND a.status IN ('blocked','pending','failed');
  UPDATE public.exam_intake_incident i SET state='resolved',resolved_at=COALESCE(resolved_at,now()),document_id=NULL FROM public.exam_intake_receipt r
    JOIN public.exam_collection_cursor c ON c.collector_id=r.collector_id JOIN public.exam_document_source s ON s.id=ANY(source_ids) AND s.account_id=c.scope_manifest->>'account_id' AND s.message_id=r.message_id AND s.attachment_id=r.attachment_id WHERE i.receipt_id=r.id;
  UPDATE public.exam_intake_receipt r SET source_id=s.id,document_id=tomb.id,disposition='excluded',reason_code='user_deleted',sha256=NULL,size_bytes=NULL
    FROM public.exam_collection_cursor c JOIN public.exam_document_source s ON s.id=ANY(source_ids) AND s.account_id=c.scope_manifest->>'account_id'
    WHERE c.collector_id=r.collector_id AND s.message_id=r.message_id AND s.attachment_id=r.attachment_id;
  DELETE FROM public.exam_intake_document_hold WHERE document_id=candidate.id;
  IF to_regclass('public.exam_intake_receipt_detail') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.exam_intake_receipt_detail WHERE receipt_id IN (SELECT id FROM public.exam_intake_receipt WHERE source_id=ANY($1))' USING source_ids;
  END IF;
  UPDATE public.exam_document_source SET document_id=tomb.id,metadata=public.exam_deleted_source_identity(metadata) WHERE document_id=candidate.id;
  DELETE FROM public.exam_document_event WHERE document_id=candidate.id;
  UPDATE public.exam_document SET canonical_document_id=tomb.id,deletion_state='deleted',original_name='Ficha excluída',identification_status='not_exam',
    sha256=NULL,size_bytes=NULL,extracted_data='{}',confirmed_data='{}',evidence='[]',extractor_version=NULL,review_reason=NULL,client_code=NULL,assigned_to=NULL,
    group_release_at=NULL,group_exception_reason=NULL WHERE id=candidate.id;
  PERFORM set_config('exam_document.delete_internal','off',true);
  RETURN jsonb_build_object('document_id',tomb.id,'state','deleted','excluded',true,'claimed',false,'upload_required',false);
END $$;
REVOKE ALL ON FUNCTION public.stage_exam_document_file(uuid,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.stage_exam_document_file(uuid,jsonb,text) TO service_role;

DO $$ DECLARE definition text; needle text := 'IF source_ids IS NULL THEN RETURN result; END IF;'; BEGIN
  definition := pg_get_functiondef('public.stage_exam_intake_file(uuid,jsonb,text)'::regprocedure);
  IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Notice staging contract changed; review before installation'; END IF;
  definition := replace(definition,needle,'IF result->>''excluded''=''true'' OR source_ids IS NULL THEN RETURN result; END IF;');
  definition := replace(definition,'older_doc.canonical_document_id IS NULL','older_doc.canonical_document_id IS NULL AND older_doc.deletion_state IS NULL');
  EXECUTE definition;
END $$;

COMMIT;
