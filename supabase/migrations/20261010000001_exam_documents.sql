-- Shared PamLaudos/PAM Nexus document pipeline, v1. Additive: no historical rows rewritten.
BEGIN;

CREATE TABLE public.exam_document_member (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin','vet','reception')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.is_exam_document_member()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.exam_document_member WHERE user_id = auth.uid() AND active);
$$;
REVOKE ALL ON FUNCTION public.is_exam_document_member() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_exam_document_member() TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.require_exam_document_member(p_roles text[] DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.exam_document_member WHERE user_id = auth.uid() AND active
    AND (p_roles IS NULL OR role = ANY(p_roles))) THEN
    RAISE EXCEPTION 'Equipe autorizada necessária' USING ERRCODE = '42501';
  END IF;
  RETURN auth.uid();
END;
$$;

CREATE OR REPLACE FUNCTION public.require_exam_document_service()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Operação restrita ao serviço de exames' USING ERRCODE = '42501';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.require_exam_document_member(text[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.require_exam_document_service() FROM PUBLIC, anon, authenticated;

CREATE TABLE public.exam_document_configuration (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled_destinations text[] NOT NULL DEFAULT '{}',
  notification_cutoff timestamptz,
  group_destination_key text,
  max_file_bytes bigint NOT NULL DEFAULT 20971520 CHECK (max_file_bytes BETWEEN 1 AND 52428800),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.exam_document_configuration(singleton) VALUES (true);

CREATE TABLE public.exam_document (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version bigint NOT NULL DEFAULT 1,
  previous_document_id uuid REFERENCES public.exam_document(id) ON DELETE RESTRICT,
  canonical_document_id uuid REFERENCES public.exam_document(id) ON DELETE RESTRICT,
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes > 0),
  mime_type text NOT NULL DEFAULT 'application/pdf',
  original_name text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  file_status text NOT NULL DEFAULT 'pending' CHECK (file_status IN ('pending','saved','failed')),
  identification_status text NOT NULL DEFAULT 'unidentified'
    CHECK (identification_status IN ('unidentified','suggested','confirmed','review','not_exam')),
  drive_file_id text,
  drive_folder_id text,
  drive_name text,
  staging_bucket text,
  staging_path text,
  storage_bucket text,
  storage_path text,
  extracted_data jsonb NOT NULL DEFAULT '{}',
  confirmed_data jsonb NOT NULL DEFAULT '{}',
  evidence jsonb NOT NULL DEFAULT '[]',
  extractor_version text,
  review_reason text,
  pet_id uuid REFERENCES public.pets(id) ON DELETE RESTRICT,
  client_code text,
  assigned_to uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  link_confirmed_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  link_confirmed_at timestamptz,
  group_release_at timestamptz,
  group_exception_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (id IS DISTINCT FROM previous_document_id AND id IS DISTINCT FROM canonical_document_id),
  CHECK ((storage_bucket IS NULL) = (storage_path IS NULL)),
  CHECK ((staging_bucket IS NULL) = (staging_path IS NULL)),
  CHECK (file_status <> 'saved' OR (drive_file_id IS NOT NULL AND sha256 IS NOT NULL AND size_bytes IS NOT NULL)),
  CHECK (identification_status <> 'confirmed' OR (pet_id IS NOT NULL AND link_confirmed_by IS NOT NULL AND link_confirmed_at IS NOT NULL))
);
CREATE UNIQUE INDEX exam_document_content_unique ON public.exam_document(sha256,size_bytes)
  WHERE sha256 IS NOT NULL AND canonical_document_id IS NULL;
CREATE INDEX exam_document_received_idx ON public.exam_document(received_at DESC) WHERE canonical_document_id IS NULL;
CREATE INDEX exam_document_pet_idx ON public.exam_document(pet_id);

CREATE TABLE public.exam_document_source (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.exam_document(id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK (channel IN ('email','whatsapp','manual')),
  account_id text NOT NULL,
  message_id text NOT NULL,
  attachment_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(channel,account_id,message_id,attachment_id)
);
CREATE INDEX exam_document_source_document_idx ON public.exam_document_source(document_id);

ALTER TABLE public.exam_card ADD COLUMN IF NOT EXISTS pet_id uuid REFERENCES public.pets(id);
ALTER TABLE public.exam_card ADD COLUMN IF NOT EXISTS client_code text;
ALTER TABLE public.exam_card ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.exam_card DROP CONSTRAINT IF EXISTS exam_card_origin_check;
ALTER TABLE public.exam_card ADD CONSTRAINT exam_card_origin_check CHECK (origin IN ('venda','email','manual','whatsapp'));

CREATE TABLE public.exam_document_item (
  document_id uuid NOT NULL REFERENCES public.exam_document(id) ON DELETE RESTRICT,
  exam_item_id uuid NOT NULL REFERENCES public.exam_item(id) ON DELETE RESTRICT,
  confirmed_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  contacted_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  contacted_at timestamptz,
  contact_channel text,
  contact_note text,
  PRIMARY KEY(document_id,exam_item_id),
  CHECK ((contacted_at IS NULL) = (contacted_by IS NULL))
);
CREATE INDEX exam_document_item_item_idx ON public.exam_document_item(exam_item_id);

CREATE TABLE public.exam_document_delivery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.exam_document(id) ON DELETE RESTRICT,
  destination text NOT NULL CHECK (destination IN ('drive','processing','group','nexus')),
  destination_key text NOT NULL DEFAULT 'default',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','reserved','submitted','sent','uncertain','failed','completed','waived')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  worker text,
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  external_id text,
  external_status text,
  last_error text,
  submitted_at timestamptz,
  sent_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(document_id,destination,destination_key)
);
CREATE INDEX exam_document_delivery_queue_idx ON public.exam_document_delivery(destination,status,next_attempt_at);

CREATE TABLE public.exam_document_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES public.exam_document(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  actor_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX exam_document_event_document_idx ON public.exam_document_event(document_id,created_at DESC);

ALTER TABLE public.exames ADD COLUMN IF NOT EXISTS exam_document_id uuid REFERENCES public.exam_document(id) ON DELETE RESTRICT;
ALTER TABLE public.exames ADD COLUMN IF NOT EXISTS storage_bucket text;
ALTER TABLE public.exames ADD COLUMN IF NOT EXISTS storage_path text;
CREATE UNIQUE INDEX IF NOT EXISTS exames_document_unique ON public.exames(exam_document_id) WHERE exam_document_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.touch_exam_document()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN NEW.version := OLD.version + 1; NEW.updated_at := now(); RETURN NEW; END;
$$;
CREATE TRIGGER touch_exam_document BEFORE UPDATE ON public.exam_document FOR EACH ROW EXECUTE FUNCTION public.touch_exam_document();

-- No client can insert/overwrite evidence through REST. All changes go through RPCs.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['exam_document_member','exam_document_configuration','exam_document','exam_document_source',
    'exam_document_item','exam_document_delivery','exam_document_event'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated',t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['exam_document','exam_document_source','exam_document_item','exam_document_delivery','exam_document_event'] LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated',t);
    EXECUTE format('CREATE POLICY team_read ON public.%I FOR SELECT TO authenticated USING (public.is_exam_document_member())',t);
  END LOOP;
END;
$$;
GRANT SELECT ON public.exam_document_member TO authenticated;
CREATE POLICY own_membership ON public.exam_document_member FOR SELECT TO authenticated USING (user_id = auth.uid());
GRANT USAGE, SELECT ON SEQUENCE public.exam_document_event_id_seq TO service_role;

-- Existing card tables/views used to permit anonymous mutation. Secure this monitoring scope.
DO $$
DECLARE t text; p record;
BEGIN
  FOREACH t IN ARRAY ARRAY['exam_card','exam_item','exam_card_log','lab_shipment'] LOOP
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I',p.policyname,t);
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon',t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated',t);
    EXECUTE format('CREATE POLICY team_monitor_access ON public.%I FOR ALL TO authenticated USING (public.is_exam_document_member()) WITH CHECK (public.is_exam_document_member())',t);
  END LOOP;
END;
$$;

INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES ('exam_documents_private','exam_documents_private',false,52428800,ARRAY['application/pdf'])
ON CONFLICT (id) DO UPDATE SET public=false;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES ('exam_documents_staging','exam_documents_staging',false,20971520,ARRAY['application/pdf'])
ON CONFLICT (id) DO UPDATE SET public=false;
CREATE POLICY exam_document_private_read ON storage.objects FOR SELECT TO authenticated
USING (bucket_id IN ('exam_documents_private','exam_documents_staging') AND public.is_exam_document_member());
-- Existing projects can contain broad Storage policies. Restrictive policies prevent
-- those permissive policies from accidentally opening these new buckets.
CREATE POLICY exam_document_private_read_boundary ON storage.objects AS RESTRICTIVE FOR SELECT TO anon,authenticated
USING (bucket_id NOT IN ('exam_documents_private','exam_documents_staging') OR public.is_exam_document_member());
CREATE POLICY exam_document_private_insert_boundary ON storage.objects AS RESTRICTIVE FOR INSERT TO anon,authenticated
WITH CHECK (bucket_id NOT IN ('exam_documents_private','exam_documents_staging'));
CREATE POLICY exam_document_private_update_boundary ON storage.objects AS RESTRICTIVE FOR UPDATE TO anon,authenticated
USING (bucket_id NOT IN ('exam_documents_private','exam_documents_staging')) WITH CHECK (bucket_id NOT IN ('exam_documents_private','exam_documents_staging'));
CREATE POLICY exam_document_private_delete_boundary ON storage.objects AS RESTRICTIVE FOR DELETE TO anon,authenticated
USING (bucket_id NOT IN ('exam_documents_private','exam_documents_staging'));

CREATE OR REPLACE FUNCTION public.log_exam_document(p_document_id uuid,p_type text,p_details jsonb DEFAULT '{}')
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO public.exam_document_event(document_id,event_type,actor_id,details)
  VALUES(p_document_id,p_type,auth.uid(),p_details);
$$;
REVOKE ALL ON FUNCTION public.log_exam_document(uuid,text,jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.reserve_exam_document_source(p_source jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid; v_existing uuid; v_key text; v_missing boolean; v_unknown boolean;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_source->>'channel' NOT IN ('email','manual','whatsapp') OR
    NULLIF(p_source->>'account_id','') IS NULL OR NULLIF(p_source->>'message_id','') IS NULL OR
    NULLIF(p_source->>'attachment_id','') IS NULL OR NULLIF(p_source->>'original_name','') IS NULL THEN
    RAISE EXCEPTION 'Origem estável, canal e nome original obrigatórios' USING ERRCODE='22023';
  END IF;
  v_key := (p_source->>'channel')||':'||(p_source->>'account_id')||':'||(p_source->>'message_id')||':'||(p_source->>'attachment_id');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key,0));
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

CREATE OR REPLACE FUNCTION public.stage_exam_document_file(p_document_id uuid,p_file jsonb,p_worker text DEFAULT 'ingestion')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_doc public.exam_document; v_canonical public.exam_document; v_task public.exam_document_delivery; v_hash text; v_size bigint;
BEGIN
  PERFORM public.require_exam_document_service();
  v_hash := lower(p_file->>'sha256'); v_size := (p_file->>'size_bytes')::bigint;
  IF v_hash IS NULL OR v_hash !~ '^[a-f0-9]{64}$' OR v_size IS NULL OR v_size<=0
    OR v_size>(SELECT max_file_bytes FROM public.exam_document_configuration) THEN
    RAISE EXCEPTION 'Hash/tamanho inválido ou arquivo excede limite' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_hash||':'||v_size,0));
  SELECT * INTO STRICT v_doc FROM public.exam_document WHERE id=p_document_id FOR NO KEY UPDATE;
  IF v_doc.canonical_document_id IS NOT NULL THEN
    SELECT * INTO STRICT v_doc FROM public.exam_document WHERE id=v_doc.canonical_document_id FOR NO KEY UPDATE;
  END IF;
  IF v_doc.sha256 IS NOT NULL AND (v_doc.sha256<>v_hash OR v_doc.size_bytes<>v_size) THEN
    RAISE EXCEPTION 'Os bytes de uma origem já reservada não podem ser substituídos' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_canonical FROM public.exam_document WHERE sha256=v_hash AND size_bytes=v_size AND canonical_document_id IS NULL FOR NO KEY UPDATE;
  IF FOUND AND v_canonical.id<>v_doc.id THEN
    UPDATE public.exam_document_source SET document_id=v_canonical.id WHERE document_id=v_doc.id;
    UPDATE public.exam_document SET canonical_document_id=v_canonical.id WHERE id=v_doc.id;
    PERFORM public.log_exam_document(v_doc.id,'duplicate_canonical',jsonb_build_object('canonical_document_id',v_canonical.id));
    PERFORM public.log_exam_document(v_canonical.id,'source_deduplicated',jsonb_build_object('duplicate_document_id',v_doc.id));
    v_doc := v_canonical;
    IF v_doc.file_status<>'saved' AND p_file->>'staging_bucket'='exam_documents_staging' AND v_doc.staging_bucket IS NULL THEN
      UPDATE public.exam_document SET staging_bucket='exam_documents_staging',staging_path=id::text||'/original.pdf'
        WHERE id=v_doc.id RETURNING * INTO v_doc;
    END IF;
  ELSE
    UPDATE public.exam_document SET sha256=v_hash,size_bytes=v_size,
      drive_file_id=COALESCE(drive_file_id,NULLIF(p_file->>'drive_file_id','')),
      drive_folder_id=COALESCE(drive_folder_id,NULLIF(p_file->>'drive_folder_id','')),
      staging_bucket=COALESCE(staging_bucket,CASE WHEN p_file->>'staging_bucket'='exam_documents_staging' THEN 'exam_documents_staging' END),
      staging_path=COALESCE(staging_path,CASE WHEN p_file->>'staging_bucket'='exam_documents_staging' THEN id::text||'/original.pdf' END)
    WHERE id=v_doc.id RETURNING * INTO v_doc;
  END IF;
  IF v_doc.file_status='saved' THEN
    RETURN jsonb_build_object('document_id',v_doc.id,'drive_file_id',v_doc.drive_file_id,'upload_required',false,'claimed',false,'document',to_jsonb(v_doc));
  END IF;
  -- A manual staged upload may not have a Drive-generated ID yet. The drive worker supplies it before uploading.
  IF v_doc.drive_file_id IS NULL AND NULLIF(p_file->>'drive_file_id','') IS NOT NULL THEN
    UPDATE public.exam_document SET drive_file_id=p_file->>'drive_file_id',drive_folder_id=p_file->>'drive_folder_id'
      WHERE id=v_doc.id RETURNING * INTO v_doc;
  END IF;
  INSERT INTO public.exam_document_delivery(document_id,destination) VALUES(v_doc.id,'drive') ON CONFLICT DO NOTHING;
  SELECT * INTO v_task FROM public.exam_document_delivery WHERE document_id=v_doc.id AND destination='drive' FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM public.exam_document_configuration WHERE 'drive'=ANY(enabled_destinations)) AND p_file->>'staging_bucket' IS NULL THEN
    RETURN jsonb_build_object('document_id',v_doc.id,'drive_file_id',v_doc.drive_file_id,'upload_required',true,'claimed',false,'paused',true,'document',to_jsonb(v_doc));
  END IF;
  IF v_task.status='reserved' AND v_task.lease_until>now() THEN
    IF v_task.lease_token::text=p_file->>'lease_token' AND v_task.worker=p_worker THEN
      RETURN jsonb_build_object('document_id',v_doc.id,'drive_file_id',v_doc.drive_file_id,'upload_required',true,'claimed',true,
        'delivery_id',v_task.id,'lease_token',v_task.lease_token,'document',to_jsonb(v_doc));
    END IF;
    RETURN jsonb_build_object('document_id',v_doc.id,'drive_file_id',v_doc.drive_file_id,'upload_required',true,'claimed',false,'document',to_jsonb(v_doc));
  END IF;
  UPDATE public.exam_document_delivery SET status='reserved',worker=p_worker,lease_token=gen_random_uuid(),lease_until=now()+interval '10 minutes',
    attempts=attempts+1,updated_at=now() WHERE id=v_task.id RETURNING * INTO v_task;
  RETURN jsonb_build_object('document_id',v_doc.id,'drive_file_id',v_doc.drive_file_id,'upload_required',true,'claimed',true,
    'delivery_id',v_task.id,'lease_token',v_task.lease_token,'document',to_jsonb(v_doc));
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_exam_document_file(p_document_id uuid,p_file jsonb,p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_doc public.exam_document; v_task public.exam_document_delivery;
BEGIN
  PERFORM public.require_exam_document_service();
  SELECT * INTO STRICT v_doc FROM public.exam_document WHERE id=p_document_id FOR NO KEY UPDATE;
  IF v_doc.file_status='saved' THEN
    IF v_doc.drive_file_id IS DISTINCT FROM p_file->>'drive_file_id' OR v_doc.sha256 IS DISTINCT FROM lower(p_file->>'sha256')
      OR v_doc.size_bytes IS DISTINCT FROM (p_file->>'size_bytes')::bigint THEN RAISE EXCEPTION 'Arquivo já salvo diverge da confirmação'; END IF;
    RETURN jsonb_build_object('document_id',v_doc.id,'already_saved',true,'document',to_jsonb(v_doc));
  END IF;
  SELECT * INTO STRICT v_task FROM public.exam_document_delivery WHERE document_id=v_doc.id AND destination='drive' FOR UPDATE;
  IF v_task.lease_token IS DISTINCT FROM p_lease_token OR v_task.status<>'reserved' OR v_task.lease_until<=now() THEN
    RAISE EXCEPTION 'Reserva de armazenamento inválida/expirada' USING ERRCODE='40001';
  END IF;
  IF NULLIF(v_doc.drive_file_id,'') IS NULL OR v_doc.drive_file_id IS DISTINCT FROM p_file->>'drive_file_id'
    OR v_doc.sha256 IS DISTINCT FROM lower(p_file->>'sha256') OR v_doc.size_bytes IS DISTINCT FROM (p_file->>'size_bytes')::bigint THEN
    RAISE EXCEPTION 'Confirmação não corresponde ao arquivo reservado' USING ERRCODE='23514';
  END IF;
  UPDATE public.exam_document SET file_status='saved',drive_folder_id=COALESCE(p_file->>'drive_folder_id',drive_folder_id),
    drive_name=COALESCE(p_file->>'drive_name',original_name) WHERE id=v_doc.id RETURNING * INTO v_doc;
  UPDATE public.exam_document_delivery SET status='completed',completed_at=now(),lease_until=NULL,external_id=v_doc.drive_file_id,updated_at=now() WHERE id=v_task.id;
  INSERT INTO public.exam_document_delivery(document_id,destination) VALUES(v_doc.id,'processing') ON CONFLICT DO NOTHING;
  PERFORM public.log_exam_document(v_doc.id,'file_saved',jsonb_build_object('drive_file_id',v_doc.drive_file_id,'sha256',v_doc.sha256,'size_bytes',v_doc.size_bytes));
  RETURN jsonb_build_object('document_id',v_doc.id,'document',to_jsonb(v_doc));
END;
$$;

CREATE OR REPLACE FUNCTION public.update_exam_document_extraction(p_document_id uuid,p_extraction jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_doc public.exam_document; v_class text; v_release boolean; v_task public.exam_document_delivery;
BEGIN
  PERFORM public.require_exam_document_service();
  SELECT * INTO STRICT v_doc FROM public.exam_document WHERE id=p_document_id FOR NO KEY UPDATE;
  IF v_doc.file_status<>'saved' THEN RAISE EXCEPTION 'Preserve o original antes de extrair'; END IF;
  SELECT * INTO STRICT v_task FROM public.exam_document_delivery WHERE id=(p_extraction->>'delivery_id')::uuid AND document_id=v_doc.id AND destination='processing' FOR UPDATE;
  IF v_task.status<>'reserved' OR v_task.lease_token::text IS DISTINCT FROM p_extraction->>'lease_token' OR v_task.lease_until<=now() THEN
    RAISE EXCEPTION 'Reserva de processamento inválida/expirada' USING ERRCODE='40001'; END IF;
  IF jsonb_typeof(p_extraction->'fields') IS DISTINCT FROM 'object' OR jsonb_typeof(COALESCE(p_extraction->'evidence','[]'))<>'array' THEN
    RAISE EXCEPTION 'Extração deve conter fields objeto e evidence lista'; END IF;
  v_class := p_extraction->>'classification';
  IF v_class NOT IN ('exam','review','not_exam') OR v_class IS NULL OR NULLIF(p_extraction->>'extractor_version','') IS NULL THEN RAISE EXCEPTION 'Classificação e versão do extrator obrigatórias'; END IF;
  -- Parse dates only when explicitly supplied. Impossible dates fail; absence remains NULL.
  IF NULLIF(p_extraction->'fields'->>'exam_date','') IS NOT NULL THEN PERFORM (p_extraction->'fields'->>'exam_date')::date; END IF;
  v_release := v_class='exam' AND COALESCE((p_extraction->>'single_patient')::boolean,false)
    AND NOT EXISTS(SELECT 1 FROM public.exam_document_source WHERE document_id=v_doc.id AND COALESCE((metadata->>'unknown_sender')::boolean,false))
    AND NULLIF(trim(p_extraction->'fields'->>'pet_name'),'') IS NOT NULL
    AND NULLIF(trim(COALESCE(p_extraction->'fields'->>'client_name',p_extraction->'fields'->>'tutor_name')),'') IS NOT NULL;
  UPDATE public.exam_document SET extracted_data=p_extraction->'fields',evidence=COALESCE(p_extraction->'evidence','[]'),
    extractor_version=p_extraction->>'extractor_version',drive_name=COALESCE(p_extraction->>'drive_name',drive_name),
    identification_status=CASE WHEN identification_status='confirmed' THEN 'confirmed' WHEN v_class='not_exam' THEN 'not_exam' WHEN v_release THEN 'suggested' ELSE 'review' END,
    review_reason=p_extraction->>'review_reason',group_release_at=CASE WHEN v_release THEN COALESCE(group_release_at,now()) ELSE NULL END
    WHERE id=v_doc.id RETURNING * INTO v_doc;
  IF v_release THEN INSERT INTO public.exam_document_delivery(document_id,destination) SELECT v_doc.id,'group' WHERE NOT EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=v_doc.id AND destination='group') AND NOT EXISTS(SELECT 1 FROM public.exam_document WHERE id=v_doc.id AND group_exception_reason IS NOT NULL) ON CONFLICT DO NOTHING; END IF;
  PERFORM public.log_exam_document(v_doc.id,'extraction_updated',jsonb_build_object('classification',v_class,'extractor_version',v_doc.extractor_version,'released',v_release));
  RETURN jsonb_build_object('document_id',v_doc.id,'document',to_jsonb(v_doc));
END;
$$;

CREATE OR REPLACE FUNCTION public.exam_document_fields_fill_only(p_old jsonb,p_new jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT (p_old-'exam_date'-'lab_name')=(p_new-'exam_date'-'lab_name')
    AND (NULLIF(p_old->>'exam_date','') IS NULL OR p_old->>'exam_date' IS NOT DISTINCT FROM p_new->>'exam_date')
    AND (NULLIF(p_old->>'lab_name','') IS NULL OR p_old->>'lab_name' IS NOT DISTINCT FROM p_new->>'lab_name');
$$;

CREATE OR REPLACE FUNCTION public.confirm_exam_document_link(p_document_id uuid,p_pet_id uuid,p_item_ids uuid[],p_expected_version bigint,p_confirmed jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_actor uuid; v_doc public.exam_document; v_pet public.pets; v_item public.exam_item; v_card public.exam_card;
  v_id uuid; v_card_id uuid; v_origin text; v_client jsonb; v_date date; v_existing_ids uuid[]; v_inserted integer;
BEGIN
  v_actor:=public.require_exam_document_member();
  SELECT * INTO STRICT v_doc FROM public.exam_document WHERE id=p_document_id FOR NO KEY UPDATE;
  IF v_doc.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'Documento mudou; atualize a tela' USING ERRCODE='40001'; END IF;
  IF v_doc.file_status<>'saved' OR v_doc.canonical_document_id IS NOT NULL THEN RAISE EXCEPTION 'Original ainda não foi salvo'; END IF;
  IF v_doc.pet_id IS NOT NULL AND v_doc.pet_id<>p_pet_id THEN RAISE EXCEPTION 'Documento já vinculado a outro paciente'; END IF;
  IF v_doc.previous_document_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.exam_document WHERE id=v_doc.previous_document_id AND pet_id IS NOT NULL AND pet_id<>p_pet_id) THEN
    RAISE EXCEPTION 'Correção deve pertencer ao mesmo paciente da versão anterior'; END IF;
  SELECT * INTO STRICT v_pet FROM public.pets WHERE id=p_pet_id;
  IF jsonb_typeof(p_confirmed) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Dados confirmados obrigatórios'; END IF;
  SELECT array_agg(exam_item_id ORDER BY exam_item_id) INTO v_existing_ids FROM public.exam_document_item WHERE document_id=v_doc.id;
  IF cardinality(COALESCE(p_item_ids,'{}'::uuid[]))=0 AND v_existing_ids IS NOT NULL THEN p_item_ids:=v_existing_ids; END IF;
  IF v_doc.pet_id IS NOT NULL AND (EXISTS(SELECT 1 FROM public.exam_document_item WHERE document_id=v_doc.id AND contacted_at IS NOT NULL)
    OR EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=v_doc.id AND destination='nexus' AND status='completed'))
    AND ((v_doc.confirmed_data IS DISTINCT FROM p_confirmed AND NOT (public.exam_document_fields_fill_only(v_doc.confirmed_data,p_confirmed)
      AND NOT EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=v_doc.id AND destination='nexus' AND status='completed')))
      OR v_existing_ids IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(p_item_ids) x)) THEN
    RAISE EXCEPTION 'Resultado já usado no contato/cadastro: registre uma nova versão corrigida';
  END IF;
  IF v_doc.pet_id=p_pet_id AND v_doc.confirmed_data=p_confirmed AND v_existing_ids IS NOT DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(p_item_ids) x) THEN
    RETURN jsonb_build_object('document_id',v_doc.id,'document',to_jsonb(v_doc),'item_ids',v_existing_ids,'already_linked',true);
  END IF;
  IF NULLIF(p_confirmed->>'exam_date','') IS NOT NULL THEN v_date:=(p_confirmed->>'exam_date')::date; END IF;
  -- No date is invented; Nexus task remains blocked until the team confirms the clinical date.
  IF cardinality(COALESCE(p_item_ids,'{}'::uuid[]))=0 THEN
    IF NULLIF(trim(p_confirmed->>'exam_type'),'') IS NULL THEN RAISE EXCEPTION 'Tipo do exame necessário para criar resultado externo'; END IF;
    SELECT to_jsonb(c) INTO v_client FROM public.clients c WHERE "Código"=v_pet.client_code LIMIT 1;
    SELECT channel INTO v_origin FROM public.exam_document_source WHERE document_id=v_doc.id ORDER BY created_at LIMIT 1;
    INSERT INTO public.exam_card(pet_id,client_code,pet_name,pet_species,pet_breed,client_name,client_phone,client_email,status,origin,is_orphan)
    VALUES(v_pet.id,v_pet.client_code,v_pet.name,v_pet.species,v_pet.breed,v_client->>'Nome',v_client->>'Celular',v_client->>'E-mail','exame_pronto',COALESCE(v_origin,'manual'),false)
      RETURNING id INTO v_card_id;
    INSERT INTO public.exam_item(exam_card_id,exam_type,lab_name) VALUES(v_card_id,p_confirmed->>'exam_type',p_confirmed->>'lab_name') RETURNING id INTO v_id;
    p_item_ids:=ARRAY[v_id];
  END IF;
  IF cardinality(p_item_ids)<> (SELECT count(DISTINCT x) FROM unnest(p_item_ids) x) THEN RAISE EXCEPTION 'Itens repetidos'; END IF;
  FOREACH v_id IN ARRAY p_item_ids LOOP
    SELECT * INTO STRICT v_item FROM public.exam_item WHERE id=v_id FOR UPDATE;
    SELECT * INTO STRICT v_card FROM public.exam_card WHERE id=v_item.exam_card_id FOR UPDATE;
    IF v_card.archived_at IS NOT NULL OR (v_card.pet_id IS NOT NULL AND v_card.pet_id<>v_pet.id)
      OR (v_card.client_code IS NOT NULL AND v_card.client_code<>v_pet.client_code) THEN
      RAISE EXCEPTION 'Item pertence a outro paciente/tutor ou card arquivado' USING ERRCODE='23514';
    END IF;
    IF EXISTS(SELECT 1 FROM public.exam_document_item di JOIN public.exam_document d ON d.id=di.document_id WHERE di.exam_item_id=v_id AND d.pet_id<>v_pet.id) THEN
      RAISE EXCEPTION 'Item já contém documento de outro paciente'; END IF;
    IF v_card.sale_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.exam_tracking t WHERE t.sale_id=v_card.sale_id AND t.pet_id IS NOT NULL AND t.pet_id<>v_pet.id) THEN
      RAISE EXCEPTION 'Venda vinculada a outro paciente'; END IF;
    UPDATE public.exam_card SET pet_id=v_pet.id,client_code=v_pet.client_code WHERE id=v_card.id;
  END LOOP;
  UPDATE public.exam_document SET pet_id=v_pet.id,client_code=v_pet.client_code,confirmed_data=p_confirmed,
    identification_status='confirmed',link_confirmed_by=v_actor,link_confirmed_at=COALESCE(link_confirmed_at,now()),
    group_release_at=COALESCE(group_release_at,now()),review_reason=NULL WHERE id=v_doc.id RETURNING * INTO v_doc;
  FOREACH v_id IN ARRAY p_item_ids LOOP
    INSERT INTO public.exam_document_item(document_id,exam_item_id,confirmed_by) VALUES(v_doc.id,v_id,v_actor) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_inserted=ROW_COUNT;
    IF v_inserted>0 THEN
      UPDATE public.exam_item SET result_received=true,result_received_at=(SELECT min(d.received_at) FROM public.exam_document d JOIN public.exam_document_item di ON di.document_id=d.id WHERE di.exam_item_id=v_id),
        contacted=false,contacted_at=NULL,contacted_by=NULL WHERE id=v_id;
    END IF;
  END LOOP;
  INSERT INTO public.exam_document_delivery(document_id,destination) SELECT v_doc.id,'group' WHERE NOT EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=v_doc.id AND destination='group') AND NOT EXISTS(SELECT 1 FROM public.exam_document WHERE id=v_doc.id AND group_exception_reason IS NOT NULL) ON CONFLICT DO NOTHING;
  IF v_date IS NOT NULL THEN INSERT INTO public.exam_document_delivery(document_id,destination) VALUES(v_doc.id,'nexus') ON CONFLICT DO NOTHING; END IF;
  PERFORM public.log_exam_document(v_doc.id,'link_confirmed',jsonb_build_object('pet_id',v_pet.id,'item_ids',p_item_ids));
  RETURN jsonb_build_object('document_id',v_doc.id,'document',to_jsonb(v_doc),'item_ids',p_item_ids);
