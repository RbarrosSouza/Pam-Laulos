BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

-- Gmail attachmentId is a download locator that can change. The immutable
-- provenance is mailbox + message + MIME part. Parse cautiously and fail closed.
CREATE FUNCTION public.exam_intake_gmail_part_key(p_key text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE value jsonb; part text;
BEGIN
  IF p_key IS NULL OR left(p_key,11)<>'gmail-part:' OR length(p_key)>2048 THEN RETURN NULL; END IF;
  BEGIN value:=substring(p_key FROM 12)::jsonb; EXCEPTION WHEN OTHERS THEN RETURN NULL; END;
  IF jsonb_typeof(value)<>'array' THEN RETURN NULL; END IF;
  IF jsonb_array_length(value)<>2 OR jsonb_typeof(value->0)<>'string'
    OR jsonb_typeof(value->1) NOT IN ('string','null') THEN RETURN NULL; END IF;
  part:=value->>0;
  IF length(part)>2048 OR part ~ '[[:cntrl:]]' THEN RETURN NULL; END IF;
  RETURN part;
END $$;

CREATE FUNCTION public.exam_intake_gmail_part_binding(p_source_id uuid,p_account text,p_message text,p_key text)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE part text; src public.exam_document_source; parsed jsonb; candidates integer;
BEGIN
  part:=public.exam_intake_gmail_part_key(p_key);
  IF part IS NULL OR p_account IS NULL OR p_message IS NULL THEN RETURN false; END IF;
  SELECT * INTO src FROM public.exam_document_source WHERE id=p_source_id;
  IF NOT FOUND OR src.channel<>'email' OR src.account_id IS DISTINCT FROM p_account OR src.message_id IS DISTINCT FROM p_message
    OR src.metadata->>'provider' IS DISTINCT FROM 'gmail' OR src.metadata->>'gmail_message_id' IS DISTINCT FROM p_message
    OR 'gmail:'||(src.metadata->>'mailbox') IS DISTINCT FROM p_account
    OR jsonb_typeof(src.metadata->'gmail_part_id') IS DISTINCT FROM 'string' OR src.metadata->>'gmail_part_id' IS DISTINCT FROM part
    OR public.exam_intake_gmail_part_key(src.attachment_id) IS DISTINCT FROM part
    OR NOT (src.metadata ? 'gmail_attachment_id') THEN RETURN false; END IF;
  BEGIN parsed:=substring(src.attachment_id FROM 12)::jsonb; EXCEPTION WHEN OTHERS THEN RETURN false; END;
  IF parsed->1 IS DISTINCT FROM src.metadata->'gmail_attachment_id' THEN RETURN false; END IF;
  SELECT count(*) INTO candidates FROM public.exam_document_source s WHERE s.channel='email' AND s.account_id=p_account AND s.message_id=p_message
    AND (public.exam_intake_gmail_part_key(s.attachment_id)=part OR s.metadata->>'gmail_part_id'=part);
  RETURN candidates=1;
END $$;
REVOKE ALL ON FUNCTION public.exam_intake_gmail_part_key(text),public.exam_intake_gmail_part_binding(uuid,text,text,text) FROM PUBLIC,anon,authenticated,service_role;

-- Patch only the three installed, known contracts; abort atomically if a source
-- fragment drifted. Existing source IDs, attachment IDs and metadata stay intact.
DO $patch$
DECLARE fn oid; definition text; old text; new text;
BEGIN
  fn:='public.lookup_exam_intake_sources(text,jsonb)'::regprocedure;
  SELECT pg_get_functiondef(fn) INTO definition;
  old:=$old$      ELSIF scope.scope_manifest->>'provider'='gmail' AND identity->>'attachment_id' ~ '^hopelab-link:([a-f0-9]{64}|missing)$' THEN$old$;
  new:=$new$      ELSIF scope.scope_manifest->>'provider'='gmail' AND public.exam_intake_gmail_part_key(identity->>'attachment_id') IS NOT NULL THEN
        SELECT array_agg(s.id ORDER BY s.id) INTO source_ids FROM public.exam_document_source s
          WHERE s.channel='email' AND s.account_id=identity->>'account_id' AND s.message_id=identity->>'message_id'
            AND (public.exam_intake_gmail_part_key(s.attachment_id)=public.exam_intake_gmail_part_key(identity->>'attachment_id')
              OR s.metadata->>'gmail_part_id'=public.exam_intake_gmail_part_key(identity->>'attachment_id'));
        IF cardinality(source_ids)=1 AND public.exam_intake_gmail_part_binding(source_ids[1],identity->>'account_id',identity->>'message_id',identity->>'attachment_id') THEN
          SELECT * INTO source_row FROM public.exam_document_source WHERE id=source_ids[1];match_kind:='gmail_part_origin';exact_binding:=true;
        ELSIF cardinality(source_ids)>0 THEN item_status:='pending';reason:='gmail_part_binding_requires_review'; END IF;
      ELSIF scope.scope_manifest->>'provider'='gmail' AND identity->>'attachment_id' ~ '^hopelab-link:([a-f0-9]{64}|missing)$' THEN$new$;
  IF position(old IN definition)=0 OR position(old IN substring(definition FROM position(old IN definition)+length(old)))>0 THEN RAISE EXCEPTION 'Lookup contract drift'; END IF;
  EXECUTE replace(definition,old,new);

  fn:='public.record_exam_intake_event(uuid,uuid,jsonb)'::regprocedure;
  SELECT pg_get_functiondef(fn) INTO definition;
  old:=$old$source_row.attachment_id<>attachment$old$;
  new:=$new$(source_row.attachment_id<>attachment AND NOT (cursor_row.scope_manifest->>'provider'='gmail' AND public.exam_intake_gmail_part_binding(source_row.id,source_row.account_id,message,attachment)))$new$;
  IF position(old IN definition)=0 OR position(old IN substring(definition FROM position(old IN definition)+length(old)))>0 THEN RAISE EXCEPTION 'Receipt event contract drift'; END IF;
  definition:=replace(definition,old,new);
  old:=$old$      SELECT * INTO STRICT source_row FROM public.exam_document_source WHERE id=(p_event->>'source_id')::uuid;$old$;
  new:=$new$      IF cursor_row.scope_manifest->>'provider'='gmail' AND public.exam_intake_gmail_part_key(attachment) IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('gmail_part_v1',cursor_row.scope_manifest->>'account_id',message,public.exam_intake_gmail_part_key(attachment))::text,0));
      END IF;
      SELECT * INTO STRICT source_row FROM public.exam_document_source WHERE id=(p_event->>'source_id')::uuid;$new$;
  IF position(old IN definition)=0 OR position(old IN substring(definition FROM position(old IN definition)+length(old)))>0 THEN RAISE EXCEPTION 'Receipt event source lock drift'; END IF;
  EXECUTE replace(definition,old,new);

  fn:='public.resolve_exam_intake_receipt_saved(uuid,uuid,uuid)'::regprocedure;
  SELECT pg_get_functiondef(fn) INTO definition;
  old:=$old$source_row.attachment_id IS DISTINCT FROM receipt.attachment_id$old$;
  new:=$new$(source_row.attachment_id IS DISTINCT FROM receipt.attachment_id AND NOT (scope.scope_manifest->>'provider'='gmail' AND public.exam_intake_gmail_part_binding(source_row.id,source_row.account_id,receipt.message_id,receipt.attachment_id)))$new$;
  IF position(old IN definition)=0 OR position(old IN substring(definition FROM position(old IN definition)+length(old)))>0 THEN RAISE EXCEPTION 'Receipt resolution contract drift'; END IF;
  definition:=replace(definition,old,new);
  old:=$old$  SELECT * INTO STRICT source_row FROM public.exam_document_source WHERE id=p_source_id FOR SHARE;$old$;
  new:=$new$  IF scope.scope_manifest->>'provider'='gmail' AND public.exam_intake_gmail_part_key(receipt.attachment_id) IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('gmail_part_v1',scope.scope_manifest->>'account_id',receipt.message_id,public.exam_intake_gmail_part_key(receipt.attachment_id))::text,0));
  END IF;
  SELECT * INTO STRICT source_row FROM public.exam_document_source WHERE id=p_source_id FOR SHARE;$new$;
  IF position(old IN definition)=0 OR position(old IN substring(definition FROM position(old IN definition)+length(old)))>0 THEN RAISE EXCEPTION 'Receipt resolution source lock drift'; END IF;
  EXECUTE replace(definition,old,new);
END $patch$;
COMMIT;
