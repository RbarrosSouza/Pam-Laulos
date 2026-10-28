BEGIN;

DO $$ BEGIN
  IF to_regclass('public.exam_collection_sweep') IS NULL OR to_regprocedure('public.require_exam_document_service()') IS NULL THEN
    RAISE EXCEPTION 'Install the existing document and collection schema before intake v2';
  END IF;
END $$;

ALTER TABLE public.exam_collection_sweep
  ADD COLUMN intake_mode text CHECK (intake_mode IN ('audit','operational')),
  ADD COLUMN intake_token uuid,
  ADD COLUMN intake_lease_seconds integer CHECK (intake_lease_seconds BETWEEN 60 AND 3600),
  ADD COLUMN intake_enumeration_complete boolean NOT NULL DEFAULT false,
  ADD COLUMN intake_expected_messages integer CHECK (intake_expected_messages>=0),
  ADD COLUMN intake_expected_pages integer CHECK (intake_expected_pages>=0),
  ADD COLUMN intake_counts jsonb;
ALTER TABLE public.exam_collection_message
  ADD COLUMN intake_received_at timestamptz,
  ADD COLUMN intake_manifest jsonb;

CREATE TABLE public.exam_intake_alert_configuration (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  destination_key text NOT NULL DEFAULT 'whatsapp_primary' CHECK (destination_key ~ '^[A-Za-z0-9_.:-]{1,96}$')
);
INSERT INTO public.exam_intake_alert_configuration(singleton) VALUES(true);

CREATE TABLE public.exam_intake_health (
  collector_id text PRIMARY KEY REFERENCES public.exam_collection_cursor(collector_id),
  provider text NOT NULL CHECK (provider IN ('gmail','outlook','chatwoot')),
  monitored boolean NOT NULL DEFAULT false,
  stale_after_seconds integer NOT NULL DEFAULT 900 CHECK (stale_after_seconds BETWEEN 60 AND 86400),
  last_started_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  progress_at timestamptz NOT NULL DEFAULT now(),
  last_finished_at timestamptz,
  last_success_at timestamptz,
  last_sweep_id uuid REFERENCES public.exam_collection_sweep(id)
);
CREATE TABLE public.exam_intake_page (
  sweep_id uuid NOT NULL REFERENCES public.exam_collection_sweep(id),
  partition_key text NOT NULL,
  page_key text NOT NULL CHECK (page_key ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  request_cursor_sha256 text CHECK (request_cursor_sha256 ~ '^[a-f0-9]{64}$'),
  next_cursor_sha256 text CHECK (next_cursor_sha256 ~ '^[a-f0-9]{64}$'),
  page_sha256 text NOT NULL CHECK (page_sha256 ~ '^[a-f0-9]{64}$'),
  message_ids jsonb NOT NULL CHECK (jsonb_typeof(message_ids)='array' AND jsonb_array_length(message_ids)<=100),
  is_terminal boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(sweep_id,partition_key,page_key)
);
CREATE TABLE public.exam_intake_receipt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collector_id text NOT NULL REFERENCES public.exam_collection_cursor(collector_id),
  partition_key text NOT NULL,
  message_id text NOT NULL,
  attachment_id text NOT NULL,
  artifact_kind text NOT NULL CHECK (artifact_kind IN ('attachment','download_link','notice')),
  relation_sha256 text CHECK (relation_sha256 ~ '^[a-f0-9]{64}$'),
  disposition text NOT NULL DEFAULT 'discovered' CHECK (disposition IN ('discovered','saved','pending','failed','excluded')),
  source_id uuid REFERENCES public.exam_document_source(id),
  document_id uuid REFERENCES public.exam_document(id),
  sha256 text CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint CHECK (size_bytes>0),
  reason_code text CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,95}$'),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(collector_id,message_id,attachment_id),
  CHECK (disposition<>'saved' OR (source_id IS NOT NULL AND document_id IS NOT NULL AND sha256 IS NOT NULL AND size_bytes IS NOT NULL))
);
ALTER TABLE public.exam_collection_origin ADD COLUMN intake_receipt_id uuid REFERENCES public.exam_intake_receipt(id),ADD COLUMN intake_outcome_recorded boolean NOT NULL DEFAULT false;

CREATE TABLE public.exam_intake_incident (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_key text NOT NULL UNIQUE,
  collector_id text REFERENCES public.exam_collection_cursor(collector_id),
  receipt_id uuid REFERENCES public.exam_intake_receipt(id),
  document_id uuid REFERENCES public.exam_document(id),
  stage text NOT NULL CHECK (stage ~ '^[a-z][a-z0-9_]{0,63}$'),
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{0,95}$'),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','acknowledged','resolved')),
  generation integer NOT NULL DEFAULT 1 CHECK (generation>0),
  occurrences integer NOT NULL DEFAULT 1 CHECK (occurrences>0),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES auth.users(id),
  resolved_at timestamptz
);
CREATE TABLE public.exam_intake_alert_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES public.exam_intake_incident(id),
  generation integer NOT NULL,
  channel text NOT NULL DEFAULT 'whatsapp' CHECK (channel='whatsapp'),
  destination_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('blocked','pending','reserved','started','submitted','sent','failed','uncertain','cancelled')),
  worker text,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  lease_token uuid,
  lease_until timestamptz,
  content_sha256 text CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  submit_started_at timestamptz,
  external_id text,
  external_status text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(incident_id,generation),
  CHECK (status<>'sent' OR external_id IS NOT NULL)
);

