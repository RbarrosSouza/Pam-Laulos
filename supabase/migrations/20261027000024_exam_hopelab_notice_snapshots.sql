BEGIN;

CREATE TABLE public.exam_intake_document_hold (
  document_id uuid PRIMARY KEY REFERENCES public.exam_document(id),
  state text NOT NULL DEFAULT 'held' CHECK (state IN ('held','released')),
  reason text NOT NULL CHECK (reason IN ('awaiting_snapshot','missing_link','changed_content_review','historical_snapshot_unavailable','first_original')),
  relation_sha256 text CHECK (relation_sha256 ~ '^[a-f0-9]{64}$'),
  previous_document_id uuid REFERENCES public.exam_document(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  released_by uuid REFERENCES auth.users(id)
);
CREATE TABLE public.exam_intake_snapshot (
  source_id uuid PRIMARY KEY REFERENCES public.exam_document_source(id),
  document_id uuid NOT NULL REFERENCES public.exam_document(id),
  previous_document_id uuid REFERENCES public.exam_document(id),
  relation_sha256 text NOT NULL CHECK (relation_sha256 ~ '^[a-f0-9]{64}$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes>0),
  relation_state text NOT NULL CHECK (relation_state IN ('new_original','unchanged','changed_review','existing_content_review','historical_unknown_review')),
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION public.hold_exam_intake_notice_source()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE relation text;
BEGIN
  IF NEW.metadata->>'hopelab_notice_protocol' IS DISTINCT FROM 'gmail_notice_link_v2' THEN RETURN NEW; END IF;
  relation:=NEW.metadata->>'link_sha256';
  IF NEW.channel<>'email' OR NEW.metadata->>'provider' IS DISTINCT FROM 'hopelab_link' OR NEW.message_id IS DISTINCT FROM NEW.metadata->>'gmail_message_id'
    OR (relation IS NOT NULL AND (relation !~ '^[a-f0-9]{64}$' OR NEW.attachment_id IS DISTINCT FROM 'hopelab-link:'||relation))
    OR (relation IS NULL AND NEW.attachment_id<>'hopelab-link:missing') THEN RAISE EXCEPTION 'Invalid per-notice Hopelab v2 identity'; END IF;
  INSERT INTO public.exam_intake_document_hold(document_id,reason,relation_sha256) VALUES(NEW.document_id,CASE WHEN relation IS NULL THEN 'missing_link' ELSE 'awaiting_snapshot' END,relation) ON CONFLICT DO NOTHING;
  IF relation IS NULL THEN PERFORM public.open_exam_intake_incident('source:'||NEW.id||':missing_link',NULL,NULL,NEW.document_id,'link','hopelab_link_missing'); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER exam_intake_notice_hold AFTER INSERT ON public.exam_document_source FOR EACH ROW EXECUTE FUNCTION public.hold_exam_intake_notice_source();

CREATE FUNCTION public.record_exam_intake_notice_file_failure()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.file_status='failed' AND OLD.file_status IS DISTINCT FROM NEW.file_status AND EXISTS(SELECT 1 FROM public.exam_document_source WHERE document_id=NEW.id AND metadata->>'hopelab_notice_protocol'='gmail_notice_link_v2') THEN
    PERFORM public.open_exam_intake_incident('document:'||NEW.id||':notice_file_failure',NULL,NULL,NEW.id,'storage','notice_original_preservation_failed');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER exam_intake_notice_file_failure AFTER UPDATE OF file_status ON public.exam_document FOR EACH ROW EXECUTE FUNCTION public.record_exam_intake_notice_file_failure();

CREATE OR REPLACE FUNCTION public.check_exam_intake_health()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pending_hold record; result jsonb; snapshots integer:=0;
BEGIN
  PERFORM public.require_exam_document_service();
  result:=public.check_exam_intake_pipeline_health();
  UPDATE public.exam_intake_incident i SET state='resolved',resolved_at=now() WHERE i.state<>'resolved' AND i.code IN ('notice_original_preservation_failed','notice_snapshot_not_captured') AND EXISTS(SELECT 1 FROM public.exam_document d LEFT JOIN public.exam_document canonical ON canonical.id=d.canonical_document_id WHERE d.id=i.document_id AND (d.file_status='saved' OR canonical.file_status='saved'));
  FOR pending_hold IN SELECT h.document_id FROM public.exam_intake_document_hold h JOIN public.exam_document d ON d.id=h.document_id WHERE h.state='held' AND h.reason='awaiting_snapshot' AND h.created_at<now()-interval '15 minutes' AND d.canonical_document_id IS NULL LOOP
    PERFORM public.open_exam_intake_incident('document:'||pending_hold.document_id||':snapshot_timeout',NULL,NULL,pending_hold.document_id,'storage','notice_snapshot_not_captured');snapshots:=snapshots+1;
  END LOOP;
  UPDATE public.exam_intake_alert_outbox a SET status='cancelled',updated_at=now() FROM public.exam_intake_incident i WHERE i.id=a.incident_id AND i.state='resolved' AND a.status IN ('blocked','pending','reserved') AND a.submit_started_at IS NULL;
  RETURN result||jsonb_build_object('stale_notice_snapshots',snapshots);
END $$;

CREATE TEMP TABLE exam_intake_group_rpc_before ON COMMIT DROP AS
SELECT p.oid,p.proowner,p.proacl FROM pg_proc p WHERE p.oid='public.reserve_exam_document_delivery(text,text,integer)'::regprocedure;
DO $$ DECLARE definition text; needle text:='AND d.canonical_document_id IS NULL'; matches integer; BEGIN
  SELECT pg_get_functiondef('public.reserve_exam_document_delivery(text,text,integer)'::regprocedure) INTO definition;
  matches:=(length(definition)-length(replace(definition,needle,'')))/length(needle);
  IF matches<>1 OR strpos(definition,'exam_intake_document_hold')>0 THEN RAISE EXCEPTION 'Group reservation drift: review the exact claim WHERE before installing'; END IF;
  definition:=replace(definition,needle,needle||' AND (p_destination<>''group'' OR NOT EXISTS(SELECT 1 FROM public.exam_intake_document_hold intake_hold WHERE intake_hold.document_id=d.id AND intake_hold.state=''held''))');
  EXECUTE definition;
  IF EXISTS(SELECT 1 FROM exam_intake_group_rpc_before b JOIN pg_proc p ON p.oid=b.oid WHERE p.proowner<>b.proowner OR p.proacl IS DISTINCT FROM b.proacl) THEN RAISE EXCEPTION 'Existing group RPC owner or ACL changed'; END IF;
END $$;

CREATE FUNCTION public.reserve_exam_intake_source(p_source jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb; source_row public.exam_document_source;
BEGIN
  PERFORM public.require_exam_document_service();
  result:=public.reserve_exam_document_source(p_source);
  IF p_source->'metadata'->>'hopelab_notice_protocol' IS DISTINCT FROM 'gmail_notice_link_v2' THEN RETURN result; END IF;
  IF strpos(pg_get_functiondef('public.reserve_exam_document_delivery(text,text,integer)'::regprocedure),'exam_intake_document_hold')=0
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.exam_document_source'::regclass AND tgname='exam_intake_notice_hold' AND tgenabled IN ('O','A')) THEN RAISE EXCEPTION 'Hopelab v2 group hold contract is unavailable'; END IF;
  SELECT * INTO STRICT source_row FROM public.exam_document_source WHERE channel=p_source->>'channel' AND account_id=p_source->>'account_id' AND message_id=p_source->>'message_id' AND attachment_id=p_source->>'attachment_id';
  IF source_row.metadata->>'hopelab_notice_protocol' IS DISTINCT FROM 'gmail_notice_link_v2' OR source_row.metadata->>'link_sha256' IS DISTINCT FROM p_source->'metadata'->>'link_sha256' THEN RAISE EXCEPTION 'Hopelab v2 source replay identity differs'; END IF;
  RETURN result||jsonb_build_object('hopelab_notice_v2',jsonb_build_object('contract','hopelab_notice_v2_hold_v1','source_id',source_row.id,'notice_id',source_row.message_id,'url_sha256',source_row.metadata->>'link_sha256','group_hold_enforced',true));
END $$;

CREATE FUNCTION public.stage_exam_intake_file(p_document_id uuid,p_file jsonb,p_worker text DEFAULT 'ingestion')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE source_ids uuid[]; source_row public.exam_document_source; captured public.exam_intake_snapshot; doc public.exam_document; previous_id uuid; unavailable_id uuid; result jsonb; relation_state text; relation text; lock_scope record;
BEGIN
  PERFORM public.require_exam_document_service();
  SELECT array_agg(id ORDER BY id) INTO source_ids FROM public.exam_document_source WHERE document_id=p_document_id AND metadata->>'hopelab_notice_protocol'='gmail_notice_link_v2';
  IF source_ids IS NOT NULL THEN
    FOR lock_scope IN SELECT DISTINCT account_id,metadata->>'link_sha256' AS relation FROM public.exam_document_source WHERE id=ANY(source_ids) ORDER BY account_id,relation LOOP
      IF lock_scope.relation IS NULL THEN RAISE EXCEPTION 'Cannot stage a notice without a validated result link'; END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('exam_intake_link:'||jsonb_build_array(lock_scope.account_id,lock_scope.relation)::text,0));
    END LOOP;
  END IF;
  result:=public.stage_exam_document_file(p_document_id,p_file,p_worker);
  IF source_ids IS NULL THEN RETURN result; END IF;
  SELECT * INTO STRICT doc FROM public.exam_document WHERE id=(result->>'document_id')::uuid;
  FOR source_row IN SELECT * FROM public.exam_document_source WHERE id=ANY(source_ids) ORDER BY id LOOP
    IF source_row.document_id<>doc.id OR doc.canonical_document_id IS NOT NULL OR doc.sha256 IS NULL OR doc.size_bytes IS NULL THEN RAISE EXCEPTION 'Staged canonical binding is unproven'; END IF;
    SELECT * INTO captured FROM public.exam_intake_snapshot WHERE source_id=source_row.id;
    IF FOUND THEN
      IF captured.document_id<>doc.id OR captured.sha256<>doc.sha256 OR captured.size_bytes<>doc.size_bytes THEN RAISE EXCEPTION 'A notice snapshot is immutable'; END IF;
      CONTINUE;
    END IF;
    relation:=source_row.metadata->>'link_sha256';
    SELECT older_doc.id INTO previous_id FROM public.exam_document_source older_source JOIN public.exam_document older_doc ON older_doc.id=older_source.document_id
      WHERE older_source.account_id=source_row.account_id AND older_source.metadata->>'provider'='hopelab_link' AND older_source.metadata->>'link_sha256'=relation
        AND older_source.id<>source_row.id AND older_doc.canonical_document_id IS NULL AND older_doc.file_status='saved'
        AND (older_source.received_at<source_row.received_at OR (older_source.received_at=source_row.received_at AND older_source.created_at<source_row.created_at))
      ORDER BY older_source.received_at DESC,older_source.created_at DESC,older_source.id LIMIT 1;
    IF previous_id=doc.id THEN previous_id:=NULL; END IF;
    SELECT older_doc.id INTO unavailable_id FROM public.exam_document_source older_source JOIN public.exam_document older_doc ON older_doc.id=older_source.document_id
      WHERE older_source.account_id=source_row.account_id AND older_source.metadata->>'provider'='hopelab_link' AND older_source.metadata->>'link_sha256'=relation
        AND older_source.id<>source_row.id AND older_doc.id<>doc.id AND older_doc.canonical_document_id IS NULL
        AND (older_doc.file_status<>'saved' OR older_doc.sha256 IS NULL OR older_doc.size_bytes IS NULL)
        AND (older_source.received_at<source_row.received_at OR (older_source.received_at=source_row.received_at AND older_source.created_at<source_row.created_at))
      ORDER BY older_source.received_at DESC,older_source.created_at DESC,older_source.id LIMIT 1;
    relation_state:=CASE WHEN p_document_id<>doc.id THEN CASE WHEN previous_id IS NULL AND unavailable_id IS NULL THEN 'unchanged' ELSE 'existing_content_review' END WHEN unavailable_id IS NOT NULL THEN 'historical_unknown_review' WHEN previous_id IS NULL THEN 'new_original' ELSE 'changed_review' END;
    INSERT INTO public.exam_intake_snapshot(source_id,document_id,previous_document_id,relation_sha256,sha256,size_bytes,relation_state)
      VALUES(source_row.id,doc.id,COALESCE(previous_id,unavailable_id),relation,doc.sha256,doc.size_bytes,relation_state);
    IF p_document_id=doc.id THEN
      IF previous_id IS NULL AND unavailable_id IS NULL THEN
        UPDATE public.exam_intake_document_hold SET state='released',reason='first_original',released_at=now() WHERE document_id=doc.id AND reason='awaiting_snapshot';
      ELSE
        UPDATE public.exam_intake_document_hold SET state='held',reason=CASE WHEN unavailable_id IS NOT NULL THEN 'historical_snapshot_unavailable' ELSE 'changed_content_review' END,previous_document_id=COALESCE(previous_id,unavailable_id),relation_sha256=relation,released_at=NULL,released_by=NULL WHERE document_id=doc.id;
      END IF;
    END IF;
    IF previous_id IS NOT NULL THEN PERFORM public.open_exam_intake_incident('source:'||source_row.id||':changed_content',NULL,NULL,doc.id,'version','linked_result_content_requires_review'); END IF;
    IF unavailable_id IS NOT NULL THEN PERFORM public.open_exam_intake_incident('source:'||source_row.id||':historical_snapshot_unavailable',NULL,NULL,doc.id,'version','historical_link_snapshot_unavailable'); END IF;
  END LOOP;
  RETURN result||jsonb_build_object('notice_snapshots_recorded',cardinality(source_ids),'group_hold',(SELECT state='held' FROM public.exam_intake_document_hold WHERE document_id=doc.id));
END $$;

CREATE FUNCTION public.release_exam_intake_hold(p_document_id uuid,p_expected_sha256 text,p_reason_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor uuid; doc public.exam_document; hold public.exam_intake_document_hold;
BEGIN
  actor:=public.require_exam_document_member(ARRAY['admin','vet']);
  SELECT * INTO STRICT doc FROM public.exam_document WHERE id=p_document_id FOR NO KEY UPDATE;
  SELECT * INTO STRICT hold FROM public.exam_intake_document_hold WHERE document_id=doc.id FOR UPDATE;
  IF doc.sha256 IS DISTINCT FROM p_expected_sha256 OR doc.file_status<>'saved' OR doc.canonical_document_id IS NOT NULL OR p_reason_code IS NULL OR p_reason_code !~ '^[a-z][a-z0-9_]{0,95}$' OR hold.reason NOT IN ('changed_content_review','historical_snapshot_unavailable') THEN RAISE EXCEPTION 'Review the preserved changed snapshot before releasing its group hold'; END IF;
  IF hold.state='released' THEN RETURN jsonb_build_object('document_id',doc.id,'hold_released',true,'already_released',true); END IF;
  UPDATE public.exam_intake_document_hold SET state='released',released_at=COALESCE(released_at,now()),released_by=COALESCE(released_by,actor) WHERE document_id=doc.id;
  INSERT INTO public.exam_document_event(document_id,event_type,actor_id,details) VALUES(doc.id,'intake_version_reviewed',actor,jsonb_build_object('reason_code',p_reason_code,'sha256',doc.sha256));
  UPDATE public.exam_intake_incident SET state='resolved',resolved_at=now() WHERE document_id=doc.id AND code IN ('linked_result_content_requires_review','historical_link_snapshot_unavailable') AND state<>'resolved';
  RETURN jsonb_build_object('document_id',doc.id,'hold_released',true);
END $$;
CREATE FUNCTION public.get_exam_intake_version_holds(p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM public.require_exam_document_member();
  IF p_limit NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Invalid version hold limit'; END IF;
  RETURN jsonb_build_object('as_of',now(),'total',(SELECT count(*) FROM public.exam_intake_document_hold h JOIN public.exam_document d ON d.id=h.document_id WHERE h.state='held' AND d.canonical_document_id IS NULL),
    'has_more',(SELECT count(*)>p_limit FROM public.exam_intake_document_hold h JOIN public.exam_document d ON d.id=h.document_id WHERE h.state='held' AND d.canonical_document_id IS NULL),
    'holds',COALESCE((SELECT jsonb_agg(to_jsonb(h)) FROM (SELECT h.*,d.sha256,d.file_status FROM public.exam_intake_document_hold h JOIN public.exam_document d ON d.id=h.document_id WHERE h.state='held' AND d.canonical_document_id IS NULL ORDER BY h.created_at,h.document_id LIMIT p_limit) h),'[]'));
END $$;

DO $$ DECLARE name text; item regprocedure; BEGIN
  FOREACH name IN ARRAY ARRAY['exam_intake_document_hold','exam_intake_snapshot'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',name);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON public.%I TO service_role',name);
  END LOOP;
  FOR item IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('hold_exam_intake_notice_source','record_exam_intake_notice_file_failure','reserve_exam_intake_source','stage_exam_intake_file','release_exam_intake_hold','get_exam_intake_version_holds') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',item);
    IF (SELECT proname FROM pg_proc WHERE oid=item) IN ('release_exam_intake_hold','get_exam_intake_version_holds') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',item);
    ELSE EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',item); END IF;
  END LOOP;
END $$;
COMMIT;
