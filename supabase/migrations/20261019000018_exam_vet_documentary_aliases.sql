-- Explicit documentary names only: no real alias seed, fuzzy match, CRMV numeric
-- fallback, display-name change or historical responsibility refresh.
BEGIN;
ALTER TABLE public.veterinarios ADD COLUMN nome_laudo_aliases text[] NOT NULL DEFAULT '{}'::text[]
  CHECK(COALESCE(array_ndims(nome_laudo_aliases),1)=1);
COMMENT ON COLUMN public.veterinarios.nome_laudo_aliases IS
  'Explicit full names printed on reports, confirmed separately for this veterinarian. Does not change the displayed name or CRMV.';

CREATE FUNCTION public.exam_document_vet_documentary_name_matches(p_name text,p_aliases text[],p_requester text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE key text:=public.normalize_exam_vet_name(p_requester);
BEGIN
  IF key='' OR key !~ '[[:alpha:]]' THEN RETURN false; END IF;
  RETURN public.normalize_exam_vet_name(p_name)=key
    OR EXISTS(SELECT 1 FROM unnest(COALESCE(p_aliases,'{}'::text[])) alias
      WHERE public.normalize_exam_vet_name(alias)=key);
END;
$$;
REVOKE ALL ON FUNCTION public.exam_document_vet_documentary_name_matches(text,text[],text) FROM PUBLIC,anon,authenticated,service_role;

DO $patch$
DECLARE definition text; marker text;
BEGIN
  definition:=pg_get_functiondef('public.resolve_exam_document_responsible_vet(uuid)'::regprocedure);
  marker:=$old$WHERE ativo AND public.normalize_exam_vet_name(nome)=public.normalize_exam_vet_name(requester);$old$;
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'Contrato do nome documental mudou; revisão obrigatória'; END IF;
  EXECUTE replace(definition,marker,$new$WHERE ativo AND public.exam_document_vet_documentary_name_matches(nome,nome_laudo_aliases,requester);$new$);
END;
$patch$;
-- Same resolver owner/ACL, name candidate cardinality, active-only filter,
-- qualified-CRMV intersection, manual priority and sale-conflict rules.
COMMIT;
