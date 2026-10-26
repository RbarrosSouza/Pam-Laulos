-- Allow searching candidates by phone number, phonetic variations (quiara / kiara / chiara),
-- and requesting/attending veterinarian name, returning client_phone and doctor information
-- while raising candidate limit up to 100 to avoid cutting off homonyms.
BEGIN;

CREATE OR REPLACE FUNCTION public.search_exam_document_candidates(p_query text,p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_result jsonb;
  v_q text := trim(COALESCE(p_query,''));
  v_digits text := regexp_replace(v_q, '\D', '', 'g');
  v_alt1 text := CASE
    WHEN lower(v_q) LIKE '%qui%' THEN replace(lower(v_q), 'qui', 'ki')
    WHEN lower(v_q) LIKE '%ki%' THEN replace(lower(v_q), 'ki', 'qui')
    ELSE NULL
  END;
  v_alt2 text := CASE
    WHEN lower(v_q) LIKE '%chi%' THEN replace(lower(v_q), 'chi', 'ki')
    WHEN lower(v_q) LIKE '%ki%' THEN replace(lower(v_q), 'ki', 'chi')
    WHEN lower(v_q) LIKE '%qui%' THEN replace(lower(v_q), 'qui', 'chi')
    ELSE NULL
  END;
BEGIN
  PERFORM public.require_exam_document_member();
  IF length(v_q) < 2 OR p_limit NOT BETWEEN 1 AND 100 THEN RETURN '[]'::jsonb; END IF;

  SELECT COALESCE(jsonb_agg(x),'[]') INTO v_result FROM (
    SELECT
      p.id AS pet_id,
      p.name AS pet_name,
      p.species,
      p.client_code,
      c."Nome" AS tutor_name,
      c."Nome" AS client_name,
      c."Celular" AS client_phone,
      c."Celular" AS tutor_phone,
      (
        SELECT ec.vet_name
        FROM public.exam_card ec
        WHERE ec.archived_at IS NULL
          AND (ec.pet_id = p.id OR (ec.pet_id IS NULL AND ec.client_code = p.client_code AND lower(ec.pet_name) = lower(p.name)))
          AND ec.vet_name IS NOT NULL
        ORDER BY ec.created_at DESC
        LIMIT 1
      ) AS last_vet_name,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', i.id, 'exam_card_id', i.exam_card_id, 'exam_type', i.exam_type, 'result_received', i.result_received))
        FROM public.exam_item i
        JOIN public.exam_card ec ON ec.id = i.exam_card_id
        WHERE ec.archived_at IS NULL
          AND (ec.pet_id = p.id OR (ec.pet_id IS NULL AND ec.client_code = p.client_code AND lower(ec.pet_name) = lower(p.name)))
      ), '[]') AS items
    FROM public.pets p
    LEFT JOIN public.clients c ON c."Código" = p.client_code
    WHERE
      p.name ILIKE '%'||v_q||'%'
      OR (v_alt1 IS NOT NULL AND p.name ILIKE '%'||v_alt1||'%')
      OR (v_alt2 IS NOT NULL AND p.name ILIKE '%'||v_alt2||'%')
      OR c."Nome" ILIKE '%'||v_q||'%'
      OR (v_alt1 IS NOT NULL AND c."Nome" ILIKE '%'||v_alt1||'%')
      OR c."Celular" ILIKE '%'||v_q||'%'
      OR (length(v_digits) >= 4 AND regexp_replace(COALESCE(c."Celular",''), '\D', '', 'g') LIKE '%'||v_digits||'%')
      OR p.code = v_q
      OR p.chip = v_q
      OR EXISTS (
        SELECT 1 FROM public.exam_card ec
        WHERE ec.archived_at IS NULL
          AND (ec.pet_id = p.id OR (ec.pet_id IS NULL AND ec.client_code = p.client_code AND lower(ec.pet_name) = lower(p.name)))
          AND ec.vet_name ILIKE '%'||v_q||'%'
      )
    ORDER BY p.name, c."Nome"
    LIMIT p_limit
  ) x;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.search_exam_document_candidates(text,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.search_exam_document_candidates(text,integer) TO authenticated;

COMMIT;
