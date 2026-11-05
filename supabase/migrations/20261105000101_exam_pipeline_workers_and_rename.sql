-- Durable bounded consumers. Events are wakeups, never the only work journal.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
CREATE TABLE public.exam_pipeline_configuration (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 enabled boolean NOT NULL DEFAULT false,
 n8n_base_url text CHECK(n8n_base_url IS NULL OR n8n_base_url ~ '^https://[A-Za-z0-9][A-Za-z0-9.-]+(:443)?$')
);
INSERT INTO public.exam_pipeline_configuration(singleton) VALUES(true);
ALTER TABLE public.exam_pipeline_configuration ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.exam_pipeline_configuration FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.exam_pipeline_configuration TO service_role;
CREATE FUNCTION public.get_exam_pipeline_wakeup_configuration() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM public.require_exam_document_service();
 RETURN (SELECT to_jsonb(c) FROM public.exam_pipeline_configuration c WHERE singleton);
END $$;

CREATE TABLE public.exam_pipeline_worker (
 stage text PRIMARY KEY CHECK(stage IN ('processing','group','reconcile','rename','nexus')),
 worker text, lease_token uuid, lease_until timestamptz,
 started_at timestamptz, finished_at timestamptz
);
INSERT INTO public.exam_pipeline_worker(stage) SELECT unnest(ARRAY['processing','group','reconcile','rename','nexus']);
ALTER TABLE public.exam_pipeline_worker ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.exam_pipeline_worker FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.exam_pipeline_worker TO service_role;
CREATE FUNCTION public.acquire_exam_pipeline_worker(p_stage text,p_worker text,p_lease_seconds integer DEFAULT 660) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE w public.exam_pipeline_worker;
BEGIN
 PERFORM public.require_exam_document_service();
 IF p_worker IS NULL OR p_worker !~ '^[A-Za-z0-9_.:-]{1,160}$' OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 60 AND 900 THEN RAISE EXCEPTION 'Invalid pipeline worker claim'; END IF;
 SELECT * INTO STRICT w FROM public.exam_pipeline_worker WHERE stage=p_stage FOR UPDATE;
 IF w.lease_until>now() THEN
   IF w.worker=p_worker THEN RETURN jsonb_build_object('claimed',true,'stage',w.stage,'lease_token',w.lease_token,'lease_until',w.lease_until,'already_claimed',true); END IF;
   RETURN jsonb_build_object('claimed',false,'reason','worker_active','stage',w.stage);
 END IF;
 IF p_stage IN ('processing','group','nexus') AND EXISTS(SELECT 1 FROM public.exam_document_delivery t JOIN public.exam_document d ON d.id=t.document_id
   WHERE t.destination=p_stage AND t.status='reserved' AND t.lease_until>now() AND COALESCE(t.worker,'') NOT LIKE 'fallback:%' AND t.worker IS DISTINCT FROM p_worker
     AND d.deletion_state IS NULL) THEN RETURN jsonb_build_object('claimed',false,'reason','legacy_worker_active','stage',p_stage); END IF;
 UPDATE public.exam_pipeline_worker SET worker=p_worker,lease_token=gen_random_uuid(),lease_until=now()+make_interval(secs=>p_lease_seconds),started_at=now(),finished_at=NULL
   WHERE stage=p_stage RETURNING * INTO w;
 RETURN jsonb_build_object('claimed',true,'stage',w.stage,'lease_token',w.lease_token,'lease_until',w.lease_until);
