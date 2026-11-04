-- Deterministic business conflicts must not advertise serialization_failure.
-- PostgREST 12 retries SQLSTATE 40001 inside one HTTP request indefinitely.
-- Preserve every guard, signature, owner and ACL; change only explicit RAISE
-- ERRCODE='40001' / RAISE SQLSTATE '40001' literals to HTTP conflict PT409.
-- Native database serialization errors and EXCEPTION handlers stay untouched.
-- Reviewed production inventory: 38 exam functions plus stock_app_count and
-- stock_app_count_revise (explicit stale-version / expired-counting rejection).
-- https://supabase.com/kb/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- A small lexer avoids changing comments, error messages, quoted identifiers,
-- dollar-quoted dynamic SQL or EXCEPTION WHEN SQLSTATE '40001' handlers.
-- Scan UTF-8 bytes once: text substring(position) repeatedly traverses preceding
-- multibyte characters and made the first production attempt exceed 30 seconds.
-- That attempt rolled back; production was restored with pre-reviewed exact
-- definitions. The same bounded migration remains safe for fresh installations.
-- This helper exists only in this connection's temporary schema.
CREATE OR REPLACE FUNCTION pg_temp.pam_nonretryable_business_conflicts(source text)
RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog AS $lexer$
DECLARE
  bytes bytea:=convert_to(source,'UTF8'); result bytea:=bytes;
  pos integer:=0; start_pos integer; end_pos integer; total integer:=octet_length(bytes);
  depth integer; token text; delimiter bytea; delimiter_length integer;
  character integer; next_character integer; escaped boolean; raise_statement boolean:=false;
  using_clause boolean:=false; raise_tokens integer:=0; expect_code integer:=0;
BEGIN
  WHILE pos<total LOOP
    character:=get_byte(bytes,pos);
    next_character:=CASE WHEN pos+1<total THEN get_byte(bytes,pos+1) ELSE -1 END;
    IF character IN (9,10,11,12,13,32) THEN pos:=pos+1; CONTINUE; END IF;
    IF character=45 AND next_character=45 THEN
      pos:=pos+2;
      WHILE pos<total AND get_byte(bytes,pos)<>10 LOOP pos:=pos+1; END LOOP;
      CONTINUE;
    END IF;
    IF character=47 AND next_character=42 THEN
      depth:=1; pos:=pos+2;
      WHILE pos<total AND depth>0 LOOP
        character:=get_byte(bytes,pos);
        next_character:=CASE WHEN pos+1<total THEN get_byte(bytes,pos+1) ELSE -1 END;
        IF character=47 AND next_character=42 THEN depth:=depth+1; pos:=pos+2;
        ELSIF character=42 AND next_character=47 THEN depth:=depth-1; pos:=pos+2;
        ELSE pos:=pos+1; END IF;
      END LOOP;
      IF depth<>0 THEN RAISE EXCEPTION 'Unterminated function comment'; END IF;
      CONTINUE;
    END IF;
    -- SQL strings can contain both semicolons and the word RAISE.
    IF character=39 OR (character IN (69,101) AND next_character=39) THEN
      escaped:=character<>39; IF escaped THEN pos:=pos+1; END IF;
      start_pos:=pos; pos:=pos+1;
      WHILE pos<total LOOP
        character:=get_byte(bytes,pos);
        next_character:=CASE WHEN pos+1<total THEN get_byte(bytes,pos+1) ELSE -1 END;
        IF escaped AND character=92 THEN pos:=pos+2;
        ELSIF character=39 AND next_character=39 THEN pos:=pos+2;
        ELSIF character=39 THEN EXIT;
        ELSE pos:=pos+1; END IF;
      END LOOP;
      IF pos>=total THEN RAISE EXCEPTION 'Unterminated function string'; END IF;
      IF expect_code=2 AND pos-start_pos=6 AND
        substring(bytes from start_pos+1 for 7)=convert_to('''40001''','UTF8') THEN
        -- Equal byte lengths keep every following token offset unchanged.
        result:=overlay(result placing convert_to('PT409','UTF8') from start_pos+2 for 5);
      END IF;
      expect_code:=0; pos:=pos+1; raise_tokens:=raise_tokens+1; CONTINUE;
    END IF;
    IF character=34 THEN
      pos:=pos+1;
      WHILE pos<total LOOP
        character:=get_byte(bytes,pos);
        next_character:=CASE WHEN pos+1<total THEN get_byte(bytes,pos+1) ELSE -1 END;
        IF character=34 AND next_character=34 THEN pos:=pos+2;
        ELSIF character=34 THEN EXIT;
        ELSE pos:=pos+1; END IF;
      END LOOP;
      IF pos>=total THEN RAISE EXCEPTION 'Unterminated function identifier'; END IF;
      expect_code:=0; pos:=pos+1; raise_tokens:=raise_tokens+1; CONTINUE;
    END IF;
    IF character=36 THEN
      end_pos:=pos+1;
      IF next_character=95 OR next_character BETWEEN 65 AND 90 OR
        next_character BETWEEN 97 AND 122 OR next_character>=128 THEN
        WHILE end_pos<total LOOP
          character:=get_byte(bytes,end_pos);
          EXIT WHEN NOT(character=95 OR character BETWEEN 65 AND 90 OR
            character BETWEEN 97 AND 122 OR character BETWEEN 48 AND 57 OR character>=128);
          end_pos:=end_pos+1;
        END LOOP;
      END IF;
      IF end_pos<total AND get_byte(bytes,end_pos)=36 THEN
        delimiter_length:=end_pos-pos+1;
        delimiter:=substring(bytes from pos+1 for delimiter_length);
        end_pos:=end_pos+1;
        WHILE end_pos<total LOOP
          EXIT WHEN get_byte(bytes,end_pos)=36 AND
            substring(bytes from end_pos+1 for delimiter_length)=delimiter;
          end_pos:=end_pos+1;
        END LOOP;
        IF end_pos>=total THEN RAISE EXCEPTION 'Unterminated function dollar string'; END IF;
        pos:=end_pos+delimiter_length; expect_code:=0;
        raise_tokens:=raise_tokens+1; CONTINUE;
      END IF;
      character:=36;
    END IF;
    IF character=95 OR character BETWEEN 65 AND 90 OR character BETWEEN 97 AND 122 OR character>=128 THEN
      start_pos:=pos;
      WHILE pos<total LOOP
        character:=get_byte(bytes,pos);
        EXIT WHEN NOT(character IN (36,95) OR character BETWEEN 65 AND 90 OR
          character BETWEEN 97 AND 122 OR character BETWEEN 48 AND 57 OR character>=128);
        pos:=pos+1;
      END LOOP;
      token:=CASE WHEN pos-start_pos<=8 THEN upper(convert_from(substring(bytes from start_pos+1 for pos-start_pos),'UTF8')) ELSE '' END;
      IF token='RAISE' THEN
        raise_statement:=true; using_clause:=false; raise_tokens:=0; expect_code:=0;
      ELSIF raise_statement THEN
        IF token='USING' THEN using_clause:=true; expect_code:=0;
        ELSIF token='ERRCODE' AND using_clause THEN expect_code:=1;
        ELSIF token='SQLSTATE' AND NOT using_clause AND raise_tokens<=1 THEN expect_code:=2;
        ELSE expect_code:=0; END IF;
        raise_tokens:=raise_tokens+1;
      ELSE expect_code:=0; END IF;
      CONTINUE;
    END IF;
    IF character=59 THEN raise_statement:=false; using_clause:=false; raise_tokens:=0; expect_code:=0;
    ELSIF character=61 AND expect_code=1 THEN expect_code:=2;
    ELSE expect_code:=0; END IF;
    pos:=pos+1;
  END LOOP;
  RETURN convert_from(result,'UTF8');
