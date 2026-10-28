BEGIN;

DO $$ BEGIN
  IF to_regclass('public.exam_intake_receipt') IS NULL OR to_regclass('public.exam_intake_document_hold') IS NULL
    OR to_regprocedure('public.require_exam_document_service()') IS NULL THEN
    RAISE EXCEPTION 'Install intake schema 23 and 24 before the read-only source lookup';
  END IF;
END $$;

CREATE FUNCTION public.lookup_exam_intake_sources(p_collector_id text,p_identities jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE scope public.exam_collection_cursor; identity jsonb; source_row public.exam_document_source; doc public.exam_document;
  source_ids uuid[]; visited uuid[]; depth integer; expected_channel text; match_kind text; item_status text; reason text; group_status text;
  preserved boolean; exact_binding boolean; result jsonb:='[]'::jsonb; original_document_id uuid;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_collector_id IS NULL OR p_collector_id !~ '^[A-Za-z0-9_.:-]{1,96}$' OR jsonb_typeof(p_identities) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_identities) NOT BETWEEN 1 AND 100 OR octet_length(p_identities::text)>262144 THEN
    RAISE EXCEPTION 'A collector and one to one hundred source identities are required';
  END IF;
  SELECT * INTO scope FROM public.exam_collection_cursor WHERE collector_id=p_collector_id;
  IF NOT FOUND OR COALESCE(scope.scope_manifest->>'provider','') NOT IN ('gmail','outlook','chatwoot') OR NULLIF(scope.scope_manifest->>'account_id','') IS NULL THEN
    RAISE EXCEPTION 'Registered intake account scope required';
  END IF;
  expected_channel:=CASE WHEN scope.scope_manifest->>'provider'='chatwoot' THEN 'whatsapp' ELSE 'email' END;
  FOR identity IN SELECT value FROM jsonb_array_elements(p_identities) LOOP
    IF jsonb_typeof(identity) IS DISTINCT FROM 'object' OR (identity-ARRAY['account_id','message_id','attachment_id','partition_key'])<>'{}'::jsonb
      OR jsonb_typeof(identity->'account_id') IS DISTINCT FROM 'string' OR length(COALESCE(identity->>'account_id','')) NOT BETWEEN 1 AND 2048
      OR jsonb_typeof(identity->'message_id') IS DISTINCT FROM 'string' OR length(COALESCE(identity->>'message_id','')) NOT BETWEEN 1 AND 2048
      OR jsonb_typeof(identity->'attachment_id') IS DISTINCT FROM 'string' OR length(COALESCE(identity->>'attachment_id','')) NOT BETWEEN 1 AND 2048
      OR (identity->>'account_id') ~ '[[:cntrl:]]' OR (identity->>'message_id') ~ '[[:cntrl:]]' OR (identity->>'attachment_id') ~ '[[:cntrl:]]'
      OR (identity?'partition_key' AND (jsonb_typeof(identity->'partition_key') IS DISTINCT FROM 'string' OR length(identity->>'partition_key') NOT BETWEEN 1 AND 2048 OR (identity->>'partition_key') ~ '[[:cntrl:]]')) THEN
      RAISE EXCEPTION 'Only sanitized account, message, attachment and optional partition identities are accepted';
    END IF;
    source_row:=NULL; doc:=NULL; source_ids:=NULL; visited:='{}'::uuid[]; depth:=0; original_document_id:=NULL;
    match_kind:=NULL; item_status:='not_found'; reason:='source_origin_not_recorded'; group_status:='unknown'; preserved:=false; exact_binding:=false;
    IF identity->>'account_id' IS DISTINCT FROM scope.scope_manifest->>'account_id' THEN
      item_status:='pending'; reason:='lookup_account_scope_mismatch';
    ELSE
      SELECT * INTO source_row FROM public.exam_document_source s WHERE s.channel=expected_channel AND s.account_id=identity->>'account_id'
        AND s.message_id=identity->>'message_id' AND s.attachment_id=identity->>'attachment_id';
      IF FOUND THEN match_kind:='exact_origin'; exact_binding:=true;
      ELSIF scope.scope_manifest->>'provider'='gmail' AND identity->>'attachment_id' ~ '^hopelab-link:([a-f0-9]{64}|missing)$' THEN
        SELECT array_agg(s.id ORDER BY s.id) INTO source_ids FROM public.exam_document_source s
          WHERE s.channel='email' AND s.account_id=identity->>'account_id' AND s.attachment_id=identity->>'attachment_id'
            AND s.metadata->>'provider'='hopelab_link' AND s.metadata->>'gmail_message_id'=identity->>'message_id'
            AND s.metadata->>'hopelab_notice_protocol' IS DISTINCT FROM 'gmail_notice_link_v2';
        IF cardinality(source_ids)=1 THEN SELECT * INTO source_row FROM public.exam_document_source WHERE id=source_ids[1];match_kind:='legacy_notice_metadata';
        ELSIF cardinality(source_ids)>1 THEN item_status:='pending';reason:='legacy_notice_source_ambiguous';
        ELSE reason:='notice_origin_not_recorded'; END IF;
      END IF;
      IF source_row.id IS NOT NULL THEN
        item_status:='pending';reason:='source_original_not_preserved';original_document_id:=source_row.document_id;
        SELECT * INTO doc FROM public.exam_document WHERE id=source_row.document_id;
        WHILE doc.id IS NOT NULL AND doc.canonical_document_id IS NOT NULL LOOP
          IF doc.id=ANY(visited) OR depth>=8 THEN reason:='canonical_lineage_unresolved';doc:=NULL;EXIT; END IF;
          visited:=array_append(visited,doc.id);depth:=depth+1;
          SELECT * INTO doc FROM public.exam_document WHERE id=doc.canonical_document_id;
        END LOOP;
        IF doc.id IS NOT NULL THEN
          preserved:=doc.canonical_document_id IS NULL AND doc.file_status='saved' AND doc.sha256 IS NOT NULL AND doc.size_bytes>0
            AND doc.drive_file_id IS NOT NULL AND doc.drive_folder_id IS NOT NULL;
          IF exact_binding AND depth=0 AND preserved THEN item_status:='saved';reason:='canonical_original_preserved';
          ELSIF match_kind='legacy_notice_metadata' THEN reason:='legacy_notice_binding_requires_review';
          ELSIF depth>0 THEN reason:='source_alias_binding_requires_review';
          ELSIF doc.file_status='failed' THEN reason:='source_original_preservation_failed';
          END IF;
          group_status:=CASE
            WHEN EXISTS(SELECT 1 FROM public.exam_document_delivery t WHERE t.document_id=doc.id AND t.destination='group' AND t.status='sent') THEN 'sent'
            WHEN doc.identification_status='not_exam' THEN 'not_exam'
            WHEN doc.group_exception_reason IS NOT NULL OR EXISTS(SELECT 1 FROM public.exam_document_delivery t WHERE t.document_id=doc.id AND t.destination='group' AND t.status='waived') THEN 'waived'
            WHEN EXISTS(SELECT 1 FROM public.exam_intake_document_hold h WHERE h.document_id=doc.id AND h.state='held') THEN 'held'
            WHEN EXISTS(SELECT 1 FROM public.exam_document_delivery t WHERE t.document_id=doc.id AND t.destination='group' AND t.status='uncertain') THEN 'uncertain'
            WHEN EXISTS(SELECT 1 FROM public.exam_document_delivery t WHERE t.document_id=doc.id AND t.destination='group' AND t.status='submitted') THEN 'submitted'
            WHEN EXISTS(SELECT 1 FROM public.exam_document_delivery t WHERE t.document_id=doc.id AND t.destination='group' AND t.status='reserved') THEN 'reserved'
            WHEN EXISTS(SELECT 1 FROM public.exam_document_delivery t WHERE t.document_id=doc.id AND t.destination='group' AND t.status='failed') THEN 'failed'
            WHEN EXISTS(SELECT 1 FROM public.exam_document_delivery t WHERE t.document_id=doc.id AND t.destination='group') THEN 'pending'
            ELSE 'not_queued' END;
        ELSE reason:='canonical_lineage_unresolved'; END IF;
      END IF;
    END IF;
    result:=result||jsonb_build_array(jsonb_build_object('message_id',identity->>'message_id','attachment_id',identity->>'attachment_id',
      'status',item_status,'reason',reason,'match_kind',match_kind,'source_id',source_row.id,'source_document_id',original_document_id,
      'document_id',doc.id,'sha256',doc.sha256,'size_bytes',doc.size_bytes,'file_status',doc.file_status,
      'canonical_file_preserved',preserved,'group_status',group_status));
  END LOOP;
  RETURN jsonb_build_object('contract','exam_intake_source_lookup_v1','items',result);
END $$;

REVOKE ALL ON FUNCTION public.lookup_exam_intake_sources(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_exam_intake_sources(text,jsonb) TO service_role;
COMMIT;
