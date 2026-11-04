-- Independent preservation and group delivery. Drive/processing truth is unchanged.
-- Disabled until an explicit source scope and cutoff are configured.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE public.exam_fallback_configuration (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL DEFAULT false,
  source_account_id text,
  source_conversation_id text,
  received_from timestamptz,
  minimum_age_seconds integer NOT NULL DEFAULT 120 CHECK(minimum_age_seconds BETWEEN 30 AND 3600),
  CHECK (NOT enabled OR (source_account_id IS NOT NULL AND source_conversation_id IS NOT NULL AND source_account_id ~ '^chatwoot:[0-9]+:inbox:[0-9]+$'
    AND source_conversation_id ~ '^[0-9]+$' AND received_from IS NOT NULL))
);
INSERT INTO public.exam_fallback_configuration(singleton) VALUES(true);

CREATE TABLE public.exam_fallback_original (
  document_id uuid PRIMARY KEY REFERENCES public.exam_document(id),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint NOT NULL CHECK(size_bytes>0),
  bucket text NOT NULL DEFAULT 'exam_documents_staging' CHECK(bucket='exam_documents_staging'),
  path text NOT NULL,
  state text NOT NULL CHECK(state IN ('reserved','verified')),
  worker text NOT NULL,
  lease_token uuid NOT NULL,
  lease_until timestamptz,
  drive_lease_token uuid,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(path=document_id::text||'/original.pdf'),
  CHECK(state<>'verified' OR verified_at IS NOT NULL)
);
CREATE TRIGGER exam_deletion_fallback_original_guard BEFORE INSERT OR UPDATE ON public.exam_fallback_original
  FOR EACH ROW EXECUTE FUNCTION public.exam_document_deletion_guard();

-- A reserved upload may still be in flight even after its wall-clock lease expires.
-- Deletion must not race a late immutable Storage PUT and orphan an original.
CREATE FUNCTION public.guard_exam_fallback_deletion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.deletion_state IS DISTINCT FROM OLD.deletion_state AND NEW.deletion_state IS NOT NULL
    AND EXISTS(SELECT 1 FROM public.exam_fallback_original WHERE document_id=NEW.id AND state='reserved') THEN
    RAISE EXCEPTION 'Fallback de preservação em andamento; reconciliar antes de excluir' USING ERRCODE='PT409';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER exam_fallback_deletion_guard BEFORE UPDATE OF deletion_state ON public.exam_document
  FOR EACH ROW EXECUTE FUNCTION public.guard_exam_fallback_deletion();

CREATE FUNCTION public.exam_fallback_source_in_scope(p_document_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.exam_document_source s CROSS JOIN public.exam_fallback_configuration c
    WHERE c.singleton AND c.enabled AND c.received_from IS NOT NULL
      AND s.document_id=COALESCE((SELECT canonical_document_id FROM public.exam_document WHERE id=p_document_id),p_document_id) AND s.channel='whatsapp' AND s.account_id=c.source_account_id
      AND s.received_at>=c.received_from
      AND s.metadata->>'provider'='chatwoot'
      AND s.metadata->>'chatwoot_conversation_id'=c.source_conversation_id
      AND s.metadata->'sender_allowlisted'='true'::jsonb
      AND s.metadata->'unknown_sender'='false'::jsonb
      AND s.metadata->'exam_candidate'='true'::jsonb
      AND s.metadata->>'chatwoot_message_id'=s.message_id
      AND s.attachment_id='chatwoot-attachment:'||(s.metadata->>'chatwoot_attachment_id')
      AND s.metadata->'unsupported_attachment'='false'::jsonb
  );
$$;

