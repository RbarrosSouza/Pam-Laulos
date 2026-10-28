BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

DO $$ BEGIN
  IF to_regclass('public.exam_intake_receipt') IS NULL
    OR to_regprocedure('public.record_exam_intake_event(uuid,uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Install intake migration 23 before resumable audit fences';
  END IF;
END $$;

-- Durable nonce journal contains token hashes only. It never exposes provider data or credentials.
CREATE TABLE public.exam_intake_resume_request (
  resume_request_id uuid PRIMARY KEY,
  sweep_id uuid NOT NULL REFERENCES public.exam_collection_sweep(id),
  collector_id text NOT NULL REFERENCES public.exam_collection_cursor(collector_id),
  scope_key text NOT NULL CHECK(scope_key ~ '^[a-f0-9]{64}$'),
  request_id uuid NOT NULL,
  previous_token_sha256 text NOT NULL CHECK(previous_token_sha256 ~ '^[a-f0-9]{64}$'),
  result_token_sha256 text NOT NULL CHECK(result_token_sha256 ~ '^[a-f0-9]{64}$'),
  ttl_seconds integer NOT NULL CHECK(ttl_seconds BETWEEN 60 AND 3600),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.exam_intake_resume_request ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.exam_intake_resume_request FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.exam_intake_resume_request TO service_role;

CREATE FUNCTION public.resume_exam_intake_sweep(
  p_collector_id text,p_scope_key text,p_request_id uuid,p_sweep_id uuid,p_run_token uuid,
  p_resume_request_id uuid,p_ttl_seconds integer DEFAULT 900
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cursor_row public.exam_collection_cursor; run public.exam_collection_sweep;
  request_row public.exam_intake_resume_request; next_token uuid; old_hash text; next_hash text; inserted uuid;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_collector_id IS NULL OR p_collector_id !~ '^[A-Za-z0-9_.:-]{1,96}$' OR p_scope_key IS NULL OR p_scope_key !~ '^[a-f0-9]{64}$'
    OR p_request_id IS NULL OR p_sweep_id IS NULL OR p_run_token IS NULL OR p_resume_request_id IS NULL
    OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 60 AND 3600 THEN
    RAISE EXCEPTION 'Invalid intake resume identity' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('exam_intake:'||p_collector_id,0));
  SELECT * INTO STRICT cursor_row FROM public.exam_collection_cursor WHERE collector_id=p_collector_id FOR UPDATE;
  SELECT * INTO STRICT run FROM public.exam_collection_sweep WHERE id=p_sweep_id FOR UPDATE;
  IF run.collector_id IS DISTINCT FROM p_collector_id OR cursor_row.scope_key IS DISTINCT FROM p_scope_key
    OR run.request_id IS DISTINCT FROM p_request_id OR run.expected_revision IS DISTINCT FROM cursor_row.revision
    OR run.intake_mode IS DISTINCT FROM 'audit' OR run.status IS DISTINCT FROM 'running' OR run.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'Intake resume scope or lifecycle mismatch' USING ERRCODE='40001';
  END IF;
  old_hash:=encode(sha256(convert_to(p_run_token::text,'UTF8')),'hex');
  SELECT * INTO request_row FROM public.exam_intake_resume_request WHERE resume_request_id=p_resume_request_id;
  IF FOUND THEN
    IF request_row.sweep_id<>run.id OR request_row.collector_id<>p_collector_id OR request_row.scope_key<>p_scope_key
      OR request_row.request_id<>p_request_id OR request_row.previous_token_sha256<>old_hash OR request_row.ttl_seconds<>p_ttl_seconds
      OR request_row.result_token_sha256<>encode(sha256(convert_to(run.intake_token::text,'UTF8')),'hex') THEN
      RAISE EXCEPTION 'Intake resume nonce identity or fence changed' USING ERRCODE='40001';
    END IF;
    IF run.expires_at<=now() THEN
      UPDATE public.exam_collection_sweep SET expires_at=now()+make_interval(secs=>request_row.ttl_seconds) WHERE id=run.id RETURNING * INTO run;
      UPDATE public.exam_intake_health SET heartbeat_at=now() WHERE collector_id=p_collector_id;
    END IF;
    RETURN jsonb_build_object('sweep_id',run.id,'run_token',run.intake_token,'mode','audit','resumed',true,'replayed',true,'expires_at',run.expires_at,
      'collector_id',run.collector_id,'scope_key',cursor_row.scope_key,'request_id',run.request_id,'received_from',run.received_from,'received_through',run.received_through);
  END IF;
  IF run.intake_token IS DISTINCT FROM p_run_token THEN
    RAISE EXCEPTION 'Intake resume fence changed' USING ERRCODE='40001';
  END IF;
  next_token:=gen_random_uuid();
  WHILE next_token=p_run_token LOOP next_token:=gen_random_uuid(); END LOOP;
  next_hash:=encode(sha256(convert_to(next_token::text,'UTF8')),'hex');
  INSERT INTO public.exam_intake_resume_request(resume_request_id,sweep_id,collector_id,scope_key,request_id,previous_token_sha256,result_token_sha256,ttl_seconds)
    VALUES(p_resume_request_id,run.id,p_collector_id,p_scope_key,p_request_id,old_hash,next_hash,p_ttl_seconds)
    ON CONFLICT DO NOTHING RETURNING resume_request_id INTO inserted;
  IF inserted IS NULL THEN RAISE EXCEPTION 'Intake resume nonce identity conflict' USING ERRCODE='40001'; END IF;
  INSERT INTO public.exam_collection_event(sweep_id,kind,metadata) VALUES(run.id,'intake_resumed',
    jsonb_build_object('resume_request_id',p_resume_request_id,'was_expired',run.expires_at<=now(),'token_rotated',true));
  UPDATE public.exam_collection_sweep SET intake_token=next_token,intake_lease_seconds=p_ttl_seconds,
    expires_at=now()+make_interval(secs=>p_ttl_seconds),event_count=event_count+1 WHERE id=run.id RETURNING * INTO run;
  -- A resume is a heartbeat, never processing progress or evidence of complete enumeration.
  UPDATE public.exam_intake_health SET heartbeat_at=now() WHERE collector_id=p_collector_id;
  RETURN jsonb_build_object('sweep_id',run.id,'run_token',run.intake_token,'mode','audit','resumed',true,'replayed',false,'expires_at',run.expires_at,
    'collector_id',run.collector_id,'scope_key',cursor_row.scope_key,'request_id',run.request_id,'received_from',run.received_from,'received_through',run.received_through);
END $$;

REVOKE ALL ON FUNCTION public.resume_exam_intake_sweep(text,text,uuid,uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.resume_exam_intake_sweep(text,text,uuid,uuid,uuid,uuid,integer) TO service_role;
COMMIT;
