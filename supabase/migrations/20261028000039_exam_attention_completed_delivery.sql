-- Only adjust the read-only attention query. Never mutate deliveries or receipts.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
CREATE TEMP TABLE exam_attention39_acl_before ON COMMIT DROP AS
 SELECT oid,proowner,proacl FROM pg_proc WHERE oid='public.get_exam_intake_exam_failures(integer,integer,timestamptz,uuid)'::regprocedure;
DO $patch$
DECLARE definition text; old_rule text:=$old$OR (NOT clinical_confirmed AND file_status='saved' AND age_from<=now()-interval '10 minutes')$old$;
 new_rule text:=$new$OR (NOT clinical_confirmed AND file_status='saved' AND age_from<=now()-interval '10 minutes'
         AND NOT (processing_status='completed' AND group_status IN ('sent','waived')) IS TRUE)$new$;
BEGIN
 SELECT pg_get_functiondef('public.get_exam_intake_exam_failures(integer,integer,timestamptz,uuid)'::regprocedure) INTO definition;
 IF position('exam_intake_receipt_detail' IN definition)=0 OR
   (length(definition)-length(replace(definition,old_rule,'')))/length(old_rule)<>1 THEN
   RAISE EXCEPTION 'Expected SQL38 attention query differs; review before installing'; END IF;
 EXECUTE replace(definition,old_rule,new_rule);
END $patch$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM exam_attention39_acl_before) OR EXISTS (
  SELECT 1 FROM exam_attention39_acl_before b JOIN pg_proc p ON p.oid=b.oid
   WHERE p.proowner IS DISTINCT FROM b.proowner OR p.proacl IS DISTINCT FROM b.proacl)
 THEN RAISE EXCEPTION 'Unexpected function owner or ACL change'; END IF;
END $$;
COMMIT;
