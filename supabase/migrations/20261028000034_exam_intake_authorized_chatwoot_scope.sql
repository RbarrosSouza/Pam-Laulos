BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

-- Preserve existing all-sender scopes and permit an explicit hash of the
-- Chatwoot processing allowlist. The prospective scope enumerates every
-- individual sender; unknown senders stay pending and never reach the child.
CREATE TEMP TABLE exam_intake_begin_before ON COMMIT DROP AS
SELECT oid,proowner,proacl FROM pg_proc
WHERE oid='public.begin_exam_intake_sweep(text,text,jsonb,timestamptz,timestamptz,uuid,text,integer)'::regprocedure;
DO $patch$
DECLARE definition text; old_keys text:=$old$'include_deleted','initial_received_from','lookback_seconds']$old$;
  new_keys text:=$new$'include_deleted','initial_received_from','lookback_seconds','sender_policy_sha256']$new$;
  old_rule text:=$old$p_scope_manifest->>'sender_policy' IS DISTINCT FROM 'all' THEN$old$;
  new_rule text:=$rule$((p_scope_manifest ? 'sender_policy_sha256' AND
    (jsonb_typeof(p_scope_manifest->'sender_policy_sha256') IS DISTINCT FROM 'string' OR COALESCE(p_scope_manifest->>'sender_policy_sha256','') !~ '^[a-f0-9]{64}$')) OR
    NOT COALESCE(((p_scope_manifest->>'sender_policy'='all' AND
    (p_scope_manifest->>'provider'<>'chatwoot' OR p_scope_manifest->>'scope_kind' NOT LIKE '%:individual%' OR
      (p_scope_manifest->>'account_id' ~ '^chatwoot:[1-9][0-9]*:inbox:[1-9][0-9]*$'
       AND p_scope_manifest->>'scope_kind' IN ('inbox:'||split_part(p_scope_manifest->>'account_id',':',4)||':individual',
         'inbox:'||split_part(p_scope_manifest->>'account_id',':',4)||':individual:canary')
       AND p_scope_manifest->>'sender_policy_sha256' ~ '^[a-f0-9]{64}$'))) OR
    (p_scope_manifest->>'provider'='chatwoot' AND p_scope_manifest->>'sender_policy'='authorized_only'
      AND p_scope_manifest->>'account_id' ~ '^chatwoot:[1-9][0-9]*:inbox:[1-9][0-9]*$'
      AND p_scope_manifest->>'scope_kind' IN ('inbox:'||split_part(p_scope_manifest->>'account_id',':',4)||':authorized_individual',
        'inbox:'||split_part(p_scope_manifest->>'account_id',':',4)||':authorized_individual:canary')
      AND p_scope_manifest->>'sender_policy_sha256' ~ '^[a-f0-9]{64}$')),false)) THEN$rule$;
BEGIN
  SELECT pg_get_functiondef('public.begin_exam_intake_sweep(text,text,jsonb,timestamptz,timestamptz,uuid,text,integer)'::regprocedure) INTO definition;
  IF (length(definition)-length(replace(definition,old_keys,'')))/length(old_keys)<>1
    OR (length(definition)-length(replace(definition,old_rule,'')))/length(old_rule)<>1 THEN
    RAISE EXCEPTION 'Existing intake scope definition drifted; review before installing'; END IF;
  definition:=replace(replace(definition,old_keys,new_keys),old_rule,new_rule);
  EXECUTE definition;
END $patch$;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM exam_intake_begin_before b JOIN pg_proc p ON p.oid=b.oid WHERE p.proowner<>b.proowner OR p.proacl IS DISTINCT FROM b.proacl) THEN
    RAISE EXCEPTION 'Existing intake begin owner or ACL changed'; END IF;
END $$;
COMMIT;
