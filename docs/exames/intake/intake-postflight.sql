BEGIN;
SET TRANSACTION READ ONLY;
SELECT c.relname,c.relrowsecurity,
  has_table_privilege('anon',c.oid,'SELECT') AS anon_can_read,
  has_table_privilege('authenticated',c.oid,'SELECT') AS member_can_read_directly
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'exam_intake_%' AND c.relkind='r' ORDER BY c.relname;
SELECT p.oid::regprocedure::text AS signature,pg_get_userbyid(p.proowner) AS owner,
  has_function_privilege('anon',p.oid,'EXECUTE') AS anon_can_call,
  has_function_privilege('authenticated',p.oid,'EXECUTE') AS member_can_call,
  has_function_privilege('service_role',p.oid,'EXECUTE') AS worker_can_call
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('begin_exam_intake_sweep','record_exam_intake_event','finish_exam_intake_sweep','check_exam_intake_health','reserve_exam_intake_source','stage_exam_intake_file','reserve_exam_intake_alert','begin_exam_intake_alert','record_exam_intake_alert_result','get_exam_intake_panel','get_exam_intake_worker_status','acknowledge_exam_intake_incident','get_exam_intake_version_holds','release_exam_intake_hold') ORDER BY signature;
SELECT enabled,destination_key FROM public.exam_intake_alert_configuration;
SELECT strpos(pg_get_functiondef('public.reserve_exam_document_delivery(text,text,integer)'::regprocedure),'exam_intake_document_hold')>0 AS group_hold_guard_present,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.reserve_exam_document_source(jsonb)'::regprocedure)='ea4f2ca17e18ed109e9ecd958ff09bc9' AS original_source_body_preserved,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.stage_exam_document_file(uuid,jsonb,text)'::regprocedure)='eb59790852b2b00bd03a95612f48a709' AS original_stage_body_preserved,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.require_exam_document_member(text[])'::regprocedure)='5e3481e739d8b32eb6bc4b9e0e74e664' AS membership_guard_body_preserved;
SELECT count(*) FILTER(WHERE state='held') AS held_document_rows FROM public.exam_intake_document_hold;
SELECT count(*) AS snapshots FROM public.exam_intake_snapshot;
SELECT count(*) AS receipts FROM public.exam_intake_receipt;
SELECT count(*) FILTER(WHERE state<>'resolved') AS open_incidents FROM public.exam_intake_incident;
SELECT status,count(*) AS alerts FROM public.exam_intake_alert_outbox GROUP BY status ORDER BY status;
COMMIT;
