-- Optional first-admin phase only. Expectations come from private captured metadata.
-- This source grants no access to document tables, buckets, memberships or schemas.
BEGIN;
SET LOCAL search_path=pg_catalog,public;

DO $legacy_rpc_transition$
DECLARE
  expected jsonb; target oid; f record; a record; expected_acl aclitem[];
  actual_acl aclitem[]; restricted_acl aclitem[]; expected_normal jsonb;
  actual_normal jsonb; restricted_normal jsonb; signatures text[];
BEGIN
  expected:=NULLIF(current_setting('pamvet.legacy_rpc_transition_expected',true),'')::jsonb;
  IF expected IS NULL OR jsonb_typeof(expected) IS DISTINCT FROM 'object'
     OR expected->>'signature' IS DISTINCT FROM 'receive_email_result(text,text,text,text,text,timestamp with time zone)'
     OR jsonb_typeof(expected->'acl') IS DISTINCT FROM 'array' OR jsonb_array_length(expected->'acl')=0
     OR jsonb_typeof(expected->'owner') IS DISTINCT FROM 'string' OR expected->>'owner'=''
     OR jsonb_typeof(expected->'md5') IS DISTINCT FROM 'string' OR expected->>'md5' !~ '^[a-f0-9]{32}$'
     OR expected->'definer' IS DISTINCT FROM 'true'::jsonb
     OR jsonb_typeof(expected->'search_path') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Metadados verificados do RPC legado obrigatórios' USING ERRCODE='40001';
  END IF;
  target:=to_regprocedure('public.'||(expected->>'signature'));
  SELECT array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text) INTO signatures
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='receive_email_result';
  IF target IS NULL OR cardinality(signatures)<>1 OR signatures[1]<>target::regprocedure::text THEN
    RAISE EXCEPTION 'Inventário de assinaturas do RPC legado divergiu' USING ERRCODE='40001';
  END IF;
  SELECT p.*,pg_get_userbyid(p.proowner) owner_name INTO STRICT f FROM pg_proc p WHERE p.oid=target;
  IF f.owner_name<>expected->>'owner' OR current_user<>f.owner_name
     OR md5(pg_get_functiondef(target))<>expected->>'md5' OR NOT f.prosecdef
     OR to_jsonb(ARRAY(SELECT x FROM unnest(COALESCE(f.proconfig,'{}'::text[])) x
         WHERE split_part(x,'=',1)='search_path')) IS DISTINCT FROM expected->'search_path' THEN
    RAISE EXCEPTION 'Corpo/owner/definer/search_path do RPC legado divergiu' USING ERRCODE='40001';
  END IF;
  SELECT array_agg(value::aclitem) INTO expected_acl FROM jsonb_array_elements_text(expected->'acl');
  IF EXISTS(SELECT 1 FROM aclexplode(expected_acl) x
       WHERE x.grantor<>f.proowner OR x.privilege_type<>'EXECUTE' OR x.is_grantable) THEN
    RAISE EXCEPTION 'Grantor ou grant option legado não reproduzível neste pacote' USING ERRCODE='40001';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM aclexplode(expected_acl) x WHERE x.grantee=f.proowner) THEN
    RAISE EXCEPTION 'ACL capturado não contém o owner esperado' USING ERRCODE='40001';
  END IF;
  -- 02 removes PUBLIC/anon/authenticated and grants EXECUTE to service_role.
  SELECT array_agg(value) INTO restricted_acl FROM (
    SELECT value FROM unnest(expected_acl) value WHERE
      NOT EXISTS(SELECT 1 FROM aclexplode(ARRAY[value]) x WHERE x.grantee=0
        OR x.grantee IN('anon'::regrole::oid,'authenticated'::regrole::oid))
    UNION ALL
    SELECT format('%I=X/%I','service_role',f.owner_name)::aclitem
      WHERE NOT EXISTS(SELECT 1 FROM aclexplode(expected_acl) x WHERE x.grantee='service_role'::regrole::oid)
  ) restricted;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('grantor',x.grantor,'grantee',x.grantee,
      'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee,x.grantor,x.privilege_type,x.is_grantable),'[]'::jsonb)
    INTO expected_normal FROM aclexplode(expected_acl) x;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('grantor',x.grantor,'grantee',x.grantee,
      'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee,x.grantor,x.privilege_type,x.is_grantable),'[]'::jsonb)
    INTO restricted_normal FROM aclexplode(restricted_acl) x;
  actual_acl:=COALESCE(f.proacl,acldefault('f',f.proowner));
  SELECT COALESCE(jsonb_agg(jsonb_build_object('grantor',x.grantor,'grantee',x.grantee,
      'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee,x.grantor,x.privilege_type,x.is_grantable),'[]'::jsonb)
    INTO actual_normal FROM aclexplode(actual_acl) x;
  IF actual_normal IS DISTINCT FROM restricted_normal THEN
    RAISE EXCEPTION 'ACL após restrição 02 divergiu do esperado' USING ERRCODE='40001';
  END IF;
  LOCK TABLE public.exam_document IN ACCESS EXCLUSIVE MODE NOWAIT;
  IF EXISTS(SELECT 1 FROM public.exam_document) THEN
    RAISE EXCEPTION 'Fase administrativa exige zero documentos' USING ERRCODE='40001';
  END IF;
  -- Rebuild only this function ACL. Grantor is the verified existing owner.
  FOR a IN SELECT DISTINCT grantee FROM aclexplode(actual_acl) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s',target::regprocedure,
      CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END);
  END LOOP;
  FOR a IN SELECT * FROM aclexplode(expected_acl) LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s',target::regprocedure,
      CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END);
  END LOOP;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('grantor',x.grantor,'grantee',x.grantee,
      'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee,x.grantor,x.privilege_type,x.is_grantable),'[]'::jsonb)
    INTO actual_normal FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) x WHERE p.oid=target;
  IF actual_normal IS DISTINCT FROM expected_normal THEN
    RAISE EXCEPTION 'Restauração do ACL legado não foi exata' USING ERRCODE='40001';
  END IF;
  SELECT array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text) INTO signatures
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='receive_email_result';
  SELECT p.*,pg_get_userbyid(p.proowner) owner_name INTO STRICT f FROM pg_proc p WHERE p.oid=target;
  IF cardinality(signatures)<>1 OR signatures[1]<>target::regprocedure::text
     OR f.owner_name<>expected->>'owner' OR md5(pg_get_functiondef(target))<>expected->>'md5'
     OR NOT f.prosecdef OR to_jsonb(ARRAY(SELECT x FROM unnest(COALESCE(f.proconfig,'{}'::text[])) x
       WHERE split_part(x,'=',1)='search_path')) IS DISTINCT FROM expected->'search_path' THEN
    RAISE EXCEPTION 'Contrato do RPC legado mudou durante restauração' USING ERRCODE='40001';
  END IF;
END;
$legacy_rpc_transition$;

CREATE FUNCTION public.guard_exam_document_admin_phase_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  -- Intentionally unconditional: closing RPC ACLs alone cannot retire the collector.
  RAISE EXCEPTION 'Fase administrativa: criação de documentos bloqueada até retirada versionada do coletor legado e desta barreira'
    USING ERRCODE='42501';
END;
$$;
REVOKE ALL ON FUNCTION public.guard_exam_document_admin_phase_insert() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_exam_document_admin_phase_insert BEFORE INSERT ON public.exam_document
FOR EACH ROW EXECUTE FUNCTION public.guard_exam_document_admin_phase_insert();
ALTER TABLE public.exam_document ENABLE ALWAYS TRIGGER guard_exam_document_admin_phase_insert;

COMMIT;
