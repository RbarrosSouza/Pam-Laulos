-- Optional worker collection journal. Installing does not enable/import workflows.
-- Provider completeness and physical byte readback remain adapter responsibilities.
-- Gmail v1 uses collection_scope=gmail_all_mail in the API. The legacy folder_id
-- ledger column is only an internal partition key; it is never a Gmail label or
-- a Graph folder mapping. This migration is still local/unpublished.
BEGIN;
CREATE TABLE public.exam_collection_cursor (
  collector_id text PRIMARY KEY CHECK (collector_id ~ '^[A-Za-z0-9_.:-]{1,96}$'),
  scope_key text NOT NULL CHECK (scope_key ~ '^[a-f0-9]{64}$'),
  scope_manifest jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  received_through timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((revision = 0) = (received_through IS NULL))
);
CREATE TABLE public.exam_collection_sweep (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collector_id text NOT NULL REFERENCES public.exam_collection_cursor(collector_id),
  request_id uuid NOT NULL,
  expected_revision bigint NOT NULL CHECK (expected_revision >= 0),
  received_from timestamptz NOT NULL,
  received_through timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','failed','committed')),
  conclusive boolean NOT NULL DEFAULT false,
  event_count integer NOT NULL DEFAULT 0 CHECK (event_count BETWEEN 0 AND 100000),
  committed_revision bigint,
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  finished_at timestamptz,
  UNIQUE (collector_id, request_id),
  CHECK (received_through > received_from),
  CHECK (expires_at > started_at),
  CHECK ((status = 'committed') = (committed_revision IS NOT NULL))
);
CREATE UNIQUE INDEX exam_collection_one_running ON public.exam_collection_sweep(collector_id) WHERE status='running';
CREATE TABLE public.exam_collection_message (
  sweep_id uuid NOT NULL REFERENCES public.exam_collection_sweep(id),
  folder_id text NOT NULL,
  message_id text NOT NULL,
  completed boolean NOT NULL DEFAULT false,
  attachment_count integer,
  PRIMARY KEY(sweep_id,folder_id,message_id)
);
CREATE TABLE public.exam_collection_origin (
  sweep_id uuid NOT NULL REFERENCES public.exam_collection_sweep(id),
  folder_id text NOT NULL,
  message_id text NOT NULL,
  attachment_id text NOT NULL,
  source_id uuid REFERENCES public.exam_document_source(id),
  disposition text NOT NULL DEFAULT 'discovered' CHECK (disposition IN ('discovered','saved','excluded')),
  PRIMARY KEY(sweep_id,folder_id,message_id,attachment_id),
  FOREIGN KEY(sweep_id,folder_id,message_id) REFERENCES public.exam_collection_message(sweep_id,folder_id,message_id),
  CHECK (disposition <> 'saved' OR source_id IS NOT NULL)
);
CREATE TABLE public.exam_collection_folder (
  sweep_id uuid NOT NULL REFERENCES public.exam_collection_sweep(id),
  folder_id text NOT NULL,
  message_count integer NOT NULL CHECK (message_count BETWEEN 0 AND 10000),
  PRIMARY KEY(sweep_id,folder_id)
);
CREATE TABLE public.exam_collection_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sweep_id uuid NOT NULL REFERENCES public.exam_collection_sweep(id),
  kind text NOT NULL,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(metadata::text) <= 4096)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['exam_collection_cursor','exam_collection_sweep','exam_collection_message','exam_collection_origin','exam_collection_folder','exam_collection_event'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON public.%I TO service_role',t);
  END LOOP;
END $$;
GRANT USAGE,SELECT ON SEQUENCE public.exam_collection_event_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.exam_collection_gmail_source_in_scope(
  p_source public.exam_document_source,p_manifest jsonb,p_from timestamptz,p_through timestamptz
) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT COALESCE(p_source.channel='email' AND p_source.account_id=p_manifest->>'account_id' AND
    p_source.received_at>=p_from AND p_source.received_at<p_through AND
    p_source.metadata->>'provider'='gmail' AND p_source.metadata->>'mailbox'=p_manifest->>'mailbox' AND
    p_source.metadata->>'gmail_message_id'=p_source.message_id AND
    jsonb_typeof(p_source.metadata->'gmail_part_id')='string' AND
    length(p_source.metadata->>'gmail_part_id')<=2048 AND
    (p_source.metadata->>'gmail_part_id') !~ '[[:cntrl:]]' AND
    jsonb_typeof(p_source.metadata->'gmail_attachment_id')='string' AND
    length(p_source.metadata->>'gmail_attachment_id') BETWEEN 1 AND 2048 AND
    (p_source.metadata->>'gmail_attachment_id') !~ '[[:cntrl:]]' AND
    p_source.attachment_id='gmail-part:['||(p_source.metadata->'gmail_part_id')::text||','||
      (p_source.metadata->'gmail_attachment_id')::text||']',false)
$$;
REVOKE ALL ON FUNCTION public.exam_collection_gmail_source_in_scope(public.exam_document_source,jsonb,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.exam_collection_gmail_source_in_scope(public.exam_document_source,jsonb,timestamptz,timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.load_exam_collection_checkpoint(p_collector_id text,p_scope_key text,p_sweep_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.exam_collection_cursor; s public.exam_collection_sweep; a public.exam_collection_sweep;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_collector_id IS NULL OR p_collector_id !~ '^[A-Za-z0-9_.:-]{1,96}$' OR p_scope_key IS NULL OR p_scope_key !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Identidade da coleta inválida' USING ERRCODE='22023';
  END IF;
  SELECT * INTO c FROM public.exam_collection_cursor WHERE collector_id=p_collector_id;
  IF FOUND AND c.scope_key <> p_scope_key THEN RAISE EXCEPTION 'Escopo da coleta mudou; rescan explícito necessário' USING ERRCODE='40001'; END IF;
  IF p_sweep_id IS NOT NULL THEN
    SELECT * INTO s FROM public.exam_collection_sweep WHERE id=p_sweep_id AND collector_id=p_collector_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Sweep não pertence à coleta' USING ERRCODE='40001'; END IF;
  ELSE
    SELECT * INTO s FROM public.exam_collection_sweep WHERE collector_id=p_collector_id ORDER BY started_at DESC,id DESC LIMIT 1;
  END IF;
  SELECT * INTO a FROM public.exam_collection_sweep WHERE collector_id=p_collector_id AND status='running';
  RETURN jsonb_build_object('server_now',now(),'checkpoint',CASE WHEN c.received_through IS NOT NULL THEN
    jsonb_build_object('scope_key',c.scope_key,'revision',c.revision::text,'received_through',c.received_through) ELSE NULL END,
    'sweep',CASE WHEN s.id IS NOT NULL THEN jsonb_build_object('sweep_id',s.id,'request_id',s.request_id,'status',s.status,
      'conclusive',s.conclusive,'committed_revision',s.committed_revision::text,'received_through',s.received_through) ELSE NULL END,
    'active_sweep',CASE WHEN a.id IS NOT NULL THEN jsonb_build_object('sweep_id',a.id,'request_id',a.request_id,'expires_at',a.expires_at) ELSE NULL END);
END $$;

CREATE OR REPLACE FUNCTION public.begin_exam_collection_sweep(
  p_collector_id text,p_scope_key text,p_scope_manifest jsonb,p_received_from timestamptz,p_received_through timestamptz,
  p_expected_revision bigint,p_request_id uuid,p_ttl_seconds integer DEFAULT 900
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.exam_collection_cursor; s public.exam_collection_sweep; f jsonb; v_from timestamptz; v_initial timestamptz; v_lookback integer; v_gmail boolean;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_collector_id IS NULL OR p_collector_id !~ '^[A-Za-z0-9_.:-]{1,96}$' OR p_scope_key IS NULL OR p_scope_key !~ '^[a-f0-9]{64}$' OR
    p_request_id IS NULL OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 1 AND 3600 OR p_expected_revision < 0 OR
    p_received_from IS NULL OR p_received_through IS NULL OR p_received_through <= p_received_from OR p_received_through>now() THEN
    RAISE EXCEPTION 'Contrato de sweep inválido' USING ERRCODE='22023';
  END IF;
  IF p_scope_manifest IS NULL OR jsonb_typeof(p_scope_manifest) <> 'object' OR octet_length(p_scope_manifest::text)>16384 OR
    p_scope_manifest::text ~ '://|[\r\n]' OR
    jsonb_typeof(p_scope_manifest->'account_id') IS DISTINCT FROM 'string' OR length(p_scope_manifest->>'account_id') NOT BETWEEN 1 AND 256 OR
    jsonb_typeof(p_scope_manifest->'mailbox') IS DISTINCT FROM 'string' OR length(p_scope_manifest->>'mailbox') NOT BETWEEN 1 AND 320 OR
    jsonb_typeof(p_scope_manifest->'initial_received_from') IS DISTINCT FROM 'string' OR
    jsonb_typeof(p_scope_manifest->'lookback_seconds') IS DISTINCT FROM 'number' OR COALESCE(p_scope_manifest->>'lookback_seconds','') !~ '^[0-9]{1,8}$' THEN
    RAISE EXCEPTION 'Escopo sanitizado obrigatório' USING ERRCODE='22023';
  END IF;
  v_gmail:=p_scope_manifest->>'provider'='gmail';
  IF COALESCE(v_gmail,false) THEN
    IF (p_scope_manifest - ARRAY['provider','manifest_version','account_id','mailbox','scope_kind','include_spam_trash','read_state',
      'initial_received_from','lookback_seconds','identity_policy','source_policy','message_exclusion_policy','candidate_policy_sha256'])<>'{}'::jsonb OR
      p_scope_manifest->'manifest_version' IS DISTINCT FROM '1'::jsonb OR
      p_scope_manifest->>'account_id' IS DISTINCT FROM 'gmail:'||(p_scope_manifest->>'mailbox') OR
      p_scope_manifest->>'scope_kind' IS DISTINCT FROM 'gmail_all_mail' OR
      jsonb_typeof(p_scope_manifest->'include_spam_trash') IS DISTINCT FROM 'boolean' OR
      p_scope_manifest->>'read_state' IS DISTINCT FROM 'any' OR
      p_scope_manifest->>'identity_policy' IS DISTINCT FROM 'gmail_message_part_v1_with_hash_dedup' OR
      p_scope_manifest->>'source_policy' IS DISTINCT FROM 'pdf_parts_and_notices_v1' OR
      p_scope_manifest->>'message_exclusion_policy' IS DISTINCT FROM 'no_pdf_no_exam_hint_v1' OR
      jsonb_typeof(p_scope_manifest->'candidate_policy_sha256') IS DISTINCT FROM 'string' OR
      COALESCE(p_scope_manifest->>'candidate_policy_sha256','') !~ '^[a-f0-9]{64}$' OR
      COALESCE(p_scope_manifest->>'initial_received_from','') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
      RAISE EXCEPTION 'Manifesto Gmail v1 explícito obrigatório' USING ERRCODE='22023';
    END IF;
  ELSE
  IF (p_scope_manifest - ARRAY['account_id','mailbox','folder_ids','initial_received_from','lookback_seconds','identity_policy','exclude_inline_images','exclusion_policy_evidence'])<>'{}'::jsonb OR
    jsonb_typeof(p_scope_manifest->'folder_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(p_scope_manifest->'folder_ids') NOT BETWEEN 1 AND 100 OR
    COALESCE(p_scope_manifest->>'identity_policy','') NOT IN ('rest_id_with_hash_dedup','require_translation') OR
    jsonb_typeof(p_scope_manifest->'exclude_inline_images') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'Escopo Outlook sanitizado obrigatório' USING ERRCODE='22023';
  END IF;
  FOR f IN SELECT value FROM jsonb_array_elements(p_scope_manifest->'folder_ids') LOOP
    IF jsonb_typeof(f) <> 'string' OR length(f #>> '{}') NOT BETWEEN 1 AND 2048 OR (f #>> '{}') ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION 'Pasta de coleta inválida' USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM jsonb_array_elements(p_scope_manifest->'folder_ids')) <>
    (SELECT count(DISTINCT value) FROM jsonb_array_elements(p_scope_manifest->'folder_ids')) THEN
    RAISE EXCEPTION 'Pastas repetidas' USING ERRCODE='22023';
  END IF;
  IF (p_scope_manifest->>'exclude_inline_images')::boolean AND
    (jsonb_typeof(p_scope_manifest->'exclusion_policy_evidence') IS DISTINCT FROM 'string' OR length(p_scope_manifest->>'exclusion_policy_evidence') NOT BETWEEN 1 AND 256) THEN
    RAISE EXCEPTION 'Política de exclusão não registrada' USING ERRCODE='22023';
  END IF;
  IF NOT (p_scope_manifest->>'exclude_inline_images')::boolean AND
    COALESCE(jsonb_typeof(p_scope_manifest->'exclusion_policy_evidence'),'null') <> 'null' THEN
    RAISE EXCEPTION 'Política de exclusão inconsistente' USING ERRCODE='22023';
  END IF;
  END IF;
  v_initial := (p_scope_manifest->>'initial_received_from')::timestamptz;
  v_lookback := (p_scope_manifest->>'lookback_seconds')::integer;
  IF v_lookback NOT BETWEEN 0 AND 31622400 THEN RAISE EXCEPTION 'Lookback fora do limite' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('exam_collection:'||p_collector_id,0));
  INSERT INTO public.exam_collection_cursor(collector_id,scope_key,scope_manifest) VALUES(p_collector_id,p_scope_key,p_scope_manifest) ON CONFLICT DO NOTHING;
  SELECT * INTO c FROM public.exam_collection_cursor WHERE collector_id=p_collector_id FOR UPDATE;
  IF c.scope_key<>p_scope_key OR c.scope_manifest<>p_scope_manifest THEN RAISE EXCEPTION 'Escopo da coleta é imutável; criar rescan explícito' USING ERRCODE='40001'; END IF;
  IF c.revision<>COALESCE(p_expected_revision,0) THEN RAISE EXCEPTION 'Revisão do checkpoint mudou' USING ERRCODE='40001'; END IF;
  v_from := CASE WHEN c.received_through IS NULL THEN v_initial ELSE greatest(v_initial,c.received_through-make_interval(secs=>v_lookback)) END;
  IF p_received_from<>v_from OR (c.received_through IS NOT NULL AND p_received_through<=c.received_through) THEN
    RAISE EXCEPTION 'Janela não corresponde ao corte/lookback/checkpoint' USING ERRCODE='40001';
  END IF;
  SELECT * INTO s FROM public.exam_collection_sweep WHERE collector_id=p_collector_id AND request_id=p_request_id;
  IF FOUND THEN
    IF s.received_from<>p_received_from OR s.received_through<>p_received_through OR s.expected_revision<>COALESCE(p_expected_revision,0) THEN
      RAISE EXCEPTION 'Identidade da requisição tem janela diferente' USING ERRCODE='40001';
    END IF;
    RETURN jsonb_build_object('sweep_id',s.id,'started',false,'status',s.status,'reason','existing_request');
  END IF;
  SELECT * INTO s FROM public.exam_collection_sweep WHERE collector_id=p_collector_id AND status='running' FOR UPDATE;
  IF FOUND THEN
    IF s.expires_at>now() THEN RAISE EXCEPTION 'Outro sweep está ativo' USING ERRCODE='40001'; END IF;
    UPDATE public.exam_collection_sweep SET status='failed',finished_at=now(),event_count=event_count+1 WHERE id=s.id;
    INSERT INTO public.exam_collection_event(sweep_id,kind,metadata) VALUES(s.id,'failure',jsonb_build_object('code','sweep_expired'));
  END IF;
  INSERT INTO public.exam_collection_sweep(collector_id,request_id,expected_revision,received_from,received_through,expires_at)
    VALUES(p_collector_id,p_request_id,c.revision,p_received_from,p_received_through,now()+make_interval(secs=>p_ttl_seconds)) RETURNING * INTO s;
  RETURN jsonb_build_object('sweep_id',s.id,'started',true,'status',s.status);
END $$;

CREATE OR REPLACE FUNCTION public.record_exam_collection_event(p_sweep_id uuid,p_event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.exam_collection_sweep; c public.exam_collection_cursor; v_kind text; o jsonb; v_folder text; v_message text; v_attachment text;
  v_source public.exam_document_source; v_doc public.exam_document; v_origin public.exam_collection_origin; v_count integer; k text; v jsonb;
  v_gmail boolean; v_received_at timestamptz;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_event IS NULL OR jsonb_typeof(p_event)<>'object' OR octet_length(p_event::text)>4096 OR
    (p_event-ARRAY['kind','origin','document_id','duplicate','counts','code','rule','policy_evidence','received_at','attachment_count','attachment_pages','message_count','message_pages'])<>'{}'::jsonb OR
    p_event::text ~ '://|[\r\n]' THEN RAISE EXCEPTION 'Evento deve conter apenas metadados sanitizados' USING ERRCODE='22023'; END IF;
  v_kind:=p_event->>'kind';
  IF v_kind IS NULL OR v_kind NOT IN ('message_discovered','origin_discovered','origin_saved','attachment_excluded','message_completed','message_excluded','folder_completed','mailbox_completed','failure','sweep_conclusive') THEN
    RAISE EXCEPTION 'Tipo de evento inválido' USING ERRCODE='22023';
  END IF;
  IF (p_event ? 'document_id' AND (jsonb_typeof(p_event->'document_id')<>'string' OR
    COALESCE(p_event->>'document_id','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')) OR
    (p_event ? 'duplicate' AND jsonb_typeof(p_event->'duplicate')<>'boolean') OR
    (p_event ? 'counts' AND v_kind<>'sweep_conclusive') OR
    (p_event ? 'code' AND v_kind<>'failure') OR
    ((p_event ? 'rule' OR p_event ? 'policy_evidence') AND v_kind NOT IN ('attachment_excluded','message_excluded')) OR
    (p_event ? 'received_at' AND v_kind<>'message_excluded') OR
    ((p_event ? 'message_count' OR p_event ? 'message_pages') AND v_kind NOT IN ('folder_completed','mailbox_completed')) OR
    ((p_event ? 'attachment_count' OR p_event ? 'attachment_pages') AND v_kind<>'message_completed') THEN
    RAISE EXCEPTION 'Campos de evento não correspondem ao tipo' USING ERRCODE='22023';
  END IF;
  IF p_event ? 'counts' THEN
    IF jsonb_typeof(p_event->'counts')<>'object' OR
      ((p_event->'counts')-ARRAY['folders','mailbox_scopes','message_pages','messages','attachment_pages','attachments','reserved','saved','already_saved','excluded_messages','excluded_inline_images','repeated_messages','repeated_attachments'])<>'{}'::jsonb THEN
      RAISE EXCEPTION 'Contagens inválidas' USING ERRCODE='22023';
    END IF;
    FOR k,v IN SELECT key,value FROM jsonb_each(p_event->'counts') LOOP
      IF jsonb_typeof(v)<>'number' OR (v #>> '{}') !~ '^[0-9]{1,7}$' OR (v #>> '{}')::integer>1000000 THEN RAISE EXCEPTION 'Contagens inválidas' USING ERRCODE='22023'; END IF;
    END LOOP;
  END IF;
  FOREACH k IN ARRAY ARRAY['attachment_count','attachment_pages','message_count','message_pages'] LOOP
    IF p_event ? k AND (jsonb_typeof(p_event->k)<>'number' OR (p_event->>k) !~ '^[0-9]{1,6}$') THEN RAISE EXCEPTION 'Contagens inválidas' USING ERRCODE='22023'; END IF;
  END LOOP;
  SELECT * INTO s FROM public.exam_collection_sweep WHERE id=p_sweep_id FOR UPDATE;
  IF NOT FOUND OR s.status='committed' THEN RAISE EXCEPTION 'Sweep indisponível para eventos' USING ERRCODE='40001'; END IF;
  IF s.event_count>=99999 THEN RAISE EXCEPTION 'Limite de eventos; aguardar expiração sem checkpoint' USING ERRCODE='40001'; END IF;
  SELECT * INTO c FROM public.exam_collection_cursor WHERE collector_id=s.collector_id;
  v_gmail:=COALESCE(c.scope_manifest->>'provider'='gmail',false);
  IF (v_gmail AND v_kind IN ('folder_completed','attachment_excluded')) OR
    (NOT v_gmail AND v_kind IN ('mailbox_completed','message_excluded')) THEN
    RAISE EXCEPTION 'Tipo de evento não corresponde ao provider' USING ERRCODE='22023';
  END IF;
  o:=p_event->'origin';
  IF o IS NOT NULL AND o<>'null'::jsonb THEN
    IF jsonb_typeof(o)<>'object' OR
      (o-CASE WHEN v_gmail THEN ARRAY['account_id','mailbox','collection_scope','message_id','attachment_id'] ELSE ARRAY['account_id','mailbox','folder_id','message_id','attachment_id'] END)<>'{}'::jsonb OR
      o->>'account_id' IS DISTINCT FROM c.scope_manifest->>'account_id' OR o->>'mailbox' IS DISTINCT FROM c.scope_manifest->>'mailbox' THEN
      RAISE EXCEPTION 'Origem fora do escopo' USING ERRCODE='40001';
    END IF;
    v_message:=o->>'message_id'; v_attachment:=o->>'attachment_id';
    IF v_gmail THEN
      IF jsonb_typeof(o->'collection_scope') IS DISTINCT FROM 'string' OR o->>'collection_scope' IS DISTINCT FROM c.scope_manifest->>'scope_kind' THEN
        RAISE EXCEPTION 'Coleção Gmail fora do escopo' USING ERRCODE='40001';
      END IF;
      v_folder:=o->>'collection_scope';
    ELSE
      v_folder:=o->>'folder_id';
      IF jsonb_typeof(o->'folder_id') IS DISTINCT FROM 'string' OR NOT (c.scope_manifest->'folder_ids' ? v_folder) THEN RAISE EXCEPTION 'Pasta fora do escopo' USING ERRCODE='40001'; END IF;
    END IF;
    FOREACH k IN ARRAY ARRAY['message_id','attachment_id'] LOOP
      IF o ? k AND o->k<>'null'::jsonb AND (jsonb_typeof(o->k)<>'string' OR length(o->>k) NOT BETWEEN 1 AND 2048 OR (o->>k) ~ '[[:cntrl:]]') THEN
        RAISE EXCEPTION 'IDs de origem inválidos' USING ERRCODE='22023';
      END IF;
    END LOOP;
  ELSIF v_kind NOT IN ('failure','sweep_conclusive') THEN RAISE EXCEPTION 'Origem obrigatória no evento' USING ERRCODE='22023'; END IF;
  IF v_kind IN ('message_discovered','message_completed','message_excluded','origin_discovered','origin_saved','attachment_excluded') AND v_message IS NULL THEN
    RAISE EXCEPTION 'Mensagem obrigatória' USING ERRCODE='22023';
  END IF;
  IF v_kind IN ('origin_discovered','origin_saved','attachment_excluded') AND v_attachment IS NULL THEN RAISE EXCEPTION 'Anexo obrigatório' USING ERRCODE='22023'; END IF;
  IF v_kind='message_discovered' THEN
    INSERT INTO public.exam_collection_message(sweep_id,folder_id,message_id) VALUES(s.id,v_folder,v_message) ON CONFLICT DO NOTHING;
  ELSIF v_kind='origin_discovered' THEN
    INSERT INTO public.exam_collection_origin(sweep_id,folder_id,message_id,attachment_id) VALUES(s.id,v_folder,v_message,v_attachment) ON CONFLICT DO NOTHING;
  ELSIF v_kind IN ('origin_saved','attachment_excluded') THEN
    SELECT * INTO v_origin FROM public.exam_collection_origin WHERE sweep_id=s.id AND folder_id=v_folder AND message_id=v_message AND attachment_id=v_attachment FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Descobrir origem antes de concluí-la' USING ERRCODE='40001'; END IF;
    IF v_kind='origin_saved' THEN
      SELECT * INTO v_source FROM public.exam_document_source WHERE channel='email' AND account_id=c.scope_manifest->>'account_id' AND message_id=v_message AND attachment_id=v_attachment;
      IF NOT FOUND THEN RAISE EXCEPTION 'Origem de arquivo não reservada' USING ERRCODE='40001'; END IF;
      IF v_gmail AND NOT public.exam_collection_gmail_source_in_scope(v_source,c.scope_manifest,s.received_from,s.received_through) THEN
        RAISE EXCEPTION 'Origem Gmail não corresponde à tupla/provider/janela' USING ERRCODE='40001';
      END IF;
      SELECT * INTO v_doc FROM public.exam_document WHERE id=v_source.document_id;
      IF v_origin.disposition='excluded' OR v_doc.file_status IS DISTINCT FROM 'saved' OR v_doc.canonical_document_id IS NOT NULL OR
        v_doc.sha256 IS NULL OR v_doc.size_bytes IS NULL OR v_doc.size_bytes NOT BETWEEN 1 AND 20971520 OR NULLIF(v_doc.drive_file_id,'') IS NULL OR NULLIF(v_doc.drive_folder_id,'') IS NULL OR
        p_event->>'document_id' IS DISTINCT FROM v_doc.id::text THEN
        RAISE EXCEPTION 'Original canônico não está salvo no banco' USING ERRCODE='40001';
      END IF;
      UPDATE public.exam_collection_origin SET disposition='saved',source_id=v_source.id WHERE sweep_id=s.id AND folder_id=v_folder AND message_id=v_message AND attachment_id=v_attachment;
    ELSE
      IF v_origin.disposition='saved' OR NOT (c.scope_manifest->>'exclude_inline_images')::boolean OR p_event->>'rule' IS DISTINCT FROM 'inline_file_image' OR
        p_event->>'policy_evidence' IS DISTINCT FROM c.scope_manifest->>'exclusion_policy_evidence' THEN
        RAISE EXCEPTION 'Exclusão sem política auditada' USING ERRCODE='40001';
      END IF;
      UPDATE public.exam_collection_origin SET disposition='excluded' WHERE sweep_id=s.id AND folder_id=v_folder AND message_id=v_message AND attachment_id=v_attachment;
    END IF;
  ELSIF v_kind='message_excluded' THEN
    IF p_event->>'policy_evidence' IS DISTINCT FROM c.scope_manifest->>'candidate_policy_sha256' OR
      COALESCE(p_event->>'rule','') NOT IN ('no_pdf_no_exam_hint_v1','outside_received_window') OR v_attachment IS NOT NULL OR
      EXISTS(SELECT 1 FROM public.exam_collection_origin WHERE sweep_id=s.id AND folder_id=v_folder AND message_id=v_message) THEN
      RAISE EXCEPTION 'Exclusão Gmail não pode liberar origem pendente' USING ERRCODE='40001';
    END IF;
    IF p_event->>'rule'='outside_received_window' THEN
      IF jsonb_typeof(p_event->'received_at') IS DISTINCT FROM 'string' OR
        COALESCE(p_event->>'received_at','') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
        RAISE EXCEPTION 'Data recebida explícita obrigatória na exclusão de janela' USING ERRCODE='22023';
      END IF;
      v_received_at:=(p_event->>'received_at')::timestamptz;
      IF v_received_at>=s.received_from AND v_received_at<s.received_through THEN
        RAISE EXCEPTION 'Mensagem recebida dentro da janela não pode ser excluída por data' USING ERRCODE='40001';
      END IF;
      IF EXISTS(SELECT 1 FROM public.exam_document_source WHERE channel='email' AND account_id=c.scope_manifest->>'account_id'
        AND message_id=v_message AND received_at<>v_received_at) THEN
        RAISE EXCEPTION 'Data de exclusão diverge da origem Gmail já reservada' USING ERRCODE='40001';
      END IF;
    ELSIF p_event ? 'received_at' THEN
      RAISE EXCEPTION 'Exclusão por política não admite data de janela' USING ERRCODE='22023';
    ELSIF EXISTS(SELECT 1 FROM public.exam_document_source WHERE channel='email' AND account_id=c.scope_manifest->>'account_id' AND message_id=v_message) THEN
      RAISE EXCEPTION 'Exclusão por política não pode ignorar origem Gmail já reservada' USING ERRCODE='40001';
    END IF;
    UPDATE public.exam_collection_message SET completed=true,attachment_count=0 WHERE sweep_id=s.id AND folder_id=v_folder AND message_id=v_message;
    IF NOT FOUND THEN RAISE EXCEPTION 'Mensagem não descoberta' USING ERRCODE='40001'; END IF;
  ELSIF v_kind='message_completed' THEN
    SELECT count(*) INTO v_count FROM public.exam_collection_origin WHERE sweep_id=s.id AND folder_id=v_folder AND message_id=v_message;
    IF p_event->>'attachment_count' IS NULL OR (v_gmail AND v_count=0) OR v_count<>(p_event->>'attachment_count')::integer OR EXISTS(
      SELECT 1 FROM public.exam_collection_origin WHERE sweep_id=s.id AND folder_id=v_folder AND message_id=v_message AND disposition='discovered') THEN
      RAISE EXCEPTION 'Mensagem tem origens pendentes' USING ERRCODE='40001';
    END IF;
    UPDATE public.exam_collection_message SET completed=true,attachment_count=v_count WHERE sweep_id=s.id AND folder_id=v_folder AND message_id=v_message;
    IF NOT FOUND THEN RAISE EXCEPTION 'Mensagem não descoberta' USING ERRCODE='40001'; END IF;
  ELSIF v_kind IN ('folder_completed','mailbox_completed') THEN
    SELECT count(*) INTO v_count FROM public.exam_collection_message WHERE sweep_id=s.id AND folder_id=v_folder;
    IF p_event->>'message_count' IS NULL OR v_count<>(p_event->>'message_count')::integer OR EXISTS(
      SELECT 1 FROM public.exam_collection_message WHERE sweep_id=s.id AND folder_id=v_folder AND NOT completed) THEN
      RAISE EXCEPTION 'Pasta tem mensagens pendentes' USING ERRCODE='40001';
    END IF;
    INSERT INTO public.exam_collection_folder(sweep_id,folder_id,message_count) VALUES(s.id,v_folder,v_count) ON CONFLICT DO NOTHING;
  ELSIF v_kind='failure' THEN
    IF COALESCE(p_event->>'code','') !~ '^[a-z][a-z0-9_]{0,95}$' THEN RAISE EXCEPTION 'Código de falha inválido' USING ERRCODE='22023'; END IF;
    UPDATE public.exam_collection_sweep SET status='failed',finished_at=COALESCE(finished_at,now()),conclusive=false WHERE id=s.id;
  ELSIF v_kind='sweep_conclusive' THEN
    IF s.status<>'running' THEN RAISE EXCEPTION 'Sweep com falha não pode concluir' USING ERRCODE='40001'; END IF;
    UPDATE public.exam_collection_sweep SET conclusive=true WHERE id=s.id;
  END IF;
  INSERT INTO public.exam_collection_event(sweep_id,kind,metadata) VALUES(s.id,v_kind,p_event);
  UPDATE public.exam_collection_sweep SET event_count=event_count+1 WHERE id=s.id RETURNING * INTO s;
  RETURN jsonb_build_object('recorded',true,'sweep_id',s.id,'status',s.status,'event_count',s.event_count);
END $$;

CREATE OR REPLACE FUNCTION public.commit_exam_collection_sweep(p_sweep_id uuid,p_expected_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.exam_collection_sweep; c public.exam_collection_cursor; v_collector text;
BEGIN
  PERFORM public.require_exam_document_service();
  SELECT collector_id INTO v_collector FROM public.exam_collection_sweep WHERE id=p_sweep_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sweep não encontrado' USING ERRCODE='40001'; END IF;
  -- Same lock order as begin: cursor then sweep, never a reversed pair.
  SELECT * INTO c FROM public.exam_collection_cursor WHERE collector_id=v_collector FOR UPDATE;
  SELECT * INTO s FROM public.exam_collection_sweep WHERE id=p_sweep_id FOR UPDATE;
  IF s.expected_revision<>COALESCE(p_expected_revision,0) THEN RAISE EXCEPTION 'Revisão da requisição diverge' USING ERRCODE='40001'; END IF;
  IF s.status='committed' THEN RETURN jsonb_build_object('committed',true,'already_committed',true,'checkpoint',
    jsonb_build_object('scope_key',c.scope_key,'revision',s.committed_revision::text,'received_through',s.received_through)); END IF;
  IF s.status<>'running' OR NOT s.conclusive OR s.expires_at<=now() OR c.revision<>s.expected_revision OR
    (SELECT count(*) FROM public.exam_collection_folder WHERE sweep_id=s.id)<>(CASE WHEN c.scope_manifest->>'provider'='gmail' THEN 1 ELSE jsonb_array_length(c.scope_manifest->'folder_ids') END) OR
    EXISTS(SELECT 1 FROM public.exam_collection_message m WHERE m.sweep_id=s.id AND (NOT m.completed OR m.attachment_count IS DISTINCT FROM
      (SELECT count(*) FROM public.exam_collection_origin o WHERE o.sweep_id=m.sweep_id AND o.folder_id=m.folder_id AND o.message_id=m.message_id))) OR
    EXISTS(SELECT 1 FROM public.exam_collection_folder f WHERE f.sweep_id=s.id AND f.message_count<>
      (SELECT count(*) FROM public.exam_collection_message m WHERE m.sweep_id=f.sweep_id AND m.folder_id=f.folder_id)) OR
    EXISTS(SELECT 1 FROM public.exam_collection_origin WHERE sweep_id=s.id AND disposition='discovered') OR
    EXISTS(SELECT 1 FROM public.exam_collection_origin o LEFT JOIN public.exam_document_source src ON src.id=o.source_id
      LEFT JOIN public.exam_document d ON d.id=src.document_id WHERE o.sweep_id=s.id AND o.disposition='saved' AND
        (d.id IS NULL OR d.file_status<>'saved' OR d.canonical_document_id IS NOT NULL OR d.sha256 IS NULL OR
         d.size_bytes IS NULL OR d.size_bytes NOT BETWEEN 1 AND 20971520 OR NULLIF(d.drive_file_id,'') IS NULL OR NULLIF(d.drive_folder_id,'') IS NULL OR
         (c.scope_manifest->>'provider'='gmail' AND (src.channel<>'email' OR src.account_id<>c.scope_manifest->>'account_id' OR
          src.message_id<>o.message_id OR src.attachment_id<>o.attachment_id OR
          NOT public.exam_collection_gmail_source_in_scope(src,c.scope_manifest,s.received_from,s.received_through))))) THEN
    RAISE EXCEPTION 'Sweep incompleto, expirado ou checkpoint concorrente; preservar marco' USING ERRCODE='40001';
  END IF;
  UPDATE public.exam_collection_cursor SET revision=revision+1,received_through=s.received_through,updated_at=now() WHERE collector_id=c.collector_id RETURNING * INTO c;
  UPDATE public.exam_collection_sweep SET status='committed',committed_revision=c.revision,finished_at=now() WHERE id=s.id;
  RETURN jsonb_build_object('committed',true,'checkpoint',jsonb_build_object('scope_key',c.scope_key,'revision',c.revision::text,'received_through',c.received_through));
END $$;

REVOKE ALL ON FUNCTION public.load_exam_collection_checkpoint(text,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.begin_exam_collection_sweep(text,text,jsonb,timestamptz,timestamptz,bigint,uuid,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.record_exam_collection_event(uuid,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.commit_exam_collection_sweep(uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.load_exam_collection_checkpoint(text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_exam_collection_sweep(text,text,jsonb,timestamptz,timestamptz,bigint,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_exam_collection_event(uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_exam_collection_sweep(uuid,bigint) TO service_role;
COMMIT;
