-- Daily pending-contact reminder. No activation, credential, contact or delivery replay.
-- All clocks/dates/destinations are server-owned. A grant to POST is consumed
-- before the external effect, and can never be issued again after that point.
BEGIN;

DO $$ BEGIN
  IF to_regclass('public.exam_document_responsibility') IS NULL
    OR to_regprocedure('public.exam_document_group_readiness(jsonb,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Estrutura de responsabilidade/grupo ausente; resumo não instalado';
  END IF;
END $$;

CREATE TABLE public.exam_pending_summary (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  summary_day date NOT NULL,
  destination_key text NOT NULL CHECK (length(trim(destination_key)) BETWEEN 1 AND 500),
  status text NOT NULL CHECK (status IN ('reserved','empty','blocked','started','submitted','sent','failed','uncertain')),
  worker text NOT NULL,
  lease_token uuid NOT NULL DEFAULT gen_random_uuid(),
  lease_until timestamptz NOT NULL,
  as_of timestamptz NOT NULL,
  total integer NOT NULL DEFAULT 0 CHECK (total>=0),
  documents jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(documents)='array' AND jsonb_array_length(documents)<=200),
  content_sha256 text CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  content_characters integer CHECK (content_characters BETWEEN 1 AND 12000),
  submit_started_at timestamptz,
  submitted_at timestamptz,
  sent_at timestamptz,
  external_id text,
  external_status text,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(summary_day,destination_key),
  CHECK ((submit_started_at IS NULL)=(status IN ('reserved','empty','blocked'))),
  CHECK ((submit_started_at IS NULL)=(content_sha256 IS NULL)),
  CHECK ((submit_started_at IS NULL)=(content_characters IS NULL)),
  CHECK (status='blocked' OR total=jsonb_array_length(documents)),
  CHECK (status<>'empty' OR total=0),
  CHECK (status<>'sent' OR (sent_at IS NOT NULL AND external_id IS NOT NULL))
);
CREATE TABLE public.exam_pending_summary_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  summary_id uuid NOT NULL REFERENCES public.exam_pending_summary(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(details)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.exam_pending_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_pending_summary_event ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.exam_pending_summary,public.exam_pending_summary_event FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.exam_pending_summary,public.exam_pending_summary_event TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.exam_pending_summary_event_id_seq TO service_role;

-- Isolated clock seam for offline SQL tests; no client clock/day override.
CREATE FUNCTION public.exam_pending_summary_clock()
RETURNS timestamptz LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$ SELECT statement_timestamp() $$;
REVOKE ALL ON FUNCTION public.exam_pending_summary_clock() FROM PUBLIC,anon,authenticated,service_role;

-- Same eligibility as the reviewed PENDENTES-01 snapshot. The guard returns no
-- partial documents when more than 200 qualify; the worker must HOLD explicitly.
CREATE FUNCTION public.exam_pending_summary_snapshot(p_as_of timestamptz,p_destination_key text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
WITH valid_documents AS MATERIALIZED (
  SELECT d.id,d.previous_document_id,d.pet_id,d.identification_status,d.extracted_data,d.confirmed_data
  FROM public.exam_document d
  WHERE d.canonical_document_id IS NULL AND d.file_status='saved'
    AND d.identification_status<>'not_exam' AND d.group_exception_reason IS NULL
    AND d.id<>'595e61de-fb0b-4cda-86bf-ebdce543b6fc'::uuid
    AND d.original_name !~* '^PAMVET[_ -]TESTE[_ -]EX[0-9]+([_ -]|$)'
    AND NOT EXISTS (SELECT 1 FROM public.exam_document_source s WHERE s.document_id=d.id AND (
      s.metadata->>'test_fixture'='true' OR s.metadata->>'synthetic_fixture'='true'
      OR s.metadata->>'homologation_fixture'='true' OR s.metadata->>'is_test'='true'
      OR s.metadata->>'fixture'='true' OR s.metadata->>'synthetic'='true'
      OR COALESCE(s.metadata->>'subject','') ~* '^PAMVET-TESTE-EX[0-9]+(-|$)'))
    AND NOT EXISTS (SELECT 1 FROM public.exam_document_event e WHERE e.document_id=d.id
      AND e.event_type IN ('homologation_fixture_preseeded','synthetic_fixture_created'))
), sent_to_group AS MATERIALIZED (
  SELECT t.document_id,min(t.sent_at) AS first_group_sent_at
  FROM public.exam_document_delivery t JOIN valid_documents d ON d.id=t.document_id
  WHERE p_destination_key IS NOT NULL AND t.destination='group'
    AND t.destination_key=p_destination_key AND t.status='sent'
    AND t.sent_at IS NOT NULL AND t.sent_at<=p_as_of AND NULLIF(trim(t.external_id),'') IS NOT NULL
  GROUP BY t.document_id
), open_documents AS MATERIALIZED (
  SELECT d.id AS document_id,sent.first_group_sent_at,fields.value->>'pet_name' AS pet_name,
    fields.value->>'client_name' AS client_name,fields.value->>'exam_type' AS exam_type,
    CASE WHEN r.source<>'conflict' AND NULLIF(trim(v.nome),'') IS NOT NULL THEN v.id END AS responsible_vet_id,
    CASE WHEN r.source<>'conflict' AND v.id IS NOT NULL AND NULLIF(trim(v.nome),'') IS NOT NULL THEN v.nome END AS responsible_vet_name,
    d.pet_id IS NULL AS patient_link_pending,stats.item_count,stats.pending_item_count,stats.pending_item_ids
  FROM valid_documents d JOIN sent_to_group sent ON sent.document_id=d.id
  LEFT JOIN public.exam_document_responsibility r ON r.document_id=d.id
  LEFT JOIN public.veterinarios v ON v.id=r.veterinarian_id
  CROSS JOIN LATERAL (SELECT public.exam_document_group_readiness(d.extracted_data,d.confirmed_data)->'fields' AS value) fields
  CROSS JOIN LATERAL (
    SELECT count(*) AS item_count,count(*) FILTER(WHERE di.contacted_at IS NULL) AS pending_item_count,
      COALESCE(jsonb_agg(di.exam_item_id ORDER BY di.exam_item_id) FILTER(WHERE di.contacted_at IS NULL),'[]'::jsonb) AS pending_item_ids
    FROM public.exam_document_item di WHERE di.document_id=d.id
  ) stats
  WHERE (stats.item_count=0 OR stats.pending_item_count>0)
    AND NOT EXISTS (
      SELECT 1 FROM valid_documents replacement
      JOIN sent_to_group replacement_sent ON replacement_sent.document_id=replacement.id
      WHERE replacement.previous_document_id=d.id AND d.pet_id IS NOT NULL
        AND replacement.pet_id=d.pet_id AND replacement.identification_status='confirmed'
    )
), totals AS (SELECT count(*) AS total FROM open_documents)
SELECT jsonb_build_object('as_of',p_as_of,'day',(p_as_of AT TIME ZONE 'America/Sao_Paulo')::date,
  'destination_key',p_destination_key,'configuration_ready',p_destination_key IS NOT NULL,
  'total',totals.total,'limit',200,'has_more',totals.total>200,
  'documents',CASE WHEN totals.total>200 THEN '[]'::jsonb ELSE COALESCE((
    SELECT jsonb_agg(jsonb_build_object('document_id',p.document_id,'pet_name',p.pet_name,'client_name',p.client_name,
      'exam_type',p.exam_type,'responsible_vet_id',p.responsible_vet_id,'responsible_vet_name',p.responsible_vet_name,
      'first_group_sent_at',p.first_group_sent_at,
      'age_seconds',greatest(0,floor(extract(epoch FROM p_as_of-p.first_group_sent_at)))::bigint,
      'patient_link_pending',p.patient_link_pending,'item_count',p.item_count,
      'pending_item_count',p.pending_item_count,'pending_item_ids',p.pending_item_ids)
      ORDER BY p.first_group_sent_at,p.document_id) FROM open_documents p),'[]'::jsonb) END)
FROM totals;
$$;
REVOKE ALL ON FUNCTION public.exam_pending_summary_snapshot(timestamptz,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.preview_exam_pending_summary()
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE destination text; snapshot jsonb;
BEGIN
  PERFORM public.require_exam_document_service();
  SELECT NULLIF(trim(group_destination_key),'') INTO destination FROM public.exam_document_configuration WHERE singleton;
  snapshot:=public.exam_pending_summary_snapshot(public.exam_pending_summary_clock(),destination);
  RETURN snapshot||jsonb_build_object('claimed',false,'dispatch_allowed',false,'preview',true);
END;
$$;

CREATE FUNCTION public.reserve_exam_pending_summary(p_worker text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE clock_at timestamptz:=public.exam_pending_summary_clock(); local_clock timestamp;
  cfg public.exam_document_configuration; run public.exam_pending_summary; snapshot jsonb;
  destination text; run_status text; reclaimed boolean:=false;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_worker IS NULL OR p_worker !~ '^[A-Za-z0-9_.:-]{1,96}$' THEN RAISE EXCEPTION 'SUMMARY_WORKER_INVALID' USING ERRCODE='22023'; END IF;
  local_clock:=clock_at AT TIME ZONE 'America/Sao_Paulo';
  IF local_clock::time<time '08:00' OR local_clock::time>=time '09:00' THEN
    RETURN jsonb_build_object('claimed',false,'reason','OUTSIDE_DAILY_WINDOW','day',local_clock::date);
  END IF;
  -- Config-before-ledger lock order is also used by begin. A changed destination
  -- cannot be advertised as the destination of an already reserved summary.
  SELECT * INTO cfg FROM public.exam_document_configuration WHERE singleton FOR SHARE;
  destination:=NULLIF(trim(cfg.group_destination_key),'');
  IF destination IS NULL OR NOT ('group'=ANY(cfg.enabled_destinations)) THEN
    RETURN jsonb_build_object('claimed',false,'reason','GROUP_CONFIGURATION_PAUSED','day',local_clock::date);
  END IF;
  INSERT INTO public.exam_pending_summary(summary_day,destination_key,status,worker,lease_until,as_of)
    VALUES(local_clock::date,destination,'reserved',p_worker,clock_at+interval '2 minutes',clock_at)
    ON CONFLICT(summary_day,destination_key) DO NOTHING RETURNING * INTO run;
  IF run.id IS NULL THEN
    SELECT * INTO STRICT run FROM public.exam_pending_summary
      WHERE summary_day=local_clock::date AND destination_key=destination FOR UPDATE;
    IF run.status<>'reserved' OR run.submit_started_at IS NOT NULL OR run.lease_until>clock_at THEN
      RETURN jsonb_build_object('claimed',false,'summary_id',run.id,'status',run.status,'reason','DAY_ALREADY_RESERVED',
        'day',run.summary_day,'destination_key',run.destination_key,'total',run.total);
    END IF;
    reclaimed:=true;
    UPDATE public.exam_pending_summary SET worker=p_worker,lease_token=gen_random_uuid(),
      lease_until=clock_at+interval '2 minutes',as_of=clock_at,updated_at=clock_at WHERE id=run.id RETURNING * INTO run;
  END IF;
  snapshot:=public.exam_pending_summary_snapshot(clock_at,destination);
  run_status:=CASE WHEN (snapshot->>'has_more')::boolean THEN 'blocked' WHEN (snapshot->>'total')::integer=0 THEN 'empty' ELSE 'reserved' END;
  UPDATE public.exam_pending_summary SET total=(snapshot->>'total')::integer,documents=snapshot->'documents',status=run_status,
    last_error_code=CASE WHEN run_status='blocked' THEN 'SUMMARY_DOCUMENT_LIMIT_EXCEEDED' END,updated_at=clock_at
    WHERE id=run.id RETURNING * INTO run;
  INSERT INTO public.exam_pending_summary_event(summary_id,event_type,details) VALUES(run.id,
    CASE WHEN reclaimed THEN 'reclaimed_before_dispatch' ELSE run_status END,jsonb_build_object('total',run.total,'day',run.summary_day));
  RETURN snapshot||jsonb_build_object('claimed',run_status='reserved','summary_id',run.id,'lease_token',
    CASE WHEN run_status='reserved' THEN run.lease_token END,'lease_until',run.lease_until,'status',run.status,
    'reason',CASE WHEN run_status='blocked' THEN 'SUMMARY_DOCUMENT_LIMIT_EXCEEDED' WHEN run_status='empty' THEN 'NO_PENDING_DOCUMENTS' END);
END;
$$;

CREATE FUNCTION public.begin_exam_pending_summary(p_summary_id uuid,p_lease_token uuid,p_destination_key text,p_content_sha256 text,p_content_characters integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE clock_at timestamptz:=public.exam_pending_summary_clock(); cfg public.exam_document_configuration; run public.exam_pending_summary; local_clock timestamp;
BEGIN
  PERFORM public.require_exam_document_service();
  SELECT * INTO cfg FROM public.exam_document_configuration WHERE singleton FOR SHARE;
  SELECT * INTO STRICT run FROM public.exam_pending_summary WHERE id=p_summary_id FOR UPDATE;
  IF run.lease_token IS DISTINCT FROM p_lease_token THEN RAISE EXCEPTION 'SUMMARY_LEASE_INVALID' USING ERRCODE='40001'; END IF;
  IF run.status<>'reserved' OR run.submit_started_at IS NOT NULL THEN
    RETURN jsonb_build_object('dispatch_allowed',false,'summary_id',run.id,'status',run.status,'reason','DISPATCH_ALREADY_CONSUMED');
  END IF;
  local_clock:=clock_at AT TIME ZONE 'America/Sao_Paulo';
  IF run.lease_until<=clock_at OR run.summary_day<>local_clock::date OR local_clock::time<time '08:00' OR local_clock::time>=time '09:00' THEN
    RAISE EXCEPTION 'SUMMARY_LEASE_EXPIRED' USING ERRCODE='40001';
  END IF;
  IF run.destination_key IS DISTINCT FROM NULLIF(trim(p_destination_key),'')
    OR run.destination_key IS DISTINCT FROM NULLIF(trim(cfg.group_destination_key),'')
    OR NOT ('group'=ANY(cfg.enabled_destinations)) THEN RAISE EXCEPTION 'SUMMARY_DESTINATION_CHANGED' USING ERRCODE='40001'; END IF;
  IF p_content_sha256 IS NULL OR p_content_sha256 !~ '^[a-f0-9]{64}$'
    OR p_content_characters IS NULL OR p_content_characters NOT BETWEEN 1 AND 12000
    OR run.total<1 OR run.total<>jsonb_array_length(run.documents) THEN
    RAISE EXCEPTION 'SUMMARY_CONTENT_INVALID' USING ERRCODE='22023';
  END IF;
  UPDATE public.exam_pending_summary SET status='started',submit_started_at=clock_at,content_sha256=p_content_sha256,
    content_characters=p_content_characters,updated_at=clock_at WHERE id=run.id;
  INSERT INTO public.exam_pending_summary_event(summary_id,event_type,details)
    VALUES(run.id,'submit_started',jsonb_build_object('content_sha256',p_content_sha256,'content_characters',p_content_characters));
  -- This is intentionally not an idempotent true: a lost acknowledgement holds.
  RETURN jsonb_build_object('dispatch_allowed',true,'summary_id',run.id,'destination_key',run.destination_key,'content_sha256',p_content_sha256);
END;
$$;

CREATE FUNCTION public.record_exam_pending_summary_result(p_summary_id uuid,p_lease_token uuid,p_outcome jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE clock_at timestamptz:=public.exam_pending_summary_clock(); run public.exam_pending_summary;
  kind text:=p_outcome->>'status'; external text:=NULLIF(trim(p_outcome->>'external_id'),''); provider_status text:=p_outcome->>'external_status';
  next_state text; safe_error text;
BEGIN
  PERFORM public.require_exam_document_service();
  IF jsonb_typeof(p_outcome) IS DISTINCT FROM 'object' OR kind IS NULL
    OR kind NOT IN ('created','sent','delivered','read','failed','uncertain') THEN RAISE EXCEPTION 'SUMMARY_OUTCOME_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO STRICT run FROM public.exam_pending_summary WHERE id=p_summary_id FOR UPDATE;
  IF run.lease_token IS DISTINCT FROM p_lease_token OR run.submit_started_at IS NULL
    OR p_outcome->>'content_sha256' IS DISTINCT FROM run.content_sha256 THEN RAISE EXCEPTION 'SUMMARY_RESULT_FENCE_INVALID' USING ERRCODE='40001'; END IF;
  IF external IS NOT NULL AND external !~ '^[1-9][0-9]{0,19}$' THEN RAISE EXCEPTION 'SUMMARY_EXTERNAL_ID_INVALID' USING ERRCODE='22023'; END IF;
  IF run.external_id IS NOT NULL AND external IS NOT NULL AND run.external_id<>external THEN RAISE EXCEPTION 'SUMMARY_EXTERNAL_ID_CONFLICT' USING ERRCODE='40001'; END IF;
  external:=COALESCE(run.external_id,external);
  IF kind IN ('created','sent','delivered','read') AND external IS NULL THEN RAISE EXCEPTION 'SUMMARY_EXTERNAL_ID_REQUIRED' USING ERRCODE='22023'; END IF;
  IF kind IN ('delivered','read') AND COALESCE(provider_status,'') NOT IN ('delivered','read') THEN RAISE EXCEPTION 'SUMMARY_DELIVERY_EVIDENCE_REQUIRED' USING ERRCODE='22023'; END IF;
  next_state:=CASE WHEN kind IN ('delivered','read') THEN 'sent' WHEN kind IN ('created','sent') THEN 'submitted' ELSE kind END;
  -- Never erase positive evidence because an older timeout/failure arrived later.
  IF run.status='sent' THEN next_state:='sent';
  ELSIF run.status IN ('submitted','failed') AND next_state='uncertain' THEN next_state:=run.status; END IF;
  safe_error:=CASE WHEN kind IN ('failed','uncertain') THEN CASE WHEN p_outcome->>'error_code' IN
    ('SUMMARY_POST_UNCERTAIN','SUMMARY_POST_FAILED','SUMMARY_PROVIDER_FAILED','SUMMARY_RESPONSE_INVALID','SUMMARY_ACK_UNCERTAIN')
    THEN p_outcome->>'error_code' ELSE 'SUMMARY_WORKER_ERROR' END END;
  IF provider_status IS NULL OR provider_status NOT IN ('created','pending','sent','delivered','read','failed') THEN provider_status:=NULL; END IF;
  UPDATE public.exam_pending_summary SET status=next_state,external_id=external,
    external_status=CASE WHEN run.status='sent' THEN run.external_status ELSE COALESCE(provider_status,run.external_status) END,
    submitted_at=CASE WHEN external IS NOT NULL THEN COALESCE(run.submitted_at,clock_at) ELSE run.submitted_at END,
    sent_at=CASE WHEN next_state='sent' THEN COALESCE(run.sent_at,clock_at) ELSE run.sent_at END,
    last_error_code=CASE WHEN next_state='sent' THEN NULL ELSE safe_error END,updated_at=clock_at WHERE id=run.id;
  INSERT INTO public.exam_pending_summary_event(summary_id,event_type,details) VALUES(run.id,'result_recorded',
    jsonb_build_object('status',next_state,'external_id',external,'external_status',provider_status,'error_code',safe_error,'late',run.lease_until<=clock_at));
  RETURN jsonb_build_object('summary_id',run.id,'status',next_state,'external_id',external,'dispatch_allowed',false,'retry_allowed',false);
END;
$$;

REVOKE ALL ON FUNCTION public.preview_exam_pending_summary(),public.reserve_exam_pending_summary(text),
  public.begin_exam_pending_summary(uuid,uuid,text,text,integer),public.record_exam_pending_summary_result(uuid,uuid,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.preview_exam_pending_summary(),public.reserve_exam_pending_summary(text),
  public.begin_exam_pending_summary(uuid,uuid,text,text,integer),public.record_exam_pending_summary_result(uuid,uuid,jsonb) TO service_role;
COMMIT;
