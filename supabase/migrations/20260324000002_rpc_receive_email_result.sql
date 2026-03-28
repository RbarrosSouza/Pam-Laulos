-- =============================================================
-- RPC: receive_email_result
-- Substitui a Edge Function — faz matching e atualiza exam_item
-- N8n chama via POST /rest/v1/rpc/receive_email_result
-- =============================================================

-- Dropar versões anteriores para evitar ambiguidade de assinatura
DROP FUNCTION IF EXISTS public.receive_email_result(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.receive_email_result();

CREATE OR REPLACE FUNCTION public.receive_email_result(
  p_pet_name    TEXT DEFAULT NULL,
  p_exam_type   TEXT DEFAULT NULL,
  p_lab_name    TEXT DEFAULT NULL,
  p_arquivo_url TEXT DEFAULT NULL,
  p_received_at TIMESTAMPTZ DEFAULT now()
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_candidate   RECORD;
  v_best_id     UUID;
  v_best_card   UUID;
  v_best_score  INT := 0;
  v_best_type   TEXT := 'none';
  v_total       INT := 0;
  v_score       INT;
  v_orphan_card UUID;
  v_norm_pet    TEXT;
  v_norm_exam   TEXT;
  v_norm_lab    TEXT;
  -- Phase 2 vars
  v_card_candidate RECORD;
  v_card_best_id   UUID;
  v_card_best_score INT := 0;
  v_card_total     INT := 0;
  v_new_item_id    UUID;
BEGIN
  -- Normaliza inputs (lowercase, sem acentos extras, trim)
  v_norm_pet  := LOWER(TRIM(COALESCE(p_pet_name, '')));
  v_norm_exam := LOWER(TRIM(COALESCE(p_exam_type, '')));
  v_norm_lab  := LOWER(TRIM(COALESCE(p_lab_name, '')));

  -- Valida que pelo menos um campo foi enviado
  IF v_norm_pet = '' AND v_norm_exam = '' AND v_norm_lab = '' THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Precisa de pelo menos pet_name, exam_type ou lab_name'
    );
  END IF;

  -- ═══════════════════════════════════════════════════════════
  -- FASE 1: Match por ITEM (pet_name + exam_type + lab_name)
  -- ═══════════════════════════════════════════════════════════
  FOR v_candidate IN
    SELECT
      i.id AS item_id,
      c.id AS card_id,
      LOWER(TRIM(COALESCE(c.pet_name, ''))) AS pet,
      LOWER(TRIM(COALESCE(i.exam_type, ''))) AS exam,
      LOWER(TRIM(COALESCE(i.lab_name, ''))) AS lab
    FROM public.exam_item i
    JOIN public.exam_card c ON c.id = i.exam_card_id
    WHERE c.status = 'aguardando_lab'
      AND i.result_received = false
  LOOP
    v_total := v_total + 1;
    v_score := 0;

    -- Pet name match (+40pts)
    IF v_norm_pet <> '' AND v_candidate.pet <> '' THEN
      IF v_norm_pet = v_candidate.pet THEN
        v_score := v_score + 40;
      ELSIF v_candidate.pet LIKE '%' || v_norm_pet || '%'
         OR v_norm_pet LIKE '%' || v_candidate.pet || '%' THEN
        v_score := v_score + 35;
      END IF;
    END IF;

    -- Exam type match (+30pts)
    IF v_norm_exam <> '' AND v_candidate.exam <> '' THEN
      IF v_norm_exam = v_candidate.exam THEN
        v_score := v_score + 30;
      ELSIF v_candidate.exam LIKE '%' || v_norm_exam || '%'
         OR v_norm_exam LIKE '%' || v_candidate.exam || '%' THEN
        v_score := v_score + 25;
      END IF;
    END IF;

    -- Lab name match (+20pts)
    IF v_norm_lab <> '' AND v_candidate.lab <> '' THEN
      IF v_norm_lab = v_candidate.lab THEN
        v_score := v_score + 20;
      ELSIF v_candidate.lab LIKE '%' || v_norm_lab || '%'
         OR v_norm_lab LIKE '%' || v_candidate.lab || '%' THEN
        v_score := v_score + 15;
      END IF;
    END IF;

    -- Guarda melhor match
    IF v_score > v_best_score THEN
      v_best_score := v_score;
      v_best_id    := v_candidate.item_id;
      v_best_card  := v_candidate.card_id;
    END IF;
  END LOOP;

  -- Bônus: se só tem 1 candidato, +10pts
  IF v_total = 1 THEN
    v_best_score := v_best_score + 10;
  END IF;

  -- Threshold: 50pts mínimo para match
  IF v_best_score >= 50 AND v_best_id IS NOT NULL THEN
    -- Match encontrado → atualiza exam_item
    UPDATE public.exam_item
    SET result_received    = true,
        result_received_at = p_received_at,
        arquivo_url        = COALESCE(p_arquivo_url, arquivo_url)
    WHERE id = v_best_id
      AND result_received = false;  -- idempotência

    -- Determina tipo de match
    IF v_best_score >= 90 THEN
      v_best_type := 'exact';
    ELSIF v_total = 1 THEN
      v_best_type := 'single';
    ELSE
      v_best_type := 'fuzzy';
    END IF;

    RETURN json_build_object(
      'success', true,
      'matched', true,
      'card_id', v_best_card,
      'item_id', v_best_id,
      'score', v_best_score,
      'match_type', v_best_type,
      'candidates_found', v_total
    );
  END IF;

  -- ═══════════════════════════════════════════════════════════
  -- FASE 2: Match por CARD (pet_name no nível do card)
  -- Se o pet existe em algum card aguardando_lab, adiciona
  -- o resultado como NOVO item nesse card
  -- ═══════════════════════════════════════════════════════════
  IF v_norm_pet <> '' THEN
    FOR v_card_candidate IN
      SELECT
        c.id AS card_id,
        LOWER(TRIM(COALESCE(c.pet_name, ''))) AS pet,
        LOWER(TRIM(COALESCE(c.client_name, ''))) AS client
      FROM public.exam_card c
      WHERE c.status = 'aguardando_lab'
      GROUP BY c.id
    LOOP
      v_card_total := v_card_total + 1;
      v_score := 0;

      -- Pet name match
      IF v_card_candidate.pet <> '' THEN
        IF v_norm_pet = v_card_candidate.pet THEN
          v_score := v_score + 40;
        ELSIF v_card_candidate.pet LIKE '%' || v_norm_pet || '%'
           OR v_norm_pet LIKE '%' || v_card_candidate.pet || '%' THEN
          v_score := v_score + 35;
        END IF;
      END IF;

      IF v_score > v_card_best_score THEN
        v_card_best_score := v_score;
        v_card_best_id    := v_card_candidate.card_id;
      END IF;
    END LOOP;

    -- Bônus: se só tem 1 card candidato, +10pts
    IF v_card_total = 1 THEN
      v_card_best_score := v_card_best_score + 10;
    END IF;

    -- Threshold para match por card: 35pts (pet_name parcial já basta)
    IF v_card_best_score >= 35 AND v_card_best_id IS NOT NULL THEN
      -- Criar NOVO item no card existente com resultado já recebido
      INSERT INTO public.exam_item (
        exam_card_id, exam_type, lab_name, arquivo_url,
        result_received, result_received_at
      ) VALUES (
        v_card_best_id,
        COALESCE(p_exam_type, 'Exame'),
        p_lab_name,
        p_arquivo_url,
        true,
        p_received_at
      ) RETURNING id INTO v_new_item_id;

      -- Atualizar status do card para exame_pronto se ainda está aguardando
      UPDATE public.exam_card
        SET status = 'exame_pronto', updated_at = now()
        WHERE id = v_card_best_id AND status = 'aguardando_lab';

      -- Log
      INSERT INTO public.exam_card_log (
        exam_card_id, previous_status, new_status, changed_by, change_reason
      ) VALUES (
        v_card_best_id, 'aguardando_lab', 'exame_pronto', 'system',
        'Resultado de exame diferente associado ao mesmo pet (match por nome)'
      );

      RETURN json_build_object(
        'success', true,
        'matched', true,
        'card_id', v_card_best_id,
        'item_id', v_new_item_id,
        'score', v_card_best_score,
        'match_type', 'card_match',
        'candidates_found', v_card_total
      );
    END IF;
  END IF;

  -- ═══════════════════════════════════════════════════════════
  -- FASE 3: Sem match → cria card órfão
  -- ═══════════════════════════════════════════════════════════
  INSERT INTO public.exam_card (
    status, alert_level, origin, is_orphan, pet_name
  ) VALUES (
    'aguardando_lab', 'warning', 'email', true, p_pet_name
  ) RETURNING id INTO v_orphan_card;

  INSERT INTO public.exam_item (
    exam_card_id, exam_type, lab_name, arquivo_url,
    result_received, result_received_at
  ) VALUES (
    v_orphan_card,
    COALESCE(p_exam_type, 'Exame'),
    p_lab_name,
    p_arquivo_url,
    true,
    p_received_at
  );

  INSERT INTO public.exam_card_log (
    exam_card_id, previous_status, new_status, changed_by, change_reason
  ) VALUES (
    v_orphan_card, NULL, 'aguardando_lab', 'webhook',
    'Email sem match — card órfão para triagem manual'
  );

  RETURN json_build_object(
    'success', true,
    'matched', false,
    'card_id', v_orphan_card,
    'match_type', 'orphan',
    'score', v_best_score,
    'candidates_found', v_total
  );
END;
$$;

-- Permissões: anon e authenticated podem chamar
GRANT EXECUTE ON FUNCTION public.receive_email_result TO anon, authenticated;

COMMENT ON FUNCTION public.receive_email_result IS
  'Recebe resultado de exame via email. Fase 1: match por item (pet+exam+lab). Fase 2: match por card (pet_name). Fase 3: cria card órfão.';
