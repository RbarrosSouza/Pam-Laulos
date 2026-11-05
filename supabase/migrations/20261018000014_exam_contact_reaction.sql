-- Prospective contact-completion reaction on the ORIGINAL group delivery.
-- No activation/backfill, contact RPC change, PDF resend or message edit.
-- The provider endpoint TOGGLES reactions: consume permission before POST and
-- never automatically grant a second POST, even after timeout/failure/restart.
BEGIN;

CREATE TABLE public.exam_reaction_configuration (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL DEFAULT false,
  activation_cutoff timestamptz,
  chatwoot_actor_id bigint CHECK(chatwoot_actor_id>0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(NOT enabled OR (activation_cutoff IS NOT NULL AND chatwoot_actor_id IS NOT NULL))
);
INSERT INTO public.exam_reaction_configuration(singleton) VALUES(true);
CREATE TABLE public.exam_document_reaction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES public.exam_document_delivery(id) ON DELETE RESTRICT,
  document_id uuid NOT NULL REFERENCES public.exam_document(id) ON DELETE RESTRICT,
  destination_key text NOT NULL,
  external_message_id text NOT NULL CHECK(external_message_id ~ '^[1-9][0-9]{0,19}$'),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  emoji text NOT NULL DEFAULT '✅' CHECK(emoji='✅'),
  actor_id bigint NOT NULL CHECK(actor_id>0),
  contact_event_id bigint NOT NULL REFERENCES public.exam_document_event(id) ON DELETE RESTRICT,
  contact_saved_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','reserved','held','started','submitted','confirmed','uncertain','failed')),
  worker text,
  lease_token uuid,
  lease_until timestamptz,
  submit_started_at timestamptz,
  confirmed_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(delivery_id,emoji),
  UNIQUE(destination_key,external_message_id,emoji,actor_id),
  CHECK(status NOT IN ('reserved','held','started','submitted','uncertain','failed') OR (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK(status NOT IN ('started','submitted','uncertain','failed') OR submit_started_at IS NOT NULL),
  CHECK(status<>'confirmed' OR confirmed_at IS NOT NULL)
);
CREATE INDEX exam_document_reaction_queue_idx ON public.exam_document_reaction(status,updated_at);
CREATE TABLE public.exam_document_reaction_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reaction_id uuid NOT NULL REFERENCES public.exam_document_reaction(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(details)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.exam_reaction_configuration ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_document_reaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_document_reaction_event ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.exam_reaction_configuration,public.exam_document_reaction,public.exam_document_reaction_event FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.exam_reaction_configuration,public.exam_document_reaction,public.exam_document_reaction_event TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.exam_document_reaction_event_id_seq TO service_role;

CREATE FUNCTION public.exam_reaction_clock()
RETURNS timestamptz LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$ SELECT clock_timestamp() $$;
REVOKE ALL ON FUNCTION public.exam_reaction_clock() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.exam_contact_reaction_candidates(p_cutoff timestamptz,p_destination_key text,p_as_of timestamptz)
RETURNS TABLE(delivery_id uuid,document_id uuid,destination_key text,external_message_id text,sha256 text,
  contact_event_id bigint,contact_saved_at timestamptz,item_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT t.id,d.id,t.destination_key,t.external_id,d.sha256,event.id,event.created_at,stats.item_count
  FROM public.exam_document_delivery t JOIN public.exam_document d ON d.id=t.document_id
  CROSS JOIN LATERAL (
    SELECT count(*) AS item_count,bool_and(di.contacted_at IS NOT NULL) AS all_contacted
    FROM public.exam_document_item di WHERE di.document_id=d.id
  ) stats
  CROSS JOIN LATERAL (
    SELECT e.id,e.created_at FROM public.exam_document_event e
    WHERE e.document_id=d.id AND e.event_type='contact_recorded'
      AND e.created_at>=p_cutoff AND e.created_at<=p_as_of
    ORDER BY e.created_at DESC,e.id DESC LIMIT 1
  ) event
  WHERE p_cutoff IS NOT NULL AND p_destination_key IS NOT NULL
    AND t.destination='group' AND t.destination_key=p_destination_key AND t.status='sent'
    AND t.sent_at IS NOT NULL AND t.sent_at<=p_as_of AND t.external_id ~ '^[1-9][0-9]{0,19}$'
    -- Conflicting mappings of one provider message must never yield two toggles
    -- or a checkmark for only one of several ambiguously mapped documents.
    AND NOT EXISTS(SELECT 1 FROM public.exam_document_delivery other
      WHERE other.destination='group' AND other.destination_key=t.destination_key
        AND other.external_id=t.external_id AND other.id<>t.id)
    AND d.canonical_document_id IS NULL AND d.file_status='saved'
    AND d.identification_status<>'not_exam' AND d.group_exception_reason IS NULL
    AND stats.item_count>0 AND stats.all_contacted;
$$;
REVOKE ALL ON FUNCTION public.exam_contact_reaction_candidates(timestamptz,text,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.preview_exam_contact_reactions()
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cfg public.exam_reaction_configuration; destination text; as_of timestamptz:=public.exam_reaction_clock(); tasks jsonb; total bigint;
BEGIN
  PERFORM public.require_exam_document_service();
  SELECT * INTO STRICT cfg FROM public.exam_reaction_configuration WHERE singleton;
  SELECT NULLIF(trim(group_destination_key),'') INTO destination FROM public.exam_document_configuration WHERE singleton;
  SELECT count(*) INTO total FROM public.exam_contact_reaction_candidates(cfg.activation_cutoff,destination,as_of);
  SELECT COALESCE(jsonb_agg(to_jsonb(c)||jsonb_build_object('emoji','✅','actor_id',cfg.chatwoot_actor_id)),'[]') INTO tasks
    FROM (SELECT * FROM public.exam_contact_reaction_candidates(cfg.activation_cutoff,destination,as_of)
      ORDER BY contact_saved_at,delivery_id LIMIT 200) c;
  RETURN jsonb_build_object('enabled',cfg.enabled,'activation_cutoff',cfg.activation_cutoff,'actor_id',cfg.chatwoot_actor_id,
    'destination_key',destination,'as_of',as_of,'tasks',tasks,'eligible_total',total,'has_more',total>200,'dispatch_allowed',false,'preview',true);
END;
$$;

CREATE FUNCTION public.reserve_exam_contact_reactions(p_worker text,p_limit integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cfg public.exam_reaction_configuration; group_cfg public.exam_document_configuration;
  as_of timestamptz:=public.exam_reaction_clock(); destination text; task public.exam_document_reaction;
  tasks jsonb:='[]'; reconcile_tasks jsonb;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_worker IS NULL OR p_worker !~ '^[A-Za-z0-9_.:-]{1,96}$' OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'REACTION_RESERVATION_INVALID' USING ERRCODE='22023';
  END IF;
  -- Same lock order in begin and result; activation/destination cannot race the grant.
  SELECT * INTO STRICT cfg FROM public.exam_reaction_configuration WHERE singleton FOR SHARE;
  SELECT * INTO STRICT group_cfg FROM public.exam_document_configuration WHERE singleton FOR SHARE;
  destination:=NULLIF(trim(group_cfg.group_destination_key),'');
  IF NOT cfg.enabled OR cfg.activation_cutoff IS NULL OR cfg.chatwoot_actor_id IS NULL
    OR destination IS NULL OR NOT ('group'=ANY(group_cfg.enabled_destinations)) THEN
    RETURN jsonb_build_object('tasks','[]'::jsonb,'reconcile_tasks','[]'::jsonb,'paused',true);
  END IF;
  INSERT INTO public.exam_document_reaction(delivery_id,document_id,destination_key,external_message_id,sha256,actor_id,contact_event_id,contact_saved_at)
    SELECT c.delivery_id,c.document_id,c.destination_key,c.external_message_id,c.sha256,cfg.chatwoot_actor_id,c.contact_event_id,c.contact_saved_at
    FROM public.exam_contact_reaction_candidates(cfg.activation_cutoff,destination,as_of) c ORDER BY c.delivery_id
    ON CONFLICT DO NOTHING;
  FOR task IN
    SELECT o.* FROM public.exam_document_reaction o
    JOIN public.exam_contact_reaction_candidates(cfg.activation_cutoff,destination,as_of) c
      ON c.delivery_id=o.delivery_id AND c.document_id=o.document_id AND c.external_message_id=o.external_message_id AND c.sha256=o.sha256
    WHERE o.destination_key=destination AND o.actor_id=cfg.chatwoot_actor_id AND o.submit_started_at IS NULL
      AND (o.status='pending' OR (o.status='reserved' AND o.lease_until<=as_of))
    ORDER BY o.contact_saved_at,o.id FOR UPDATE OF o SKIP LOCKED LIMIT p_limit LOOP
    UPDATE public.exam_document_reaction SET status='reserved',worker=p_worker,lease_token=gen_random_uuid(),
      lease_until=as_of+interval '2 minutes',updated_at=as_of WHERE id=task.id RETURNING * INTO task;
    INSERT INTO public.exam_document_reaction_event(reaction_id,event_type) VALUES(task.id,'reserved');
    tasks:=tasks||jsonb_build_array(to_jsonb(task)||jsonb_build_object('reaction_id',task.id,'reconcile_only',false));
  END LOOP;
  -- Existing starts are reads only. A new lease or a negative GET never proves
  -- that the first toggle did not happen, so none of these rows can POST again.
  SELECT COALESCE(jsonb_agg(to_jsonb(o)||jsonb_build_object('reaction_id',o.id,'reconcile_only',true)),'[]') INTO reconcile_tasks
    FROM (SELECT * FROM public.exam_document_reaction WHERE destination_key=destination AND actor_id=cfg.chatwoot_actor_id
      AND ((submit_started_at IS NOT NULL AND status IN ('started','submitted','uncertain','failed')) OR status='held')
      ORDER BY updated_at,id LIMIT p_limit) o;
  RETURN jsonb_build_object('tasks',tasks,'reconcile_tasks',reconcile_tasks,'paused',false,'actor_id',cfg.chatwoot_actor_id,
    'activation_cutoff',cfg.activation_cutoff,'destination_key',destination);
END;
$$;

CREATE FUNCTION public.begin_exam_contact_reaction(p_reaction_id uuid,p_lease_token uuid,p_destination_key text,p_external_message_id text,p_emoji text,p_actor_id bigint)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cfg public.exam_reaction_configuration; group_cfg public.exam_document_configuration;
  as_of timestamptz:=public.exam_reaction_clock(); task public.exam_document_reaction;
BEGIN
  PERFORM public.require_exam_document_service();
  SELECT * INTO STRICT cfg FROM public.exam_reaction_configuration WHERE singleton FOR SHARE;
  SELECT * INTO STRICT group_cfg FROM public.exam_document_configuration WHERE singleton FOR SHARE;
  SELECT * INTO STRICT task FROM public.exam_document_reaction WHERE id=p_reaction_id FOR UPDATE;
  IF task.lease_token IS DISTINCT FROM p_lease_token THEN RAISE EXCEPTION 'REACTION_LEASE_INVALID' USING ERRCODE='40001'; END IF;
  IF task.status<>'reserved' OR task.submit_started_at IS NOT NULL THEN
    RETURN jsonb_build_object('dispatch_allowed',false,'reaction_id',task.id,'status',task.status,'reason','REACTION_DISPATCH_CONSUMED');
  END IF;
  IF task.lease_until<=as_of THEN RAISE EXCEPTION 'REACTION_LEASE_EXPIRED' USING ERRCODE='40001'; END IF;
  IF NOT cfg.enabled OR task.actor_id IS DISTINCT FROM cfg.chatwoot_actor_id OR task.actor_id IS DISTINCT FROM p_actor_id
    OR task.destination_key IS DISTINCT FROM NULLIF(trim(group_cfg.group_destination_key),'')
    OR task.destination_key IS DISTINCT FROM p_destination_key OR task.external_message_id IS DISTINCT FROM p_external_message_id
    OR task.emoji IS DISTINCT FROM p_emoji OR NOT ('group'=ANY(group_cfg.enabled_destinations)) THEN
    RAISE EXCEPTION 'REACTION_TARGET_CHANGED' USING ERRCODE='40001';
  END IF;
  PERFORM 1 FROM public.exam_document WHERE id=task.document_id FOR SHARE;
  -- Re-read the clock after potentially waiting on the contact/document lock.
  as_of:=public.exam_reaction_clock();
  IF task.lease_until<=as_of THEN RAISE EXCEPTION 'REACTION_LEASE_EXPIRED' USING ERRCODE='40001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.exam_contact_reaction_candidates(cfg.activation_cutoff,task.destination_key,as_of) c
    WHERE c.delivery_id=task.delivery_id AND c.document_id=task.document_id
      AND c.external_message_id=task.external_message_id AND c.sha256=task.sha256) THEN
    RAISE EXCEPTION 'REACTION_CONTACT_OR_ORIGINAL_CHANGED' USING ERRCODE='40001';
  END IF;
  UPDATE public.exam_document_reaction SET status='started',submit_started_at=as_of,updated_at=as_of WHERE id=task.id;
  INSERT INTO public.exam_document_reaction_event(reaction_id,event_type) VALUES(task.id,'submit_started');
  RETURN jsonb_build_object('dispatch_allowed',true,'reaction_id',task.id,'delivery_id',task.delivery_id,
    'document_id',task.document_id,'destination_key',task.destination_key,'external_message_id',task.external_message_id,
    'sha256',task.sha256,'emoji',task.emoji,'actor_id',task.actor_id);
END;
$$;

CREATE FUNCTION public.record_exam_contact_reaction_result(p_reaction_id uuid,p_lease_token uuid,p_outcome jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cfg public.exam_reaction_configuration; group_cfg public.exam_document_configuration;
  as_of timestamptz:=public.exam_reaction_clock(); task public.exam_document_reaction;
  kind text:=p_outcome->>'status'; next_state text; safe_error text;
BEGIN
  PERFORM public.require_exam_document_service();
  IF jsonb_typeof(p_outcome) IS DISTINCT FROM 'object' OR kind IS NULL OR kind NOT IN ('confirmed','already_present','submitted','failed','uncertain') THEN
    RAISE EXCEPTION 'REACTION_OUTCOME_INVALID' USING ERRCODE='22023';
  END IF;
  SELECT * INTO STRICT cfg FROM public.exam_reaction_configuration WHERE singleton FOR SHARE;
  SELECT * INTO STRICT group_cfg FROM public.exam_document_configuration WHERE singleton FOR SHARE;
  SELECT * INTO STRICT task FROM public.exam_document_reaction WHERE id=p_reaction_id FOR UPDATE;
  IF task.lease_token IS DISTINCT FROM p_lease_token OR task.external_message_id IS DISTINCT FROM p_outcome->>'external_message_id'
    OR task.emoji IS DISTINCT FROM p_outcome->>'emoji' OR task.actor_id::text IS DISTINCT FROM p_outcome->>'actor_id' THEN
    RAISE EXCEPTION 'REACTION_RESULT_FENCE_INVALID' USING ERRCODE='40001';
  END IF;
  IF kind IN ('confirmed','already_present') AND p_outcome->'own_reaction_verified' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'REACTION_OWN_EVIDENCE_REQUIRED' USING ERRCODE='22023';
  END IF;
  IF task.status='confirmed' THEN
    RETURN jsonb_build_object('reaction_id',task.id,'status','confirmed','dispatch_allowed',false,'retry_allowed',false);
  END IF;
  IF task.submit_started_at IS NULL THEN
    -- A GET proving our existing checkmark may complete without any toggle.
    -- Other pre-dispatch outcomes cannot pretend that a POST occurred.
    IF kind IN ('uncertain','failed') AND task.status IN ('reserved','held') THEN
      safe_error:=CASE WHEN p_outcome->>'error_code' IN ('REACTION_GET_FAILED','REACTION_TARGET_MISMATCH',
        'REACTION_IDENTITY_MISMATCH','REACTION_OWN_OTHER_EMOJI','REACTION_NOT_CONFIRMED')
        THEN p_outcome->>'error_code' ELSE 'REACTION_WORKER_ERROR' END;
      UPDATE public.exam_document_reaction SET status='held',last_error_code=safe_error,updated_at=as_of WHERE id=task.id;
      INSERT INTO public.exam_document_reaction_event(reaction_id,event_type,details)
        VALUES(task.id,'pre_dispatch_hold',jsonb_build_object('error_code',safe_error));
      RETURN jsonb_build_object('reaction_id',task.id,'status','held','dispatch_allowed',false,'retry_allowed',false);
    END IF;
    IF task.status NOT IN ('reserved','held') OR kind<>'already_present' OR (task.status='reserved' AND task.lease_until<=as_of) OR NOT cfg.enabled
      OR cfg.chatwoot_actor_id IS DISTINCT FROM task.actor_id OR task.destination_key IS DISTINCT FROM NULLIF(trim(group_cfg.group_destination_key),'')
      OR NOT ('group'=ANY(group_cfg.enabled_destinations)) THEN RAISE EXCEPTION 'REACTION_NOT_DISPATCHED' USING ERRCODE='40001'; END IF;
    PERFORM 1 FROM public.exam_document WHERE id=task.document_id FOR SHARE;
    IF NOT EXISTS(SELECT 1 FROM public.exam_contact_reaction_candidates(cfg.activation_cutoff,task.destination_key,as_of) c
      WHERE c.delivery_id=task.delivery_id AND c.external_message_id=task.external_message_id AND c.sha256=task.sha256) THEN
      RAISE EXCEPTION 'REACTION_CONTACT_OR_ORIGINAL_CHANGED' USING ERRCODE='40001';
    END IF;
  END IF;
  next_state:=CASE WHEN kind IN ('confirmed','already_present') THEN 'confirmed' ELSE kind END;
  IF task.status='confirmed' THEN next_state:='confirmed';
  ELSIF task.status IN ('submitted','failed') AND kind='uncertain' THEN next_state:=task.status; END IF;
  safe_error:=CASE WHEN kind IN ('failed','uncertain') THEN CASE WHEN p_outcome->>'error_code' IN
    ('REACTION_POST_UNCERTAIN','REACTION_POST_REJECTED','REACTION_POST_RESPONSE_MISMATCH','REACTION_GET_FAILED',
      'REACTION_TARGET_MISMATCH','REACTION_IDENTITY_MISMATCH','REACTION_OWN_OTHER_EMOJI','REACTION_NOT_CONFIRMED')
    THEN p_outcome->>'error_code' ELSE 'REACTION_WORKER_ERROR' END END;
  UPDATE public.exam_document_reaction SET status=next_state,confirmed_at=CASE WHEN next_state='confirmed' THEN COALESCE(confirmed_at,as_of) ELSE confirmed_at END,
    last_error_code=CASE WHEN next_state='confirmed' THEN NULL ELSE safe_error END,updated_at=as_of WHERE id=task.id;
  INSERT INTO public.exam_document_reaction_event(reaction_id,event_type,details) VALUES(task.id,'result_recorded',
    jsonb_build_object('status',next_state,'own_reaction_verified',p_outcome->'own_reaction_verified'='true'::jsonb,'error_code',safe_error,
      'late',task.lease_until<=as_of));
  RETURN jsonb_build_object('reaction_id',task.id,'status',next_state,'dispatch_allowed',false,'retry_allowed',false);
END;
$$;

REVOKE ALL ON FUNCTION public.preview_exam_contact_reactions(),public.reserve_exam_contact_reactions(text,integer),
  public.begin_exam_contact_reaction(uuid,uuid,text,text,text,bigint),public.record_exam_contact_reaction_result(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.preview_exam_contact_reactions(),public.reserve_exam_contact_reactions(text,integer),
  public.begin_exam_contact_reaction(uuid,uuid,text,text,text,bigint),public.record_exam_contact_reaction_result(uuid,uuid,jsonb) TO service_role;
COMMIT;
