-- A generic Médico Veterinário label qualifies only inside the proven patient /
-- guardian / collection identification header. Signers and liberators do not.
-- No directory, assignment, extraction, historical document or CRMV rule changes.
BEGIN;

CREATE FUNCTION public.exam_document_header_date_valid(p_value text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE value text:=public.normalize_exam_identity(normalize(p_value,NFKC)); parts text[];
BEGIN
  IF value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    PERFORM make_date(substr(value,1,4)::integer,substr(value,6,2)::integer,substr(value,9,2)::integer); RETURN true;
  END IF;
  parts:=regexp_match(value,'^([0-9]{1,2})([./-])([0-9]{1,2})\2([0-9]{4})$');
  IF parts IS NULL THEN RETURN false; END IF;
  PERFORM make_date(parts[4]::integer,parts[3]::integer,parts[1]::integer); RETURN true;
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format OR numeric_value_out_of_range THEN RETURN false;
END;
$$;

CREATE FUNCTION public.exam_document_requester_header_matches(p_excerpt text,p_requester text,p_pet_name text,p_client_name text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE quote text:=public.normalize_exam_match_name(normalize(p_excerpt,NFKC));
  name text:=public.normalize_exam_match_name(normalize(p_requester,NFKC)); rows text[]; headers text[]; vals text[];
  pet_name text:=public.normalize_exam_match_name(normalize(p_pet_name,NFKC)); client_name text:=public.normalize_exam_match_name(normalize(p_client_name,NFKC));
  i integer; patient boolean:=false; guardian boolean:=false; collection boolean:=false; vet_name text; vet_values text;
  table_patient text; table_guardian text; guardian_columnar boolean:=false; identity record;
  header text; next_row text; registration text[]; patient_values text[]; date_count integer; collection_value text;
  inline_date text[]; at integer; offset_at integer:=0; prefix text; next_char text;
BEGIN
  IF quote IS NULL OR name IS NULL OR name='' OR pet_name='' OR client_name='' OR length(quote)>1500 OR quote ~ '(laudante|radiologista|assinad[oa]|assinatura|signatario|liberad[oa][[:space:]]+por|\mrt\M|responsavel[[:space:]]+((pelo|do)[[:space:]]+laudo|tecnico))' THEN RETURN false; END IF;
  -- Prefer real column gaps. Native n8n PDF extraction may flatten them to one
  -- space: only exact known headers and strict row suffixes permit that fallback.
  SELECT array_agg(line ORDER BY position) INTO rows FROM (
    SELECT regexp_replace(value,'^[[:space:]]+|[[:space:]]+$','','g') AS line,position
    FROM regexp_split_to_table(replace(normalize(p_excerpt,NFKC),E'\r',''),E'\n') WITH ORDINALITY r(value,position)
  ) r WHERE line<>'';
  IF cardinality(rows)>1 THEN
    FOR i IN 1..cardinality(rows)-1 LOOP
      SELECT array_agg(public.normalize_exam_match_name(value) ORDER BY position) INTO headers
        FROM unnest(regexp_split_to_array(rows[i],E'[ \\t]{2,}|\\t+')) WITH ORDINALITY c(value,position);
      SELECT array_agg(public.normalize_exam_match_name(value) ORDER BY position) INTO vals
        FROM unnest(regexp_split_to_array(rows[i+1],E'[ \\t]{2,}|\\t+')) WITH ORDINALITY c(value,position);
      header:=public.normalize_exam_match_name(rows[i]); next_row:=public.normalize_exam_match_name(rows[i+1]);
      IF header ~ '^clinica[[:space:]]+veterinaria[[:space:]]+medic[oa][[:space:]]+veterinari[oa][[:space:]]+crmv$' THEN
        IF cardinality(headers)=3 AND cardinality(vals)=3 AND NOT ''=ANY(vals) THEN vet_name:=vals[2];
        ELSE
          registration:=regexp_match(next_row,'^(.*?)[[:space:]]+((?:[a-z]{2}[[:space:]]*[-/]?[[:space:]]*[0-9]{3,8}|[0-9]{3,8}[[:space:]]*[-/]?[[:space:]]*[a-z]{2})|[0-9]{3,8})$');
          IF registration IS NOT NULL THEN vet_values:=registration[1]; END IF;
        END IF;
      END IF;
      IF header ~ '^(paciente|pet|animal|nome do paciente)[[:space:]]+idade[[:space:]]+sexo$' THEN
        IF cardinality(headers)=3 AND cardinality(vals)=3 AND NOT ''=ANY(vals) AND vals[1] ~ '[[:alpha:]]' THEN table_patient:=vals[1];
        ELSE
          patient_values:=regexp_match(next_row,'^(.+?)[[:space:]]+[0-9]+(?:[.,][0-9]+)?[[:space:]]*(?:a|m|d|anos?|meses?|dias?)[[:space:]]+(?:femea|macho|f|m)$');
          IF patient_values IS NOT NULL AND patient_values[1] ~ '[[:alpha:]]' THEN table_patient:=patient_values[1]; END IF;
        END IF;
      END IF;
      IF header ~ '^(responsavel|tutora?)[[:space:]]+raca[[:space:]]+data[[:space:]]+((da|de)[[:space:]]+)?coleta$' THEN
        SELECT count(*),min(m[1]) INTO date_count,collection_value FROM regexp_matches(next_row,'([0-9]{1,2}[./-][0-9]{1,2}[./-][0-9]{4}|[0-9]{4}-[0-9]{2}-[0-9]{2})','g') m;
        IF date_count=1 AND right(next_row,length(collection_value))=collection_value AND left(next_row,length(next_row)-length(collection_value)) ~ '[[:alpha:]]' THEN
          guardian_columnar:=cardinality(headers)=3 AND cardinality(vals)=3 AND NOT ''=ANY(vals);
          table_guardian:=CASE WHEN guardian_columnar THEN vals[1] ELSE trim(left(next_row,length(next_row)-length(collection_value))) END;
          collection:=public.exam_document_header_date_valid(collection_value);
        END IF;
      END IF;
    END LOOP;
  END IF;
  FOR identity IN SELECT * FROM (VALUES
    ('patient',pet_name,'\m(paciente|pet|animal|nome[[:space:]]+do[[:space:]]+paciente)[[:space:]]*[:=-][[:space:]]*$'),
    ('guardian',client_name,'\m(responsavel|tutora?)[[:space:]]*[:=-][[:space:]]*$')) AS identity(kind,value,label) LOOP
    offset_at:=0;
    LOOP
      at:=strpos(substr(quote,offset_at+1),identity.value); EXIT WHEN at=0;
      at:=at+offset_at; prefix:=substr(quote,1,at-1); next_char:=substr(quote,at+length(identity.value),1);
      IF prefix ~ identity.label AND (next_char='' OR next_char !~ '[[:alnum:]]') THEN
        IF identity.kind='patient' THEN patient:=true; ELSE guardian:=true; END IF; EXIT;
      END IF;
      offset_at:=at;
    END LOOP;
  END LOOP;
  IF table_patient IS NOT NULL THEN patient:=table_patient=pet_name; END IF;
  IF table_guardian IS NOT NULL THEN guardian:=CASE WHEN guardian_columnar THEN table_guardian=client_name
    ELSE left(table_guardian,length(client_name)+1)=client_name||' ' AND substr(table_guardian,length(client_name)+1) ~ '[[:alpha:]]' END; END IF;
  inline_date:=regexp_match(quote,'\m(?:data[[:space:]]+(?:(?:da|de)[[:space:]]+)?)?coleta[[:space:]]*[:=-][[:space:]]*([0-9]{1,2}[./-][0-9]{1,2}[./-][0-9]{4}|[0-9]{4}-[0-9]{2}-[0-9]{2})\M');
  collection:=collection OR (inline_date IS NOT NULL AND public.exam_document_header_date_valid(inline_date[1]));
  IF NOT (patient AND guardian AND collection) THEN RETURN false; END IF;
  IF vet_name IS NOT NULL THEN RETURN vet_name=name; END IF;
  IF vet_values IS NOT NULL THEN RETURN right(vet_values,length(name)+1)=' '||name AND left(vet_values,length(vet_values)-length(name)) ~ '[[:alpha:]]'; END IF;
  offset_at:=0;
  LOOP
    at:=strpos(substr(quote,offset_at+1),name); IF at=0 THEN RETURN false; END IF;
    at:=at+offset_at; prefix:=substr(quote,1,at-1); next_char:=substr(quote,at+length(name),1);
    IF prefix ~ '(^|[^[:alnum:]])medic[oa][[:space:]]+veterinari[oa][[:space:]]*[:=-]?[[:space:]]*((dr|dra|doutor|doutora)[.]?[[:space:]]+)?$'
      AND (next_char='' OR next_char !~ '[[:alnum:]]') THEN RETURN true; END IF;
    offset_at:=at;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.exam_document_header_date_valid(text),
  public.exam_document_requester_header_matches(text,text,text,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.exam_document_requester_identity_evidence_matches(p_excerpt text,p_requester text,p_pet_name text,p_client_name text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT public.exam_document_requester_evidence_matches(p_excerpt,p_requester)
    OR public.exam_document_requester_header_matches(p_excerpt,p_requester,p_pet_name,p_client_name)
$$;
REVOKE ALL ON FUNCTION public.exam_document_requester_identity_evidence_matches(text,text,text,text) FROM PUBLIC,anon,authenticated,service_role;

DO $patch$
DECLARE definition text; marker text;
BEGIN
  definition:=pg_get_functiondef('public.resolve_exam_document_responsible_vet(uuid)'::regprocedure);
  marker:=$old$public.exam_document_requester_evidence_matches(e->>'excerpt',requester)$old$;
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>2 THEN RAISE EXCEPTION 'Contrato das evidências da solicitante mudou; revisão obrigatória'; END IF;
  EXECUTE replace(definition,marker,$new$public.exam_document_requester_identity_evidence_matches(e->>'excerpt',requester,d.extracted_data->>'pet_name',COALESCE(d.extracted_data->>'client_name',d.extracted_data->>'tutor_name'))$new$);
END;
$patch$;
-- CREATE OR REPLACE retains resolver owner/ACL; the prior explicit-label helper,
-- name/CRMV directory matching, manual priority and source conflicts are intact.
COMMIT;
