BEGIN;
SET TRANSACTION READ ONLY;
WITH expected(signature,body_md5) AS (VALUES
  ('public.reserve_exam_document_source(jsonb)','ea4f2ca17e18ed109e9ecd958ff09bc9'),
  ('public.stage_exam_document_file(uuid,jsonb,text)','eb59790852b2b00bd03a95612f48a709'),
  ('public.reserve_exam_document_delivery(text,text,integer)','209f2fd9eb0049a30f209887a70a6890'),
  ('public.require_exam_document_member(text[])','5e3481e739d8b32eb6bc4b9e0e74e664'))
SELECT signature,md5(p.prosrc)=body_md5 AS body_matches,pg_get_userbyid(p.proowner)='postgres' AS owner_matches
FROM expected LEFT JOIN pg_proc p ON p.oid=to_regprocedure(signature);
DO $$ DECLARE expected record; BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('public.reserve_exam_document_source(jsonb)','ea4f2ca17e18ed109e9ecd958ff09bc9'),
    ('public.stage_exam_document_file(uuid,jsonb,text)','eb59790852b2b00bd03a95612f48a709'),
    ('public.reserve_exam_document_delivery(text,text,integer)','209f2fd9eb0049a30f209887a70a6890'),
    ('public.require_exam_document_member(text[])','5e3481e739d8b32eb6bc4b9e0e74e664')) v(signature,body_md5) LOOP
    IF to_regprocedure(expected.signature) IS NULL OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid=to_regprocedure(expected.signature)) IS DISTINCT FROM expected.body_md5 THEN RAISE EXCEPTION 'Current core definition differs at %; review before installation',expected.signature; END IF;
  END LOOP;
  IF to_regclass('public.exam_collection_cursor') IS NULL OR to_regclass('public.exam_collection_event') IS NULL THEN RAISE EXCEPTION 'Collection schema is absent'; END IF;
  IF to_regclass('public.exam_intake_receipt') IS NOT NULL OR to_regclass('public.exam_intake_snapshot') IS NOT NULL THEN RAISE EXCEPTION 'Intake migrations already present; inspect rather than reapply'; END IF;
END $$;
COMMIT;
