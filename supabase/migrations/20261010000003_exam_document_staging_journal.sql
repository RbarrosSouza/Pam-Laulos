-- Shared dispatch journal for the optional Composio staging bridge.
-- Installing this schema does not enable that bridge or change existing OAuth workflows.
-- A source row survives canonical-document deduplication; a lease/document ID does not.
CREATE TABLE public.exam_document_staging_operation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_nonce uuid NOT NULL DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES public.exam_document_source(id) ON DELETE RESTRICT,
  phase text NOT NULL DEFAULT 'upload_local_file' CHECK (phase = 'upload_local_file'),
  provider_scope text NOT NULL CHECK (provider_scope ~ '^[A-Za-z0-9_.:-]{1,96}$'),
  -- n8n can reserve before the full download/hash/helper execution without giving
  -- its worker credential to Workbench. Actual bytes are bound once in record().
  sha256 text CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint CHECK (size_bytes BETWEEN 1 AND 20971520),
  status text NOT NULL DEFAULT 'started' CHECK (status IN ('started','uncertain','reported')),
  started_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL,
  reported_at timestamptz,
  helper_reference_sha256 text CHECK (helper_reference_sha256 ~ '^[a-f0-9]{64}$'),
  error_code text CHECK (error_code IN ('DEADLINE','HELPER_UNKNOWN','RESULT_LOST','CANCELLED_UNKNOWN')),
  UNIQUE (source_id, phase),
  CHECK ((sha256 IS NULL) = (size_bytes IS NULL)),
  CHECK (deadline_at > started_at),
  CHECK (status <> 'reported' OR (reported_at IS NOT NULL AND helper_reference_sha256 IS NOT NULL AND sha256 IS NOT NULL))
);
ALTER TABLE public.exam_document_staging_operation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.exam_document_staging_operation FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.exam_document_staging_operation TO service_role;
COMMENT ON TABLE public.exam_document_staging_operation IS
  'No automatic reset/retry: started and uncertain may already have an external effect. reported is helper evidence, not Drive/file confirmation.';

