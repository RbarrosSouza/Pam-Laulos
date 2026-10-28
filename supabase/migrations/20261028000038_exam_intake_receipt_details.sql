-- The service records sanitized provenance before processing; no file bytes or URLs.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $$ DECLARE existing text; BEGIN
 IF to_regprocedure('public.exam_intake_gmail_part_binding(uuid,text,text,text)') IS NULL THEN RAISE EXCEPTION 'SQL36 is required'; END IF;
 SELECT pg_get_functiondef('public.get_exam_intake_exam_failures(integer,integer,timestamptz,uuid)'::regprocedure) INTO existing;
 IF position('proof.clinical_confirmed' in existing)=0 OR position('unclassified_documents_total' in existing)=0 THEN
   RAISE EXCEPTION 'Attention query does not match SQL37; review before installing'; END IF;
END $$;
CREATE TABLE public.exam_intake_receipt_detail (
 receipt_id uuid PRIMARY KEY REFERENCES public.exam_intake_receipt(id) ON DELETE RESTRICT,
 received_at timestamptz NOT NULL, position integer NOT NULL CHECK(position BETWEEN 1 AND 200),
 display_name text, mime_type text, sender text,
 CHECK(display_name IS NULL OR length(display_name) BETWEEN 1 AND 200 AND display_name !~ '[[:cntrl:]]|://'),
 CHECK(mime_type IS NULL OR length(mime_type) BETWEEN 1 AND 100 AND mime_type !~ '[[:cntrl:]]|://'),
 CHECK(sender IS NULL OR length(sender) BETWEEN 1 AND 200 AND sender !~ '[[:cntrl:]]|://')
);
ALTER TABLE public.exam_intake_receipt_detail ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.exam_intake_receipt_detail FROM PUBLIC,anon,authenticated,service_role;
CREATE TEMP TABLE exam_intake38_acl_before ON COMMIT DROP AS SELECT oid,proowner,proacl FROM pg_proc WHERE oid IN (
 'public.get_exam_intake_exam_failures(integer,integer,timestamptz,uuid)'::regprocedure,
 'public.record_exam_intake_event(uuid,uuid,jsonb)'::regprocedure);
