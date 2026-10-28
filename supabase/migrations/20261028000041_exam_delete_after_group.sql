-- Completed group delivery does not prevent deletion of an unlinked ficha.
-- Fail closed if the installed function differs from migration 40.
BEGIN;
DO $patch$
DECLARE definition text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.begin_exam_document_deletion(uuid,bigint,uuid,text)'::regprocedure) <> 'fce8ccc704e4f391f5dc3d10bd96a7d1' THEN
  RAISE EXCEPTION 'Unexpected deletion function; review before applying';
 END IF;
 SELECT pg_get_functiondef('public.begin_exam_document_deletion(uuid,bigint,uuid,text)'::regprocedure) INTO definition;
 definition:=replace(definition, 'destination IN (''group'',''nexus'')', 'destination = ''nexus''');
 definition:=replace(definition, '  -- Lock the queue rows before checking', $guard$  IF to_regclass('public.exam_document_reaction') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.exam_document_reaction WHERE document_id=$1)' INTO rec USING d.id;
    IF rec.exists THEN
      RAISE EXCEPTION 'Ficha com reação de contato exige revisão antes da exclusão' USING ERRCODE='40001';
    END IF;
  END IF;
  -- Lock the queue rows before checking$guard$);
 EXECUTE definition;
 IF to_regclass('public.exam_document_reaction') IS NOT NULL THEN
  CREATE TRIGGER exam_deletion_reaction_guard BEFORE INSERT OR UPDATE ON public.exam_document_reaction FOR EACH ROW EXECUTE FUNCTION public.exam_document_deletion_guard();
 END IF;
END $patch$;
COMMIT;
