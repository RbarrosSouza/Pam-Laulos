BEGIN;

DO $$ BEGIN
  IF to_regclass('public.exam_intake_receipt') IS NULL OR to_regclass('public.exam_intake_document_hold') IS NULL THEN
    RAISE EXCEPTION 'Install intake migrations 23 and 24 before the coverage panel';
  END IF;
END $$;

-- Read-only projection only: no receipt, delivery, alert, hold or checkpoint changes.
-- CREATE OR REPLACE preserves the deployed member RPC owner and ACL.
CREATE TEMP TABLE exam_intake_panel_rpc_before ON COMMIT DROP AS
SELECT oid,proowner,proacl FROM pg_proc
WHERE oid='public.get_exam_intake_panel(integer)'::regprocedure;

CREATE OR REPLACE FUNCTION public.get_exam_intake_panel(p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.require_exam_document_member();
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Invalid panel limit'; END IF;
  WITH
  cfg AS (SELECT notification_cutoff FROM public.exam_document_configuration WHERE singleton),
  latest_message AS (
    SELECT DISTINCT ON (s.collector_id,m.folder_id,m.message_id)
      s.collector_id,m.folder_id AS partition_key,m.message_id,m.intake_received_at AS received_at,
      m.intake_manifest,m.attachment_count,s.started_at
    FROM public.exam_collection_message m JOIN public.exam_collection_sweep s ON s.id=m.sweep_id
    WHERE s.intake_mode IS NOT NULL
    ORDER BY s.collector_id,m.folder_id,m.message_id,s.started_at DESC,s.id DESC
  ),
  entries AS (
    SELECT m.collector_id,m.partition_key,m.message_id,m.received_at,m.attachment_count,
      CASE WHEN m.intake_manifest IS NULL THEN 'inventory_pending' ELSE 'document_binding_pending' END AS reason,
      COALESCE(m.received_at<(SELECT notification_cutoff FROM cfg),false) AS before_cutoff
    FROM latest_message m
    WHERE (m.intake_manifest IS NULL OR EXISTS(SELECT 1 FROM public.exam_intake_receipt r WHERE r.collector_id=m.collector_id AND r.message_id=m.message_id AND r.disposition<>'excluded'))
      AND NOT EXISTS(SELECT 1 FROM public.exam_intake_receipt r WHERE r.collector_id=m.collector_id AND r.message_id=m.message_id AND r.document_id IS NOT NULL)
  ),
  origins AS (
    SELECT r.id,r.collector_id,r.partition_key,r.message_id,r.attachment_id,r.artifact_kind,r.disposition,
      r.document_id,r.reason_code,r.first_seen_at,r.last_seen_at,m.received_at,
      COALESCE(m.received_at<(SELECT notification_cutoff FROM cfg),false) AS before_cutoff
    FROM public.exam_intake_receipt r LEFT JOIN latest_message m ON m.collector_id=r.collector_id AND m.partition_key=r.partition_key AND m.message_id=r.message_id
    WHERE r.disposition IN ('discovered','pending','failed')
  ),
  eligible_saved AS (
    SELECT d.id AS document_id,d.original_name,d.received_at,d.created_at,d.identification_status,
      COALESCE(d.received_at<(SELECT notification_cutoff FROM cfg),false) AS before_cutoff,
      CASE WHEN EXISTS(SELECT 1 FROM public.exam_document_delivery t WHERE t.document_id=d.id AND t.destination='group' AND t.status='uncertain') THEN 'uncertain'
           WHEN EXISTS(SELECT 1 FROM public.exam_document_delivery t WHERE t.document_id=d.id AND t.destination='group' AND t.status='submitted') THEN 'submitted'
           WHEN EXISTS(SELECT 1 FROM public.exam_document_delivery t WHERE t.document_id=d.id AND t.destination='group' AND t.status='reserved') THEN 'reserved'
           WHEN EXISTS(SELECT 1 FROM public.exam_document_delivery t WHERE t.document_id=d.id AND t.destination='group' AND t.status='failed') THEN 'failed'
           WHEN EXISTS(SELECT 1 FROM public.exam_document_delivery t WHERE t.document_id=d.id AND t.destination='group') THEN 'pending'
           ELSE 'not_queued' END AS group_status,
      (SELECT reason FROM public.exam_intake_document_hold h WHERE h.document_id=d.id AND h.state='held') AS hold_reason
    FROM public.exam_document d
    WHERE d.canonical_document_id IS NULL AND d.file_status='saved' AND d.identification_status<>'not_exam' AND d.group_exception_reason IS NULL
      AND NOT EXISTS(SELECT 1 FROM public.exam_document_delivery t WHERE t.document_id=d.id AND t.destination='group' AND t.status IN ('sent','waived'))
      AND d.original_name !~* '^PAMVET[_ -]TESTE[_ -]EX[0-9]+([_ -]|$)'
      AND NOT EXISTS(SELECT 1 FROM public.exam_document_source s WHERE s.document_id=d.id AND (s.metadata->>'test_fixture'='true' OR s.metadata->>'synthetic_fixture'='true' OR s.metadata->>'homologation_fixture'='true' OR s.metadata->>'is_test'='true' OR s.metadata->>'fixture'='true' OR s.metadata->>'synthetic'='true' OR COALESCE(s.metadata->>'subject','') ~* '^PAMVET-TESTE-EX[0-9]+(-|$)'))
      AND NOT EXISTS(SELECT 1 FROM public.exam_document_event e WHERE e.document_id=d.id AND e.event_type IN ('homologation_fixture_preseeded','synthetic_fixture_created'))
  ),
  active_entries AS (SELECT * FROM entries WHERE NOT before_cutoff),
  active_origins AS (SELECT * FROM origins WHERE NOT before_cutoff),
  active_group AS (SELECT * FROM eligible_saved WHERE NOT before_cutoff),
  uncertain_group AS (SELECT * FROM active_group WHERE group_status='uncertain'),
  pending_alert AS (SELECT id,incident_id,generation,channel,status,attempts,created_at,updated_at,error_code FROM public.exam_intake_alert_outbox WHERE status NOT IN ('sent','cancelled')),
  holds AS (SELECT h.document_id,h.reason,h.previous_document_id,h.created_at,d.original_name,d.sha256,d.file_status FROM public.exam_intake_document_hold h JOIN public.exam_document d ON d.id=h.document_id WHERE h.state='held' AND d.canonical_document_id IS NULL)
  SELECT jsonb_build_object(
    'as_of',now(),'contract','exam_intake_panel_v2',
    'collectors',COALESCE((SELECT jsonb_agg(to_jsonb(h)||jsonb_build_object(
      'checkpoint',jsonb_build_object('received_through',c.received_through,'revision',c.revision),
      'latest_sweep',CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_build_object('id',s.id,'mode',s.intake_mode,'status',s.status,'received_from',s.received_from,'received_through',s.received_through,'started_at',s.started_at,'finished_at',s.finished_at,
        'coverageComplete',CASE WHEN s.intake_counts?'coverageComplete' THEN s.intake_counts->'coverageComplete' WHEN s.status<>'running' THEN to_jsonb(s.conclusive) ELSE NULL END,
        'allPreserved',s.intake_counts->'allPreserved','scanFinished',s.intake_counts->'scanFinished','counts',s.intake_counts->'counts') END) ORDER BY h.collector_id)
      FROM public.exam_intake_health h JOIN public.exam_collection_cursor c ON c.collector_id=h.collector_id
      LEFT JOIN LATERAL(SELECT * FROM public.exam_collection_sweep ss WHERE ss.collector_id=h.collector_id AND ss.intake_mode IS NOT NULL ORDER BY ss.started_at DESC,ss.id DESC LIMIT 1) s ON true),'[]'),
    'summary',jsonb_build_object('notification_cutoff',(SELECT notification_cutoff FROM cfg),'cutoff_configured',(SELECT notification_cutoff IS NOT NULL FROM cfg),'entries_without_document_total',(SELECT count(*) FROM active_entries),'unresolved_origin_total',(SELECT count(*) FROM active_origins),'saved_without_group_total',(SELECT count(*) FROM active_group),'group_uncertain_total',(SELECT count(*) FROM uncertain_group),'pending_alert_total',(SELECT count(*) FROM pending_alert),'version_hold_total',(SELECT count(*) FROM holds),'received_at_unknown_total',(SELECT count(*) FROM entries WHERE received_at IS NULL)),
    'entries_without_document_total',(SELECT count(*) FROM active_entries),'entries_without_document_has_more',(SELECT count(*)>p_limit FROM active_entries),
    'entries_without_document',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM(SELECT * FROM active_entries ORDER BY received_at NULLS FIRST,collector_id,partition_key,message_id LIMIT p_limit)x),'[]'),
    'unresolved_origin_total',(SELECT count(*) FROM active_origins),'unresolved_origins_has_more',(SELECT count(*)>p_limit FROM active_origins),
    'unresolved_origins',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM(SELECT * FROM active_origins ORDER BY first_seen_at,id LIMIT p_limit)x),'[]'),
    'saved_without_group_total',(SELECT count(*) FROM active_group),'saved_without_group_has_more',(SELECT count(*)>p_limit FROM active_group),
    'saved_without_group',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM(SELECT * FROM active_group ORDER BY received_at,document_id LIMIT p_limit)x),'[]'),
    'group_uncertain_total',(SELECT count(*) FROM uncertain_group),'group_uncertain_has_more',(SELECT count(*)>p_limit FROM uncertain_group),
    'group_uncertain',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM(SELECT * FROM uncertain_group ORDER BY received_at,document_id LIMIT p_limit)x),'[]'),
    'pending_alert_total',(SELECT count(*) FROM pending_alert),'pending_alert_has_more',(SELECT count(*)>p_limit FROM pending_alert),
    'pending_alerts',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM(SELECT * FROM pending_alert ORDER BY created_at,id LIMIT p_limit)x),'[]'),
    'version_hold_total',(SELECT count(*) FROM holds),'version_hold_has_more',(SELECT count(*)>p_limit FROM holds),
    'version_holds',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM(SELECT * FROM holds ORDER BY created_at,document_id LIMIT p_limit)x),'[]'),
    'historical',jsonb_build_object('cutoff',(SELECT notification_cutoff FROM cfg),'pre_cutoff_entries_without_document_total',(SELECT count(*) FROM entries WHERE before_cutoff),'pre_cutoff_entries_without_document_has_more',(SELECT count(*)>p_limit FROM entries WHERE before_cutoff),'pre_cutoff_entries_without_document',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM(SELECT * FROM entries WHERE before_cutoff ORDER BY received_at,collector_id,message_id LIMIT p_limit)x),'[]'),'pre_cutoff_unresolved_origin_total',(SELECT count(*) FROM origins WHERE before_cutoff),'pre_cutoff_unresolved_origins_has_more',(SELECT count(*)>p_limit FROM origins WHERE before_cutoff),'pre_cutoff_unresolved_origins',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM(SELECT * FROM origins WHERE before_cutoff ORDER BY first_seen_at,id LIMIT p_limit)x),'[]'),'pre_cutoff_saved_without_group_total',(SELECT count(*) FROM eligible_saved WHERE before_cutoff),'pre_cutoff_saved_without_group_has_more',(SELECT count(*)>p_limit FROM eligible_saved WHERE before_cutoff),'pre_cutoff_saved_without_group',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM(SELECT * FROM eligible_saved WHERE before_cutoff ORDER BY received_at,document_id LIMIT p_limit)x),'[]')),
    'incident_total',(SELECT count(*) FROM public.exam_intake_incident WHERE state<>'resolved'),'incident_has_more',(SELECT count(*)>p_limit FROM public.exam_intake_incident WHERE state<>'resolved'),
    'incidents',COALESCE((SELECT jsonb_agg(to_jsonb(i)-'incident_key') FROM(SELECT * FROM public.exam_intake_incident WHERE state<>'resolved' ORDER BY first_seen_at,id LIMIT p_limit)i),'[]'),
    'receipt_total',(SELECT count(*) FROM public.exam_intake_receipt),'receipt_has_more',(SELECT count(*)>p_limit FROM public.exam_intake_receipt),
    'receipts',COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM(SELECT * FROM public.exam_intake_receipt ORDER BY last_seen_at DESC,id LIMIT p_limit)r),'[]'),
    'alerts',COALESCE((SELECT jsonb_agg(to_jsonb(a)-'lease_token'-'content_sha256') FROM(SELECT * FROM public.exam_intake_alert_outbox ORDER BY created_at DESC,id LIMIT p_limit)a),'[]')) INTO result;
  RETURN result;
END $$;

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM exam_intake_panel_rpc_before b JOIN pg_proc p ON p.oid=b.oid WHERE p.proowner<>b.proowner OR p.proacl IS DISTINCT FROM b.proacl) THEN
    RAISE EXCEPTION 'Existing intake panel owner or ACL changed';
  END IF;
END $$;
COMMIT;