CREATE FUNCTION public.reserve_exam_fallback_original(p_document_id uuid,p_sha256 text,p_size_bytes bigint,p_worker text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE staged jsonb; d public.exam_document; f public.exam_fallback_original;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_worker IS NULL OR p_worker !~ '^fallback:[A-Za-z0-9_.:-]{1,140}$' THEN RAISE EXCEPTION 'Invalid fallback worker'; END IF;
  IF NOT public.exam_fallback_source_in_scope(p_document_id) THEN RAISE EXCEPTION 'Fallback source is not enabled or authorized' USING ERRCODE='42501'; END IF;
  -- A verified replay must not consume another Drive attempt or acquire its lease.
  SELECT * INTO STRICT d FROM public.exam_document WHERE id=p_document_id;
  IF d.canonical_document_id IS NOT NULL THEN SELECT * INTO STRICT d FROM public.exam_document WHERE id=d.canonical_document_id; END IF;
  IF d.deletion_state IS NOT NULL OR d.identification_status='not_exam' THEN RAISE EXCEPTION 'Fallback document is excluded'; END IF;
  SELECT * INTO f FROM public.exam_fallback_original WHERE document_id=d.id;
  IF FOUND AND f.state='verified' AND f.sha256=lower(p_sha256) AND f.size_bytes=p_size_bytes
    AND d.sha256=f.sha256 AND d.size_bytes=f.size_bytes AND d.staging_bucket=f.bucket AND d.staging_path=f.path
    AND EXISTS(SELECT 1 FROM storage.objects o JOIN storage.buckets b ON b.id=o.bucket_id
      WHERE o.bucket_id=f.bucket AND o.name=f.path AND b.public=false AND (o.metadata->>'size')::bigint=f.size_bytes) THEN
    RETURN jsonb_build_object('document_id',d.id,'already_verified',true,'claimed',false,'bucket',f.bucket,'path',f.path,'document',to_jsonb(d));
  END IF;
  -- Reuse canonicalization, tombstones, immutable source bytes and notice/version guards.
  -- This can return another worker's active Drive reservation; it is never stolen.
  staged:=public.stage_exam_intake_file(p_document_id,jsonb_build_object('sha256',p_sha256,'size_bytes',p_size_bytes,
    'staging_bucket','exam_documents_staging'),p_worker);
  IF staged->'excluded'='true'::jsonb THEN RETURN staged||jsonb_build_object('claimed',false); END IF;
  SELECT * INTO STRICT d FROM public.exam_document WHERE id=(staged->>'document_id')::uuid FOR NO KEY UPDATE;
  IF d.deletion_state IS NOT NULL OR d.canonical_document_id IS NOT NULL OR d.identification_status='not_exam' THEN
    RAISE EXCEPTION 'Fallback document is excluded';
  END IF;
  IF NOT public.exam_fallback_source_in_scope(d.id) THEN RAISE EXCEPTION 'Canonical fallback source is outside scope'; END IF;
  IF d.file_status='saved' THEN
    RETURN jsonb_build_object('document_id',d.id,'already_saved',true,'claimed',false,'document',to_jsonb(d));
  END IF;
  IF d.sha256 IS DISTINCT FROM lower(p_sha256) OR d.size_bytes IS DISTINCT FROM p_size_bytes
    OR d.staging_bucket IS DISTINCT FROM 'exam_documents_staging' OR d.staging_path IS DISTINCT FROM d.id::text||'/original.pdf' THEN
    RAISE EXCEPTION 'Fallback staging identity diverges';
  END IF;
  SELECT * INTO f FROM public.exam_fallback_original WHERE document_id=d.id FOR UPDATE;
  IF FOUND THEN
    IF f.sha256 IS DISTINCT FROM d.sha256 OR f.size_bytes IS DISTINCT FROM d.size_bytes THEN RAISE EXCEPTION 'Fallback bytes cannot change'; END IF;
    IF f.state='verified' AND EXISTS(SELECT 1 FROM storage.objects o JOIN storage.buckets b ON b.id=o.bucket_id
      WHERE o.bucket_id=f.bucket AND o.name=f.path AND b.public=false AND (o.metadata->>'size')::bigint=f.size_bytes) THEN
      -- stage may have claimed a Drive lease during this replay. Release only that claim.
      IF staged->'claimed'='true'::jsonb THEN
        UPDATE public.exam_document_delivery SET status='pending',lease_until=NULL,worker=NULL,updated_at=now()
          WHERE id=(staged->>'delivery_id')::uuid AND status='reserved' AND worker=p_worker AND lease_token=(staged->>'lease_token')::uuid;
      END IF;
      RETURN jsonb_build_object('document_id',d.id,'already_verified',true,'claimed',false,'bucket',f.bucket,'path',f.path,'document',to_jsonb(d));
    END IF;
    IF f.lease_until>now() AND f.worker<>p_worker THEN
      RETURN jsonb_build_object('document_id',d.id,'claimed',false,'reason','fallback_reserved','document',to_jsonb(d));
    END IF;
    IF f.lease_until>now() AND f.worker=p_worker THEN
      RETURN jsonb_build_object('document_id',d.id,'claimed',true,'lease_token',f.lease_token,'lease_until',f.lease_until,'bucket',f.bucket,'path',f.path,'document',to_jsonb(d));
    END IF;
  END IF;
  INSERT INTO public.exam_fallback_original(document_id,sha256,size_bytes,path,state,worker,lease_token,lease_until,drive_lease_token)
    VALUES(d.id,d.sha256,d.size_bytes,d.staging_path,'reserved',p_worker,gen_random_uuid(),now()+interval '2 minutes',
      CASE WHEN staged->'claimed'='true'::jsonb THEN (staged->>'lease_token')::uuid END)
    ON CONFLICT(document_id) DO UPDATE SET state='reserved',worker=excluded.worker,lease_token=excluded.lease_token,
      lease_until=excluded.lease_until,drive_lease_token=excluded.drive_lease_token,updated_at=now()
    RETURNING * INTO f;
  RETURN jsonb_build_object('document_id',d.id,'claimed',true,'lease_token',f.lease_token,'lease_until',f.lease_until,
    'bucket',f.bucket,'path',f.path,'document',to_jsonb(d));
END $$;

-- This service-only RPC follows the backend's PDF/hash/readback verification.
-- Storage metadata alone is not presented as a content proof by the worker API.
CREATE FUNCTION public.confirm_exam_fallback_original(p_document_id uuid,p_lease_token uuid,p_sha256 text,p_size_bytes bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.exam_document; f public.exam_fallback_original;
BEGIN
  PERFORM public.require_exam_document_service();
  SELECT * INTO STRICT d FROM public.exam_document WHERE id=p_document_id FOR NO KEY UPDATE;
  SELECT * INTO STRICT f FROM public.exam_fallback_original WHERE document_id=d.id FOR UPDATE;
  IF d.deletion_state IS NOT NULL OR d.canonical_document_id IS NOT NULL OR d.identification_status='not_exam'
    OR NOT public.exam_fallback_source_in_scope(d.id) THEN RAISE EXCEPTION 'Fallback document is no longer eligible'; END IF;
  IF f.lease_token IS DISTINCT FROM p_lease_token OR f.sha256 IS DISTINCT FROM lower(p_sha256) OR f.size_bytes IS DISTINCT FROM p_size_bytes
    OR d.sha256 IS DISTINCT FROM f.sha256 OR d.size_bytes IS DISTINCT FROM f.size_bytes
    OR d.staging_bucket IS DISTINCT FROM f.bucket OR d.staging_path IS DISTINCT FROM f.path THEN RAISE EXCEPTION 'Fallback confirmation fence invalid' USING ERRCODE='PT409'; END IF;
  IF f.state='verified' THEN RETURN jsonb_build_object('document_id',d.id,'verified',true,'already_verified',true,'document',to_jsonb(d)); END IF;
  IF f.lease_until<=now() THEN RAISE EXCEPTION 'Fallback storage lease expired' USING ERRCODE='PT409'; END IF;
  IF NOT EXISTS(SELECT 1 FROM storage.objects o JOIN storage.buckets b ON b.id=o.bucket_id
    WHERE o.bucket_id=f.bucket AND o.name=f.path AND b.public=false AND (o.metadata->>'size')::bigint=f.size_bytes) THEN
    RAISE EXCEPTION 'Fallback Storage object is not confirmed';
  END IF;
  UPDATE public.exam_fallback_original SET state='verified',verified_at=now(),lease_until=NULL,updated_at=now() WHERE document_id=d.id;
  -- Preserve every prior Drive attempt and leave that destination pending.
  UPDATE public.exam_document_delivery SET status='pending',lease_until=NULL,worker=NULL,updated_at=now()
    WHERE document_id=d.id AND destination='drive' AND status='reserved' AND worker=f.worker AND lease_token=f.drive_lease_token;
  UPDATE public.exam_document SET group_release_at=COALESCE(group_release_at,now()) WHERE id=d.id RETURNING * INTO d;
  INSERT INTO public.exam_document_delivery(document_id,destination) SELECT d.id,'group'
    WHERE d.group_exception_reason IS NULL AND NOT EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=d.id AND destination='group') ON CONFLICT DO NOTHING;
  PERFORM public.log_exam_document(d.id,'fallback_original_verified',jsonb_build_object('sha256',f.sha256,'size_bytes',f.size_bytes,'bucket',f.bucket,'path',f.path));
  RETURN jsonb_build_object('document_id',d.id,'verified',true,'drive_pending',d.file_status<>'saved','document',to_jsonb(d));
END $$;

CREATE FUNCTION public.exam_fallback_group_eligible(p_document_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.exam_document d CROSS JOIN public.exam_document_configuration cfg
    LEFT JOIN LATERAL (SELECT event_type,details FROM public.exam_document_event WHERE document_id=d.id AND actor_id IS NOT NULL
      AND event_type IN ('reviewed','link_confirmed') ORDER BY id DESC LIMIT 1) human_decision ON true
    LEFT JOIN LATERAL (SELECT details FROM public.exam_document_event WHERE document_id=d.id AND event_type='extraction_updated' ORDER BY id DESC LIMIT 1) extraction ON true
    WHERE d.id=p_document_id AND public.exam_fallback_source_in_scope(d.id)
      AND 'group'=ANY(cfg.enabled_destinations) AND cfg.notification_cutoff IS NOT NULL AND d.received_at>=cfg.notification_cutoff
      AND NULLIF(cfg.group_destination_key,'') IS NOT NULL AND d.canonical_document_id IS NULL AND d.deletion_state IS NULL
      AND d.identification_status<>'not_exam' AND d.group_exception_reason IS NULL AND d.group_release_at IS NOT NULL
      AND (d.file_status='saved' OR EXISTS(SELECT 1 FROM public.exam_fallback_original f JOIN storage.objects o ON o.bucket_id=f.bucket AND o.name=f.path JOIN storage.buckets b ON b.id=o.bucket_id
        WHERE b.public=false AND f.document_id=d.id AND f.state='verified' AND f.sha256=d.sha256 AND f.size_bytes=d.size_bytes
          AND f.bucket=d.staging_bucket AND f.path=d.staging_path AND (o.metadata->>'size')::bigint=f.size_bytes))
      AND NOT EXISTS(SELECT 1 FROM public.exam_intake_document_hold h WHERE h.document_id=d.id AND h.state='held'
        AND h.reason NOT IN ('changed_content_review','historical_snapshot_unavailable'))
      AND CASE WHEN human_decision.event_type='link_confirmed' THEN true
        WHEN human_decision.event_type='reviewed' AND human_decision.details->>'classification'='not_exam' THEN false
        WHEN human_decision.event_type='reviewed' AND human_decision.details->>'classification'='exam' THEN true
        WHEN extraction.details->>'classification'='not_exam' THEN false
        ELSE EXISTS(SELECT 1 FROM public.exam_document_source s WHERE s.document_id=d.id AND s.metadata->'exam_candidate'='true'::jsonb) END
  );
$$;

-- Recovery must not depend on n8n's separate expiry job. An old primary
-- reservation has no pre-POST grant marker, so only a GET reconciliation is safe.
CREATE FUNCTION public.expire_exam_fallback_group_leases(p_document_id uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE candidate record; d public.exam_document; t public.exam_document_delivery; count_expired integer:=0; no_dispatch boolean;
BEGIN
  PERFORM public.require_exam_document_service();
  FOR candidate IN SELECT g.id,g.document_id,cfg.group_destination_key AS configured_destination FROM public.exam_document_delivery g JOIN public.exam_document doc ON doc.id=g.document_id
    CROSS JOIN public.exam_document_configuration cfg
    WHERE g.destination='group' AND g.status='reserved' AND g.lease_until<=now()
      AND (p_document_id IS NULL OR g.document_id=p_document_id)
      AND g.destination_key IN ('default',cfg.group_destination_key) AND doc.deletion_state IS NULL
      AND public.exam_fallback_source_in_scope(doc.id) ORDER BY g.document_id,g.id LIMIT 100 LOOP
    SELECT * INTO STRICT d FROM public.exam_document WHERE id=candidate.document_id FOR NO KEY UPDATE;
    SELECT * INTO STRICT t FROM public.exam_document_delivery WHERE id=candidate.id FOR UPDATE;
    IF t.status<>'reserved' OR t.lease_until>now() THEN CONTINUE; END IF;
    no_dispatch:=t.worker ~ '^fallback:' AND NOT EXISTS(SELECT 1 FROM public.exam_document_event e
      WHERE e.document_id=d.id AND e.event_type='fallback_group_dispatch_started' AND e.details->>'delivery_id'=t.id::text
        AND e.details->>'lease_token'=t.lease_token::text);
    UPDATE public.exam_document_delivery SET status=CASE WHEN no_dispatch THEN 'pending' ELSE 'uncertain' END,
      lease_token=CASE WHEN no_dispatch THEN NULL ELSE lease_token END,lease_until=NULL,
      destination_key=CASE WHEN destination_key='default' THEN candidate.configured_destination ELSE destination_key END,
      next_attempt_at=CASE WHEN no_dispatch THEN now() ELSE next_attempt_at END,
      last_error=CASE WHEN no_dispatch THEN 'Fallback pre-submit lease expired; no dispatch grant' ELSE 'Primary lease expired; reconcile provider before retry' END,
      updated_at=now() WHERE id=t.id;
    PERFORM public.log_exam_document(d.id,'fallback_group_lease_expired',jsonb_build_object('delivery_id',t.id,'dispatch_unstarted',no_dispatch));
    count_expired:=count_expired+1;
  END LOOP;
  RETURN count_expired;
END $$;

CREATE FUNCTION public.reserve_exam_fallback_group(p_document_id uuid,p_worker text,p_min_age_seconds integer DEFAULT 120)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.exam_document; t public.exam_document_delivery; cfg public.exam_document_configuration; fallback public.exam_fallback_configuration;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_worker IS NULL OR p_worker !~ '^fallback:[A-Za-z0-9_.:-]{1,140}$' OR p_min_age_seconds IS NULL OR p_min_age_seconds NOT BETWEEN 0 AND 3600 THEN RAISE EXCEPTION 'Invalid fallback claim'; END IF;
  SELECT * INTO STRICT d FROM public.exam_document WHERE id=p_document_id FOR NO KEY UPDATE;
  SELECT * INTO STRICT cfg FROM public.exam_document_configuration;
  SELECT * INTO STRICT fallback FROM public.exam_fallback_configuration WHERE singleton;
  PERFORM public.expire_exam_fallback_group_leases(d.id);
  IF NOT public.exam_fallback_group_eligible(d.id) THEN RETURN jsonb_build_object('claimed',false,'reason','ineligible'); END IF;
  IF d.received_at>now()-make_interval(secs=>greatest(p_min_age_seconds,fallback.minimum_age_seconds)) THEN
    RETURN jsonb_build_object('claimed',false,'reason','primary_grace');
  END IF;
  SELECT * INTO t FROM public.exam_document_delivery WHERE document_id=d.id AND destination='group' ORDER BY created_at,id LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('claimed',false,'reason','group_task_missing'); END IF;
  IF t.status NOT IN ('pending','failed') OR t.attempts>=t.max_attempts OR t.next_attempt_at>now()
    OR t.destination_key NOT IN ('default',cfg.group_destination_key) THEN
    RETURN jsonb_build_object('claimed',false,'reason','group_not_retryable','status',t.status);
  END IF;
  UPDATE public.exam_document_delivery SET status='reserved',worker=p_worker,lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',
    destination_key=cfg.group_destination_key,attempts=attempts+1,updated_at=now() WHERE id=t.id RETURNING * INTO t;
  RETURN jsonb_build_object('claimed',true,'task',to_jsonb(t)||jsonb_build_object('document',to_jsonb(d),'configured_destination',cfg.group_destination_key,
    'notification_fields',public.exam_document_group_readiness(d.extracted_data,d.confirmed_data)->'fields'));
END $$;

-- Atomic one-shot grant immediately before the HTTP POST. A lost response stays
-- uncertain and can only be reconciled, not claimed for a second POST.
CREATE FUNCTION public.begin_exam_fallback_group_dispatch(p_delivery_id uuid,p_lease_token uuid,p_content_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.exam_document; t public.exam_document_delivery; doc_id uuid; cfg public.exam_document_configuration;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_content_sha256 IS NULL OR p_content_sha256 !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid fallback content fingerprint'; END IF;
  SELECT document_id INTO STRICT doc_id FROM public.exam_document_delivery WHERE id=p_delivery_id;
  SELECT * INTO STRICT d FROM public.exam_document WHERE id=doc_id FOR NO KEY UPDATE;
  SELECT * INTO STRICT t FROM public.exam_document_delivery WHERE id=p_delivery_id FOR UPDATE;
  SELECT * INTO STRICT cfg FROM public.exam_document_configuration;
  IF t.lease_token IS DISTINCT FROM p_lease_token OR t.destination<>'group' OR t.worker !~ '^fallback:' THEN RAISE EXCEPTION 'Fallback dispatch fence invalid' USING ERRCODE='PT409'; END IF;
  IF t.status IN ('uncertain','submitted','sent') THEN RETURN jsonb_build_object('dispatch_allowed',false,'status',t.status); END IF;
  IF t.status<>'reserved' OR t.lease_until<=now() OR t.destination_key IS DISTINCT FROM cfg.group_destination_key
    OR NOT public.exam_fallback_group_eligible(d.id) THEN RAISE EXCEPTION 'Fallback dispatch no longer eligible' USING ERRCODE='PT409'; END IF;
  UPDATE public.exam_document_delivery SET status='uncertain',last_error='Fallback submission started; reconcile before retry',lease_until=NULL,updated_at=now() WHERE id=t.id;
  PERFORM public.log_exam_document(d.id,'fallback_group_dispatch_started',jsonb_build_object('delivery_id',t.id,'lease_token',t.lease_token,'content_sha256',p_content_sha256));
  RETURN jsonb_build_object('dispatch_allowed',true,'delivery_id',t.id,'document_id',d.id,'destination_key',t.destination_key,'sha256',d.sha256,'content_sha256',p_content_sha256);
END $$;

CREATE TABLE public.exam_fallback_runtime (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  worker text,
  run_token uuid,
  run_until timestamptz,
  scan jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_started_at timestamptz,
  last_checkpoint_at timestamptz,
  last_completed_at timestamptz,
  last_error_code text,
  CHECK(jsonb_typeof(scan)='object' AND octet_length(scan::text)<=8192),
  CHECK(last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,95}$')
);
INSERT INTO public.exam_fallback_runtime(singleton) VALUES(true);

CREATE FUNCTION public.valid_exam_fallback_scan(p_scan jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE c jsonb; k text; v jsonb; iso text;
BEGIN
  IF p_scan IS NULL OR jsonb_typeof(p_scan)<>'object' OR octet_length(p_scan::text)>8192 THEN RETURN false; END IF;
  IF p_scan='{}'::jsonb THEN RETURN true; END IF;
  IF NOT p_scan ?& ARRAY['cursor','window_start','window_end'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_scan) key WHERE key NOT IN ('cursor','window_start','window_end')) THEN RETURN false; END IF;
  FOR iso IN SELECT p_scan->>'window_start' UNION ALL SELECT p_scan->>'window_end' LOOP
    IF iso IS NULL OR iso !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$' THEN RETURN false; END IF;
    PERFORM iso::timestamptz;
  END LOOP;
  IF (p_scan->>'window_start')::timestamptz >= (p_scan->>'window_end')::timestamptz THEN RETURN false; END IF;
  c:=p_scan->'cursor';
  IF c='null'::jsonb THEN RETURN true; END IF;
  IF jsonb_typeof(c)<>'object' OR NOT c ?& ARRAY['version','scope','conversationIndex','beforeMessageId','highWaterMessageIds']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(c) key WHERE key NOT IN ('version','scope','conversationIndex','beforeMessageId','highWaterMessageIds'))
    OR c->'version'<>'1'::jsonb OR jsonb_typeof(c->'scope')<>'string' OR c->>'scope' !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(c->'conversationIndex')<>'number' OR c->>'conversationIndex' !~ '^[0-9]{1,2}$' OR (c->>'conversationIndex')::integer>20
    OR (c->'beforeMessageId'<>'null'::jsonb AND (jsonb_typeof(c->'beforeMessageId')<>'string' OR c->>'beforeMessageId' !~ '^[0-9]{1,32}$'))
    OR jsonb_typeof(c->'highWaterMessageIds')<>'object' THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(c->'highWaterMessageIds'))>20 THEN RETURN false; END IF;
  FOR k,v IN SELECT * FROM jsonb_each(c->'highWaterMessageIds') LOOP
    IF k !~ '^[0-9]{1,32}$' OR jsonb_typeof(v)<>'string' OR v#>>'{}' !~ '^[0-9]{1,32}$' THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation THEN RETURN false;
END $$;

CREATE FUNCTION public.claim_exam_fallback_run(p_worker text,p_max_seconds integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.exam_fallback_runtime; cfg public.exam_fallback_configuration;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_worker IS NULL OR p_worker !~ '^fallback:[A-Za-z0-9_.:-]{1,140}$' OR p_max_seconds IS NULL OR p_max_seconds NOT BETWEEN 20 AND 120 THEN RAISE EXCEPTION 'Invalid fallback run'; END IF;
  SELECT * INTO STRICT cfg FROM public.exam_fallback_configuration WHERE singleton;
  IF NOT cfg.enabled THEN RETURN jsonb_build_object('claimed',false,'reason','disabled'); END IF;
  SELECT * INTO STRICT r FROM public.exam_fallback_runtime WHERE singleton FOR UPDATE;
  IF r.run_until>now() THEN RETURN jsonb_build_object('claimed',false,'reason','run_active'); END IF;
  UPDATE public.exam_fallback_runtime SET worker=p_worker,run_token=gen_random_uuid(),run_until=now()+make_interval(secs=>p_max_seconds),last_started_at=now()
    WHERE singleton RETURNING * INTO r;
  RETURN jsonb_build_object('claimed',true,'run_token',r.run_token,'run_until',r.run_until,'config',to_jsonb(cfg),'scan',r.scan);
END $$;

CREATE FUNCTION public.checkpoint_exam_fallback_run(p_run_token uuid,p_state jsonb,p_completed boolean,p_error_code text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.exam_fallback_runtime;
BEGIN
  PERFORM public.require_exam_document_service();
  IF NOT public.valid_exam_fallback_scan(p_state) OR p_completed IS NULL
    OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z][a-z0-9_]{0,95}$')
    OR (p_completed AND p_error_code IS NOT NULL) THEN RAISE EXCEPTION 'Invalid fallback checkpoint metadata'; END IF;
  SELECT * INTO STRICT r FROM public.exam_fallback_runtime WHERE singleton FOR UPDATE;
  IF r.run_token IS DISTINCT FROM p_run_token OR r.run_until IS NULL OR r.run_until<=now() THEN RAISE EXCEPTION 'Fallback run fence expired' USING ERRCODE='PT409'; END IF;
  UPDATE public.exam_fallback_runtime SET scan=CASE WHEN p_completed THEN '{}'::jsonb ELSE p_state END,
    last_checkpoint_at=now(),last_completed_at=CASE WHEN p_completed THEN now() ELSE last_completed_at END,last_error_code=p_error_code,
    run_until=NULL WHERE singleton RETURNING * INTO r;
  RETURN jsonb_build_object('recorded',true,'completed',p_completed,'scan',r.scan);
END $$;

CREATE FUNCTION public.list_exam_fallback_group_reconciliation(p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'Invalid fallback reconciliation limit'; END IF;
  PERFORM public.expire_exam_fallback_group_leases(NULL);
  SELECT COALESCE(jsonb_agg(to_jsonb(t)-'doc'||jsonb_build_object('document',t.doc)),'[]'::jsonb) INTO result FROM (
    SELECT g.*,to_jsonb(d) doc FROM public.exam_document_delivery g JOIN public.exam_document d ON d.id=g.document_id
      CROSS JOIN public.exam_document_configuration cfg
    WHERE g.destination='group' AND g.status IN ('submitted','uncertain') AND g.destination_key=cfg.group_destination_key
      AND d.deletion_state IS NULL AND public.exam_fallback_source_in_scope(d.id)
    ORDER BY g.updated_at,g.id LIMIT p_limit
  ) t;
  RETURN jsonb_build_object('tasks',result);
END $$;

-- Discovery persists work before downloading. Failed origins move to a later
-- due time instead of occupying the head of every scan forever.
CREATE TABLE public.exam_fallback_source_queue (
  source_id uuid PRIMARY KEY REFERENCES public.exam_document_source(id),
  document_id uuid NOT NULL REFERENCES public.exam_document(id),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','reserved','done')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  worker text,
  lease_token uuid,
  lease_until timestamptz,
  last_error_code text CHECK(last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,95}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX exam_fallback_source_due ON public.exam_fallback_source_queue(next_attempt_at,created_at,source_id) WHERE state='pending';

CREATE FUNCTION public.enqueue_exam_fallback_source(p_source jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cfg public.exam_fallback_configuration; reserved jsonb; s public.exam_document_source; q public.exam_fallback_source_queue;
BEGIN
  PERFORM public.require_exam_document_service();
  SELECT * INTO STRICT cfg FROM public.exam_fallback_configuration WHERE singleton;
  IF NOT cfg.enabled OR p_source IS NULL OR jsonb_typeof(p_source)<>'object'
    OR octet_length(p_source::text)>8192 OR jsonb_typeof(p_source->'metadata') IS DISTINCT FROM 'object'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_source->'metadata') key WHERE key NOT IN
      ('provider','chatwoot_account_id','chatwoot_inbox_id','chatwoot_conversation_id','chatwoot_message_id','chatwoot_attachment_id',
       'sender_phone','sender_allowlisted','unknown_sender','exam_candidate','missing_attachment','unsupported_attachment','pending_reason','attachment_url_sha256','original_name','mime_type'))
    OR EXISTS(SELECT 1 FROM jsonb_each(p_source->'metadata') value WHERE jsonb_typeof(value.value) IN ('object','array') OR value.value#>>'{}' ~ '://')
    OR p_source->>'channel' IS DISTINCT FROM 'whatsapp' OR p_source->>'account_id' IS DISTINCT FROM cfg.source_account_id
    OR p_source->'metadata'->>'provider' IS DISTINCT FROM 'chatwoot'
    OR p_source->'metadata'->>'chatwoot_conversation_id' IS DISTINCT FROM cfg.source_conversation_id
    OR p_source->'metadata'->'sender_allowlisted' IS DISTINCT FROM 'true'::jsonb
    OR p_source->'metadata'->'unknown_sender' IS DISTINCT FROM 'false'::jsonb
    OR p_source->'metadata'->'exam_candidate' IS DISTINCT FROM 'true'::jsonb
    OR jsonb_typeof(p_source->'metadata'->'unsupported_attachment') IS DISTINCT FROM 'boolean'
    OR p_source->>'message_id' IS DISTINCT FROM p_source->'metadata'->>'chatwoot_message_id'
    OR p_source->>'attachment_id' IS DISTINCT FROM 'chatwoot-attachment:'||(p_source->'metadata'->>'chatwoot_attachment_id')
    OR NULLIF(p_source->>'received_at','') IS NULL OR (p_source->>'received_at')::timestamptz<cfg.received_from THEN
    RAISE EXCEPTION 'Fallback queue source is outside the enabled scope' USING ERRCODE='42501';
  END IF;
  reserved:=public.reserve_exam_intake_source(p_source);
  SELECT * INTO STRICT s FROM public.exam_document_source WHERE channel='whatsapp' AND account_id=p_source->>'account_id'
    AND message_id=p_source->>'message_id' AND attachment_id=p_source->>'attachment_id';
  IF p_source->'metadata'->'unsupported_attachment'='true'::jsonb THEN
    IF EXISTS(SELECT 1 FROM public.exam_document WHERE id=s.document_id AND deletion_state IS NOT NULL) THEN
      RETURN jsonb_build_object('queued',false,'reason','source_excluded','document_id',s.document_id,'source_id',s.id);
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.exam_document_event WHERE document_id=s.document_id AND event_type='fallback_source_requires_review' AND details->>'source_id'=s.id::text) THEN
      PERFORM public.log_exam_document(s.document_id,'fallback_source_requires_review',jsonb_build_object('source_id',s.id,'reason_code','unsupported_attachment_requires_review'));
    END IF;
    PERFORM public.open_exam_intake_incident('fallback-source:'||s.id::text||':unsupported',NULL,NULL,s.document_id,'input','unsupported_attachment_requires_review');
    RETURN jsonb_build_object('queued',false,'reason','requires_review','document_id',s.document_id,'source_id',s.id);
  END IF;
  IF NOT public.exam_fallback_source_in_scope(s.document_id) THEN
    RETURN jsonb_build_object('queued',false,'reason','source_excluded','document_id',s.document_id,'source_id',s.id);
  END IF;
  INSERT INTO public.exam_fallback_source_queue(source_id,document_id) VALUES(s.id,s.document_id) ON CONFLICT(source_id) DO NOTHING;
  SELECT * INTO STRICT q FROM public.exam_fallback_source_queue WHERE source_id=s.id;
  RETURN jsonb_build_object('queued',q.state<>'done','document_id',s.document_id,'source_id',s.id,'state',q.state);
END $$;

CREATE FUNCTION public.claim_exam_fallback_sources(p_worker text,p_limit integer DEFAULT 6)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb; cfg public.exam_fallback_configuration;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_worker IS NULL OR p_worker !~ '^fallback:[A-Za-z0-9_.:-]{1,140}$' OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'Invalid fallback source queue claim'; END IF;
  SELECT * INTO STRICT cfg FROM public.exam_fallback_configuration WHERE singleton;
  IF NOT cfg.enabled THEN RETURN jsonb_build_object('tasks','[]'::jsonb,'paused',true); END IF;
  UPDATE public.exam_fallback_source_queue SET state='pending',next_attempt_at=now()+interval '30 seconds',lease_token=NULL,lease_until=NULL,worker=NULL,last_error_code='source_lease_expired',updated_at=now()
    WHERE state='reserved' AND lease_until<=now();
  -- Excluded or already-dispatched canonical documents do not need another POST.
  -- Submitted/uncertain deliveries remain covered by the separate GET-only pass.
  WITH terminal AS (
    SELECT q.source_id FROM public.exam_fallback_source_queue q JOIN public.exam_document_source s ON s.id=q.source_id JOIN public.exam_document d ON d.id=s.document_id
    WHERE q.state='pending' AND (d.deletion_state IS NOT NULL OR d.identification_status='not_exam'
      OR EXISTS(SELECT 1 FROM public.exam_document_delivery g WHERE g.document_id=d.id AND g.destination='group' AND g.destination_key IN ('default',(SELECT group_destination_key FROM public.exam_document_configuration)) AND g.status IN ('sent','submitted','uncertain','waived')))
    ORDER BY q.created_at,q.source_id FOR UPDATE OF q SKIP LOCKED LIMIT 100
  ) UPDATE public.exam_fallback_source_queue q SET state='done',updated_at=now() FROM terminal t WHERE q.source_id=t.source_id;
  WITH eligible AS (
    SELECT q.source_id,s.document_id FROM public.exam_fallback_source_queue q JOIN public.exam_document_source s ON s.id=q.source_id JOIN public.exam_document d ON d.id=s.document_id
    WHERE q.state='pending' AND q.next_attempt_at<=now() AND public.exam_fallback_source_in_scope(d.id)
      AND s.received_at<=now()-make_interval(secs=>cfg.minimum_age_seconds)
      AND d.deletion_state IS NULL AND d.identification_status<>'not_exam'
    ORDER BY q.next_attempt_at,q.created_at,q.source_id FOR UPDATE OF q SKIP LOCKED LIMIT p_limit
  ), claimed AS (
    UPDATE public.exam_fallback_source_queue q SET state='reserved',document_id=e.document_id,worker=p_worker,lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',attempts=attempts+1,updated_at=now()
      FROM eligible e WHERE q.source_id=e.source_id RETURNING q.*
  ) SELECT COALESCE(jsonb_agg(to_jsonb(c)||jsonb_build_object('source',to_jsonb(s),'document',to_jsonb(d))),'[]'::jsonb) INTO result FROM claimed c JOIN public.exam_document_source s ON s.id=c.source_id JOIN public.exam_document d ON d.id=s.document_id;
  RETURN jsonb_build_object('tasks',result,'paused',false);
END $$;

CREATE FUNCTION public.finish_exam_fallback_source(p_source_id uuid,p_lease_token uuid,p_outcome text,p_error_code text DEFAULT NULL,p_retry_seconds integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q public.exam_fallback_source_queue; s public.exam_document_source; d public.exam_document; delay_seconds integer;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_outcome IS NULL OR p_outcome NOT IN ('retry','done') OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z][a-z0-9_]{0,95}$')
    OR (p_retry_seconds IS NOT NULL AND p_retry_seconds NOT BETWEEN 15 AND 900) THEN RAISE EXCEPTION 'Invalid fallback source outcome'; END IF;
  SELECT * INTO STRICT q FROM public.exam_fallback_source_queue WHERE source_id=p_source_id FOR UPDATE;
  IF q.state<>'reserved' OR q.lease_token IS DISTINCT FROM p_lease_token OR q.lease_until<=now() THEN RAISE EXCEPTION 'Fallback source queue fence expired' USING ERRCODE='PT409'; END IF;
  SELECT * INTO STRICT s FROM public.exam_document_source WHERE id=q.source_id;
  SELECT * INTO STRICT d FROM public.exam_document WHERE id=s.document_id;
  IF p_outcome='done' AND NOT (d.deletion_state IS NOT NULL OR d.identification_status='not_exam'
    OR EXISTS(SELECT 1 FROM public.exam_document_delivery g WHERE g.document_id=d.id AND g.destination='group' AND g.destination_key IN ('default',(SELECT group_destination_key FROM public.exam_document_configuration)) AND g.status IN ('sent','submitted','uncertain','waived'))) THEN
    RAISE EXCEPTION 'Fallback source is not terminal; preserve its retry';
  END IF;
  delay_seconds:=COALESCE(p_retry_seconds,CASE q.attempts WHEN 1 THEN 60 WHEN 2 THEN 300 ELSE 900 END);
  UPDATE public.exam_fallback_source_queue SET state=CASE WHEN p_outcome='done' THEN 'done' ELSE 'pending' END,
    document_id=d.id,next_attempt_at=CASE WHEN p_outcome='retry' THEN now()+make_interval(secs=>delay_seconds) ELSE next_attempt_at END,
    worker=NULL,lease_until=NULL,lease_token=NULL,last_error_code=p_error_code,updated_at=now() WHERE source_id=q.source_id;
  RETURN jsonb_build_object('recorded',true,'source_id',q.source_id,'document_id',d.id,'state',CASE WHEN p_outcome='done' THEN 'done' ELSE 'pending' END);
END $$;

ALTER TABLE public.exam_fallback_source_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.exam_fallback_source_queue FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.exam_fallback_source_queue TO service_role;

ALTER TABLE public.exam_fallback_runtime ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.exam_fallback_runtime FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.exam_fallback_runtime TO service_role;

ALTER TABLE public.exam_fallback_configuration ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_fallback_original ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.exam_fallback_configuration,public.exam_fallback_original FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.exam_fallback_configuration,public.exam_fallback_original TO service_role;
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('guard_exam_fallback_deletion','exam_fallback_source_in_scope','reserve_exam_fallback_original',
      'confirm_exam_fallback_original','exam_fallback_group_eligible','reserve_exam_fallback_group','begin_exam_fallback_group_dispatch',
      'valid_exam_fallback_scan','claim_exam_fallback_run','checkpoint_exam_fallback_run','list_exam_fallback_group_reconciliation','expire_exam_fallback_group_leases',
      'enqueue_exam_fallback_source','claim_exam_fallback_sources','finish_exam_fallback_source') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',item.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',item.signature);
  END LOOP;
END $$;
COMMIT;