CREATE FUNCTION public.open_exam_intake_incident(p_key text,p_collector_id text,p_receipt_id uuid,p_document_id uuid,p_stage text,p_code text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE incident public.exam_intake_incident; cfg public.exam_intake_alert_configuration;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_key IS NULL OR length(p_key)>4096 OR p_key ~ '://|[[:cntrl:]]' OR p_stage !~ '^[a-z][a-z0-9_]{0,63}$' OR p_code !~ '^[a-z][a-z0-9_]{0,95}$' THEN RAISE EXCEPTION 'Invalid incident metadata'; END IF;
  INSERT INTO public.exam_intake_incident(incident_key,collector_id,receipt_id,document_id,stage,code)
    VALUES(p_key,p_collector_id,p_receipt_id,p_document_id,p_stage,p_code)
    ON CONFLICT(incident_key) DO UPDATE SET occurrences=exam_intake_incident.occurrences+1,last_seen_at=now(),
      generation=exam_intake_incident.generation+CASE WHEN exam_intake_incident.state='resolved' THEN 1 ELSE 0 END,
      state=CASE WHEN exam_intake_incident.state='resolved' THEN 'open' ELSE exam_intake_incident.state END,resolved_at=NULL
    RETURNING * INTO incident;
  SELECT * INTO STRICT cfg FROM public.exam_intake_alert_configuration WHERE singleton;
  INSERT INTO public.exam_intake_alert_outbox(incident_id,generation,destination_key,status)
    VALUES(incident.id,incident.generation,cfg.destination_key,CASE WHEN cfg.enabled THEN 'pending' ELSE 'blocked' END) ON CONFLICT DO NOTHING;
  RETURN incident.id;
END $$;

CREATE FUNCTION public.begin_exam_intake_sweep(p_collector_id text,p_scope_key text,p_scope_manifest jsonb,p_received_from timestamptz,p_received_through timestamptz,p_request_id uuid,p_mode text DEFAULT 'audit',p_ttl_seconds integer DEFAULT 900)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cursor_row public.exam_collection_cursor; run public.exam_collection_sweep;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_collector_id IS NULL OR p_collector_id !~ '^[A-Za-z0-9_.:-]{1,96}$' OR p_scope_key IS NULL OR p_scope_key !~ '^[a-f0-9]{64}$' OR p_request_id IS NULL OR p_mode NOT IN ('audit','operational') OR p_ttl_seconds NOT BETWEEN 60 AND 3600
    OR p_received_from IS NULL OR p_received_through IS NULL OR p_received_through<=p_received_from OR p_received_through>now() THEN RAISE EXCEPTION 'Invalid intake sweep'; END IF;
  IF jsonb_typeof(p_scope_manifest) IS DISTINCT FROM 'object' OR octet_length(p_scope_manifest::text)>4096 OR p_scope_manifest::text ~ '://|[\r\n]'
    OR (p_scope_manifest-ARRAY['provider','account_id','scope_kind','policy_version','sender_policy','include_spam_trash','include_deleted','initial_received_from','lookback_seconds'])<>'{}'::jsonb
    OR p_scope_manifest->>'provider' NOT IN ('gmail','outlook','chatwoot') OR NULLIF(p_scope_manifest->>'account_id','') IS NULL
    OR NULLIF(p_scope_manifest->>'scope_kind','') IS NULL OR p_scope_manifest->>'policy_version' IS DISTINCT FROM 'intake_v2'
    OR p_scope_manifest->>'sender_policy' IS DISTINCT FROM 'all' THEN RAISE EXCEPTION 'Explicit all-sender intake v2 scope is required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('exam_intake:'||p_collector_id,0));
  INSERT INTO public.exam_collection_cursor(collector_id,scope_key,scope_manifest) VALUES(p_collector_id,p_scope_key,p_scope_manifest) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT cursor_row FROM public.exam_collection_cursor WHERE collector_id=p_collector_id FOR UPDATE;
  IF cursor_row.scope_key<>p_scope_key OR cursor_row.scope_manifest<>p_scope_manifest THEN RAISE EXCEPTION 'Intake scope changed; use a separate explicit audit collector' USING ERRCODE='40001'; END IF;
  SELECT * INTO run FROM public.exam_collection_sweep WHERE collector_id=p_collector_id AND request_id=p_request_id;
  IF FOUND THEN
    IF run.intake_mode IS DISTINCT FROM p_mode OR run.received_from<>p_received_from OR run.received_through<>p_received_through THEN RAISE EXCEPTION 'Request ID reused with a different intake window' USING ERRCODE='40001'; END IF;
    RETURN jsonb_build_object('sweep_id',run.id,'run_token',run.intake_token,'mode',run.intake_mode,'replayed',true);
  END IF;
  SELECT * INTO run FROM public.exam_collection_sweep WHERE collector_id=p_collector_id AND status='running' FOR UPDATE;
  IF FOUND THEN
    IF run.expires_at>now() THEN RAISE EXCEPTION 'Another intake sweep is active' USING ERRCODE='40001'; END IF;
    UPDATE public.exam_collection_sweep SET status='failed',finished_at=now(),conclusive=false WHERE id=run.id;
    PERFORM public.open_exam_intake_incident('collector:'||p_collector_id||':expired',p_collector_id,NULL,NULL,'enumeration','sweep_expired');
  END IF;
  INSERT INTO public.exam_collection_sweep(collector_id,request_id,expected_revision,received_from,received_through,expires_at,intake_mode,intake_token,intake_lease_seconds)
    VALUES(p_collector_id,p_request_id,cursor_row.revision,p_received_from,p_received_through,now()+make_interval(secs=>p_ttl_seconds),p_mode,gen_random_uuid(),p_ttl_seconds) RETURNING * INTO run;
  INSERT INTO public.exam_intake_health(collector_id,provider,monitored,last_sweep_id) VALUES(p_collector_id,p_scope_manifest->>'provider',p_mode='operational',run.id)
    ON CONFLICT(collector_id) DO UPDATE SET monitored=exam_intake_health.monitored OR excluded.monitored,last_started_at=now(),heartbeat_at=now(),progress_at=now(),last_sweep_id=run.id;
  RETURN jsonb_build_object('sweep_id',run.id,'run_token',run.intake_token,'mode',run.intake_mode,'replayed',false);
END $$;

CREATE FUNCTION public.record_exam_intake_event(p_sweep_id uuid,p_run_token uuid,p_event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE run public.exam_collection_sweep; cursor_row public.exam_collection_cursor; kind text; partition text; message text; attachment text; spec jsonb; canonical_manifest jsonb;
  receipt public.exam_intake_receipt; origin public.exam_collection_origin; source_row public.exam_document_source; document_row public.exam_document; incident uuid; received timestamptz; item_count integer; previous_manifest jsonb; page public.exam_intake_page;
BEGIN
  PERFORM public.require_exam_document_service();
  SELECT * INTO STRICT run FROM public.exam_collection_sweep WHERE id=p_sweep_id FOR UPDATE;
  IF run.intake_token IS DISTINCT FROM p_run_token OR run.intake_mode IS NULL OR run.status<>'running' OR run.expires_at<=now() THEN RAISE EXCEPTION 'Intake sweep fence expired' USING ERRCODE='40001'; END IF;
  SELECT * INTO STRICT cursor_row FROM public.exam_collection_cursor WHERE collector_id=run.collector_id;
  IF jsonb_typeof(p_event) IS DISTINCT FROM 'object' OR octet_length(p_event::text)>262144 OR p_event::text ~ '://|[\r\n]'
    OR (p_event-ARRAY['kind','partition_key','message_id','received_at','origins','policy_code','attachment_id','disposition','source_id','document_id','stage','code','page_key','request_cursor_sha256','next_cursor_sha256','page_sha256','message_ids','is_terminal','expected_message_count','page_count'])<>'{}'::jsonb THEN RAISE EXCEPTION 'Sanitized intake metadata required'; END IF;
  kind:=p_event->>'kind'; partition:=COALESCE(p_event->>'partition_key','scope'); message:=p_event->>'message_id'; attachment:=p_event->>'attachment_id';
  IF length(partition) NOT BETWEEN 1 AND 2048 OR partition ~ '[[:cntrl:]]' OR (message IS NOT NULL AND (length(message) NOT BETWEEN 1 AND 2048 OR message ~ '[[:cntrl:]]')) THEN RAISE EXCEPTION 'Invalid intake identity'; END IF;
  IF kind='page_discovered' THEN
    IF jsonb_typeof(p_event->'message_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(p_event->'message_ids')>100 OR jsonb_typeof(p_event->'is_terminal') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Explicit page inventory required'; END IF;
    FOR spec IN SELECT value FROM jsonb_array_elements(p_event->'message_ids') LOOP
      IF jsonb_typeof(spec)<>'string' OR length(spec#>>'{}') NOT BETWEEN 1 AND 2048 OR (spec#>>'{}') ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'Invalid page message identity'; END IF;
    END LOOP;
    IF (SELECT count(*) FROM jsonb_array_elements(p_event->'message_ids'))<>(SELECT count(DISTINCT value) FROM jsonb_array_elements(p_event->'message_ids')) THEN RAISE EXCEPTION 'Repeated message in discovery page'; END IF;
    SELECT * INTO page FROM public.exam_intake_page WHERE sweep_id=run.id AND partition_key=partition AND page_key=p_event->>'page_key';
    IF FOUND THEN
      IF page.page_sha256 IS DISTINCT FROM p_event->>'page_sha256' OR page.message_ids IS DISTINCT FROM p_event->'message_ids' OR page.is_terminal IS DISTINCT FROM (p_event->>'is_terminal')::boolean OR page.request_cursor_sha256 IS DISTINCT FROM p_event->>'request_cursor_sha256' OR page.next_cursor_sha256 IS DISTINCT FROM p_event->>'next_cursor_sha256' THEN RAISE EXCEPTION 'Discovery page replay conflicts' USING ERRCODE='40001'; END IF;
    ELSE
      INSERT INTO public.exam_intake_page(sweep_id,partition_key,page_key,request_cursor_sha256,next_cursor_sha256,page_sha256,message_ids,is_terminal)
        VALUES(run.id,partition,p_event->>'page_key',p_event->>'request_cursor_sha256',p_event->>'next_cursor_sha256',p_event->>'page_sha256',p_event->'message_ids',(p_event->>'is_terminal')::boolean);
    END IF;
    FOR spec IN SELECT value FROM jsonb_array_elements(p_event->'message_ids') LOOP
      INSERT INTO public.exam_collection_message(sweep_id,folder_id,message_id) VALUES(run.id,partition,spec#>>'{}') ON CONFLICT DO NOTHING;
    END LOOP;
  ELSIF kind='message_discovered' THEN
    IF message IS NULL THEN RAISE EXCEPTION 'Message ID required'; END IF;
    received:=(p_event->>'received_at')::timestamptz;
    INSERT INTO public.exam_collection_message(sweep_id,folder_id,message_id,intake_received_at) VALUES(run.id,partition,message,received)
      ON CONFLICT(sweep_id,folder_id,message_id) DO UPDATE SET intake_received_at=COALESCE(exam_collection_message.intake_received_at,excluded.intake_received_at);
    IF received IS NOT NULL AND EXISTS(SELECT 1 FROM public.exam_collection_message WHERE sweep_id=run.id AND folder_id=partition AND message_id=message AND intake_received_at<>received) THEN RAISE EXCEPTION 'Message timestamp changed'; END IF;
  ELSIF kind='origins_declared' THEN
    IF message IS NULL OR jsonb_typeof(p_event->'origins') IS DISTINCT FROM 'array' OR jsonb_array_length(p_event->'origins')>200 THEN RAISE EXCEPTION 'Explicit per-message origin inventory required'; END IF;
    SELECT intake_manifest INTO previous_manifest FROM public.exam_collection_message WHERE sweep_id=run.id AND folder_id=partition AND message_id=message FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Discover message before origins'; END IF;
    FOR spec IN SELECT value FROM jsonb_array_elements(p_event->'origins') LOOP
      IF jsonb_typeof(spec)<>'object' OR (spec-ARRAY['attachment_id','artifact_kind','relation_sha256'])<>'{}'::jsonb OR length(COALESCE(spec->>'attachment_id','')) NOT BETWEEN 1 AND 2048 OR (spec->>'attachment_id') ~ '[[:cntrl:]]' OR spec->>'artifact_kind' NOT IN ('attachment','download_link','notice') THEN RAISE EXCEPTION 'Invalid origin manifest'; END IF;
    END LOOP;
    SELECT COALESCE(jsonb_agg(value ORDER BY value->>'attachment_id'),'[]') INTO canonical_manifest FROM jsonb_array_elements(p_event->'origins');
    item_count:=jsonb_array_length(canonical_manifest);
    IF item_count<>(SELECT count(DISTINCT value->>'attachment_id') FROM jsonb_array_elements(canonical_manifest)) OR (previous_manifest IS NOT NULL AND previous_manifest<>canonical_manifest) THEN RAISE EXCEPTION 'Origin manifest replay conflicts' USING ERRCODE='40001'; END IF;
    IF item_count=0 AND COALESCE(p_event->>'policy_code','') !~ '^[a-z][a-z0-9_]{0,95}$' THEN RAISE EXCEPTION 'Empty message needs an explicit exclusion policy'; END IF;
    UPDATE public.exam_collection_message SET intake_manifest=canonical_manifest,attachment_count=item_count,completed=item_count=0 WHERE sweep_id=run.id AND folder_id=partition AND message_id=message;
    FOR spec IN SELECT value FROM jsonb_array_elements(canonical_manifest) LOOP
      INSERT INTO public.exam_intake_receipt(collector_id,partition_key,message_id,attachment_id,artifact_kind,relation_sha256)
        VALUES(run.collector_id,partition,message,spec->>'attachment_id',spec->>'artifact_kind',spec->>'relation_sha256') ON CONFLICT DO NOTHING;
      SELECT * INTO STRICT receipt FROM public.exam_intake_receipt WHERE collector_id=run.collector_id AND message_id=message AND attachment_id=spec->>'attachment_id';
      IF receipt.artifact_kind<>spec->>'artifact_kind' OR receipt.relation_sha256 IS DISTINCT FROM spec->>'relation_sha256' THEN RAISE EXCEPTION 'Origin identity changed'; END IF;
      INSERT INTO public.exam_collection_origin(sweep_id,folder_id,message_id,attachment_id,intake_receipt_id) VALUES(run.id,partition,message,spec->>'attachment_id',receipt.id) ON CONFLICT DO NOTHING;
    END LOOP;
  ELSIF kind='origin_outcome' THEN
    SELECT * INTO STRICT origin FROM public.exam_collection_origin WHERE sweep_id=run.id AND folder_id=partition AND message_id=message AND attachment_id=attachment FOR UPDATE;
    SELECT * INTO STRICT receipt FROM public.exam_intake_receipt WHERE id=origin.intake_receipt_id FOR UPDATE;
    IF p_event->>'disposition' NOT IN ('saved','pending','failed','excluded') THEN RAISE EXCEPTION 'Invalid origin disposition'; END IF;
    IF receipt.disposition='saved' AND p_event->>'disposition'<>'saved' THEN RAISE EXCEPTION 'A preserved original cannot be degraded'; END IF;
    IF p_event->>'disposition'='saved' THEN
      SELECT * INTO STRICT source_row FROM public.exam_document_source WHERE id=(p_event->>'source_id')::uuid;
      SELECT * INTO STRICT document_row FROM public.exam_document WHERE id=source_row.document_id;
      IF source_row.account_id IS DISTINCT FROM cursor_row.scope_manifest->>'account_id' OR source_row.message_id<>message OR source_row.attachment_id<>attachment OR source_row.channel<>(CASE WHEN cursor_row.scope_manifest->>'provider'='chatwoot' THEN 'whatsapp' ELSE 'email' END)
        OR document_row.id::text IS DISTINCT FROM p_event->>'document_id' OR document_row.canonical_document_id IS NOT NULL OR document_row.file_status<>'saved' OR document_row.sha256 IS NULL OR document_row.size_bytes IS NULL OR document_row.drive_folder_id IS NULL
        OR (receipt.disposition='saved' AND (receipt.source_id<>source_row.id OR receipt.document_id<>document_row.id OR receipt.sha256<>document_row.sha256 OR receipt.size_bytes<>document_row.size_bytes)) THEN RAISE EXCEPTION 'Saved receipt does not match the immutable canonical source'; END IF;
      UPDATE public.exam_intake_receipt SET disposition='saved',source_id=source_row.id,document_id=document_row.id,sha256=document_row.sha256,size_bytes=document_row.size_bytes,reason_code=NULL,last_seen_at=now() WHERE id=receipt.id;
      UPDATE public.exam_collection_origin SET disposition='saved',source_id=source_row.id WHERE sweep_id=run.id AND folder_id=partition AND message_id=message AND attachment_id=attachment;
      UPDATE public.exam_intake_incident SET state='resolved',resolved_at=now() WHERE receipt_id=receipt.id AND state<>'resolved';
      UPDATE public.exam_intake_alert_outbox a SET status='cancelled',updated_at=now() FROM public.exam_intake_incident i WHERE a.incident_id=i.id AND i.receipt_id=receipt.id AND a.status IN ('pending','blocked','reserved') AND a.submit_started_at IS NULL;
    ELSE
      IF COALESCE(p_event->>'code','') !~ '^[a-z][a-z0-9_]{0,95}$' THEN RAISE EXCEPTION 'Origin outcome needs a controlled reason code'; END IF;
      UPDATE public.exam_intake_receipt SET disposition=p_event->>'disposition',reason_code=p_event->>'code',last_seen_at=now() WHERE id=receipt.id;
      IF p_event->>'disposition'='excluded' THEN
        UPDATE public.exam_collection_origin SET disposition='excluded' WHERE sweep_id=run.id AND folder_id=partition AND message_id=message AND attachment_id=attachment;
      ELSE
        incident:=public.open_exam_intake_incident('receipt:'||receipt.id||':'||COALESCE(p_event->>'stage','storage')||':'||(p_event->>'code'),run.collector_id,receipt.id,receipt.document_id,COALESCE(p_event->>'stage','storage'),p_event->>'code');
      END IF;
    END IF;
    UPDATE public.exam_collection_origin SET intake_outcome_recorded=true WHERE sweep_id=run.id AND folder_id=partition AND message_id=message AND attachment_id=attachment;
    UPDATE public.exam_collection_message m SET completed=NOT EXISTS(SELECT 1 FROM public.exam_collection_origin o JOIN public.exam_intake_receipt r ON r.id=o.intake_receipt_id WHERE o.sweep_id=m.sweep_id AND o.folder_id=m.folder_id AND o.message_id=m.message_id AND r.disposition='discovered') WHERE m.sweep_id=run.id AND m.folder_id=partition AND m.message_id=message;
  ELSIF kind='enumeration_complete' THEN
    IF COALESCE(p_event->>'expected_message_count','') !~ '^[0-9]{1,7}$' OR COALESCE(p_event->>'page_count','') !~ '^[0-9]{1,7}$' THEN RAISE EXCEPTION 'Explicit enumeration counts required'; END IF;
    UPDATE public.exam_collection_sweep SET intake_enumeration_complete=true,intake_expected_messages=(p_event->>'expected_message_count')::integer,intake_expected_pages=(p_event->>'page_count')::integer WHERE id=run.id;
  ELSIF kind='failure' THEN
    incident:=public.open_exam_intake_incident('collector:'||run.collector_id||':'||partition||':'||COALESCE(message,'')||':'||COALESCE(attachment,'')||':'||COALESCE(p_event->>'stage','enumeration')||':'||(p_event->>'code'),run.collector_id,NULL,NULL,COALESCE(p_event->>'stage','enumeration'),p_event->>'code');
  ELSIF kind='heartbeat' THEN NULL;
  ELSE RAISE EXCEPTION 'Unknown intake event'; END IF;
  INSERT INTO public.exam_collection_event(sweep_id,kind,metadata) VALUES(run.id,'intake_'||kind,jsonb_build_object('kind',kind,'partition_digest',md5(partition),'message_digest',md5(message),'attachment_digest',md5(attachment),'incident_id',incident));
  UPDATE public.exam_collection_sweep SET event_count=event_count+1,expires_at=now()+make_interval(secs=>run.intake_lease_seconds) WHERE id=run.id;
  UPDATE public.exam_intake_health SET heartbeat_at=now(),progress_at=CASE WHEN kind<>'heartbeat' THEN now() ELSE progress_at END WHERE collector_id=run.collector_id;
  RETURN jsonb_build_object('recorded',true,'sweep_id',run.id,'receipt_id',receipt.id,'incident_id',incident);
END $$;

CREATE FUNCTION public.finish_exam_intake_sweep(p_sweep_id uuid,p_run_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE run public.exam_collection_sweep; cursor_row public.exam_collection_cursor; messages integer; pages integer; undeclared integer; missing integer; failed integer; pending integer; saved integer; excluded integer; terminal_missing integer; run_failures integer; coverage boolean; all_preserved boolean; healthy boolean; counts jsonb; incident uuid;
BEGIN
  PERFORM public.require_exam_document_service();
  SELECT collector_id INTO cursor_row.collector_id FROM public.exam_collection_sweep WHERE id=p_sweep_id;
  SELECT * INTO STRICT cursor_row FROM public.exam_collection_cursor WHERE collector_id=cursor_row.collector_id FOR UPDATE;
  SELECT * INTO STRICT run FROM public.exam_collection_sweep WHERE id=p_sweep_id FOR UPDATE;
  IF run.intake_token IS DISTINCT FROM p_run_token OR run.intake_mode IS NULL THEN RAISE EXCEPTION 'Invalid intake finish fence'; END IF;
  IF run.status<>'running' THEN RETURN run.intake_counts; END IF;
  SELECT count(*),count(*) FILTER(WHERE intake_manifest IS NULL) INTO messages,undeclared FROM public.exam_collection_message WHERE sweep_id=run.id;
  SELECT count(*) INTO pages FROM public.exam_intake_page WHERE sweep_id=run.id;
  SELECT count(*) INTO terminal_missing FROM (SELECT partition_key FROM public.exam_intake_page WHERE sweep_id=run.id GROUP BY partition_key HAVING NOT bool_or(is_terminal)) partitions;
  SELECT count(*) FILTER(WHERE r.id IS NULL OR r.disposition='discovered' OR NOT o.intake_outcome_recorded),count(*) FILTER(WHERE r.disposition='failed'),count(*) FILTER(WHERE r.disposition='pending'),count(*) FILTER(WHERE r.disposition='saved' AND o.intake_outcome_recorded),count(*) FILTER(WHERE r.disposition='excluded' AND o.intake_outcome_recorded)
    INTO missing,failed,pending,saved,excluded FROM public.exam_collection_origin o LEFT JOIN public.exam_intake_receipt r ON r.id=o.intake_receipt_id WHERE o.sweep_id=run.id;
  coverage:=run.intake_enumeration_complete AND run.expires_at>now() AND run.intake_expected_messages=messages AND run.intake_expected_pages=pages AND pages>0 AND terminal_missing=0 AND undeclared=0 AND missing=0;
  all_preserved:=coverage AND failed=0 AND pending=0;
  SELECT count(*) INTO run_failures FROM public.exam_collection_event WHERE sweep_id=run.id AND kind='intake_failure';
  healthy:=all_preserved AND run_failures=0;
  counts:=jsonb_build_object('messages',messages,'pages',pages,'undeclared_messages',undeclared,'missing_receipts',missing,'saved',saved,'failed',failed,'pending',pending,'excluded',excluded,'run_failures',run_failures);
  IF NOT coverage THEN incident:=public.open_exam_intake_incident('collector:'||run.collector_id||':incomplete',run.collector_id,NULL,NULL,'enumeration','intake_coverage_incomplete'); END IF;
  IF healthy AND cursor_row.revision<>run.expected_revision THEN RAISE EXCEPTION 'Intake checkpoint changed concurrently' USING ERRCODE='40001'; END IF;
  IF healthy AND run.intake_mode='operational' THEN UPDATE public.exam_collection_cursor SET revision=revision+1,received_through=run.received_through,updated_at=now() WHERE collector_id=run.collector_id RETURNING * INTO cursor_row; END IF;
  counts:=jsonb_build_object('coverageComplete',coverage,'allPreserved',all_preserved,'scanFinished',healthy,'counts',counts,'checkpointAdvanced',healthy AND run.intake_mode='operational','alertDeliveryComplete',NOT EXISTS(SELECT 1 FROM public.exam_intake_alert_outbox a JOIN public.exam_intake_incident i ON i.id=a.incident_id WHERE i.collector_id=run.collector_id AND i.state<>'resolved' AND a.status NOT IN ('sent','cancelled')));
  UPDATE public.exam_collection_sweep SET status=CASE WHEN healthy THEN 'committed' ELSE 'failed' END,conclusive=coverage,finished_at=now(),committed_revision=CASE WHEN healthy THEN cursor_row.revision END,intake_counts=counts WHERE id=run.id;
  UPDATE public.exam_intake_health SET heartbeat_at=now(),progress_at=now(),last_finished_at=now(),last_success_at=CASE WHEN healthy THEN now() ELSE last_success_at END WHERE collector_id=run.collector_id;
  RETURN counts;
END $$;

CREATE FUNCTION public.check_exam_intake_pipeline_health()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE item public.exam_intake_health; overdue record; cfg public.exam_document_configuration; total integer:=0; receipts integer:=0; groups integer:=0;
BEGIN
  PERFORM public.require_exam_document_service();
  UPDATE public.exam_intake_incident i SET state='resolved',resolved_at=now() WHERE i.state<>'resolved' AND i.code='collector_heartbeat_stale' AND EXISTS(SELECT 1 FROM public.exam_intake_health h WHERE h.collector_id=i.collector_id AND (NOT h.monitored OR (h.heartbeat_at>=now()-make_interval(secs=>h.stale_after_seconds) AND h.progress_at>=now()-make_interval(secs=>h.stale_after_seconds))));
  UPDATE public.exam_intake_incident i SET state='resolved',resolved_at=now() WHERE i.state<>'resolved' AND i.code='receipt_processing_overdue' AND EXISTS(SELECT 1 FROM public.exam_intake_receipt r WHERE r.id=i.receipt_id AND r.disposition IN ('saved','excluded'));
  UPDATE public.exam_intake_incident i SET state='resolved',resolved_at=now() WHERE i.state<>'resolved' AND i.code='group_delivery_overdue' AND EXISTS(SELECT 1 FROM public.exam_document d WHERE d.id=i.document_id AND (d.identification_status='not_exam' OR d.group_exception_reason IS NOT NULL OR EXISTS(SELECT 1 FROM public.exam_document_delivery t WHERE t.document_id=d.id AND t.destination='group' AND t.status='sent')));
  FOR item IN SELECT * FROM public.exam_intake_health WHERE monitored AND (heartbeat_at<now()-make_interval(secs=>stale_after_seconds) OR progress_at<now()-make_interval(secs=>stale_after_seconds)) LOOP
    PERFORM public.open_exam_intake_incident('collector:'||item.collector_id||':heartbeat',item.collector_id,NULL,NULL,'health','collector_heartbeat_stale');total:=total+1;
  END LOOP;
  FOR overdue IN SELECT r.id,r.collector_id,r.document_id FROM public.exam_intake_receipt r WHERE r.disposition IN ('discovered','pending','failed') AND r.first_seen_at<now()-interval '10 minutes' LOOP
    PERFORM public.open_exam_intake_incident('receipt:'||overdue.id||':processing_overdue',overdue.collector_id,overdue.id,overdue.document_id,'processing','receipt_processing_overdue');receipts:=receipts+1;
  END LOOP;
  SELECT * INTO STRICT cfg FROM public.exam_document_configuration WHERE singleton;
  IF 'group'=ANY(cfg.enabled_destinations) AND cfg.notification_cutoff IS NOT NULL AND cfg.group_destination_key IS NOT NULL THEN
    FOR overdue IN SELECT d.id FROM public.exam_document d
      LEFT JOIN LATERAL (SELECT max(e.created_at) AS saved_at FROM public.exam_document_event e WHERE e.document_id=d.id AND e.event_type='file_saved') saved ON true
      LEFT JOIN LATERAL (SELECT min(t.created_at) AS created_at FROM public.exam_document_delivery t WHERE t.document_id=d.id AND t.destination='group') task ON true
      WHERE d.canonical_document_id IS NULL AND d.file_status='saved' AND d.identification_status<>'not_exam' AND d.group_exception_reason IS NULL AND d.received_at>=cfg.notification_cutoff
        AND greatest(COALESCE(saved.saved_at,d.created_at),COALESCE(task.created_at,d.created_at))<now()-interval '15 minutes'
        AND NOT EXISTS(SELECT 1 FROM public.exam_document_delivery t WHERE t.document_id=d.id AND t.destination='group' AND t.status IN ('sent','waived'))
        AND d.original_name !~* '^PAMVET[_ -]TESTE[_ -]EX[0-9]+([_ -]|$)'
        AND NOT EXISTS(SELECT 1 FROM public.exam_document_source s WHERE s.document_id=d.id AND (s.metadata->>'test_fixture'='true' OR s.metadata->>'synthetic_fixture'='true' OR s.metadata->>'homologation_fixture'='true' OR s.metadata->>'is_test'='true' OR s.metadata->>'fixture'='true' OR s.metadata->>'synthetic'='true' OR COALESCE(s.metadata->>'subject','') ~* '^PAMVET-TESTE-EX[0-9]+(-|$)'))
        AND NOT EXISTS(SELECT 1 FROM public.exam_document_event e WHERE e.document_id=d.id AND e.event_type IN ('homologation_fixture_preseeded','synthetic_fixture_created'))
    LOOP
      PERFORM public.open_exam_intake_incident('document:'||overdue.id||':group_overdue',NULL,NULL,overdue.id,'group','group_delivery_overdue');groups:=groups+1;
    END LOOP;
  END IF;
  UPDATE public.exam_intake_alert_outbox a SET status='cancelled',updated_at=now() FROM public.exam_intake_incident i WHERE i.id=a.incident_id AND i.state='resolved' AND a.status IN ('blocked','pending','reserved') AND a.submit_started_at IS NULL;
  RETURN jsonb_build_object('stale_collectors',total,'overdue_receipts',receipts,'overdue_group_documents',groups);
END $$;
CREATE FUNCTION public.check_exam_intake_health()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM public.require_exam_document_service();
  RETURN public.check_exam_intake_pipeline_health();
END $$;

CREATE FUNCTION public.reserve_exam_intake_alert(p_worker text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cfg public.exam_intake_alert_configuration; task public.exam_intake_alert_outbox;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_worker IS NULL OR p_worker !~ '^[A-Za-z0-9_.:-]{1,160}$' THEN RAISE EXCEPTION 'Valid alert worker required'; END IF;
  SELECT * INTO STRICT cfg FROM public.exam_intake_alert_configuration WHERE singleton;
  IF NOT cfg.enabled THEN RETURN jsonb_build_object('claimed',false,'paused',true); END IF;
  UPDATE public.exam_intake_alert_outbox SET status=CASE WHEN submit_started_at IS NULL THEN 'pending' ELSE 'uncertain' END,lease_until=NULL,error_code='alert_lease_expired',updated_at=now() WHERE status IN ('reserved','started') AND lease_until<=now();
  SELECT a.* INTO task FROM public.exam_intake_alert_outbox a JOIN public.exam_intake_incident i ON i.id=a.incident_id WHERE i.state<>'resolved' AND a.status IN ('pending','blocked','failed') AND a.attempts<a.max_attempts AND a.submit_started_at IS NULL ORDER BY a.created_at,a.id FOR UPDATE OF a SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('claimed',false,'paused',false); END IF;
  UPDATE public.exam_intake_alert_outbox SET status='reserved',worker=p_worker,attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',destination_key=cfg.destination_key,updated_at=now() WHERE id=task.id RETURNING * INTO task;
  RETURN jsonb_build_object('claimed',true,'alert',to_jsonb(task),'incident',(SELECT to_jsonb(i)-'incident_key' FROM public.exam_intake_incident i WHERE i.id=task.incident_id));
END $$;
CREATE FUNCTION public.begin_exam_intake_alert(p_alert_id uuid,p_lease_token uuid,p_destination_key text,p_content_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE task public.exam_intake_alert_outbox; cfg public.exam_intake_alert_configuration;
BEGIN
  PERFORM public.require_exam_document_service();
  SELECT * INTO STRICT cfg FROM public.exam_intake_alert_configuration WHERE singleton FOR UPDATE;
  SELECT * INTO STRICT task FROM public.exam_intake_alert_outbox WHERE id=p_alert_id FOR UPDATE;
  IF task.lease_token IS DISTINCT FROM p_lease_token OR task.status<>'reserved' OR task.submit_started_at IS NOT NULL OR task.lease_until<=now() OR NOT cfg.enabled OR task.destination_key IS DISTINCT FROM p_destination_key OR cfg.destination_key IS DISTINCT FROM p_destination_key OR p_content_sha256 IS NULL OR p_content_sha256 !~ '^[a-f0-9]{64}$' OR EXISTS(SELECT 1 FROM public.exam_intake_incident WHERE id=task.incident_id AND state='resolved') THEN RAISE EXCEPTION 'Alert dispatch fence invalid' USING ERRCODE='40001'; END IF;
  UPDATE public.exam_intake_alert_outbox SET status='started',content_sha256=p_content_sha256,submit_started_at=now(),updated_at=now() WHERE id=task.id;
  RETURN jsonb_build_object('dispatch_allowed',true,'alert_id',task.id,'destination_key',task.destination_key,'content_sha256',p_content_sha256);
END $$;
CREATE FUNCTION public.record_exam_intake_alert_result(p_alert_id uuid,p_lease_token uuid,p_outcome jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE task public.exam_intake_alert_outbox; observed text; next_status text;
BEGIN
  PERFORM public.require_exam_document_service();
  SELECT * INTO STRICT task FROM public.exam_intake_alert_outbox WHERE id=p_alert_id FOR UPDATE;
  observed:=p_outcome->>'status';
  IF task.lease_token IS DISTINCT FROM p_lease_token OR task.submit_started_at IS NULL OR p_outcome->>'content_sha256' IS DISTINCT FROM task.content_sha256 OR observed NOT IN ('created','sent','delivered','read','failed','uncertain') OR (p_outcome-ARRAY['status','content_sha256','external_id','error_code'])<>'{}'::jsonb THEN RAISE EXCEPTION 'Alert outcome fence invalid' USING ERRCODE='40001'; END IF;
  IF observed IN ('created','sent','delivered','read') AND NULLIF(p_outcome->>'external_id','') IS NULL THEN RAISE EXCEPTION 'Provider receipt required'; END IF;
  IF task.external_id IS NOT NULL AND p_outcome->>'external_id' IS NOT NULL AND task.external_id<>p_outcome->>'external_id' THEN RAISE EXCEPTION 'Provider alert identity changed'; END IF;
  next_status:=CASE WHEN observed IN ('delivered','read') THEN 'sent' WHEN observed IN ('created','sent') THEN 'submitted' ELSE observed END;
  IF task.status='sent' THEN next_status:='sent'; END IF;
  UPDATE public.exam_intake_alert_outbox SET status=next_status,external_id=COALESCE(external_id,NULLIF(p_outcome->>'external_id','')),external_status=CASE WHEN task.status='sent' THEN task.external_status ELSE observed END,error_code=CASE WHEN next_status IN ('failed','uncertain') THEN left(p_outcome->>'error_code',96) END,lease_until=NULL,updated_at=now() WHERE id=task.id RETURNING * INTO task;
  RETURN jsonb_build_object('alert_id',task.id,'status',task.status);
END $$;

CREATE FUNCTION public.get_exam_intake_panel(p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM public.require_exam_document_member();
  IF p_limit NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Invalid panel limit'; END IF;
  RETURN jsonb_build_object('as_of',now(),'collectors',COALESCE((SELECT jsonb_agg(to_jsonb(h)) FROM public.exam_intake_health h),'[]'),
    'incident_total',(SELECT count(*) FROM public.exam_intake_incident WHERE state<>'resolved'),'incident_has_more',(SELECT count(*)>p_limit FROM public.exam_intake_incident WHERE state<>'resolved'),
    'incidents',COALESCE((SELECT jsonb_agg(to_jsonb(i)-'incident_key') FROM (SELECT * FROM public.exam_intake_incident WHERE state<>'resolved' ORDER BY first_seen_at,id LIMIT p_limit) i),'[]'),
    'receipt_total',(SELECT count(*) FROM public.exam_intake_receipt),'receipt_has_more',(SELECT count(*)>p_limit FROM public.exam_intake_receipt),
    'receipts',COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM public.exam_intake_receipt ORDER BY last_seen_at DESC,id LIMIT p_limit) r),'[]'),
    'alerts',COALESCE((SELECT jsonb_agg(to_jsonb(a)-'lease_token'-'content_sha256') FROM (SELECT * FROM public.exam_intake_alert_outbox ORDER BY created_at DESC,id LIMIT p_limit) a),'[]'));
END $$;
CREATE FUNCTION public.get_exam_intake_worker_status()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE incidents bigint; pending_alerts bigint;
BEGIN
  PERFORM public.require_exam_document_service();
  SELECT count(*) INTO incidents FROM public.exam_intake_incident WHERE state<>'resolved';
  SELECT count(*) INTO pending_alerts FROM public.exam_intake_alert_outbox WHERE status NOT IN ('sent','cancelled');
  RETURN jsonb_build_object('contract','exam_intake_monitor_v1','as_of',now(),
    'collectors',COALESCE((SELECT jsonb_agg(jsonb_build_object('collector_id',h.collector_id,'provider',h.provider,'monitored',h.monitored,'heartbeat_at',h.heartbeat_at,'progress_at',h.progress_at,'last_success_at',h.last_success_at,'stale_after_seconds',h.stale_after_seconds)) FROM public.exam_intake_health h),'[]'),
    'open_incidents',incidents,'incident_total',incidents,'pending_alerts',pending_alerts,'pending_alert_total',pending_alerts);
END $$;
CREATE FUNCTION public.acknowledge_exam_intake_incident(p_incident_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor uuid; incident public.exam_intake_incident;
BEGIN
  actor:=public.require_exam_document_member();
  UPDATE public.exam_intake_incident SET state=CASE WHEN state='open' THEN 'acknowledged' ELSE state END,acknowledged_at=COALESCE(acknowledged_at,now()),acknowledged_by=COALESCE(acknowledged_by,actor) WHERE id=p_incident_id RETURNING * INTO STRICT incident;
  RETURN jsonb_build_object('incident_id',incident.id,'state',incident.state);
END $$;

DO $$ DECLARE name text; item regprocedure; BEGIN
  FOREACH name IN ARRAY ARRAY['exam_intake_alert_configuration','exam_intake_health','exam_intake_page','exam_intake_receipt','exam_intake_incident','exam_intake_alert_outbox'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',name);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON public.%I TO service_role',name);
  END LOOP;
  FOR item IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('open_exam_intake_incident','begin_exam_intake_sweep','record_exam_intake_event','finish_exam_intake_sweep','check_exam_intake_health','check_exam_intake_pipeline_health','reserve_exam_intake_alert','begin_exam_intake_alert','record_exam_intake_alert_result','get_exam_intake_panel','get_exam_intake_worker_status','acknowledge_exam_intake_incident') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',item);
    IF (SELECT proname FROM pg_proc WHERE oid=item) IN ('get_exam_intake_panel','acknowledge_exam_intake_incident') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',item);
    ELSE EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',item); END IF;
  END LOOP;
END $$;
COMMIT;