END;
$$;

CREATE OR REPLACE FUNCTION public.assign_exam_document(p_document_id uuid,p_assignee_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_doc public.exam_document;
BEGIN
  PERFORM public.require_exam_document_member();
  IF p_assignee_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.exam_document_member WHERE user_id=p_assignee_id AND active) THEN RAISE EXCEPTION 'Responsável não autorizado'; END IF;
  UPDATE public.exam_document SET assigned_to=p_assignee_id WHERE id=p_document_id RETURNING * INTO STRICT v_doc;
  PERFORM public.log_exam_document(v_doc.id,'assigned',jsonb_build_object('assigned_to',p_assignee_id));
  RETURN to_jsonb(v_doc);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_exam_document_contact(p_document_id uuid,p_item_ids uuid[],p_channel text,p_note text,p_contacted_at timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_actor uuid; v_doc public.exam_document; v_id uuid;
BEGIN
  v_actor:=public.require_exam_document_member(ARRAY['admin','vet']);
  SELECT * INTO STRICT v_doc FROM public.exam_document WHERE id=p_document_id FOR NO KEY UPDATE;
  IF v_doc.identification_status<>'confirmed' OR v_doc.file_status<>'saved' THEN RAISE EXCEPTION 'Confirme o paciente e preserve o resultado antes do contato'; END IF;
  IF p_channel IS NULL OR p_channel NOT IN ('whatsapp','phone','email','in_person') OR NULLIF(trim(p_note),'') IS NULL OR p_contacted_at IS NULL
    OR p_contacted_at>now()+interval '5 minutes' OR p_contacted_at<v_doc.received_at THEN RAISE EXCEPTION 'Canal, data e anotação de contato válidos são obrigatórios'; END IF;
  IF cardinality(COALESCE(p_item_ids,'{}'))=0 OR EXISTS(SELECT 1 FROM unnest(p_item_ids) x WHERE NOT EXISTS(SELECT 1 FROM public.exam_document_item WHERE document_id=v_doc.id AND exam_item_id=x)) THEN
    RAISE EXCEPTION 'Selecione somente itens abrangidos por este documento'; END IF;
  FOREACH v_id IN ARRAY p_item_ids LOOP
    UPDATE public.exam_document_item SET contacted_by=v_actor,contacted_at=p_contacted_at,contact_channel=p_channel,contact_note=p_note
      WHERE document_id=v_doc.id AND exam_item_id=v_id AND contacted_at IS NULL;
    UPDATE public.exam_item SET contacted=NOT EXISTS(SELECT 1 FROM public.exam_document_item WHERE exam_item_id=v_id AND contacted_at IS NULL),
      contacted_at=CASE WHEN NOT EXISTS(SELECT 1 FROM public.exam_document_item WHERE exam_item_id=v_id AND contacted_at IS NULL) THEN (SELECT max(contacted_at) FROM public.exam_document_item WHERE exam_item_id=v_id) ELSE NULL END,
      contacted_by=CASE WHEN NOT EXISTS(SELECT 1 FROM public.exam_document_item WHERE exam_item_id=v_id AND contacted_at IS NULL) THEN (SELECT contacted_by::text FROM public.exam_document_item WHERE exam_item_id=v_id ORDER BY contacted_at DESC LIMIT 1) ELSE NULL END WHERE id=v_id;
  END LOOP;
  UPDATE public.exam_document SET assigned_to=COALESCE(assigned_to,v_actor) WHERE id=v_doc.id RETURNING * INTO v_doc;
  PERFORM public.log_exam_document(v_doc.id,'contact_recorded',jsonb_build_object('item_ids',p_item_ids,'channel',p_channel,'contacted_at',p_contacted_at));
  RETURN jsonb_build_object('document_id',v_doc.id,'document',to_jsonb(v_doc));
END;
$$;

CREATE OR REPLACE FUNCTION public.review_exam_document(p_document_id uuid,p_expected_version bigint,p_fields jsonb,p_classification text DEFAULT 'exam',p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_doc public.exam_document; v_release boolean;
BEGIN
  PERFORM public.require_exam_document_member();
  SELECT * INTO STRICT v_doc FROM public.exam_document WHERE id=p_document_id FOR NO KEY UPDATE;
  IF v_doc.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'Documento mudou; atualize a tela' USING ERRCODE='40001'; END IF;
  IF p_classification IS NULL OR p_classification NOT IN ('exam','review','not_exam') OR jsonb_typeof(p_fields) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Conferência inválida'; END IF;
  IF p_classification<>'exam' AND NULLIF(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'Motivo obrigatório'; END IF;
  IF (EXISTS(SELECT 1 FROM public.exam_document_item WHERE document_id=v_doc.id AND contacted_at IS NOT NULL)
    OR EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=v_doc.id AND destination='nexus' AND status='completed'))
    AND ((v_doc.confirmed_data IS DISTINCT FROM p_fields AND NOT (public.exam_document_fields_fill_only(v_doc.confirmed_data,p_fields)
      AND NOT EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=v_doc.id AND destination='nexus' AND status='completed'))) OR p_classification<>'exam') THEN
    RAISE EXCEPTION 'Resultado já usado no contato/cadastro: registre uma nova versão corrigida'; END IF;
  IF NULLIF(p_fields->>'exam_date','') IS NOT NULL THEN PERFORM (p_fields->>'exam_date')::date; END IF;
  IF v_doc.pet_id IS NOT NULL AND p_classification='not_exam' THEN RAISE EXCEPTION 'Resultado vinculado deve ser revisado, nunca descartado'; END IF;
  v_release:=p_classification='exam' AND v_doc.file_status='saved' AND NULLIF(trim(p_fields->>'pet_name'),'') IS NOT NULL AND NULLIF(trim(COALESCE(p_fields->>'client_name',p_fields->>'tutor_name')),'') IS NOT NULL;
  UPDATE public.exam_document SET confirmed_data=p_fields,review_reason=p_reason,
    identification_status=CASE WHEN pet_id IS NOT NULL THEN 'confirmed' WHEN p_classification='not_exam' THEN 'not_exam' WHEN v_release THEN 'suggested' ELSE 'review' END,
    group_release_at=CASE WHEN v_release THEN COALESCE(group_release_at,now()) ELSE NULL END WHERE id=v_doc.id RETURNING * INTO v_doc;
  IF v_release THEN INSERT INTO public.exam_document_delivery(document_id,destination) SELECT v_doc.id,'group' WHERE NOT EXISTS(SELECT 1 FROM public.exam_document_delivery WHERE document_id=v_doc.id AND destination='group') AND NOT EXISTS(SELECT 1 FROM public.exam_document WHERE id=v_doc.id AND group_exception_reason IS NOT NULL) ON CONFLICT DO NOTHING; END IF;
  IF v_doc.pet_id IS NOT NULL AND NULLIF(p_fields->>'exam_date','') IS NOT NULL THEN INSERT INTO public.exam_document_delivery(document_id,destination) VALUES(v_doc.id,'nexus') ON CONFLICT DO NOTHING; END IF;
  PERFORM public.log_exam_document(v_doc.id,'reviewed',jsonb_build_object('classification',p_classification,'reason',p_reason));
  RETURN to_jsonb(v_doc);
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_exam_document_delivery(p_destination text,p_worker text,p_limit integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_config public.exam_document_configuration; v_tasks jsonb;
BEGIN
  PERFORM public.require_exam_document_service();
  IF p_destination NOT IN ('drive','processing','group','nexus') OR NULLIF(p_worker,'') IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'Reserva inválida'; END IF;
  SELECT * INTO STRICT v_config FROM public.exam_document_configuration;
  IF NOT p_destination=ANY(v_config.enabled_destinations) THEN RETURN jsonb_build_object('tasks','[]'::jsonb,'paused',true); END IF;
  WITH candidates AS (
    SELECT t.id FROM public.exam_document_delivery t JOIN public.exam_document d ON d.id=t.document_id
    WHERE t.destination=p_destination AND t.status IN ('pending','failed') AND t.attempts<t.max_attempts AND t.next_attempt_at<=now()
      AND d.canonical_document_id IS NULL AND d.identification_status<>'not_exam'
      AND (p_destination='drive' OR d.file_status='saved')
      AND (p_destination<>'group' OR (d.group_release_at IS NOT NULL AND d.identification_status IN ('suggested','confirmed')
        AND d.group_exception_reason IS NULL
        AND v_config.notification_cutoff IS NOT NULL AND d.received_at>=v_config.notification_cutoff AND NULLIF(v_config.group_destination_key,'') IS NOT NULL
        AND t.destination_key IN ('default',v_config.group_destination_key)))
      AND (p_destination<>'nexus' OR (d.identification_status='confirmed' AND d.pet_id IS NOT NULL AND NULLIF(d.confirmed_data->>'exam_date','') IS NOT NULL))
    ORDER BY t.created_at FOR UPDATE OF t SKIP LOCKED LIMIT p_limit
  ), claimed AS (
    UPDATE public.exam_document_delivery t SET status='reserved',worker=p_worker,lease_token=gen_random_uuid(),lease_until=now()+interval '10 minutes',
      destination_key=CASE WHEN t.destination='group' AND t.destination_key='default' THEN v_config.group_destination_key ELSE t.destination_key END,
      attempts=attempts+1,updated_at=now() FROM candidates WHERE t.id=candidates.id RETURNING t.*
  ) SELECT COALESCE(jsonb_agg(to_jsonb(c)||jsonb_build_object('document',to_jsonb(d),'configured_destination',v_config.group_destination_key)),'[]') INTO v_tasks
      FROM claimed c JOIN public.exam_document d ON d.id=c.document_id;
  RETURN jsonb_build_object('tasks',v_tasks,'paused',false);
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_exam_document_delivery(p_delivery_id uuid,p_lease_token uuid,p_outcome jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_task public.exam_document_delivery; v_doc public.exam_document; v_status text; v_exam_id uuid; v_path text; v_document_id uuid;
BEGIN
  PERFORM public.require_exam_document_service();
  -- Follow the document -> delivery lock order used by review, cancel and confirmation.
  SELECT document_id INTO STRICT v_document_id FROM public.exam_document_delivery WHERE id=p_delivery_id;
  SELECT * INTO STRICT v_doc FROM public.exam_document WHERE id=v_document_id FOR NO KEY UPDATE;
  SELECT * INTO STRICT v_task FROM public.exam_document_delivery WHERE id=p_delivery_id FOR UPDATE;
  v_status:=p_outcome->>'status';
  IF v_task.lease_token IS DISTINCT FROM p_lease_token THEN RAISE EXCEPTION 'Token de reserva incorreto' USING ERRCODE='40001'; END IF;
  IF v_task.status IN ('completed','sent') THEN RETURN jsonb_build_object('task',to_jsonb(v_task),'already_completed',true); END IF;
  IF v_task.status NOT IN ('reserved','submitted','uncertain') THEN RAISE EXCEPTION 'Tarefa não reservada'; END IF;
  IF v_task.status='reserved' AND v_task.lease_until<=now() AND v_status NOT IN ('uncertain','failed') THEN RAISE EXCEPTION 'Reserva expirada' USING ERRCODE='40001'; END IF;
  IF v_status NOT IN ('submitted','sent','uncertain','failed','completed') OR v_status IS NULL THEN RAISE EXCEPTION 'Resultado inválido'; END IF;
  IF v_task.destination='group' THEN
    IF v_status='completed' THEN RAISE EXCEPTION 'Grupo exige sent com prova, nunca completed genérico'; END IF;
    IF v_status IN ('submitted','sent') AND NULLIF(COALESCE(p_outcome->>'external_id',v_task.external_id),'') IS NULL THEN RAISE EXCEPTION 'ID Chatwoot obrigatório'; END IF;
    IF v_status='sent' AND COALESCE(p_outcome->>'external_status','') NOT IN ('delivered','read') THEN RAISE EXCEPTION 'Confirmação do provedor ou conferência humana necessária'; END IF;
    IF v_task.status='submitted' AND v_status='failed' THEN RAISE EXCEPTION 'Mensagem submetida exige reconciliação; não autorizar reenvio cego'; END IF;
  ELSIF v_status IN ('submitted','sent') THEN RAISE EXCEPTION 'Estado exclusivo de envio ao grupo'; END IF;
  IF v_task.destination='nexus' AND v_status='completed' THEN
    v_path:=v_doc.pet_id::text||'/'||v_doc.id::text||'/original.pdf';
    IF v_doc.identification_status<>'confirmed' OR NULLIF(v_doc.confirmed_data->>'exam_date','') IS NULL
      OR p_outcome->>'storage_bucket' IS DISTINCT FROM 'exam_documents_private' OR p_outcome->>'storage_path' IS DISTINCT FROM v_path
      OR p_outcome->>'sha256' IS DISTINCT FROM v_doc.sha256 OR (p_outcome->>'size_bytes')::bigint IS DISTINCT FROM v_doc.size_bytes
      OR NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='exam_documents_private' AND name=v_path) THEN
      RAISE EXCEPTION 'Anexo não verificado ou paciente/data/objeto incompatíveis' USING ERRCODE='23514'; END IF;
    INSERT INTO public.exames(pet_id,nome,data_exame,arquivo_nome,arquivo_tipo,arquivo_tamanho,observacoes,exam_document_id,storage_bucket,storage_path)
    VALUES(v_doc.pet_id,COALESCE(NULLIF(v_doc.confirmed_data->>'exam_type',''),'Exame'),(v_doc.confirmed_data->>'exam_date')::date,
      v_doc.original_name,v_doc.mime_type,v_doc.size_bytes,'Recebido pelo fluxo de exames; original preservado no Drive.',v_doc.id,'exam_documents_private',v_path)
    ON CONFLICT (exam_document_id) WHERE exam_document_id IS NOT NULL DO UPDATE SET exam_document_id=EXCLUDED.exam_document_id RETURNING id INTO v_exam_id;
    UPDATE public.exam_document SET storage_bucket='exam_documents_private',storage_path=v_path WHERE id=v_doc.id;
  END IF;
  IF v_task.destination='processing' AND v_status='completed' AND v_doc.extractor_version IS NULL THEN RAISE EXCEPTION 'Extração ainda não foi registrada'; END IF;
  IF v_task.destination='drive' AND v_status='completed' THEN RAISE EXCEPTION 'Use confirmação de arquivo para concluir armazenamento'; END IF;
  UPDATE public.exam_document_delivery SET status=v_status,
    external_id=COALESCE(v_exam_id::text,p_outcome->>'external_id',external_id),external_status=COALESCE(p_outcome->>'external_status',external_status),
    last_error=CASE WHEN v_status IN ('failed','uncertain') THEN left(p_outcome->>'error',1000) ELSE NULL END,
    submitted_at=CASE WHEN v_status IN ('submitted','sent') THEN COALESCE(submitted_at,now()) ELSE submitted_at END,
    sent_at=CASE WHEN v_status='sent' THEN COALESCE(sent_at,now()) ELSE sent_at END,
    completed_at=CASE WHEN v_status='completed' THEN COALESCE(completed_at,now()) ELSE completed_at END,
    next_attempt_at=CASE WHEN v_status='failed' THEN COALESCE((p_outcome->>'next_attempt_at')::timestamptz,now()+make_interval(mins=>CASE attempts WHEN 1 THEN 1 WHEN 2 THEN 5 WHEN 3 THEN 15 ELSE 60 END)) ELSE next_attempt_at END,
    lease_until=NULL,updated_at=now() WHERE id=v_task.id RETURNING * INTO v_task;
  PERFORM public.log_exam_document(v_doc.id,'delivery_'||v_status,jsonb_build_object('delivery_id',v_task.id,'destination',v_task.destination,'external_id',v_task.external_id,'error',v_task.last_error));
  IF v_task.destination='group' AND v_status='sent' THEN
    UPDATE public.exam_card c SET status=CASE WHEN c.status='exame_pronto' THEN 'no_grupo' ELSE c.status END,
      group_sent_at=CASE WHEN c.group_sent_at IS NULL OR c.group_sent_at>v_task.sent_at THEN v_task.sent_at ELSE c.group_sent_at END
    WHERE EXISTS(SELECT 1 FROM public.exam_document_item di JOIN public.exam_item i ON i.id=di.exam_item_id WHERE di.document_id=v_doc.id AND di.contacted_at IS NULL AND i.exam_card_id=c.id);
  END IF;
  RETURN jsonb_build_object('task',to_jsonb(v_task),'exame_id',v_exam_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_exam_document_tasks()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_task public.exam_document_delivery; v_count integer:=0;
BEGIN
  PERFORM public.require_exam_document_service();
  FOR v_task IN SELECT * FROM public.exam_document_delivery WHERE status='reserved' AND lease_until<=now() FOR UPDATE SKIP LOCKED LOOP
    UPDATE public.exam_document_delivery SET status=CASE WHEN destination='group' THEN 'uncertain' ELSE 'pending' END,
      last_error='Reserva expirou; reconciliar efeito externo antes de repetir',lease_until=NULL,updated_at=now() WHERE id=v_task.id;
    PERFORM public.log_exam_document(v_task.document_id,'lease_expired',jsonb_build_object('delivery_id',v_task.id,'destination',v_task.destination));
    v_count:=v_count+1;
  END LOOP;
  RETURN jsonb_build_object('reconciled',v_count,'drive_tasks',COALESCE((SELECT jsonb_agg(to_jsonb(t)||jsonb_build_object('document',to_jsonb(d))) FROM public.exam_document_delivery t JOIN public.exam_document d ON d.id=t.document_id WHERE t.destination='drive' AND t.status IN ('pending','failed') AND (d.drive_file_id IS NOT NULL OR d.staging_path IS NOT NULL) AND EXISTS(SELECT 1 FROM public.exam_document_configuration WHERE 'drive'=ANY(enabled_destinations))),'[]'), 'group_tasks',COALESCE((SELECT jsonb_agg(to_jsonb(t)||jsonb_build_object('document',to_jsonb(d),'configured_destination',t.destination_key)) FROM public.exam_document_delivery t JOIN public.exam_document d ON d.id=t.document_id WHERE t.destination='group' AND t.status IN ('submitted','uncertain')),'[]'));
END;
$$;

CREATE OR REPLACE FUNCTION public.retry_exam_document_delivery(p_delivery_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_task public.exam_document_delivery;
BEGIN
  PERFORM public.require_exam_document_member();
  SELECT * INTO STRICT v_task FROM public.exam_document_delivery WHERE id=p_delivery_id FOR UPDATE;
  IF v_task.status<>'failed' OR NULLIF(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'Somente falha confirmada pode ser repetida; envio incerto exige reconciliação'; END IF;
  UPDATE public.exam_document_delivery SET status='pending',attempts=0,next_attempt_at=now(),last_error=NULL,updated_at=now() WHERE id=v_task.id RETURNING * INTO v_task;
  PERFORM public.log_exam_document(v_task.document_id,'retry_requested',jsonb_build_object('delivery_id',v_task.id,'reason',p_reason));
  RETURN to_jsonb(v_task);
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_exam_document_group_exception(p_document_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_doc public.exam_document; v_task public.exam_document_delivery; v_waived integer:=0;
BEGIN
  PERFORM public.require_exam_document_member(ARRAY['admin']);
  IF NULLIF(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'Justificativa obrigatória'; END IF;
  SELECT * INTO STRICT v_doc FROM public.exam_document WHERE id=p_document_id FOR NO KEY UPDATE;
  -- A task claim locks its row. If claim wins first, this operation sees reserved and
  -- rejects; if cancellation wins first, the worker sees waived/exception and cannot claim.
  FOR v_task IN SELECT * FROM public.exam_document_delivery WHERE document_id=v_doc.id AND destination='group' ORDER BY id FOR UPDATE LOOP
    IF v_task.status IN ('reserved','submitted','uncertain') THEN
      RAISE EXCEPTION 'Envio já iniciado ou incerto: reconcilie a mensagem antes de dispensar';
    END IF;
    IF v_task.status IN ('pending','failed') THEN
      UPDATE public.exam_document_delivery SET status='waived',lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=now()
        WHERE id=v_task.id;
      v_waived:=v_waived+1;
    END IF;
  END LOOP;
  UPDATE public.exam_document SET group_exception_reason=p_reason WHERE id=p_document_id;
  PERFORM public.log_exam_document(p_document_id,'group_exception',jsonb_build_object('reason',p_reason,'tasks_waived',v_waived));
  RETURN jsonb_build_object('document_id',p_document_id,'tasks_waived',v_waived);
END;
$$;

CREATE OR REPLACE FUNCTION public.search_exam_document_candidates(p_query text,p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_result jsonb;
BEGIN
  PERFORM public.require_exam_document_member();
  IF length(trim(COALESCE(p_query,'')))<2 OR p_limit NOT BETWEEN 1 AND 50 THEN RETURN '[]'::jsonb; END IF;
  SELECT COALESCE(jsonb_agg(x),'[]') INTO v_result FROM (
    SELECT p.id AS pet_id,p.name AS pet_name,p.species,p.client_code,c."Nome" AS tutor_name,c."Nome" AS client_name,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',i.id,'exam_card_id',i.exam_card_id,'exam_type',i.exam_type,'result_received',i.result_received))
        FROM public.exam_item i JOIN public.exam_card ec ON ec.id=i.exam_card_id
        WHERE ec.archived_at IS NULL AND (ec.pet_id=p.id OR (ec.pet_id IS NULL AND ec.client_code=p.client_code AND lower(ec.pet_name)=lower(p.name)))),'[]') AS items
    FROM public.pets p LEFT JOIN public.clients c ON c."Código"=p.client_code
    WHERE p.name ILIKE '%'||p_query||'%' OR c."Nome" ILIKE '%'||p_query||'%' OR p.code=p_query OR p.chip=p_query
    ORDER BY p.name LIMIT p_limit
  ) x;
  RETURN v_result;
END;
$$;

CREATE VIEW public.v_exam_documents WITH (security_invoker=true) AS
SELECT d.*,('EX-'||upper(substr(d.id::text,1,8))) AS display_code,
  COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.received_at) FROM public.exam_document_source s WHERE s.document_id=d.id),'[]') AS sources,
  COALESCE((SELECT jsonb_agg(to_jsonb(di)||jsonb_build_object('exam_type',i.exam_type,'exam_card_id',i.exam_card_id)) FROM public.exam_document_item di JOIN public.exam_item i ON i.id=di.exam_item_id WHERE di.document_id=d.id),'[]') AS items,
  COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at) FROM public.exam_document_delivery t WHERE t.document_id=d.id),'[]') AS deliveries,
  CASE WHEN EXISTS(SELECT 1 FROM public.exam_document_item di WHERE di.document_id=d.id)
    AND NOT EXISTS(SELECT 1 FROM public.exam_document_item di WHERE di.document_id=d.id AND di.contacted_at IS NULL) THEN 'completed'
    WHEN d.assigned_to IS NOT NULL THEN 'assigned' ELSE 'pending' END AS contact_status,
  COALESCE((SELECT status FROM public.exam_document_delivery t WHERE t.document_id=d.id AND destination='group' ORDER BY created_at DESC LIMIT 1),'pending') AS group_status,
  COALESCE((SELECT status FROM public.exam_document_delivery t WHERE t.document_id=d.id AND destination='nexus' ORDER BY created_at DESC LIMIT 1),'awaiting_link') AS nexus_status,
  COALESCE((SELECT status FROM public.exam_document_delivery t WHERE t.document_id=d.id AND destination='processing' ORDER BY created_at DESC LIMIT 1),'pending') AS process_status,
  (SELECT min(sent_at) FROM public.exam_document_delivery t WHERE t.document_id=d.id AND destination='group' AND status='sent') AS oldest_group_sent_at,
  (d.file_status='saved' AND d.identification_status='confirmed'
    AND EXISTS(SELECT 1 FROM public.exam_document_item di WHERE di.document_id=d.id)
    AND NOT EXISTS(SELECT 1 FROM public.exam_document_item di WHERE di.document_id=d.id AND di.contacted_at IS NULL)
    AND EXISTS(SELECT 1 FROM public.exam_document_delivery t WHERE t.document_id=d.id AND destination='nexus' AND status='completed')
    AND (d.group_exception_reason IS NOT NULL OR EXISTS(SELECT 1 FROM public.exam_document_delivery t WHERE t.document_id=d.id AND destination='group' AND status='sent'))) AS completed
FROM public.exam_document d WHERE d.canonical_document_id IS NULL;
REVOKE ALL ON public.v_exam_documents FROM PUBLIC,anon;
GRANT SELECT ON public.v_exam_documents TO authenticated,service_role;

-- Function grants are explicit; default PUBLIC execute would otherwise bypass RLS via definer RPCs.
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('reserve_exam_document_source','stage_exam_document_file','confirm_exam_document_file',
      'update_exam_document_extraction','reserve_exam_document_delivery','complete_exam_document_delivery','reconcile_exam_document_tasks') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('confirm_exam_document_link','assign_exam_document','record_exam_document_contact',
      'review_exam_document','retry_exam_document_delivery','confirm_exam_document_group_exception','search_exam_document_candidates') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon',f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',f.signature);
  END LOOP;
END;
$$;
COMMIT;
