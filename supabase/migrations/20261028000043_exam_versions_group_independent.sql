-- Each distinct preserved result can reach the group while its clinical relation is reviewed.
-- Snapshot capture remains a gate; no delivery is reset or replayed.
BEGIN;
DO $patch$
DECLARE definition text; needle text;
BEGIN
 SELECT pg_get_functiondef('public.reserve_exam_document_delivery(text,text,integer)'::regprocedure) INTO definition;
 needle:='intake_hold.document_id=d.id AND intake_hold.state=''held''';
 IF position(needle in definition)=0 THEN RAISE EXCEPTION 'Review group claim definition before migration 43'; END IF;
 definition:=replace(definition,needle,needle||' AND intake_hold.reason NOT IN (''changed_content_review'',''historical_snapshot_unavailable'')');
 EXECUTE definition;
 SELECT pg_get_functiondef('public.get_exam_intake_version_review(uuid)'::regprocedure) INTO definition;
 needle:='document_id=item.id AND state=''held''';
 IF position(needle in definition)=0 THEN RAISE EXCEPTION 'Review version projection before migration 43'; END IF;
 definition:=replace(definition,needle,needle||' AND reason NOT IN (''changed_content_review'',''historical_snapshot_unavailable'')');
 EXECUTE definition;
END $patch$;
COMMIT;
