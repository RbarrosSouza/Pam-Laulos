-- Gmail logical origin identity: account + immutable message ID + immutable part ID.
-- Preserve historical source keys, locators, events, permissions and active settings.
-- Only the operational reserve_source lookup changes; no data cleanup or activation.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
SET LOCAL search_path=pg_catalog,public;
LOCK TABLE public.exam_document,public.exam_document_source IN SHARE ROW EXCLUSIVE MODE NOWAIT;
CREATE TEMP TABLE exam_gmail_identity_rpc_before ON COMMIT DROP AS
 SELECT p.oid,p.proowner,p.proacl,p.proconfig,p.prosecdef,p.provolatile,p.proparallel,p.proleakproof
 FROM pg_proc p WHERE p.oid='public.reserve_exam_document_source(jsonb)'::regprocedure;
DO $guard$
DECLARE p record;
BEGIN
 SELECT f.*,l.lanname INTO STRICT p FROM pg_proc f JOIN pg_language l ON l.oid=f.prolang
 WHERE f.oid='public.reserve_exam_document_source(jsonb)'::regprocedure;
 IF (SELECT count(*) FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace
     WHERE n.nspname='public' AND f.proname='reserve_exam_document_source')<>1
   OR md5(p.prosrc)<>'6108dcc3da7e1fb64afa062ea2c1f462' OR p.prosecdef IS NOT TRUE OR p.lanname<>'plpgsql'
   OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
   OR p.prorettype<>'jsonb'::regtype
   OR NOT has_function_privilege('service_role',p.oid,'EXECUTE')
   OR has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE')
   OR EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee NOT IN (p.proowner,'service_role'::regrole::oid) OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
 THEN RAISE EXCEPTION 'Contrato original de reserve_source divergiu; nenhuma alteração aplicada'; END IF;
END;
$guard$;