CREATE OR REPLACE FUNCTION public.begin_exam_document_staging(
  p_source jsonb, p_file jsonb, p_provider_scope text, p_deadline_seconds integer DEFAULT 45
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_source public.exam_document_source; v_doc public.exam_document;
  v_op public.exam_document_staging_operation; v_hash text; v_size bigint;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_source IS NULL OR jsonb_typeof(p_source) <> 'object' OR
     p_source->>'channel' IS NULL OR p_source->>'channel' NOT IN ('email','whatsapp','manual') OR
     jsonb_typeof(p_source->'account_id') IS DISTINCT FROM 'string' OR NULLIF(p_source->>'account_id','') IS NULL OR
     jsonb_typeof(p_source->'message_id') IS DISTINCT FROM 'string' OR NULLIF(p_source->>'message_id','') IS NULL OR
     jsonb_typeof(p_source->'attachment_id') IS DISTINCT FROM 'string' OR NULLIF(p_source->>'attachment_id','') IS NULL THEN
    RAISE EXCEPTION 'Origem reservada obrigatória para staging' USING ERRCODE='22023';
  END IF;
  IF p_provider_scope IS NULL OR p_provider_scope !~ '^[A-Za-z0-9_.:-]{1,96}$' OR
     p_deadline_seconds IS NULL OR p_deadline_seconds NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'Contrato de staging inválido' USING ERRCODE='22023';
  END IF;
  IF p_file IS NOT NULL AND (jsonb_typeof(p_file) <> 'object' OR
     (p_file - ARRAY['sha256','size_bytes']) <> '{}'::jsonb OR
     jsonb_typeof(p_file->'sha256') IS DISTINCT FROM 'string' OR
     COALESCE(p_file->>'sha256','') !~ '^[a-fA-F0-9]{64}$' OR
     jsonb_typeof(p_file->'size_bytes') IS DISTINCT FROM 'number' OR
     COALESCE(p_file->>'size_bytes','') !~ '^[0-9]{1,8}$') THEN
    RAISE EXCEPTION 'Contrato de staging inválido' USING ERRCODE='22023';
  END IF;
  v_hash := lower(p_file->>'sha256'); v_size := (p_file->>'size_bytes')::bigint;
  IF p_file IS NOT NULL AND (v_size < 1 OR v_size > LEAST(20971520,(SELECT max_file_bytes FROM public.exam_document_configuration))) THEN
    RAISE EXCEPTION 'Tamanho de staging inválido' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_source FROM public.exam_document_source
    WHERE channel=p_source->>'channel' AND account_id=p_source->>'account_id'
      AND message_id=p_source->>'message_id' AND attachment_id=p_source->>'attachment_id' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reservar origem antes do staging' USING ERRCODE='40001';
  END IF;
  SELECT * INTO v_doc FROM public.exam_document WHERE id=v_source.document_id;
  IF p_file IS NOT NULL AND v_doc.sha256 IS NOT NULL AND (v_doc.sha256 <> v_hash OR v_doc.size_bytes <> v_size) THEN
    RAISE EXCEPTION 'Bytes divergentes da origem reservada' USING ERRCODE='40001';
  END IF;
  SELECT * INTO v_op FROM public.exam_document_staging_operation WHERE source_id=v_source.id AND phase='upload_local_file';
  IF FOUND THEN
    IF (p_file IS NOT NULL AND v_op.sha256 IS NOT NULL AND (v_op.sha256 <> v_hash OR v_op.size_bytes <> v_size)) OR v_op.provider_scope <> p_provider_scope THEN
      RAISE EXCEPTION 'Identidade de staging mudou; investigar sem repetir' USING ERRCODE='40001';
    END IF;
    RETURN jsonb_build_object('dispatch_allowed',false,'reason','existing_operation','operation_id',v_op.id,
      'source_id',v_source.id,'document_id',v_source.document_id,'status',v_op.status,
      'deadline_at',v_op.deadline_at,'helper_reference_sha256',v_op.helper_reference_sha256,'ready_for_drive',false);
  END IF;
  IF v_doc.file_status='saved' THEN
    RETURN jsonb_build_object('dispatch_allowed',false,'reason','original_already_preserved',
      'source_id',v_source.id,'document_id',v_source.document_id,'ready_for_drive',false);
  END IF;
  -- This transaction must commit and the response be acknowledged BEFORE calling the helper.
  INSERT INTO public.exam_document_staging_operation(source_id,provider_scope,sha256,size_bytes,deadline_at)
  VALUES(v_source.id,p_provider_scope,v_hash,v_size,now()+make_interval(secs=>p_deadline_seconds)) RETURNING * INTO v_op;
  PERFORM public.log_exam_document(v_source.document_id,'staging_started',jsonb_build_object('operation_id',v_op.id,'source_id',v_source.id));
  RETURN jsonb_build_object('dispatch_allowed',true,'operation_id',v_op.id,'dispatch_nonce',v_op.dispatch_nonce,'source_id',v_source.id,
    'document_id',v_source.document_id,'status',v_op.status,'deadline_at',v_op.deadline_at,'ready_for_drive',false);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_exam_document_staging(
  p_operation_id uuid, p_dispatch_nonce uuid, p_outcome jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_op public.exam_document_staging_operation; v_state text; v_ref text; v_code text; v_doc uuid;
  v_document public.exam_document;
  v_has_bytes boolean; v_hash text; v_size bigint;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_outcome IS NULL OR jsonb_typeof(p_outcome) <> 'object' OR
     (p_outcome - ARRAY['state','sha256','size_bytes','helper_reference_sha256','error_code']) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Resultado de staging inválido' USING ERRCODE='22023';
  END IF;
  v_state := p_outcome->>'state'; v_ref := p_outcome->>'helper_reference_sha256'; v_code := p_outcome->>'error_code';
  v_has_bytes := p_outcome ? 'sha256' OR p_outcome ? 'size_bytes';
  IF v_state IS NULL OR v_state NOT IN ('uncertain','reported') OR
     (v_has_bytes AND (jsonb_typeof(p_outcome->'sha256') IS DISTINCT FROM 'string' OR COALESCE(p_outcome->>'sha256','') !~ '^[a-fA-F0-9]{64}$' OR
       jsonb_typeof(p_outcome->'size_bytes') IS DISTINCT FROM 'number' OR COALESCE(p_outcome->>'size_bytes','') !~ '^[0-9]{1,8}$')) OR
     (v_state='reported' AND NOT v_has_bytes) OR
     (v_state='reported' AND (jsonb_typeof(p_outcome->'helper_reference_sha256') IS DISTINCT FROM 'string' OR v_ref IS NULL OR v_ref !~ '^[a-f0-9]{64}$' OR v_code IS NOT NULL)) OR
     (v_state='uncertain' AND (v_ref IS NOT NULL OR jsonb_typeof(p_outcome->'error_code') IS DISTINCT FROM 'string' OR v_code IS NULL OR v_code NOT IN ('DEADLINE','HELPER_UNKNOWN','RESULT_LOST','CANCELLED_UNKNOWN'))) THEN
    RAISE EXCEPTION 'Evidência de staging inválida' USING ERRCODE='22023';
  END IF;
  v_hash := lower(p_outcome->>'sha256'); v_size := (p_outcome->>'size_bytes')::bigint;
  IF v_has_bytes AND (v_size < 1 OR v_size > LEAST(20971520,(SELECT max_file_bytes FROM public.exam_document_configuration))) THEN
    RAISE EXCEPTION 'Tamanho de staging inválido' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_op FROM public.exam_document_staging_operation WHERE id=p_operation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Operação de staging não encontrada' USING ERRCODE='40001'; END IF;
  IF p_dispatch_nonce IS NULL OR p_dispatch_nonce <> v_op.dispatch_nonce THEN
    RAISE EXCEPTION 'Recibo de staging divergente' USING ERRCODE='40001';
  END IF;
  IF v_has_bytes AND v_op.sha256 IS NOT NULL AND (v_op.sha256 <> v_hash OR v_op.size_bytes <> v_size) THEN
    RAISE EXCEPTION 'Resultado pertence a bytes diferentes' USING ERRCODE='40001';
  END IF;
  SELECT document_id INTO v_doc FROM public.exam_document_source WHERE id=v_op.source_id;
  SELECT * INTO v_document FROM public.exam_document WHERE id=v_doc;
  IF v_has_bytes AND v_document.sha256 IS NOT NULL AND (v_document.sha256 <> v_hash OR v_document.size_bytes <> v_size) THEN
    RAISE EXCEPTION 'Resultado diverge do documento reservado' USING ERRCODE='40001';
  END IF;
  IF v_op.status='reported' THEN
    IF v_state='reported' AND v_ref <> v_op.helper_reference_sha256 THEN
      RAISE EXCEPTION 'Referência de staging mudou; investigar sem repetir' USING ERRCODE='40001';
    END IF;
    -- An out-of-order timeout must not erase an already reported late result.
  ELSE
    UPDATE public.exam_document_staging_operation SET status=v_state,
      sha256=COALESCE(sha256,v_hash),size_bytes=COALESCE(size_bytes,v_size),
      reported_at=CASE WHEN v_state='reported' THEN now() ELSE NULL END,
      helper_reference_sha256=v_ref,error_code=v_code WHERE id=v_op.id RETURNING * INTO v_op;
    PERFORM public.log_exam_document(v_doc,'staging_'||v_state,jsonb_build_object('operation_id',v_op.id,'source_id',v_op.source_id,'error_code',v_code));
  END IF;
  RETURN jsonb_build_object('operation_id',v_op.id,'source_id',v_op.source_id,'status',v_op.status,
    'dispatch_allowed',false,'ready_for_drive',false,'helper_reference_sha256',v_op.helper_reference_sha256);
END;
$$;
REVOKE ALL ON FUNCTION public.begin_exam_document_staging(jsonb,jsonb,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_exam_document_staging(uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_exam_document_staging(jsonb,jsonb,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_exam_document_staging(uuid,uuid,jsonb) TO service_role;
