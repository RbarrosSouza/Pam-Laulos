-- Independent bounded dispatch/reconciliation lanes for the contact checkmark.
-- The legacy provider endpoint toggles; new dispatch uses atomic ensure.
-- A consumed dispatch grant is NEVER reset or retried.
-- No contact, delivery, activation, recipient or existing reaction is rewritten.
BEGIN;

CREATE OR REPLACE FUNCTION public.exam_contact_reaction_safe_error(p_code text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN p_code=ANY(ARRAY[
  'REACTION_ACTOR_ACCOUNT_MISMATCH','REACTION_API_RESPONSE_INVALID','REACTION_CONFIGURATION_INVALID','REACTION_CREDENTIAL_ACTOR_MISMATCH',
  'REACTION_DIAGNOSTIC_READ_ONLY','REACTION_DISPATCH_PERMISSION_INVALID','REACTION_DUPLICATE_TARGET','REACTION_ENSURE_CONFLICT',
  'REACTION_ENSURE_RESPONSE_INVALID','REACTION_ENSURE_UNCERTAIN','REACTION_EXISTING_SUPPORT_CHOICE','REACTION_GET_FAILED',
  'REACTION_GROUP_IDENTITY_MISMATCH','REACTION_HTTP_429','REACTION_HTTP_4XX','REACTION_HTTP_5XX',
  'REACTION_HTTP_TIMEOUT','REACTION_IDENTITY_MISMATCH','REACTION_LEASE_TOO_SHORT','REACTION_MESSAGE_DESTINATION_MISMATCH',
  'REACTION_MESSAGE_ID_INVALID','REACTION_MESSAGE_INVALID','REACTION_MESSAGE_ORDER_INVALID','REACTION_MESSAGE_PAGE_INVALID',
  'REACTION_MESSAGE_SCAN_INCOMPLETE','REACTION_MESSAGE_TARGET_INVALID','REACTION_NEW_QUEUE_HAS_RECONCILIATIONS','REACTION_NOT_CONFIRMED',
  'REACTION_NOT_OBSERVED_NO_RETRY','REACTION_ORIGINAL_CHANGED','REACTION_ORIGINAL_CORRELATION_MISMATCH','REACTION_ORIGINAL_MESSAGE_UNPROVEN',
  'REACTION_ORIGINAL_NOT_FOUND','REACTION_OWN_OTHER_EMOJI','REACTION_PARENT_IDENTITY_MISMATCH','REACTION_POST_REJECTED',
  'REACTION_POST_RESPONSE_MISMATCH','REACTION_POST_UNCERTAIN','REACTION_POST_WITHOUT_PERMISSION','REACTION_PREFLIGHT_BUDGET_EXHAUSTED',
  'REACTION_PREVIOUS_SUPPORT_REMOVAL','REACTION_PROVIDER_CONTRACT_INVALID','REACTION_PROVIDER_CONTRACT_MISMATCH','REACTION_PROVIDER_HELD',
  'REACTION_PROVIDER_PRESENT_UNPROVEN','REACTION_PROVIDER_STATE_INVALID','REACTION_READ_FAILED','REACTION_RESERVATION_INVALID',
  'REACTION_TARGET_MISMATCH','REACTION_TASK_IDENTITY_MISMATCH','REACTION_TASK_LIMIT_EXCEEDED','REACTION_TASK_LIST_INVALID',
  'REACTION_TRANSPORT_FAILED','REACTION_WORKER_ERROR'])
 THEN p_code ELSE 'REACTION_WORKER_ERROR' END
$$;
CREATE OR REPLACE FUNCTION public.exam_contact_reaction_transient(p_code text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(p_code=ANY(ARRAY['REACTION_GET_FAILED','REACTION_READ_FAILED','REACTION_HTTP_TIMEOUT',
  'REACTION_TRANSPORT_FAILED','REACTION_HTTP_5XX','REACTION_HTTP_429',
  'REACTION_PREFLIGHT_BUDGET_EXHAUSTED','REACTION_LEASE_TOO_SHORT']),false)
$$;
CREATE OR REPLACE FUNCTION public.exam_contact_reaction_backoff(p_attempt integer)
RETURNS interval LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT make_interval(secs=>LEAST(3600,60*power(2,LEAST(GREATEST(COALESCE(p_attempt,1)-1,0),6)))::integer)
$$;
ALTER TABLE public.exam_document_reaction
 ADD COLUMN dispatch_retryable boolean NOT NULL DEFAULT false,
 ADD COLUMN dispatch_attempts integer NOT NULL DEFAULT 0 CHECK(dispatch_attempts>=0),
 ADD COLUMN dispatch_next_attempt_at timestamptz,
 ADD COLUMN reconcile_attempts integer NOT NULL DEFAULT 0 CHECK(reconcile_attempts>=0),
 ADD COLUMN reconcile_next_attempt_at timestamptz,
 ADD COLUMN reconcile_claim_token uuid,
 ADD COLUMN reconcile_claim_until timestamptz;
CREATE INDEX exam_reaction_event_target_idx ON public.exam_document_reaction_event(reaction_id,event_type);
CREATE INDEX exam_reaction_dispatch_due_idx ON public.exam_document_reaction(dispatch_attempts,dispatch_next_attempt_at,contact_saved_at)
 WHERE submit_started_at IS NULL AND status IN ('pending','reserved','held');
CREATE INDEX exam_reaction_reconcile_due_idx ON public.exam_document_reaction(reconcile_next_attempt_at,reconcile_claim_until,updated_at)
 WHERE status IN ('started','submitted','uncertain','failed','held');

CREATE OR REPLACE FUNCTION public.exam_contact_reaction_candidates(p_cutoff timestamptz,p_destination_key text,p_as_of timestamptz)
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
    AND d.canonical_document_id IS NULL AND d.deletion_state IS NULL AND d.file_status='saved'
    AND d.identification_status<>'not_exam' AND d.group_exception_reason IS NULL
    AND stats.item_count>0 AND stats.all_contacted;
$$;

CREATE OR REPLACE FUNCTION public.reserve_exam_contact_reactions(p_worker text,p_limit integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cfg public.exam_reaction_configuration; group_cfg public.exam_document_configuration;
  as_of timestamptz:=public.exam_reaction_clock(); destination text; task public.exam_document_reaction;
  tasks jsonb:='[]';
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_worker IS NULL OR p_worker !~ '^[A-Za-z0-9_.:-]{1,96}$' OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5 THEN
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
  INSERT INTO public.exam_document_reaction(delivery_id,document_id,destination_key,external_message_id,sha256,actor_id,contact_event_id,contact_saved_at,created_at,updated_at)
    SELECT c.delivery_id,c.document_id,c.destination_key,c.external_message_id,c.sha256,cfg.chatwoot_actor_id,c.contact_event_id,c.contact_saved_at,as_of,as_of
    FROM public.exam_contact_reaction_candidates(cfg.activation_cutoff,destination,as_of) c ORDER BY c.delivery_id
    ON CONFLICT DO NOTHING;
  FOR task IN
    SELECT o.* FROM public.exam_document_reaction o
    JOIN public.exam_contact_reaction_candidates(cfg.activation_cutoff,destination,as_of) c
      ON c.delivery_id=o.delivery_id AND c.document_id=o.document_id AND c.external_message_id=o.external_message_id AND c.sha256=o.sha256
    WHERE o.destination_key=destination AND o.actor_id=cfg.chatwoot_actor_id AND o.submit_started_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM public.exam_document_reaction_event used WHERE used.reaction_id=o.id AND used.event_type='submit_started')
      AND COALESCE(o.dispatch_next_attempt_at,'-infinity'::timestamptz)<=as_of
      AND (o.status='pending' OR (o.status='reserved' AND o.lease_until<=as_of)
        OR (o.status='held' AND o.dispatch_retryable))
    ORDER BY CASE WHEN mod(floor(extract(epoch FROM as_of)/60)::bigint,3)=0 THEN COALESCE(o.dispatch_next_attempt_at,o.created_at) END,
      CASE WHEN mod(floor(extract(epoch FROM as_of)/60)::bigint,3)<>0 THEN (o.dispatch_attempts=0)::integer END DESC,
      CASE WHEN mod(floor(extract(epoch FROM as_of)/60)::bigint,3)<>0 THEN o.contact_saved_at END DESC,o.dispatch_attempts,o.contact_saved_at,o.id FOR UPDATE OF o SKIP LOCKED LIMIT p_limit LOOP
    UPDATE public.exam_document_reaction SET status='reserved',worker=p_worker,lease_token=gen_random_uuid(),
      lease_until=as_of+interval '2 minutes',dispatch_attempts=dispatch_attempts+1,
      dispatch_next_attempt_at=as_of+GREATEST(interval '2 minutes',public.exam_contact_reaction_backoff(dispatch_attempts+1)),
      last_error_code=NULL,updated_at=as_of WHERE id=task.id RETURNING * INTO task;
    INSERT INTO public.exam_document_reaction_event(reaction_id,event_type) VALUES(task.id,'reserved');
    tasks:=tasks||jsonb_build_array(to_jsonb(task)||jsonb_build_object('reaction_id',task.id,'reconcile_only',false));
  END LOOP;
  -- Reconciliation has its own claim and budget; never wait on it with a dispatch lease.
  RETURN jsonb_build_object('tasks',tasks,'reconcile_tasks','[]'::jsonb,'lane','new','paused',false,'actor_id',cfg.chatwoot_actor_id,
    'activation_cutoff',cfg.activation_cutoff,'destination_key',destination);
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_exam_contact_reaction(p_reaction_id uuid,p_lease_token uuid,p_destination_key text,p_external_message_id text,p_emoji text,p_actor_id bigint)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cfg public.exam_reaction_configuration; group_cfg public.exam_document_configuration;
  as_of timestamptz:=public.exam_reaction_clock(); task public.exam_document_reaction;
BEGIN
  PERFORM public.require_exam_document_service();
  SELECT * INTO STRICT cfg FROM public.exam_reaction_configuration WHERE singleton FOR SHARE;
  SELECT * INTO STRICT group_cfg FROM public.exam_document_configuration WHERE singleton FOR SHARE;
  SELECT * INTO STRICT task FROM public.exam_document_reaction WHERE id=p_reaction_id FOR UPDATE;
  IF task.lease_token IS DISTINCT FROM p_lease_token THEN RAISE EXCEPTION 'REACTION_LEASE_INVALID' USING ERRCODE='PT409'; END IF;
  IF task.status<>'reserved' OR task.submit_started_at IS NOT NULL
    OR EXISTS(SELECT 1 FROM public.exam_document_reaction_event used WHERE used.reaction_id=task.id AND used.event_type='submit_started') THEN
    RETURN jsonb_build_object('dispatch_allowed',false,'reaction_id',task.id,'status',task.status,'reason','REACTION_DISPATCH_CONSUMED');
  END IF;
  IF task.lease_until<=as_of THEN RAISE EXCEPTION 'REACTION_LEASE_EXPIRED' USING ERRCODE='PT409'; END IF;
  IF NOT cfg.enabled OR task.actor_id IS DISTINCT FROM cfg.chatwoot_actor_id OR task.actor_id IS DISTINCT FROM p_actor_id
    OR task.destination_key IS DISTINCT FROM NULLIF(trim(group_cfg.group_destination_key),'')
    OR task.destination_key IS DISTINCT FROM p_destination_key OR task.external_message_id IS DISTINCT FROM p_external_message_id
    OR task.emoji IS DISTINCT FROM p_emoji OR NOT ('group'=ANY(group_cfg.enabled_destinations)) THEN
    RAISE EXCEPTION 'REACTION_TARGET_CHANGED' USING ERRCODE='PT409';
  END IF;
  PERFORM 1 FROM public.exam_document WHERE id=task.document_id FOR SHARE;
  -- Re-read the clock after potentially waiting on the contact/document lock.
  as_of:=public.exam_reaction_clock();
  IF task.lease_until<=as_of THEN RAISE EXCEPTION 'REACTION_LEASE_EXPIRED' USING ERRCODE='PT409'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.exam_contact_reaction_candidates(cfg.activation_cutoff,task.destination_key,as_of) c
    WHERE c.delivery_id=task.delivery_id AND c.document_id=task.document_id
      AND c.external_message_id=task.external_message_id AND c.sha256=task.sha256) THEN
    RAISE EXCEPTION 'REACTION_CONTACT_OR_ORIGINAL_CHANGED' USING ERRCODE='PT409';
  END IF;
  UPDATE public.exam_document_reaction SET status='started',submit_started_at=as_of,dispatch_retryable=false,reconcile_next_attempt_at=as_of+interval '30 seconds',updated_at=as_of WHERE id=task.id;
  INSERT INTO public.exam_document_reaction_event(reaction_id,event_type) VALUES(task.id,'submit_started');
  RETURN jsonb_build_object('dispatch_allowed',true,'reaction_id',task.id,'delivery_id',task.delivery_id,
    'document_id',task.document_id,'destination_key',task.destination_key,'external_message_id',task.external_message_id,
    'sha256',task.sha256,'emoji',task.emoji,'actor_id',task.actor_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_exam_contact_reaction_result(p_reaction_id uuid,p_lease_token uuid,p_outcome jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cfg public.exam_reaction_configuration; group_cfg public.exam_document_configuration;
  as_of timestamptz:=public.exam_reaction_clock(); task public.exam_document_reaction;
  kind text:=p_outcome->>'status'; next_state text; safe_error text;
BEGIN
  PERFORM public.require_exam_document_service();
  IF jsonb_typeof(p_outcome) IS DISTINCT FROM 'object' OR kind IS NULL OR kind NOT IN ('confirmed','already_present','submitted','failed','uncertain') THEN
    RAISE EXCEPTION 'REACTION_OUTCOME_INVALID' USING ERRCODE='22023';
  END IF;
  IF p_outcome ? 'scan_state' AND p_outcome->'scan_state'<>'null'::jsonb THEN
    RAISE EXCEPTION 'REACTION_OBSOLETE_SCAN_PROOF' USING ERRCODE='22023';
  END IF;
  SELECT * INTO STRICT cfg FROM public.exam_reaction_configuration WHERE singleton FOR SHARE;
  SELECT * INTO STRICT group_cfg FROM public.exam_document_configuration WHERE singleton FOR SHARE;
  SELECT * INTO STRICT task FROM public.exam_document_reaction WHERE id=p_reaction_id FOR UPDATE;
  IF task.lease_token IS DISTINCT FROM p_lease_token OR task.external_message_id IS DISTINCT FROM p_outcome->>'external_message_id'
    OR task.emoji IS DISTINCT FROM p_outcome->>'emoji' OR task.actor_id::text IS DISTINCT FROM p_outcome->>'actor_id' THEN
    RAISE EXCEPTION 'REACTION_RESULT_FENCE_INVALID' USING ERRCODE='PT409';
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
      safe_error:=public.exam_contact_reaction_safe_error(p_outcome->>'error_code');
      UPDATE public.exam_document_reaction SET status='held',last_error_code=safe_error,dispatch_retryable=public.exam_contact_reaction_transient(safe_error),
        dispatch_next_attempt_at=as_of+GREATEST(interval '2 minutes',public.exam_contact_reaction_backoff(task.dispatch_attempts)),
        reconcile_next_attempt_at=as_of+interval '1 minute',updated_at=as_of WHERE id=task.id;
      INSERT INTO public.exam_document_reaction_event(reaction_id,event_type,details)
        VALUES(task.id,'pre_dispatch_hold',jsonb_build_object('error_code',safe_error));
      RETURN jsonb_build_object('reaction_id',task.id,'status','held','dispatch_allowed',false,'retry_allowed',false);
    END IF;
    IF task.status NOT IN ('reserved','held') OR kind<>'already_present' OR (task.status='reserved' AND task.lease_until<=as_of) OR NOT cfg.enabled
      OR cfg.chatwoot_actor_id IS DISTINCT FROM task.actor_id OR task.destination_key IS DISTINCT FROM NULLIF(trim(group_cfg.group_destination_key),'')
      OR NOT ('group'=ANY(group_cfg.enabled_destinations)) THEN RAISE EXCEPTION 'REACTION_NOT_DISPATCHED' USING ERRCODE='PT409'; END IF;
    PERFORM 1 FROM public.exam_document WHERE id=task.document_id FOR SHARE;
    IF NOT EXISTS(SELECT 1 FROM public.exam_contact_reaction_candidates(cfg.activation_cutoff,task.destination_key,as_of) c
      WHERE c.delivery_id=task.delivery_id AND c.external_message_id=task.external_message_id AND c.sha256=task.sha256) THEN
      RAISE EXCEPTION 'REACTION_CONTACT_OR_ORIGINAL_CHANGED' USING ERRCODE='PT409';
    END IF;
  END IF;
  next_state:=CASE WHEN kind IN ('confirmed','already_present') THEN 'confirmed' ELSE kind END;
  IF task.status='confirmed' THEN next_state:='confirmed';
  ELSIF task.status IN ('submitted','failed') AND kind='uncertain' THEN next_state:=task.status; END IF;
  safe_error:=CASE WHEN kind IN ('failed','uncertain') THEN public.exam_contact_reaction_safe_error(p_outcome->>'error_code') END;
  UPDATE public.exam_document_reaction SET status=next_state,dispatch_retryable=false,confirmed_at=CASE WHEN next_state='confirmed' THEN COALESCE(confirmed_at,as_of) ELSE confirmed_at END,
    last_error_code=CASE WHEN next_state='confirmed' THEN NULL ELSE safe_error END,
    reconcile_next_attempt_at=CASE WHEN next_state='confirmed' THEN NULL ELSE as_of+interval '30 seconds' END,
    reconcile_claim_token=NULL,reconcile_claim_until=NULL,updated_at=as_of WHERE id=task.id;
  INSERT INTO public.exam_document_reaction_event(reaction_id,event_type,details) VALUES(task.id,'result_recorded',
    jsonb_build_object('status',next_state,'own_reaction_verified',p_outcome->'own_reaction_verified'='true'::jsonb,'error_code',safe_error,
      'late',task.lease_until<=as_of));
  RETURN jsonb_build_object('reaction_id',task.id,'status',next_state,'dispatch_allowed',false,'retry_allowed',false);
END;
$$;

-- Reconciliation is a separate read claim: no dispatch lease/token is returned.
CREATE FUNCTION public.reserve_exam_contact_reconciliations(p_worker text,p_limit integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cfg public.exam_reaction_configuration; group_cfg public.exam_document_configuration;
 as_of timestamptz:=public.exam_reaction_clock(); destination text; task public.exam_document_reaction; tasks jsonb:='[]';
BEGIN
 PERFORM public.require_exam_document_service();
 IF p_worker IS NULL OR p_worker !~ '^[A-Za-z0-9_.:-]{1,96}$' OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5 THEN
  RAISE EXCEPTION 'REACTION_RESERVATION_INVALID' USING ERRCODE='22023'; END IF;
 SELECT * INTO STRICT cfg FROM public.exam_reaction_configuration WHERE singleton FOR SHARE;
 SELECT * INTO STRICT group_cfg FROM public.exam_document_configuration WHERE singleton FOR SHARE;
 destination:=NULLIF(trim(group_cfg.group_destination_key),'');
 IF NOT cfg.enabled OR cfg.activation_cutoff IS NULL OR cfg.chatwoot_actor_id IS NULL
  OR destination IS NULL OR NOT ('group'=ANY(group_cfg.enabled_destinations)) THEN
  RETURN jsonb_build_object('tasks','[]'::jsonb,'lane','reconcile','paused',true,'dispatch_allowed',false); END IF;
 FOR task IN
  SELECT o.* FROM public.exam_document_reaction o JOIN public.exam_document d ON d.id=o.document_id
  WHERE o.destination_key=destination AND o.actor_id=cfg.chatwoot_actor_id
   AND d.deletion_state IS NULL AND d.canonical_document_id IS NULL AND d.file_status='saved'
   AND ((o.submit_started_at IS NOT NULL AND o.status IN ('started','submitted','uncertain','failed'))
     OR (o.status='held' AND NOT o.dispatch_retryable))
   AND COALESCE(o.reconcile_next_attempt_at,'-infinity'::timestamptz)<=as_of
   AND (o.reconcile_claim_until IS NULL OR o.reconcile_claim_until<=as_of)
  -- Two recent-first slots, then one aged-due slot: fresh ACKs and old gaps both progress.
  ORDER BY CASE WHEN mod(floor(extract(epoch FROM as_of)/60)::bigint,3)=0 THEN COALESCE(o.reconcile_next_attempt_at,o.created_at) END,
   CASE WHEN mod(floor(extract(epoch FROM as_of)/60)::bigint,3)<>0 THEN (o.reconcile_attempts=0)::integer END DESC,
   CASE WHEN mod(floor(extract(epoch FROM as_of)/60)::bigint,3)<>0 THEN o.submit_started_at END DESC,
   o.reconcile_next_attempt_at NULLS FIRST,o.updated_at,o.id FOR UPDATE OF o SKIP LOCKED LIMIT p_limit
 LOOP
  UPDATE public.exam_document_reaction SET reconcile_attempts=reconcile_attempts+1,reconcile_claim_token=gen_random_uuid(),
   reconcile_claim_until=as_of+interval '90 seconds',reconcile_next_attempt_at=as_of+public.exam_contact_reaction_backoff(reconcile_attempts+1)
   WHERE id=task.id RETURNING * INTO task;
  INSERT INTO public.exam_document_reaction_event(reaction_id,event_type,details)
   VALUES(task.id,'reconcile_claimed',jsonb_build_object('attempt',task.reconcile_attempts,'worker',p_worker));
  tasks:=tasks||jsonb_build_array(jsonb_build_object('reaction_id',task.id,'delivery_id',task.delivery_id,
   'document_id',task.document_id,'destination_key',task.destination_key,'external_message_id',task.external_message_id,
   'sha256',task.sha256,'emoji',task.emoji,'actor_id',task.actor_id,'status',task.status,
   'contact_saved_at',task.contact_saved_at,'submit_started_at',task.submit_started_at,
   'reconcile_only',true,'reconcile_token',task.reconcile_claim_token,'reconcile_lease_until',task.reconcile_claim_until,
   'dispatch_allowed',false));
 END LOOP;
 RETURN jsonb_build_object('tasks',tasks,'lane','reconcile','paused',false,'dispatch_allowed',false,
  'actor_id',cfg.chatwoot_actor_id,'activation_cutoff',cfg.activation_cutoff,'destination_key',destination);
END;
$$;
CREATE FUNCTION public.record_exam_contact_reconciliation_result(p_reaction_id uuid,p_reconcile_token uuid,p_outcome jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cfg public.exam_reaction_configuration; group_cfg public.exam_document_configuration;
 as_of timestamptz:=public.exam_reaction_clock(); task public.exam_document_reaction;
 kind text:=p_outcome->>'status'; safe_error text; next_due timestamptz;
BEGIN
 PERFORM public.require_exam_document_service();
 IF jsonb_typeof(p_outcome) IS DISTINCT FROM 'object' OR kind IS NULL OR kind NOT IN ('confirmed','already_present','uncertain','failed','pre_dispatch_ready') THEN
  RAISE EXCEPTION 'REACTION_RECONCILE_OUTCOME_INVALID' USING ERRCODE='22023'; END IF;
 IF p_outcome ? 'scan_state' AND p_outcome->'scan_state'<>'null'::jsonb THEN RAISE EXCEPTION 'REACTION_OBSOLETE_SCAN_PROOF' USING ERRCODE='22023'; END IF;
 SELECT * INTO STRICT cfg FROM public.exam_reaction_configuration WHERE singleton FOR SHARE;
 SELECT * INTO STRICT group_cfg FROM public.exam_document_configuration WHERE singleton FOR SHARE;
 SELECT * INTO STRICT task FROM public.exam_document_reaction WHERE id=p_reaction_id FOR UPDATE;
 IF task.external_message_id IS DISTINCT FROM p_outcome->>'external_message_id'
  OR task.emoji IS DISTINCT FROM p_outcome->>'emoji' OR task.actor_id::text IS DISTINCT FROM p_outcome->>'actor_id' THEN
  RAISE EXCEPTION 'REACTION_RECONCILE_IDENTITY_INVALID' USING ERRCODE='PT409'; END IF;
 IF task.delivery_id::text IS DISTINCT FROM p_outcome->>'delivery_id' OR task.document_id::text IS DISTINCT FROM p_outcome->>'document_id'
  OR task.destination_key IS DISTINCT FROM p_outcome->>'destination_key' OR task.sha256 IS DISTINCT FROM p_outcome->>'sha256' THEN
  RAISE EXCEPTION 'REACTION_RECONCILE_SCOPE_INVALID' USING ERRCODE='PT409'; END IF;
 IF kind IN ('confirmed','already_present') AND (p_outcome->'own_reaction_verified' IS DISTINCT FROM 'true'::jsonb
  OR p_outcome->'evidence_complete' IS DISTINCT FROM 'true'::jsonb
  OR p_outcome->>'provider_contract' IS DISTINCT FROM 'pamvet_check_v1') THEN
  RAISE EXCEPTION 'REACTION_OWN_EVIDENCE_REQUIRED' USING ERRCODE='22023'; END IF;
 IF kind='pre_dispatch_ready' AND EXISTS(SELECT 1 FROM public.exam_document_reaction_event e
  WHERE e.reaction_id=task.id AND e.event_type='pre_dispatch_ready' AND e.details->>'reconcile_token'=p_reconcile_token::text) THEN
  RETURN jsonb_build_object('reaction_id',task.id,'status',task.status,'handoff',true,'idempotent',true,'dispatch_allowed',false,'retry_allowed',false);
 END IF;
 IF task.status='confirmed' THEN RETURN jsonb_build_object('reaction_id',task.id,'status','confirmed','dispatch_allowed',false,'retry_allowed',false); END IF;
 IF task.reconcile_claim_token IS DISTINCT FROM p_reconcile_token OR p_reconcile_token IS NULL THEN
  RAISE EXCEPTION 'REACTION_RECONCILE_CLAIM_INVALID' USING ERRCODE='PT409'; END IF;
 IF NOT ((task.submit_started_at IS NOT NULL AND task.status IN ('started','submitted','uncertain','failed'))
  OR (task.status='held' AND NOT task.dispatch_retryable)) THEN
  RAISE EXCEPTION 'REACTION_RECONCILE_STATE_INVALID' USING ERRCODE='PT409'; END IF;
 IF kind='pre_dispatch_ready' THEN
  IF task.status<>'held' OR task.submit_started_at IS NOT NULL
   OR EXISTS(SELECT 1 FROM public.exam_document_reaction_event e WHERE e.reaction_id=task.id AND e.event_type='submit_started')
   OR EXISTS(SELECT 1 FROM public.exam_document_reaction_event e WHERE e.reaction_id=task.id AND e.details->>'error_code' IN
    ('REACTION_EXISTING_SUPPORT_CHOICE','REACTION_OWN_OTHER_EMOJI','REACTION_PREVIOUS_SUPPORT_REMOVAL'))
   OR task.last_error_code IN ('REACTION_EXISTING_SUPPORT_CHOICE','REACTION_OWN_OTHER_EMOJI','REACTION_PREVIOUS_SUPPORT_REMOVAL') THEN
   RAISE EXCEPTION 'REACTION_PRE_DISPATCH_HANDOFF_INVALID' USING ERRCODE='PT409'; END IF;
  IF p_outcome->>'provider_contract' IS DISTINCT FROM 'pamvet_check_v1'
   OR p_outcome->'evidence_complete' IS DISTINCT FROM 'true'::jsonb
   OR p_outcome->'own_reaction_absent' IS DISTINCT FROM 'true'::jsonb
   OR p_outcome->'own_reaction_verified'='true'::jsonb
   OR p_outcome->>'provider_state' IS DISTINCT FROM 'absent' THEN
   RAISE EXCEPTION 'REACTION_ABSENCE_EVIDENCE_REQUIRED' USING ERRCODE='22023'; END IF;
  IF NOT cfg.enabled OR cfg.chatwoot_actor_id IS DISTINCT FROM task.actor_id
   OR task.destination_key IS DISTINCT FROM NULLIF(trim(group_cfg.group_destination_key),'')
   OR NOT ('group'=ANY(group_cfg.enabled_destinations)) THEN RAISE EXCEPTION 'REACTION_TARGET_CHANGED' USING ERRCODE='PT409'; END IF;
  PERFORM 1 FROM public.exam_document WHERE id=task.document_id FOR SHARE;
  as_of:=public.exam_reaction_clock();
  IF NOT EXISTS(SELECT 1 FROM public.exam_contact_reaction_candidates(cfg.activation_cutoff,task.destination_key,as_of) c
   WHERE c.delivery_id=task.delivery_id AND c.document_id=task.document_id AND c.external_message_id=task.external_message_id AND c.sha256=task.sha256)
   THEN RAISE EXCEPTION 'REACTION_CONTACT_OR_ORIGINAL_CHANGED' USING ERRCODE='PT409'; END IF;
  UPDATE public.exam_document_reaction SET status='pending',dispatch_retryable=false,dispatch_next_attempt_at=as_of+interval '1 minute',
   reconcile_claim_token=NULL,reconcile_claim_until=NULL,reconcile_next_attempt_at=NULL,updated_at=as_of WHERE id=task.id;
  INSERT INTO public.exam_document_reaction_event(reaction_id,event_type,details)
   VALUES(task.id,'pre_dispatch_ready',jsonb_build_object('reconcile_token',p_reconcile_token,'next_dispatch_at',as_of+interval '1 minute'));
  RETURN jsonb_build_object('reaction_id',task.id,'status','pending','handoff',true,'dispatch_allowed',false,'retry_allowed',false,
   'next_dispatch_at',as_of+interval '1 minute');
 END IF;
 -- A late positive read may commit while its same token remains current; a newer claim fences it.
 IF kind IN ('confirmed','already_present') THEN
  IF task.submit_started_at IS NULL THEN
   IF NOT cfg.enabled OR cfg.chatwoot_actor_id IS DISTINCT FROM task.actor_id
    OR task.destination_key IS DISTINCT FROM NULLIF(trim(group_cfg.group_destination_key),'')
    OR NOT ('group'=ANY(group_cfg.enabled_destinations)) THEN RAISE EXCEPTION 'REACTION_TARGET_CHANGED' USING ERRCODE='PT409'; END IF;
   PERFORM 1 FROM public.exam_document WHERE id=task.document_id FOR SHARE;
   IF NOT EXISTS(SELECT 1 FROM public.exam_contact_reaction_candidates(cfg.activation_cutoff,task.destination_key,as_of) c
    WHERE c.delivery_id=task.delivery_id AND c.document_id=task.document_id AND c.external_message_id=task.external_message_id AND c.sha256=task.sha256)
    THEN RAISE EXCEPTION 'REACTION_CONTACT_OR_ORIGINAL_CHANGED' USING ERRCODE='PT409'; END IF;
  END IF;
  UPDATE public.exam_document_reaction SET status='confirmed',dispatch_retryable=false,confirmed_at=COALESCE(confirmed_at,as_of),last_error_code=NULL,
   reconcile_claim_token=NULL,reconcile_claim_until=NULL,reconcile_next_attempt_at=NULL,updated_at=as_of WHERE id=task.id;
 ELSE
  safe_error:=public.exam_contact_reaction_safe_error(p_outcome->>'error_code');
  next_due:=as_of+public.exam_contact_reaction_backoff(task.reconcile_attempts);
  -- Never change submission state, consumed token, dispatch lease, contact or original.
  UPDATE public.exam_document_reaction SET last_error_code=safe_error,reconcile_next_attempt_at=next_due,
   reconcile_claim_token=NULL,reconcile_claim_until=NULL,updated_at=as_of WHERE id=task.id;
 END IF;
 INSERT INTO public.exam_document_reaction_event(reaction_id,event_type,details)
  VALUES(task.id,'reconcile_result',jsonb_build_object('status',CASE WHEN kind IN ('confirmed','already_present') THEN 'confirmed' ELSE task.status END,
   'error_code',safe_error,'own_reaction_verified',p_outcome->'own_reaction_verified'='true'::jsonb));
 RETURN jsonb_build_object('reaction_id',task.id,'status',CASE WHEN kind IN ('confirmed','already_present') THEN 'confirmed' ELSE task.status END,
  'dispatch_allowed',false,'retry_allowed',false,'next_reconcile_at',next_due);
END;
$$;
REVOKE ALL ON FUNCTION public.exam_contact_reaction_safe_error(text),public.exam_contact_reaction_transient(text),
 public.exam_contact_reaction_backoff(integer) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.reserve_exam_contact_reconciliations(text,integer),
 public.record_exam_contact_reconciliation_result(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_exam_contact_reconciliations(text,integer),
 public.record_exam_contact_reconciliation_result(uuid,uuid,jsonb) TO service_role;
-- Existing RPC signatures, ownership and service-only grants remain intact.
COMMIT;
