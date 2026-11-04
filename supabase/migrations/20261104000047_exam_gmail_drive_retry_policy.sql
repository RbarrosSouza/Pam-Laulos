BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
-- Preserve existing source identity/HopeLab contracts and make new Gmail/Drive
-- failures actionable without replaying arbitrary provider error text.
CREATE TABLE IF NOT EXISTS public.exam_intake_source_retry (
 document_id uuid PRIMARY KEY REFERENCES public.exam_document(id) ON DELETE CASCADE,
 failure_count integer NOT NULL DEFAULT 0 CHECK(failure_count>=0),
 reason_code text NOT NULL,
 first_failed_at timestamptz NOT NULL DEFAULT now(),
 last_failed_at timestamptz NOT NULL DEFAULT now(),
 next_attempt_at timestamptz NOT NULL
);
ALTER TABLE public.exam_intake_source_retry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.exam_intake_source_retry FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.exam_intake_source_retry TO service_role;

DO $$ BEGIN
 IF to_regprocedure('public.reserve_exam_intake_source_before_retry_policy(jsonb)') IS NULL THEN
   ALTER FUNCTION public.reserve_exam_intake_source(jsonb) RENAME TO reserve_exam_intake_source_before_retry_policy;
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.reserve_exam_intake_source_before_retry_policy(jsonb) FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION public.reserve_exam_intake_source(p_source jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb; retry public.exam_intake_source_retry; d public.exam_document;
BEGIN
 PERFORM public.require_exam_document_service();
 result:=public.reserve_exam_intake_source_before_retry_policy(p_source);
 -- An alternate authorized origin may recover the same bytes; a Gmail cooldown
 -- never blocks PamSuporte/WhatsApp or fallback preservation.
 IF p_source->>'channel' IS DISTINCT FROM 'email' OR result->'excluded'='true'::jsonb OR NULLIF(result->>'document_id','') IS NULL THEN RETURN result; END IF;
 SELECT * INTO STRICT d FROM public.exam_document WHERE id=(result->>'document_id')::uuid;
 IF d.file_status='saved' OR d.deletion_state IS NOT NULL THEN RETURN result; END IF;
 SELECT * INTO retry FROM public.exam_intake_source_retry WHERE document_id=d.id;
 IF FOUND THEN
  result:=result||jsonb_build_object('intake_retry',jsonb_build_object('deferred',retry.next_attempt_at>now(),
    'reason_code',retry.reason_code,'failure_count',retry.failure_count,'next_attempt_at',retry.next_attempt_at));
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.reserve_exam_intake_source(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_exam_intake_source(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.record_exam_document_source_error(p_document_id uuid,p_error text,p_review_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.exam_document; code text; retry public.exam_intake_source_retry; delay_seconds integer;
BEGIN
 PERFORM public.require_exam_document_service();
 IF NULLIF(trim(p_error),'') IS NULL THEN RAISE EXCEPTION 'Descrição de falha obrigatória'; END IF;
 SELECT * INTO STRICT d FROM public.exam_document WHERE id=p_document_id FOR NO KEY UPDATE;
 IF d.canonical_document_id IS NOT NULL THEN
  SELECT * INTO STRICT d FROM public.exam_document WHERE id=d.canonical_document_id FOR NO KEY UPDATE;
 END IF;
 -- A late failing scan cannot degrade another worker's completed original.
 IF d.file_status='saved' THEN RETURN jsonb_build_object('document_id',d.id,'already_saved',true,'document',to_jsonb(d)); END IF;
 IF d.deletion_state IS NOT NULL OR d.identification_status='not_exam' THEN RETURN jsonb_build_object('document_id',d.id,'excluded',true,'document',to_jsonb(d)); END IF;
 code:=substring(p_error FROM '^Gmail/Drive \[([a-z_]+)\]$');
 IF code IS NOT NULL AND NOT(code=ANY(ARRAY['gmail_download_failed','hopelab_download_failed','inline_download_failed','inline_identity_failed','invalid_pdf_signature','original_validation_failed','drive_id_failed','drive_stage_failed','drive_lookup_failed','drive_binding_conflict','drive_create_failed','drive_upload_failed','drive_readback_failed','drive_integrity_conflict','drive_confirmation_failed','drive_recovery_lookup_failed','drive_recovery_binding_conflict','drive_recovery_content_conflict'])) THEN RAISE EXCEPTION 'Invalid Gmail/Drive failure code'; END IF;
 IF code IS NOT NULL THEN
  SELECT * INTO retry FROM public.exam_intake_source_retry WHERE document_id=d.id FOR UPDATE;
  -- Concurrent callbacks cannot inflate the failure count or extend the window.
  IF FOUND AND retry.next_attempt_at>now() THEN
    IF retry.reason_code IS DISTINCT FROM code THEN
      UPDATE public.exam_intake_source_retry SET reason_code=code WHERE document_id=d.id RETURNING * INTO retry;
    END IF;
    RETURN jsonb_build_object('document_id',d.id,'document',to_jsonb(d),'intake_retry',to_jsonb(retry),'deferred',true);
  END IF;
 END IF;
 UPDATE public.exam_document SET file_status='failed',identification_status='review',review_reason=left(COALESCE(p_review_reason,p_error),1000)
 WHERE id=d.id RETURNING * INTO d;
 PERFORM public.log_exam_document(d.id,'source_failed',jsonb_build_object('error',left(p_error,1000))
   ||CASE WHEN code IS NOT NULL THEN jsonb_build_object('reason_code',code,'stage',code) ELSE '{}'::jsonb END);
 IF code IS NOT NULL THEN
  delay_seconds:=least(3600,300*(2^least(COALESCE(retry.failure_count,0),4))::integer);
  INSERT INTO public.exam_intake_source_retry(document_id,failure_count,reason_code,next_attempt_at)
    VALUES(d.id,1,code,now()+make_interval(secs=>delay_seconds))
  ON CONFLICT(document_id) DO UPDATE SET failure_count=exam_intake_source_retry.failure_count+1,
    reason_code=excluded.reason_code,last_failed_at=now(),next_attempt_at=excluded.next_attempt_at
  RETURNING * INTO retry;
 END IF;
 RETURN jsonb_build_object('document_id',d.id,'document',to_jsonb(d),'intake_retry',CASE WHEN code IS NOT NULL THEN to_jsonb(retry) ELSE NULL END);
END $$;
REVOKE ALL ON FUNCTION public.record_exam_document_source_error(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_exam_document_source_error(uuid,text,text) TO service_role;

COMMIT;