END $$;
CREATE FUNCTION public.release_exam_pipeline_worker(p_stage text,p_lease_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE w public.exam_pipeline_worker; more boolean:=false;
BEGIN
 PERFORM public.require_exam_document_service();
 SELECT * INTO STRICT w FROM public.exam_pipeline_worker WHERE stage=p_stage FOR UPDATE;
 IF w.lease_token IS DISTINCT FROM p_lease_token THEN RAISE EXCEPTION 'Pipeline worker fence changed' USING ERRCODE='PT409'; END IF;
 UPDATE public.exam_pipeline_worker SET lease_until=NULL,finished_at=now() WHERE stage=p_stage;
 IF p_stage IN ('processing','group','nexus') THEN
   SELECT EXISTS(SELECT 1 FROM public.exam_document_delivery t JOIN public.exam_document d ON d.id=t.document_id CROSS JOIN public.exam_document_configuration cfg
     WHERE t.destination=p_stage AND t.status IN ('pending','failed') AND t.attempts<t.max_attempts AND t.next_attempt_at<=now()
       AND p_stage=ANY(cfg.enabled_destinations) AND d.canonical_document_id IS NULL AND d.deletion_state IS NULL AND d.identification_status<>'not_exam' AND d.file_status='saved'
       AND (p_stage<>'group' OR (t.destination_key IN ('default',cfg.group_destination_key) AND public.exam_document_group_dispatch_snapshot(d.id)->'eligible'='true'::jsonb))
       AND (p_stage<>'nexus' OR (d.identification_status='confirmed' AND d.pet_id IS NOT NULL AND NULLIF(d.confirmed_data->>'exam_date','') IS NOT NULL))) INTO more;
 ELSIF p_stage='reconcile' THEN
   SELECT EXISTS(SELECT 1 FROM public.exam_document_delivery t JOIN public.exam_document d ON d.id=t.document_id CROSS JOIN public.exam_document_configuration cfg
     WHERE t.destination='group' AND t.status IN ('submitted','uncertain') AND t.next_attempt_at<=now() AND d.deletion_state IS NULL AND d.canonical_document_id IS NULL
       AND t.destination_key=cfg.group_destination_key AND 'group'=ANY(cfg.enabled_destinations)) INTO more;
 ELSIF p_stage='rename' THEN
   SELECT EXISTS(SELECT 1 FROM public.exam_document_rename q JOIN public.exam_document d ON d.id=q.document_id
     WHERE (q.status IN ('pending','failed') AND q.next_attempt_at<=now() OR q.status='reserved' AND q.lease_until<=now())
       AND d.deletion_state IS NULL AND d.canonical_document_id IS NULL AND d.identification_status<>'not_exam' AND d.file_status='saved' AND d.drive_file_id IS NOT NULL) INTO more;
 END IF;
 RETURN jsonb_build_object('released',true,'stage',p_stage,'has_more',more);
END $$;
CREATE FUNCTION public.require_exam_pipeline_worker(p_stage text,p_worker text,p_lease_token uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM public.require_exam_document_service();
 PERFORM 1 FROM public.exam_pipeline_worker WHERE stage=p_stage AND worker=p_worker AND lease_token=p_lease_token AND lease_until>now() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Pipeline worker lease invalid or expired' USING ERRCODE='PT409'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.require_exam_pipeline_worker(text,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.expire_exam_pipeline_tasks() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE candidate record; d public.exam_document; t public.exam_document_delivery; unstarted boolean; expired integer:=0;
BEGIN
 PERFORM public.require_exam_document_service();
 FOR candidate IN SELECT id,document_id FROM public.exam_document_delivery WHERE status='reserved' AND lease_until<=now() ORDER BY document_id,id LIMIT 100 LOOP
   SELECT * INTO STRICT d FROM public.exam_document WHERE id=candidate.document_id FOR NO KEY UPDATE;
   SELECT * INTO STRICT t FROM public.exam_document_delivery WHERE id=candidate.id FOR UPDATE;
   IF d.deletion_state IS NOT NULL OR t.status<>'reserved' OR t.lease_until IS NULL OR t.lease_until>now() THEN CONTINUE; END IF;
   unstarted:=t.destination='group' AND (t.worker LIKE 'fallback:%' OR EXISTS(SELECT 1 FROM public.exam_document_event e
     WHERE e.document_id=d.id AND e.event_type='primary_pipeline_reserved' AND e.details->>'delivery_id'=t.id::text AND e.details->>'lease_token'=t.lease_token::text))
     AND NOT EXISTS(SELECT 1 FROM public.exam_document_event e WHERE e.document_id=d.id AND e.event_type IN ('primary_group_dispatch_started','fallback_group_dispatch_started')
       AND e.details->>'delivery_id'=t.id::text AND e.details->>'lease_token'=t.lease_token::text);
   UPDATE public.exam_document_delivery SET status=CASE WHEN destination<>'group' OR unstarted THEN 'pending' ELSE 'uncertain' END,
     worker=CASE WHEN unstarted THEN NULL ELSE worker END,lease_token=CASE WHEN unstarted THEN NULL ELSE lease_token END,
     lease_until=NULL,next_attempt_at=CASE WHEN unstarted THEN now() ELSE next_attempt_at END,
     attempts=CASE WHEN unstarted THEN greatest(attempts-1,0) ELSE attempts END,
     last_error=CASE WHEN unstarted THEN 'Pre-submit lease expired without dispatch grant' ELSE 'Lease expired; reconcile external effect before retry' END,updated_at=now()
     WHERE id=t.id;
   PERFORM public.log_exam_document(d.id,'lease_expired',jsonb_build_object('delivery_id',t.id,'destination',t.destination,'dispatch_unstarted',unstarted));
   expired:=expired+1;
 END LOOP;
 RETURN expired;
END $$;
REVOKE ALL ON FUNCTION public.expire_exam_pipeline_tasks() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.reserve_exam_pipeline_tasks(p_destination text,p_worker text,p_worker_lease_token uuid,p_limit integer DEFAULT 1) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb; item jsonb;
BEGIN
 PERFORM public.require_exam_pipeline_worker(p_destination,p_worker,p_worker_lease_token);
 IF p_destination NOT IN ('processing','group','nexus') OR p_limit IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'Pipeline tasks are reserved just in time'; END IF;
 PERFORM public.expire_exam_pipeline_tasks();
 result:=public.reserve_exam_document_delivery(p_destination,p_worker,1);
 FOR item IN SELECT value FROM jsonb_array_elements(result->'tasks') LOOP
   PERFORM public.log_exam_document((item->>'document_id')::uuid,'primary_pipeline_reserved',jsonb_build_object('delivery_id',item->>'id','lease_token',item->>'lease_token','stage',p_destination));
 END LOOP;
 RETURN result;
END $$;
CREATE FUNCTION public.list_exam_pipeline_group_reconciliation(p_worker text,p_worker_lease_token uuid,p_limit integer DEFAULT 4) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb:='[]'; candidate record; d public.exam_document; t public.exam_document_delivery; cfg public.exam_document_configuration;
BEGIN
 PERFORM public.require_exam_pipeline_worker('reconcile',p_worker,p_worker_lease_token);
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 4 THEN RAISE EXCEPTION 'Invalid pipeline reconciliation limit'; END IF;
 PERFORM public.expire_exam_pipeline_tasks();
 SELECT * INTO STRICT cfg FROM public.exam_document_configuration;
 -- Pick by due priority, then lock documents before deliveries, in document
 -- order. The delivery deletion guard also reads the document; delivery-first
 -- locking can otherwise deadlock with begin_exam_document_deletion.
 FOR candidate IN WITH due AS MATERIALIZED (
   SELECT task.id,task.document_id FROM public.exam_document_delivery task JOIN public.exam_document doc ON doc.id=task.document_id
   WHERE task.destination='group' AND task.status IN ('submitted','uncertain') AND task.next_attempt_at<=now()
     AND doc.deletion_state IS NULL AND doc.canonical_document_id IS NULL AND task.destination_key=cfg.group_destination_key
     AND 'group'=ANY(cfg.enabled_destinations)
   ORDER BY task.next_attempt_at,task.updated_at,task.id LIMIT p_limit
 ) SELECT * FROM due ORDER BY document_id,id LOOP
   SELECT * INTO d FROM public.exam_document WHERE id=candidate.document_id FOR NO KEY UPDATE;
   IF NOT FOUND THEN CONTINUE; END IF;
   SELECT * INTO t FROM public.exam_document_delivery WHERE id=candidate.id FOR UPDATE;
   IF NOT FOUND THEN CONTINUE; END IF;
   IF d.deletion_state IS NOT NULL OR d.canonical_document_id IS NOT NULL OR t.destination<>'group'
     OR t.status NOT IN ('submitted','uncertain') OR t.next_attempt_at>now() OR t.destination_key IS DISTINCT FROM cfg.group_destination_key
     OR NOT ('group'=ANY(cfg.enabled_destinations)) THEN CONTINUE; END IF;
   UPDATE public.exam_document_delivery SET next_attempt_at=now()+interval '1 minute' WHERE id=t.id RETURNING * INTO t;
   result:=result||jsonb_build_array(to_jsonb(t)||jsonb_build_object('document',to_jsonb(d),'configured_destination',t.destination_key));
 END LOOP;
 RETURN jsonb_build_object('tasks',result);
END $$;
-- All legacy reconcilers must understand protocol-2 claims. Old claims remain
-- conservative: lack of a durable dispatch fence is never proof of no POST.
DO $patch$
DECLARE definition text; marker text;
BEGIN
 definition:=pg_get_functiondef('public.reserve_exam_document_delivery(text,text,integer)'::regprocedure);
 marker:=$old$SELECT * INTO STRICT v_config FROM public.exam_document_configuration;$old$;
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'Review legacy worker reservation before pipeline migration'; END IF;
 definition:=replace(definition,marker,$new$PERFORM 1 FROM public.exam_pipeline_worker WHERE stage=p_destination FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.exam_pipeline_worker WHERE stage=p_destination AND lease_until>now() AND worker IS DISTINCT FROM p_worker) THEN
    RETURN jsonb_build_object('tasks','[]'::jsonb,'paused',false,'reason','worker_active');
  END IF;
  $new$||marker);
 EXECUTE definition;
 definition:=pg_get_functiondef('public.reconcile_exam_document_tasks()'::regprocedure);
 marker:=$old$FOR v_task IN SELECT * FROM public.exam_document_delivery WHERE status='reserved' AND lease_until<=now() FOR UPDATE SKIP LOCKED LOOP
    UPDATE public.exam_document_delivery SET status=CASE WHEN destination='group' THEN 'uncertain' ELSE 'pending' END,
      last_error='Reserva expirou; reconciliar efeito externo antes de repetir',lease_until=NULL,updated_at=now() WHERE id=v_task.id;
    PERFORM public.log_exam_document(v_task.document_id,'lease_expired',jsonb_build_object('delivery_id',v_task.id,'destination',v_task.destination));
    v_count:=v_count+1;
  END LOOP;$old$;
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'Review current task reconciliation before pipeline migration'; END IF;
 EXECUTE replace(definition,marker,'v_count:=public.expire_exam_pipeline_tasks();');
 -- The fallback expiry can run first. Treat a protocol-2 primary unstarted
 -- claim exactly like its own unstarted claims, preserving old unknown claims.
 definition:=pg_get_functiondef('public.expire_exam_fallback_group_leases(uuid)'::regprocedure);
 marker:=$old$t.worker ~ '^fallback:' AND NOT EXISTS$old$;
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'Review fallback expiry before pipeline migration'; END IF;
 definition:=replace(definition,marker,$new$(t.worker ~ '^fallback:' OR EXISTS(SELECT 1 FROM public.exam_document_event p
   WHERE p.document_id=d.id AND p.event_type='primary_pipeline_reserved' AND p.details->>'delivery_id'=t.id::text AND p.details->>'lease_token'=t.lease_token::text)) AND NOT EXISTS$new$);
 definition:=replace(definition,$old$e.event_type='fallback_group_dispatch_started'$old$,$new$e.event_type IN ('fallback_group_dispatch_started','primary_group_dispatch_started')$new$);
 EXECUTE definition;
END $patch$;

CREATE TABLE public.exam_document_rename (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 document_id uuid NOT NULL UNIQUE REFERENCES public.exam_document(id) ON DELETE CASCADE,
 revision bigint NOT NULL DEFAULT 1,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','reserved','completed','failed','cancelled')),
 worker text,lease_token uuid,lease_until timestamptz,attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 desired_name text, reserved_name text, reserved_revision bigint,reserved_document_version bigint,
 drive_file_id text,dispatch_started_at timestamptz,applied_at timestamptz,last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX exam_document_rename_queue_idx ON public.exam_document_rename(status,next_attempt_at);
ALTER TABLE public.exam_document_rename ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.exam_document_rename FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.exam_document_rename TO service_role;
-- Deletion can cancel queued/pre-POST renames, but not race a granted external
-- PATCH. The short lease expires safely beyond the worker's HTTP timeout.
CREATE FUNCTION public.guard_exam_document_rename_deletion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.deletion_state IS NOT NULL AND OLD.deletion_state IS NULL THEN
   PERFORM 1 FROM public.exam_document_rename WHERE document_id=NEW.id AND status='reserved'
     AND dispatch_started_at IS NOT NULL AND lease_until>now() FOR UPDATE;
   IF FOUND THEN RAISE EXCEPTION 'Renomeação do original em andamento; aguarde a conclusão antes de excluir' USING ERRCODE='PT409'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_exam_document_rename_deletion() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_exam_document_rename_deletion BEFORE UPDATE OF deletion_state ON public.exam_document FOR EACH ROW EXECUTE FUNCTION public.guard_exam_document_rename_deletion();

CREATE FUNCTION public.queue_exam_document_rename() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.deletion_state IS NOT NULL OR NEW.canonical_document_id IS NOT NULL OR NEW.identification_status='not_exam' THEN
   DELETE FROM public.exam_document_rename WHERE document_id=NEW.id;
 ELSIF NEW.file_status='saved' AND NEW.drive_file_id IS NOT NULL AND NEW.extractor_version IS NOT NULL
   AND (NEW.extracted_data IS DISTINCT FROM OLD.extracted_data OR NEW.confirmed_data IS DISTINCT FROM OLD.confirmed_data OR NEW.extractor_version IS DISTINCT FROM OLD.extractor_version) THEN
   INSERT INTO public.exam_document_rename(document_id,drive_file_id) VALUES(NEW.id,NEW.drive_file_id)
   ON CONFLICT(document_id) DO UPDATE SET revision=exam_document_rename.revision+1,
     status=CASE WHEN exam_document_rename.status='reserved' THEN 'reserved' ELSE 'pending' END,
     attempts=CASE WHEN exam_document_rename.status='reserved' THEN exam_document_rename.attempts ELSE 0 END,
     next_attempt_at=now(),desired_name=NULL,drive_file_id=NEW.drive_file_id,last_error=NULL,updated_at=now();
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.queue_exam_document_rename() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER queue_exam_document_rename AFTER UPDATE ON public.exam_document FOR EACH ROW EXECUTE FUNCTION public.queue_exam_document_rename();
DO $patch$
DECLARE definition text; marker text;
BEGIN
 definition:=pg_get_functiondef('public.update_exam_document_extraction(uuid,jsonb)'::regprocedure);
 marker:=$old$drive_name=COALESCE(p_extraction->>'drive_name',drive_name)$old$;
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'Review extraction physical filename before pipeline migration'; END IF;
 EXECUTE replace(definition,marker,'drive_name=drive_name');
END $patch$;

CREATE FUNCTION public.reserve_exam_document_rename(p_worker text,p_worker_lease_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE candidate record; d public.exam_document; r public.exam_document_rename;
BEGIN
 PERFORM public.require_exam_pipeline_worker('rename',p_worker,p_worker_lease_token);
 FOR candidate IN SELECT q.id,q.document_id FROM public.exam_document_rename q JOIN public.exam_document doc ON doc.id=q.document_id
   WHERE (q.status IN ('pending','failed') AND q.next_attempt_at<=now() OR q.status='reserved' AND q.lease_until<=now())
     AND doc.deletion_state IS NULL AND doc.canonical_document_id IS NULL AND doc.identification_status<>'not_exam'
     AND doc.file_status='saved' AND doc.drive_file_id IS NOT NULL
   ORDER BY q.next_attempt_at,q.created_at LIMIT 10 LOOP
   SELECT * INTO STRICT d FROM public.exam_document WHERE id=candidate.document_id FOR NO KEY UPDATE;
   SELECT * INTO STRICT r FROM public.exam_document_rename WHERE id=candidate.id FOR UPDATE;
   IF NOT (r.status IN ('pending','failed') AND r.next_attempt_at<=now() OR r.status='reserved' AND r.lease_until<=now())
     OR d.deletion_state IS NOT NULL OR d.canonical_document_id IS NOT NULL OR d.identification_status='not_exam' OR d.file_status<>'saved' THEN CONTINUE; END IF;
   UPDATE public.exam_document_rename SET status='reserved',worker=p_worker,lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',
     attempts=attempts+1,reserved_revision=revision,reserved_document_version=d.version,reserved_name=NULL,dispatch_started_at=NULL,drive_file_id=d.drive_file_id,updated_at=now()
     WHERE id=r.id RETURNING * INTO r;
   RETURN jsonb_build_object('tasks',jsonb_build_array(to_jsonb(r)||jsonb_build_object('document',to_jsonb(d)||public.exam_document_responsibility_fields(d.id),'document_version',d.version,'desired_revision',r.revision)));
 END LOOP;
 RETURN jsonb_build_object('tasks','[]'::jsonb);
END $$;
CREATE FUNCTION public.prepare_exam_document_rename(p_delivery_id uuid,p_lease_token uuid,p_document_version bigint,p_name text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.exam_document; r public.exam_document_rename; doc_id uuid;
BEGIN
 PERFORM public.require_exam_document_service();
 IF p_name IS NULL OR length(p_name) NOT BETWEEN 5 AND 1024 OR p_name !~* '[.]pdf$' OR p_name ~ '[[:cntrl:]/\\]' THEN RAISE EXCEPTION 'Invalid rename filename'; END IF;
 SELECT document_id INTO STRICT doc_id FROM public.exam_document_rename WHERE id=p_delivery_id;
 SELECT * INTO STRICT d FROM public.exam_document WHERE id=doc_id FOR NO KEY UPDATE;
 SELECT * INTO STRICT r FROM public.exam_document_rename WHERE id=p_delivery_id FOR UPDATE;
 IF r.status<>'reserved' OR r.lease_token IS DISTINCT FROM p_lease_token OR r.lease_until IS NULL OR r.lease_until<=now() THEN RAISE EXCEPTION 'Rename lease invalid or expired' USING ERRCODE='PT409'; END IF;
 IF r.dispatch_started_at IS NOT NULL THEN RETURN jsonb_build_object('dispatch_allowed',false,'reason','rename_already_started'); END IF;
 IF d.deletion_state IS NOT NULL OR d.canonical_document_id IS NOT NULL OR d.identification_status='not_exam' OR d.file_status<>'saved'
   OR d.drive_file_id IS DISTINCT FROM r.drive_file_id OR d.version IS DISTINCT FROM p_document_version OR r.reserved_revision IS DISTINCT FROM r.revision THEN
   UPDATE public.exam_document_rename SET status=CASE WHEN d.deletion_state IS NOT NULL OR d.identification_status='not_exam' THEN 'cancelled' ELSE 'pending' END,
     lease_until=NULL,next_attempt_at=now()+interval '1 minute',updated_at=now() WHERE id=r.id;
   RETURN jsonb_build_object('dispatch_allowed',false,'reason','rename_document_changed');
 END IF;
 UPDATE public.exam_document_rename SET desired_name=p_name,reserved_name=p_name,reserved_document_version=d.version,dispatch_started_at=now(),updated_at=now() WHERE id=r.id;
 RETURN jsonb_build_object('dispatch_allowed',true,'delivery_id',r.id,'drive_file_id',r.drive_file_id,'name',p_name);
END $$;
CREATE FUNCTION public.complete_exam_document_rename(p_delivery_id uuid,p_lease_token uuid,p_outcome jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.exam_document; r public.exam_document_rename; doc_id uuid; changed boolean;
BEGIN
 PERFORM public.require_exam_document_service();
 SELECT document_id INTO STRICT doc_id FROM public.exam_document_rename WHERE id=p_delivery_id;
 SELECT * INTO STRICT d FROM public.exam_document WHERE id=doc_id FOR NO KEY UPDATE;
 SELECT * INTO STRICT r FROM public.exam_document_rename WHERE id=p_delivery_id FOR UPDATE;
 IF r.lease_token IS DISTINCT FROM p_lease_token OR r.status<>'reserved' OR r.lease_until IS NULL OR r.lease_until<=now() THEN RAISE EXCEPTION 'Rename result fence invalid or expired' USING ERRCODE='PT409'; END IF;
 IF p_outcome->>'status'='completed' THEN
   IF r.dispatch_started_at IS NULL OR p_outcome->>'drive_file_id' IS DISTINCT FROM r.drive_file_id OR p_outcome->>'name' IS DISTINCT FROM r.reserved_name THEN RAISE EXCEPTION 'Rename provider receipt mismatch'; END IF;
   changed:=d.version IS DISTINCT FROM r.reserved_document_version OR r.revision IS DISTINCT FROM r.reserved_revision;
   IF d.deletion_state IS NULL AND d.drive_file_id=r.drive_file_id THEN UPDATE public.exam_document SET drive_name=r.reserved_name WHERE id=d.id; END IF;
   UPDATE public.exam_document_rename SET status=CASE WHEN d.deletion_state IS NOT NULL OR d.identification_status='not_exam' THEN 'cancelled' WHEN changed THEN 'pending' ELSE 'completed' END,
     applied_at=now(),lease_until=NULL,next_attempt_at=now(),last_error=NULL,updated_at=now() WHERE id=r.id RETURNING * INTO r;
   PERFORM public.log_exam_document(d.id,'drive_rename_applied',jsonb_build_object('rename_id',r.id,'revision',r.reserved_revision,'current_revision',r.revision,'name',r.reserved_name,'superseded',changed));
   RETURN jsonb_build_object('applied',true,'task',to_jsonb(r));
 ELSIF p_outcome->>'status'='failed' THEN
   UPDATE public.exam_document_rename SET status='failed',lease_until=NULL,next_attempt_at=now()+make_interval(secs=>least(3600,60*(2^least(attempts-1,6))::integer)),
     last_error=left(COALESCE(p_outcome->>'error','rename_failed'),1000),updated_at=now() WHERE id=r.id RETURNING * INTO r;
   RETURN jsonb_build_object('applied',false,'task',to_jsonb(r));
 END IF;
 RAISE EXCEPTION 'Invalid rename outcome';
END $$;

REVOKE ALL ON FUNCTION public.get_exam_pipeline_wakeup_configuration(), public.acquire_exam_pipeline_worker(text,text,integer),
 public.release_exam_pipeline_worker(text,uuid), public.reserve_exam_pipeline_tasks(text,text,uuid,integer),
 public.list_exam_pipeline_group_reconciliation(text,uuid,integer), public.reserve_exam_document_rename(text,uuid),
 public.prepare_exam_document_rename(uuid,uuid,bigint,text), public.complete_exam_document_rename(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_exam_pipeline_wakeup_configuration(), public.acquire_exam_pipeline_worker(text,text,integer),
 public.release_exam_pipeline_worker(text,uuid), public.reserve_exam_pipeline_tasks(text,text,uuid,integer),
 public.list_exam_pipeline_group_reconciliation(text,uuid,integer), public.reserve_exam_document_rename(text,uuid),
 public.prepare_exam_document_rename(uuid,uuid,bigint,text), public.complete_exam_document_rename(uuid,uuid,jsonb) TO service_role;
COMMIT;