DO $patch$
DECLARE definition text; marker text; replacement text;
BEGIN
 SELECT pg_get_functiondef('public.record_exam_intake_event(uuid,uuid,jsonb)'::regprocedure) INTO definition;
 marker:=$old$'expected_message_count','page_count']$old$;
 IF position(marker in definition)=0 THEN RAISE EXCEPTION 'Unexpected event key contract'; END IF;
 definition:=replace(definition,marker,$new$'expected_message_count','page_count','position','display_name','mime_type','sender']$new$);
 marker:=$old$  ELSIF kind='origin_outcome' THEN$old$;
 IF position(marker in definition)=0 THEN RAISE EXCEPTION 'Unexpected event branch contract'; END IF;
 replacement:=$new$  ELSIF kind='attachment_details' THEN
    IF (p_event-ARRAY['kind','partition_key','message_id','attachment_id','received_at','position','display_name','mime_type','sender'])<>'{}'::jsonb
      OR jsonb_typeof(p_event->'position') IS DISTINCT FROM 'number' OR COALESCE(p_event->>'position','') !~ '^[0-9]{1,3}$'
      OR (p_event->>'position')::integer NOT BETWEEN 1 AND 200
      OR jsonb_typeof(p_event->'received_at') IS DISTINCT FROM 'string'
      OR (p_event ? 'display_name' AND jsonb_typeof(p_event->'display_name') NOT IN ('null','string'))
      OR (p_event ? 'mime_type' AND jsonb_typeof(p_event->'mime_type') NOT IN ('null','string'))
      OR (p_event ? 'sender' AND jsonb_typeof(p_event->'sender') NOT IN ('null','string')) THEN RAISE EXCEPTION 'Invalid attachment details'; END IF;
    received:=(p_event->>'received_at')::timestamptz;
    SELECT * INTO STRICT origin FROM public.exam_collection_origin WHERE sweep_id=run.id AND folder_id=partition AND message_id=message AND attachment_id=attachment FOR UPDATE;
    SELECT * INTO STRICT receipt FROM public.exam_intake_receipt WHERE id=origin.intake_receipt_id FOR UPDATE;
    IF receipt.artifact_kind NOT IN ('attachment','download_link') OR NOT EXISTS(SELECT 1 FROM public.exam_collection_message m WHERE m.sweep_id=run.id AND m.folder_id=partition AND m.message_id=message AND m.intake_received_at=received) THEN RAISE EXCEPTION 'Attachment origin or receive time unproven'; END IF;
    INSERT INTO public.exam_intake_receipt_detail(receipt_id,received_at,position,display_name,mime_type,sender)
      VALUES(receipt.id,received,(p_event->>'position')::integer,p_event->>'display_name',p_event->>'mime_type',p_event->>'sender') ON CONFLICT DO NOTHING;
    IF NOT EXISTS(SELECT 1 FROM public.exam_intake_receipt_detail d WHERE d.receipt_id=receipt.id AND d.received_at=received
      AND d.position=(p_event->>'position')::integer AND d.display_name IS NOT DISTINCT FROM p_event->>'display_name'
      AND d.mime_type IS NOT DISTINCT FROM p_event->>'mime_type' AND d.sender IS NOT DISTINCT FROM p_event->>'sender')
      THEN RAISE EXCEPTION 'Attachment details replay conflicts' USING ERRCODE='40001'; END IF;
  ELSIF kind='attachment_retry_failed' THEN
    IF (p_event-ARRAY['kind','partition_key','message_id','attachment_id','code'])<>'{}'::jsonb
       OR COALESCE(p_event->>'code','') !~ '^[a-z][a-z0-9_]{0,95}$' THEN RAISE EXCEPTION 'Invalid retry reason'; END IF;
    SELECT * INTO STRICT receipt FROM public.exam_intake_receipt WHERE collector_id=run.collector_id AND partition_key=partition AND message_id=message AND attachment_id=attachment FOR UPDATE;
    IF receipt.artifact_kind NOT IN ('attachment','download_link') THEN RAISE EXCEPTION 'Retry receipt must identify a file'; END IF;
    IF receipt.disposition IN ('pending','failed') THEN
      UPDATE public.exam_intake_receipt SET reason_code=p_event->>'code',last_seen_at=now() WHERE id=receipt.id;
      incident:=public.open_exam_intake_incident('receipt:'||receipt.id||':retry:'||(p_event->>'code'),run.collector_id,receipt.id,receipt.document_id,'retry',p_event->>'code');
    END IF;
  ELSIF kind='origin_outcome' THEN$new$;
 definition:=replace(definition,marker,replacement);EXECUTE definition;