END $lexer$;

DO $patch$
DECLARE entry record; patched_body text; original_definition text; patched_definition text;
  original_metadata jsonb; current_metadata jsonb; body_pos integer;
BEGIN
  FOR entry IN
    SELECT p.oid,p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname='public' AND p.prokind='f' AND l.lanname IN ('plpgsql','sql')
      AND p.prosrc LIKE '%40001%' ORDER BY p.oid
  LOOP
    patched_body:=pg_temp.pam_nonretryable_business_conflicts(entry.prosrc);
    IF patched_body=entry.prosrc THEN CONTINUE; END IF;
    original_definition:=pg_get_functiondef(entry.oid);
    body_pos:=strpos(original_definition,entry.prosrc);
    IF body_pos=0 OR strpos(substr(original_definition,body_pos+length(entry.prosrc)),entry.prosrc)>0 THEN
      RAISE EXCEPTION 'Function body location is ambiguous for %',entry.oid::regprocedure;
    END IF;
    SELECT to_jsonb(p)-'prosrc' INTO original_metadata FROM pg_proc p WHERE oid=entry.oid;
    patched_definition:=overlay(original_definition placing patched_body from body_pos for length(entry.prosrc));
    EXECUTE patched_definition;
    SELECT to_jsonb(p)-'prosrc' INTO current_metadata FROM pg_proc p WHERE oid=entry.oid;
    IF current_metadata IS DISTINCT FROM original_metadata OR pg_get_functiondef(entry.oid) IS DISTINCT FROM patched_definition THEN
      RAISE EXCEPTION 'Function contract changed beyond conflict code for %',entry.oid::regprocedure;
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname='public' AND p.prokind='f'
    AND l.lanname IN ('plpgsql','sql') AND p.prosrc LIKE '%40001%'
    AND pg_temp.pam_nonretryable_business_conflicts(p.prosrc) IS DISTINCT FROM p.prosrc) THEN
    RAISE EXCEPTION 'Retryable custom business conflict remains';
  END IF;
END $patch$;
DROP FUNCTION pg_temp.pam_nonretryable_business_conflicts(text);
COMMIT;