CREATE OR REPLACE FUNCTION public.reserve_exam_document_source(p_source jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid; v_existing uuid; v_key text; v_missing boolean; v_unknown boolean;
  v_part text; v_count integer; v_gmail boolean;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_source->>'channel' NOT IN ('email','manual','whatsapp') OR
    NULLIF(p_source->>'account_id','') IS NULL OR NULLIF(p_source->>'message_id','') IS NULL OR
    NULLIF(p_source->>'attachment_id','') IS NULL OR NULLIF(p_source->>'original_name','') IS NULL THEN
    RAISE EXCEPTION 'Origem estável, canal e nome original obrigatórios' USING ERRCODE='22023';
  END IF;
  -- A Gmail attachmentId is a locator for downloading bytes, not origin identity.
  -- Preserve stored keys/metadata and use immutable account/message/part identity
  -- for the lookup and lock. No per-read UPDATE, alias or event is necessary.
  v_gmail := p_source->>'channel'='email' AND p_source->'metadata'->>'provider'='gmail'
    AND (p_source->>'attachment_id'<>'missing-pdf' OR p_source->'metadata' ? 'gmail_part_id');
  IF v_gmail THEN
    IF jsonb_typeof(p_source->'metadata'->'gmail_part_id') IS DISTINCT FROM 'string'
      OR length(p_source->'metadata'->>'gmail_part_id')>2048
      OR p_source->'metadata'->>'gmail_part_id' ~ '[[:cntrl:]]'
      OR p_source->>'account_id' IS DISTINCT FROM 'gmail:'||(p_source->'metadata'->>'mailbox')
      OR p_source->>'message_id' IS DISTINCT FROM p_source->'metadata'->>'gmail_message_id' THEN
      RAISE EXCEPTION 'Identidade imutável da parte Gmail inválida' USING ERRCODE='22023';
    END IF;
    v_part := p_source->'metadata'->>'gmail_part_id';
    v_key := jsonb_build_array('gmail_part_v1',p_source->>'account_id',p_source->>'message_id',v_part)::text;
  ELSE
    v_key := (p_source->>'channel')||':'||(p_source->>'account_id')||':'||(p_source->>'message_id')||':'||(p_source->>'attachment_id');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key,0));
  IF v_gmail THEN
    -- Missing/conflicting historical identities cannot be guessed from a filename.
    IF EXISTS(SELECT 1 FROM public.exam_document_source s
      WHERE s.channel='email' AND s.account_id=p_source->>'account_id' AND s.message_id=p_source->>'message_id'
        AND ((s.attachment_id=p_source->>'attachment_id' AND s.metadata->>'gmail_part_id' IS DISTINCT FROM v_part)
          OR (s.attachment_id LIKE 'gmail-part:%' AND jsonb_typeof(s.metadata->'gmail_part_id') IS DISTINCT FROM 'string')
          OR (s.metadata->>'gmail_part_id'=v_part AND
            (jsonb_typeof(s.metadata->'gmail_part_id') IS DISTINCT FROM 'string'
              OR s.metadata->>'provider' IS DISTINCT FROM 'gmail'
              OR s.metadata->>'mailbox' IS DISTINCT FROM p_source->'metadata'->>'mailbox'
              OR s.metadata->>'gmail_message_id' IS DISTINCT FROM p_source->>'message_id')))) THEN
      RAISE EXCEPTION 'Histórico da origem Gmail sem identidade comprovada' USING ERRCODE='23514';
    END IF;
    SELECT count(DISTINCT COALESCE(d.canonical_document_id,d.id)),
      min(COALESCE(d.canonical_document_id,d.id)::text)::uuid INTO v_count,v_existing
    FROM public.exam_document_source s JOIN public.exam_document d ON d.id=s.document_id
    WHERE s.channel='email' AND s.account_id=p_source->>'account_id' AND s.message_id=p_source->>'message_id'
      AND s.metadata->>'gmail_part_id'=v_part;
    IF v_count>1 THEN
      RAISE EXCEPTION 'Parte Gmail associada a documentos divergentes; revisão obrigatória' USING ERRCODE='23514';
    ELSIF v_count=1 THEN
      IF NOT EXISTS(SELECT 1 FROM public.exam_document d WHERE d.id=v_existing AND d.canonical_document_id IS NULL) THEN
        RAISE EXCEPTION 'Canônico Gmail não conclusivo; revisão obrigatória' USING ERRCODE='23514';
      END IF;
      RETURN jsonb_build_object('document_id',v_existing,'duplicate',true,
        'document',(SELECT to_jsonb(d) FROM public.exam_document d WHERE id=v_existing));
    END IF;
  END IF;
  SELECT document_id INTO v_existing FROM public.exam_document_source
    WHERE channel=p_source->>'channel' AND account_id=p_source->>'account_id'
      AND message_id=p_source->>'message_id' AND attachment_id=p_source->>'attachment_id';
  IF FOUND THEN
    RETURN jsonb_build_object('document_id',v_existing,'duplicate',true,'document',(SELECT to_jsonb(d) FROM public.exam_document d WHERE id=v_existing));
  END IF;
  v_missing := COALESCE((p_source->'metadata'->>'missing_attachment')::boolean,false);
  v_unknown := COALESCE((p_source->'metadata'->>'unknown_sender')::boolean,false);
  INSERT INTO public.exam_document(original_name,mime_type,received_at,identification_status,review_reason)
  VALUES(p_source->>'original_name',COALESCE(p_source->>'mime_type','application/pdf'),
    COALESCE((p_source->>'received_at')::timestamptz,now()),CASE WHEN v_missing OR v_unknown THEN 'review' ELSE 'unidentified' END,
    CASE WHEN v_missing THEN 'Notificação sem arquivo: aguardar obtenção do resultado' WHEN v_unknown THEN 'Remetente novo: conferência humana obrigatória' END) RETURNING id INTO v_id;
  INSERT INTO public.exam_document_source(document_id,channel,account_id,message_id,attachment_id,received_at,metadata)
  VALUES(v_id,p_source->>'channel',p_source->>'account_id',p_source->>'message_id',p_source->>'attachment_id',
    COALESCE((p_source->>'received_at')::timestamptz,now()),COALESCE(p_source->'metadata','{}')||jsonb_build_object('original_name',p_source->>'original_name','mime_type',p_source->>'mime_type'));
  PERFORM public.log_exam_document(v_id,'source_reserved',jsonb_build_object('channel',p_source->>'channel','missing_attachment',v_missing));
  RETURN jsonb_build_object('document_id',v_id,'duplicate',false,'document',(SELECT to_jsonb(d) FROM public.exam_document d WHERE id=v_id));
END;
$$;
DO $guard$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.reserve_exam_document_source(jsonb)'::regprocedure)<>'ea4f2ca17e18ed109e9ecd958ff09bc9'
   OR (SELECT to_jsonb(p) FROM (SELECT oid,proowner,proacl,proconfig,prosecdef,provolatile,proparallel,proleakproof
       FROM pg_proc WHERE oid='public.reserve_exam_document_source(jsonb)'::regprocedure) p)
     IS DISTINCT FROM (SELECT to_jsonb(p) FROM exam_gmail_identity_rpc_before p)
 THEN RAISE EXCEPTION 'Pós-condição da origem Gmail divergiu'; END IF;
END;
$guard$;
COMMIT;