END $patch$;
CREATE OR REPLACE FUNCTION public.get_exam_intake_exam_failures(p_limit integer DEFAULT 50,p_offset integer DEFAULT 0,p_after_age_from timestamptz DEFAULT NULL,p_after_document_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.require_exam_document_member();
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 1000000
    OR ((p_after_age_from IS NULL) <> (p_after_document_id IS NULL)) OR (p_after_age_from IS NOT NULL AND p_offset<>0) THEN
    RAISE EXCEPTION 'Invalid exam failure page' USING ERRCODE='22023';
  END IF;
  WITH cfg AS (SELECT * FROM public.exam_document_configuration WHERE singleton),
  expected_collectors AS (
    SELECT * FROM (VALUES ('gmail',(SELECT attention_gmail_collector_id FROM cfg)),
      ('outlook',(SELECT attention_outlook_collector_id FROM cfg)),
      ('chatwoot',(SELECT attention_chatwoot_collector_id FROM cfg))) AS expected(provider,collector_id)
  ), collector_proofs AS (
    SELECT e.provider,
      CASE WHEN e.collector_id IS NULL THEN 'not_configured'
        WHEN h.collector_id IS NULL THEN 'not_started'
        WHEN h.heartbeat_at<now()-make_interval(secs=>h.stale_after_seconds) THEN 'stale'
        WHEN c.scope_manifest->>'scope_kind' LIKE '%:canary' OR e.collector_id LIKE '%canary%' THEN 'test_only'
        ELSE 'recent' END activity,
      h.heartbeat_at last_checked,
      COALESCE(cfg.attention_coverage_verified AND cfg.attention_cutoff IS NOT NULL
      AND e.collector_id IS NOT NULL AND h.monitored AND c.scope_manifest->>'provider'=e.provider AND c.scope_manifest->>'sender_policy'='all'
      AND h.heartbeat_at>=now()-make_interval(secs=>h.stale_after_seconds)
      AND h.progress_at>=now()-make_interval(secs=>h.stale_after_seconds)
      AND h.last_success_at>=now()-make_interval(secs=>h.stale_after_seconds)
      AND c.received_through>=now()-make_interval(secs=>h.stale_after_seconds)
      AND c.received_through>cfg.attention_cutoff
      AND e.collector_id NOT LIKE '%canary%' AND s.intake_mode='operational' AND s.status='committed'
      AND s.intake_counts->'coverageComplete'='true'::jsonb AND s.intake_counts->'scanFinished'='true'::jsonb
      AND (e.provider<>'gmail' OR c.scope_manifest->'include_spam_trash'='true'::jsonb)
      AND COALESCE((SELECT range_agg(tstzrange(greatest(ss.received_from,cfg.attention_cutoff),least(ss.received_through,c.received_through),'[)'))
        @> tstzrange(cfg.attention_cutoff,c.received_through,'[)') FROM public.exam_collection_sweep ss
        WHERE ss.collector_id=e.collector_id AND ss.intake_mode='operational' AND ss.status='committed' AND ss.conclusive
          AND ss.intake_counts->'coverageComplete'='true'::jsonb AND ss.intake_counts->'scanFinished'='true'::jsonb
          AND ss.received_through>cfg.attention_cutoff AND ss.received_from<c.received_through),false),false) proven
    FROM expected_collectors e CROSS JOIN cfg LEFT JOIN public.exam_intake_health h ON h.collector_id=e.collector_id
    LEFT JOIN public.exam_collection_cursor c ON c.collector_id=e.collector_id
    LEFT JOIN public.exam_collection_sweep s ON s.id=h.last_sweep_id AND s.collector_id=e.collector_id
  ), synthetic_docs AS (
    SELECT s.document_id FROM public.exam_document_source s WHERE s.metadata->>'test_fixture'='true' OR s.metadata->>'synthetic_fixture'='true'
      OR s.metadata->>'homologation_fixture'='true' OR s.metadata->>'is_test'='true' OR s.metadata->>'fixture'='true' OR s.metadata->>'synthetic'='true'
      OR COALESCE(s.metadata->>'subject','') ~* '^PAMVET-TESTE-EX[0-9]+(-|$)'
    UNION SELECT e.document_id FROM public.exam_document_event e WHERE e.event_type IN ('homologation_fixture_preseeded','synthetic_fixture_created')
  ), latest_extraction AS (
    SELECT DISTINCT ON (e.document_id) e.document_id,e.details
    FROM public.exam_document_event e WHERE e.event_type='extraction_updated'
    ORDER BY e.document_id,e.id DESC
  ), latest_review AS (
    SELECT DISTINCT ON (e.document_id) e.document_id,e.event_type,e.details
    FROM public.exam_document_event e WHERE e.actor_id IS NOT NULL AND e.event_type IN ('reviewed','link_confirmed')
    ORDER BY e.document_id,e.id DESC
  ), candidates AS (
    SELECT d.id document_id,CASE WHEN proof.clinical_confirmed THEN d.original_name ELSE src.source_name END original_name,src.received_at,d.created_at,d.file_status,d.identification_status,d.group_exception_reason,
      public.exam_document_group_readiness(d.extracted_data,d.confirmed_data)->'fields'->>'pet_name' pet_name,
      public.exam_document_group_readiness(d.extracted_data,d.confirmed_data)->'fields'->>'client_name' client_name,
      public.exam_document_group_readiness(d.extracted_data,d.confirmed_data)->'fields'->>'exam_type' exam_type,
      p.status processing_status,g.status group_status, proof.clinical_confirmed, proof.identity_evidenced,d.evidence identity_evidence,
      src.received_at age_from,src.channel
    FROM public.exam_document d
    CROSS JOIN public.exam_document_configuration cfg
    JOIN LATERAL (SELECT min(s.received_at) received_at,
      (array_agg(NULLIF(trim(s.metadata->>'original_name'),'') ORDER BY s.received_at,s.id) FILTER (WHERE NULLIF(trim(s.metadata->>'original_name'),'') IS NOT NULL))[1] source_name,
      bool_or(s.metadata->>'mime_type'='application/pdf' AND s.metadata->'exam_candidate'='true'::jsonb AND NULLIF(s.attachment_id,'') IS NOT NULL) source_pdf_candidate,
      CASE WHEN bool_or(s.channel='email') AND bool_or(s.channel='whatsapp') THEN 'both'
        WHEN bool_or(s.channel='whatsapp') THEN 'whatsapp' ELSE 'email' END channel
      FROM public.exam_document_source s WHERE s.document_id=d.id AND s.channel IN ('email','whatsapp')
        AND cfg.attention_cutoff IS NOT NULL AND s.received_at>=cfg.attention_cutoff
      HAVING count(*)>0) src ON true
    LEFT JOIN latest_extraction x ON x.document_id=d.id
    LEFT JOIN latest_review r ON r.document_id=d.id
    LEFT JOIN LATERAL(SELECT t.status,t.lease_until FROM public.exam_document_delivery t WHERE t.document_id=d.id AND t.destination='processing' ORDER BY t.created_at DESC,t.id DESC LIMIT 1)p ON true
    LEFT JOIN LATERAL(SELECT CASE
      WHEN bool_or(t.status IN ('uncertain','submitted')) THEN 'uncertain'
      WHEN bool_or(t.status='sent') THEN 'sent'
      WHEN bool_or(t.status='failed') THEN 'failed'
      WHEN bool_or(t.status='waived') THEN 'waived'
      WHEN bool_or(t.status='reserved') THEN 'reserved'
      WHEN bool_or(t.status='pending') THEN 'pending'
      ELSE NULL END status
      FROM public.exam_document_delivery t WHERE t.document_id=d.id AND t.destination='group'
        AND (t.destination_key='default' OR t.destination_key=NULLIF(trim(cfg.group_destination_key),'')))g ON true
    CROSS JOIN LATERAL (SELECT
      COALESCE(CASE WHEN r.event_type='link_confirmed' THEN true
        WHEN r.event_type='reviewed' THEN r.details->>'classification'='exam'
        ELSE x.details->>'classification'='exam' AND NULLIF(trim(d.extracted_data->>'exam_type'),'') IS NOT NULL
          AND public.exam_document_exam_type_evidence_matches(d.extracted_data->>'exam_type',d.evidence,x.details->'single_patient'='true'::jsonb) END,false) AS clinical_confirmed,
      COALESCE(x.details->>'classification' IN ('exam','review') AND x.details->'single_patient'='true'::jsonb
        AND jsonb_typeof(d.evidence)='array' AND NOT EXISTS (
          SELECT 1 FROM (VALUES ('pet_name',d.extracted_data->>'pet_name'),
            ('client_name',COALESCE(d.extracted_data->>'client_name',d.extracted_data->>'tutor_name'))) AS fields(field,value)
          WHERE NULLIF(trim(fields.value),'') IS NULL OR NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.evidence)='array' THEN d.evidence ELSE '[]'::jsonb END) ev
            WHERE (ev->>'field'=fields.field OR (fields.field='client_name' AND ev->>'field'='tutor_name'))
              AND ev->>'page' ~ '^[1-9][0-9]*$' AND jsonb_typeof(ev->'excerpt')='string'
              AND strpos(' '||public.normalize_exam_identity(regexp_replace(ev->>'excerpt','[[:punct:]]',' ','g'))||' ',
                ' '||public.normalize_exam_identity(regexp_replace(fields.value,'[[:punct:]]',' ','g'))||' ')>0)),false) AS identity_evidenced
    ) proof
    WHERE d.canonical_document_id IS NULL
      AND NOT (r.event_type='reviewed' AND r.details->>'classification'='not_exam') IS TRUE
      AND d.original_name !~* '^PAMVET[_ -]TESTE[_ -]EX[0-9]+([_ -]|$)'
      AND NOT EXISTS(SELECT 1 FROM synthetic_docs t WHERE t.document_id=d.id)
      AND (proof.clinical_confirmed OR (
        -- A declared MIME or filename alone is not proof of an available file.
        d.file_status='saved' AND d.mime_type IN ('application/pdf','application/octet-stream') AND d.drive_file_id IS NOT NULL AND d.sha256 IS NOT NULL AND d.size_bytes>0
        AND src.received_at<=now()-interval '10 minutes'
        AND ((p.status='completed') OR (
          src.received_at<=now()-interval '10 minutes' AND p.status IS DISTINCT FROM 'completed'
          AND NOT (p.status='reserved' AND p.lease_until>now()) IS TRUE
        )) OR (d.file_status='failed' AND src.source_pdf_candidate AND src.received_at<=now()-interval '10 minutes')) )
  ), failures AS (
    SELECT document_id,original_name,received_at,
      CASE WHEN clinical_confirmed THEN pet_name WHEN identity_evidenced AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(identity_evidence)='array' THEN identity_evidence ELSE '[]'::jsonb END) ev
        WHERE ev->>'field'='pet_name' AND ev->>'page' ~ '^[1-9][0-9]*$' AND jsonb_typeof(ev->'excerpt')='string'
          AND NULLIF(trim(pet_name),'') IS NOT NULL AND strpos(' '||public.normalize_exam_identity(regexp_replace(ev->>'excerpt','[[:punct:]]',' ','g'))||' ',
            ' '||public.normalize_exam_identity(regexp_replace(pet_name,'[[:punct:]]',' ','g'))||' ')>0) THEN pet_name END pet_name,
      CASE WHEN clinical_confirmed THEN client_name WHEN identity_evidenced AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(identity_evidence)='array' THEN identity_evidence ELSE '[]'::jsonb END) ev
        WHERE ev->>'field' IN ('client_name','tutor_name') AND ev->>'page' ~ '^[1-9][0-9]*$' AND jsonb_typeof(ev->'excerpt')='string'
          AND NULLIF(trim(client_name),'') IS NOT NULL AND strpos(' '||public.normalize_exam_identity(regexp_replace(ev->>'excerpt','[[:punct:]]',' ','g'))||' ',
            ' '||public.normalize_exam_identity(regexp_replace(client_name,'[[:punct:]]',' ','g'))||' ')>0) THEN client_name END client_name,
      CASE WHEN clinical_confirmed THEN exam_type END exam_type,channel,
      CASE WHEN NOT clinical_confirmed OR file_status='failed' OR processing_status='failed' OR (processing_status IS DISTINCT FROM 'completed' AND age_from<=now()-interval '10 minutes') THEN 'processing' ELSE 'group' END issue_kind,
      CASE WHEN file_status='failed' OR processing_status='failed' THEN 'failed'
           WHEN processing_status IS DISTINCT FROM 'completed' AND age_from<=now()-interval '10 minutes' THEN 'overdue'
           WHEN group_status='failed' THEN 'failed'
           WHEN group_status='uncertain' OR group_status='submitted' THEN 'uncertain'
           ELSE 'overdue' END status,
      CASE WHEN NOT clinical_confirmed AND processing_status IS DISTINCT FROM 'completed' THEN 'unreadable_file'
           WHEN NOT clinical_confirmed THEN 'review_file'
           WHEN file_status='failed' THEN 'preservation_failed'
           WHEN processing_status='failed' THEN 'processing_failed'
           WHEN processing_status IS DISTINCT FROM 'completed' AND age_from<=now()-interval '10 minutes' THEN 'processing_overdue'
           WHEN group_status='failed' THEN 'group_failed'
           WHEN group_status IN ('uncertain','submitted') THEN 'group_delivery_uncertain'
           ELSE 'group_overdue' END reason,
      age_from
    FROM candidates
    WHERE file_status='failed' OR processing_status='failed' OR (processing_status IS DISTINCT FROM 'completed' AND age_from<=now()-interval '10 minutes')
       OR (NOT clinical_confirmed AND file_status='saved' AND age_from<=now()-interval '10 minutes')
       OR (group_exception_reason IS NULL AND group_status IS DISTINCT FROM 'sent' AND group_status IS DISTINCT FROM 'waived'
         AND (group_status IN ('failed','uncertain') OR age_from<=now()-interval '15 minutes'))
  ), receipt_candidates AS (
    SELECT DISTINCT ON (r.collector_id,r.message_id,
      COALESCE(public.exam_intake_gmail_part_key(r.attachment_id),r.attachment_id))
      r.*,COALESCE(d.received_at,m.received_at) received_at,d.position,d.display_name,d.mime_type,d.sender,c.scope_manifest->>'provider' provider,c.scope_manifest->>'account_id' account_id
    FROM public.exam_intake_receipt r LEFT JOIN public.exam_intake_receipt_detail d ON d.receipt_id=r.id
      JOIN public.exam_collection_cursor c ON c.collector_id=r.collector_id
      LEFT JOIN LATERAL (SELECT min(message.intake_received_at) received_at FROM public.exam_collection_message message
        JOIN public.exam_collection_sweep sweep ON sweep.id=message.sweep_id
        WHERE sweep.collector_id=r.collector_id AND message.folder_id=r.partition_key AND message.message_id=r.message_id) m ON true CROSS JOIN cfg
    WHERE r.collector_id IN (SELECT collector_id FROM expected_collectors) AND r.artifact_kind IN ('attachment','download_link')
      AND COALESCE(d.received_at,m.received_at)>=cfg.attention_cutoff AND COALESCE(d.received_at,m.received_at)<=now()-interval '10 minutes'
    ORDER BY r.collector_id,r.message_id,COALESCE(public.exam_intake_gmail_part_key(r.attachment_id),r.attachment_id),
      (r.disposition='saved') DESC,(d.receipt_id IS NOT NULL) DESC,r.last_seen_at DESC,r.id DESC
  ), pending_receipts AS (
    SELECT r.id row_id,NULL::uuid document_id,r.display_name original_name,r.received_at,NULL::text pet_name,NULL::text client_name,
      NULL::text exam_type,CASE WHEN r.provider='chatwoot' THEN 'whatsapp' ELSE 'email' END channel,
      'processing'::text issue_kind,CASE WHEN r.disposition='failed' THEN 'failed' ELSE 'overdue' END status,
      r.reason_code reason,r.received_at age_from,'receipt'::text row_kind,r.position,r.sender
    FROM receipt_candidates r
    WHERE (r.disposition IN ('pending','failed','excluded') OR (r.disposition='discovered' AND NOT EXISTS(
      SELECT 1 FROM public.exam_collection_origin o JOIN public.exam_collection_sweep sw ON sw.id=o.sweep_id
      WHERE o.intake_receipt_id=r.id AND sw.status='running' AND sw.expires_at>now())))
      AND NOT EXISTS(SELECT 1 FROM public.exam_document_source src JOIN public.exam_document doc ON doc.id=src.document_id
        WHERE src.account_id=r.account_id AND src.message_id=r.message_id
          AND src.channel=CASE WHEN r.provider='chatwoot' THEN 'whatsapp' ELSE 'email' END
          AND (src.attachment_id=r.attachment_id OR (r.provider='gmail' AND public.exam_intake_gmail_part_binding(src.id,r.account_id,r.message_id,r.attachment_id)))
          AND (doc.file_status='saved' OR EXISTS(SELECT 1 FROM failures failure WHERE failure.document_id=doc.id)))
  ), all_failures AS (
    SELECT document_id row_id,document_id,original_name,received_at,pet_name,client_name,exam_type,channel,issue_kind,status,reason,age_from,
      'document'::text row_kind,NULL::integer position,NULL::text sender FROM failures
    UNION ALL SELECT * FROM pending_receipts
  ), page AS (
    SELECT * FROM all_failures WHERE p_after_age_from IS NULL OR (age_from,row_id)>(p_after_age_from,p_after_document_id)
      ORDER BY age_from,row_id LIMIT p_limit OFFSET p_offset
  ), unclassified_receipts AS (
    SELECT ir.id FROM public.exam_intake_receipt ir JOIN public.exam_collection_cursor c ON c.collector_id=ir.collector_id
    WHERE c.scope_manifest->>'provider' IN ('gmail','outlook','chatwoot') AND ir.disposition IN ('discovered','pending','failed','excluded') AND ir.document_id IS NULL
      AND ir.collector_id IN (SELECT collector_id FROM expected_collectors)
      AND EXISTS(SELECT 1 FROM public.exam_collection_message m JOIN public.exam_collection_sweep sw ON sw.id=m.sweep_id
        WHERE sw.collector_id=ir.collector_id AND m.message_id=ir.message_id
          AND (m.intake_received_at>=(SELECT attention_cutoff FROM cfg) OR (m.intake_received_at IS NULL AND sw.received_through>=(SELECT attention_cutoff FROM cfg))))
  ), unclassified_messages AS (
    SELECT m.message_id FROM public.exam_collection_message m JOIN public.exam_collection_sweep sw ON sw.id=m.sweep_id
    WHERE sw.collector_id IN (SELECT collector_id FROM expected_collectors) AND m.intake_manifest='[]'::jsonb
      AND (m.intake_received_at>=(SELECT attention_cutoff FROM cfg) OR (m.intake_received_at IS NULL AND sw.received_through>=(SELECT attention_cutoff FROM cfg)))
  ), unclassified_documents AS (
    SELECT d.id FROM public.exam_document d
    WHERE d.canonical_document_id IS NULL AND (d.identification_status<>'not_exam' OR NOT EXISTS(
      SELECT 1 FROM latest_review r WHERE r.document_id=d.id AND r.event_type='reviewed' AND r.details->>'classification'='not_exam'))
      AND d.original_name !~* '^PAMVET[_ -]TESTE[_ -]EX[0-9]+([_ -]|$)'
      AND NOT EXISTS(SELECT 1 FROM synthetic_docs t WHERE t.document_id=d.id)
      AND EXISTS(SELECT 1 FROM public.exam_document_source s WHERE s.document_id=d.id AND s.channel IN ('email','whatsapp') AND s.received_at>=(SELECT attention_cutoff FROM cfg))
      AND NOT EXISTS(SELECT 1 FROM candidates c WHERE c.document_id=d.id AND c.clinical_confirmed)
  )
  SELECT jsonb_build_object('contract','exam_intake_exam_failures_v1','as_of',now(),
    'attention_cutoff',(SELECT attention_cutoff FROM cfg),
    'channels',COALESCE((SELECT jsonb_agg(jsonb_build_object('provider',provider,'activity',activity,'last_checked',last_checked) ORDER BY provider) FROM collector_proofs),'[]'::jsonb),
    'coverage_status',CASE WHEN (SELECT attention_cutoff FROM cfg) IS NULL THEN 'not_configured'
      WHEN (SELECT count(*) FROM collector_proofs WHERE proven)=3 AND NOT EXISTS(SELECT 1 FROM unclassified_receipts) AND NOT EXISTS(SELECT 1 FROM unclassified_messages)
        AND NOT EXISTS(SELECT 1 FROM unclassified_documents) THEN 'proven' ELSE 'unproven' END,
    'total',(SELECT count(*) FROM all_failures),'has_more',(SELECT count(*)>p_offset+p_limit FROM all_failures WHERE p_after_age_from IS NULL OR (age_from,row_id)>(p_after_age_from,p_after_document_id)),
    'next_cursor',CASE WHEN (SELECT count(*)>p_offset+p_limit FROM all_failures WHERE p_after_age_from IS NULL OR (age_from,row_id)>(p_after_age_from,p_after_document_id))
      THEN (SELECT jsonb_build_object('age_from',age_from,'document_id',row_id) FROM page ORDER BY age_from DESC,row_id DESC LIMIT 1) END,
    'rows',COALESCE((SELECT jsonb_agg(to_jsonb(p)-'age_from' ORDER BY p.age_from,p.row_id) FROM page p),'[]'::jsonb),
    'unclassified_receipts_total',(SELECT count(*) FROM unclassified_receipts),
    'unclassified_documents_total',(SELECT count(*) FROM unclassified_documents)) INTO result;
  RETURN result;
END $$;

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM exam_intake38_acl_before b JOIN pg_proc p ON p.oid=b.oid WHERE p.proowner IS DISTINCT FROM b.proowner OR p.proacl IS DISTINCT FROM b.proacl) THEN RAISE EXCEPTION 'Unexpected ACL change'; END IF;
END $$;
COMMIT;
