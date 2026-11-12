-- Discovery acknowledgement is independent of delivery: pending media still uses the
-- durable retry queue, and both overlapping provider scans keep finding late attachments.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

CREATE TABLE public.exam_fallback_discovery_ack (
  source_id uuid PRIMARY KEY REFERENCES public.exam_document_source(id) ON DELETE CASCADE,
  fingerprint bytea NOT NULL CHECK (octet_length(fingerprint)=32),
  disposition text NOT NULL CHECK (disposition IN ('queued','requires_review','source_excluded'))
);
ALTER TABLE public.exam_fallback_discovery_ack ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.exam_fallback_discovery_ack FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.exam_fallback_discovery_ack TO service_role;

CREATE FUNCTION public.enqueue_exam_fallback_sources(p_sources jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cfg public.exam_fallback_configuration; item jsonb; source_row public.exam_document_source;
  previous public.exam_fallback_discovery_ack; fingerprint_value bytea; outcome jsonb;
  terminal boolean; disposition_value text; acknowledged integer:=0; enqueued integer:=0; unchanged integer:=0;
BEGIN
  PERFORM public.require_exam_document_service();
  SELECT * INTO STRICT cfg FROM public.exam_fallback_configuration WHERE singleton;
  IF p_sources IS NULL OR jsonb_typeof(p_sources)<>'array' OR jsonb_array_length(p_sources) NOT BETWEEN 1 AND 100
    OR octet_length(p_sources::text)>524288 THEN RAISE EXCEPTION 'Invalid fallback discovery batch'; END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_sources) LOOP
    -- Recheck the current source authorization even on a cache hit. A fingerprint is
    -- an acknowledgement of an earlier transaction, never a grant of authority.
    IF NOT cfg.enabled OR jsonb_typeof(item)<>'object' OR octet_length(item::text)>8192
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(item) key WHERE key NOT IN
        ('channel','account_id','message_id','attachment_id','original_name','mime_type','received_at','metadata'))
      OR jsonb_typeof(item->'metadata') IS DISTINCT FROM 'object'
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(item->'metadata') key WHERE key NOT IN
        ('provider','chatwoot_account_id','chatwoot_inbox_id','chatwoot_conversation_id','chatwoot_message_id','chatwoot_attachment_id',
         'sender_phone','sender_allowlisted','unknown_sender','exam_candidate','missing_attachment','unsupported_attachment','pending_reason','attachment_url_sha256','original_name','mime_type'))
      OR EXISTS(SELECT 1 FROM jsonb_each(item->'metadata') value WHERE jsonb_typeof(value.value) IN ('object','array') OR value.value#>>'{}' ~ '://')
      OR item->>'channel' IS DISTINCT FROM 'whatsapp' OR item->>'account_id' IS DISTINCT FROM cfg.source_account_id
      OR item->'metadata'->>'provider' IS DISTINCT FROM 'chatwoot'
      OR 'chatwoot:'||(item->'metadata'->>'chatwoot_account_id')||':inbox:'||(item->'metadata'->>'chatwoot_inbox_id') IS DISTINCT FROM cfg.source_account_id
      OR item->'metadata'->>'chatwoot_conversation_id' IS DISTINCT FROM cfg.source_conversation_id
      OR item->'metadata'->'sender_allowlisted' IS DISTINCT FROM 'true'::jsonb
      OR item->'metadata'->'unknown_sender' IS DISTINCT FROM 'false'::jsonb
      OR item->'metadata'->'exam_candidate' IS DISTINCT FROM 'true'::jsonb
      OR jsonb_typeof(item->'metadata'->'missing_attachment') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(item->'metadata'->'unsupported_attachment') IS DISTINCT FROM 'boolean'
      OR COALESCE(item->>'message_id','') !~ '^[1-9][0-9]{0,29}$'
      OR COALESCE(item->'metadata'->>'chatwoot_attachment_id','') !~ '^[1-9][0-9]{0,29}$'
      OR item->>'message_id' IS DISTINCT FROM item->'metadata'->>'chatwoot_message_id'
      OR item->>'attachment_id' IS DISTINCT FROM 'chatwoot-attachment:'||(item->'metadata'->>'chatwoot_attachment_id')
      OR item->>'mime_type' IS DISTINCT FROM 'application/pdf' OR NULLIF(item->>'original_name','') IS NULL
      OR (item->'metadata'->>'attachment_url_sha256' IS NOT NULL AND item->'metadata'->>'attachment_url_sha256' !~ '^[a-f0-9]{64}$')
      OR NULLIF(item->>'received_at','') IS NULL OR (item->>'received_at')::timestamptz<cfg.received_from THEN
      RAISE EXCEPTION 'Fallback discovery source is outside the enabled scope' USING ERRCODE='42501';
    END IF;

    -- Include every stable field (including sender policy, name, MIME and pending
    -- reason). Signed URL rotation alone must not reserve/log the same source again.
    fingerprint_value:=sha256(convert_to((item #- '{metadata,attachment_url_sha256}')::text,'UTF8'));
    SELECT * INTO source_row FROM public.exam_document_source WHERE channel='whatsapp' AND account_id=item->>'account_id'
      AND message_id=item->>'message_id' AND attachment_id=item->>'attachment_id';
    SELECT * INTO previous FROM public.exam_fallback_discovery_ack WHERE source_id=source_row.id;
    terminal:=false;
    IF source_row.id IS NOT NULL THEN
      SELECT d.deletion_state IS NOT NULL OR d.identification_status='not_exam'
        OR EXISTS(SELECT 1 FROM public.exam_document_delivery g WHERE g.document_id=d.id AND g.destination='group'
          AND g.destination_key IN ('default',(SELECT group_destination_key FROM public.exam_document_configuration WHERE singleton))
          AND g.status IN ('submitted','uncertain','sent','waived'))
        INTO terminal FROM public.exam_document d WHERE d.id=source_row.document_id;
    END IF;
    IF previous.fingerprint=fingerprint_value AND (terminal
      OR (previous.disposition='source_excluded' AND NOT public.exam_fallback_source_in_scope(source_row.document_id))
      OR (previous.disposition='requires_review' AND item->'metadata'->'unsupported_attachment'='true'::jsonb)
      OR (previous.disposition='queued' AND EXISTS(SELECT 1 FROM public.exam_fallback_source_queue WHERE source_id=source_row.id))) THEN
      unchanged:=unchanged+1;
    ELSE
      IF terminal THEN
        -- Never recreate a removed queue entry for a deleted/excluded/submitted
        -- document. Existing group receipts still go through GET-only reconciliation.
        disposition_value:='source_excluded';
      ELSE
        -- Intake identity/clinical metadata stays immutable. Only these current
        -- provider observations may recover missing/unsupported media in place.
        IF source_row.id IS NOT NULL AND source_row.metadata->>'provider'='chatwoot'
          AND source_row.metadata->>'chatwoot_conversation_id'=cfg.source_conversation_id THEN
          UPDATE public.exam_document_source SET metadata=metadata||jsonb_build_object(
            'missing_attachment',item->'metadata'->'missing_attachment',
            'unsupported_attachment',item->'metadata'->'unsupported_attachment',
            'pending_reason',item->'metadata'->'pending_reason')
            WHERE id=source_row.id AND (metadata->'missing_attachment' IS DISTINCT FROM item->'metadata'->'missing_attachment'
              OR metadata->'unsupported_attachment' IS DISTINCT FROM item->'metadata'->'unsupported_attachment'
              OR metadata->'pending_reason' IS DISTINCT FROM item->'metadata'->'pending_reason');
        END IF;
        -- A missing queue is repaired only for a nonterminal source. No lease,
        -- attempt counter, primary progress or existing retry schedule is reset.
        outcome:=public.enqueue_exam_fallback_source(item);
        source_row.id:=(outcome->>'source_id')::uuid;
        IF source_row.id IS NULL THEN RAISE EXCEPTION 'Fallback discovery acknowledgement missing'; END IF;
        disposition_value:=CASE WHEN outcome->>'reason' IN ('requires_review','source_excluded') THEN outcome->>'reason' ELSE 'queued' END;
        IF outcome->'queued'='true'::jsonb THEN enqueued:=enqueued+1; END IF;
      END IF;
      -- This write commits atomically with reserve/enqueue. Failed batches roll
      -- everything back; replay after a lost HTTP response is read-only.
      INSERT INTO public.exam_fallback_discovery_ack(source_id,fingerprint,disposition)
        VALUES(source_row.id,fingerprint_value,disposition_value)
        ON CONFLICT(source_id) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,disposition=EXCLUDED.disposition;
    END IF;
    acknowledged:=acknowledged+1;
  END LOOP;
  RETURN jsonb_build_object('acknowledged',acknowledged,'enqueued',enqueued,'unchanged',unchanged);
END $$;
REVOKE ALL ON FUNCTION public.enqueue_exam_fallback_sources(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_exam_fallback_sources(jsonb) TO service_role;

COMMIT;
