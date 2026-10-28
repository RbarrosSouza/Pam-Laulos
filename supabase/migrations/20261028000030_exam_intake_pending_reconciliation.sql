BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

-- Service-only identity inventory; no PDF bytes, patient data, download URLs or side effects.
-- UUID order is stable for a page, not insertion order: start a new pass from NULL
-- after reaching next_cursor=NULL to include rows inserted below an earlier cursor.
CREATE FUNCTION public.list_exam_intake_pending_sources(p_collector_id text,p_after_receipt_id uuid DEFAULT NULL,p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE account text; result jsonb; next_id uuid; has_more boolean;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_collector_id IS NULL OR p_collector_id !~ '^[A-Za-z0-9_.:-]{1,96}$' OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid pending source page' USING ERRCODE='22023';
  END IF;
  SELECT scope_manifest->>'account_id' INTO account FROM public.exam_collection_cursor WHERE collector_id=p_collector_id;
  IF NULLIF(account,'') IS NULL THEN RAISE EXCEPTION 'Registered collector account required' USING ERRCODE='22023'; END IF;
  SELECT EXISTS(SELECT 1 FROM public.exam_intake_receipt r WHERE r.collector_id=p_collector_id AND r.disposition IN ('discovered','pending','failed') AND (p_after_receipt_id IS NULL OR r.id>p_after_receipt_id) ORDER BY r.id OFFSET p_limit LIMIT 1) INTO has_more;
  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.receipt_id),'[]'::jsonb),max(x.receipt_id::text)::uuid INTO result,next_id FROM (
    SELECT r.id receipt_id,account account_id,r.partition_key,r.message_id,r.attachment_id,r.artifact_kind
    FROM public.exam_intake_receipt r WHERE r.collector_id=p_collector_id AND r.disposition IN ('discovered','pending','failed')
      AND (p_after_receipt_id IS NULL OR r.id>p_after_receipt_id) ORDER BY r.id LIMIT p_limit
  ) x;
  RETURN jsonb_build_object('contract','exam_intake_pending_source_page_v1','collector_id',p_collector_id,'items',result,'next_cursor',CASE WHEN has_more THEN next_id ELSE NULL END);
END $$;

-- Reconcile only exact existing provenance and immutable canonical stored metadata.
-- This never reserves or creates a source, document, delivery task, message or sweep.
CREATE FUNCTION public.resolve_exam_intake_receipt_saved(p_receipt_id uuid,p_source_id uuid,p_document_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE receipt public.exam_intake_receipt; scope public.exam_collection_cursor; source_row public.exam_document_source; doc public.exam_document; was_saved boolean;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_receipt_id IS NULL OR p_source_id IS NULL OR p_document_id IS NULL THEN RAISE EXCEPTION 'Exact receipt and document identity required' USING ERRCODE='22023'; END IF;
  SELECT * INTO STRICT receipt FROM public.exam_intake_receipt WHERE id=p_receipt_id FOR UPDATE;
  SELECT * INTO STRICT scope FROM public.exam_collection_cursor WHERE collector_id=receipt.collector_id;
  SELECT * INTO STRICT source_row FROM public.exam_document_source WHERE id=p_source_id FOR SHARE;
  SELECT * INTO STRICT doc FROM public.exam_document WHERE id=p_document_id FOR SHARE;
  IF scope.scope_manifest->>'provider' NOT IN ('gmail','outlook','chatwoot') OR NULLIF(scope.scope_manifest->>'account_id','') IS NULL
    OR source_row.channel IS DISTINCT FROM (CASE WHEN scope.scope_manifest->>'provider'='chatwoot' THEN 'whatsapp' ELSE 'email' END)
    OR source_row.account_id IS DISTINCT FROM scope.scope_manifest->>'account_id'
    OR source_row.message_id IS DISTINCT FROM receipt.message_id OR source_row.attachment_id IS DISTINCT FROM receipt.attachment_id
    OR source_row.document_id IS DISTINCT FROM doc.id OR doc.canonical_document_id IS NOT NULL
    OR doc.file_status IS DISTINCT FROM 'saved' OR COALESCE(doc.sha256,'') !~ '^[a-f0-9]{64}$' OR COALESCE(doc.size_bytes,0)<=0
    OR NULLIF(doc.drive_file_id,'') IS NULL OR NULLIF(doc.drive_folder_id,'') IS NULL THEN
    RAISE EXCEPTION 'Preserved exact source identity not proven' USING ERRCODE='40001';
  END IF;
  IF receipt.disposition='excluded' THEN RAISE EXCEPTION 'Excluded receipt requires explicit review' USING ERRCODE='40001'; END IF;
  was_saved:=receipt.disposition='saved';
  IF was_saved AND (receipt.source_id IS DISTINCT FROM source_row.id OR receipt.document_id IS DISTINCT FROM doc.id OR receipt.sha256 IS DISTINCT FROM doc.sha256 OR receipt.size_bytes IS DISTINCT FROM doc.size_bytes) THEN
    RAISE EXCEPTION 'Saved receipt identity cannot change' USING ERRCODE='40001';
  END IF;
  IF NOT was_saved THEN
    UPDATE public.exam_intake_receipt SET disposition='saved',source_id=source_row.id,document_id=doc.id,sha256=doc.sha256,size_bytes=doc.size_bytes,reason_code=NULL,last_seen_at=now() WHERE id=receipt.id;
    UPDATE public.exam_collection_origin SET disposition='saved',source_id=source_row.id WHERE intake_receipt_id=receipt.id;
    UPDATE public.exam_intake_incident SET state='resolved',resolved_at=now() WHERE receipt_id=receipt.id AND state<>'resolved';
    UPDATE public.exam_intake_alert_outbox a SET status='cancelled',updated_at=now() FROM public.exam_intake_incident i WHERE a.incident_id=i.id AND i.receipt_id=receipt.id AND a.status IN ('pending','blocked','reserved') AND a.submit_started_at IS NULL;
  END IF;
  RETURN jsonb_build_object('contract','exam_intake_receipt_resolution_v1','receipt_id',receipt.id,'source_id',source_row.id,'document_id',doc.id,'sha256',doc.sha256,'size_bytes',doc.size_bytes,'disposition','saved','already_saved',was_saved);
END $$;
REVOKE ALL ON FUNCTION public.list_exam_intake_pending_sources(text,uuid,integer),public.resolve_exam_intake_receipt_saved(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.list_exam_intake_pending_sources(text,uuid,integer),public.resolve_exam_intake_receipt_saved(uuid,uuid,uuid) TO service_role;
COMMIT;
