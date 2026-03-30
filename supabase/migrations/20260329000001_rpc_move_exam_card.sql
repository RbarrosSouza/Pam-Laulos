-- =============================================================
-- RPC: move_exam_card
-- Move um card de uma coluna para outra via drag-and-drop
-- Atualiza itens conforme destino e registra audit log
-- =============================================================

DROP FUNCTION IF EXISTS public.move_exam_card(UUID, TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.move_exam_card(
  p_card_id      UUID,
  p_from_status  TEXT,
  p_to_status    TEXT,
  p_moved_by     TEXT DEFAULT 'reception',
  p_contacted_by TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_status TEXT;
BEGIN
  -- Busca status atual com lock para evitar concorrência
  SELECT status INTO v_current_status
    FROM public.exam_card
    WHERE id = p_card_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Card não encontrado');
  END IF;

  -- Idempotência: já está no destino
  IF v_current_status = p_to_status THEN
    RETURN json_build_object('success', true, 'already_there', true, 'status', v_current_status);
  END IF;

  -- Valida status de origem (evita race condition)
  IF v_current_status <> p_from_status THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Status mudou durante a operação',
      'current_status', v_current_status
    );
  END IF;

  -- Atualiza status do card
  UPDATE public.exam_card
    SET status = p_to_status, updated_at = now()
    WHERE id = p_card_id;

  -- Efeitos colaterais por destino
  IF p_to_status = 'exame_pronto' THEN
    -- Marca todos os itens como recebidos
    UPDATE public.exam_item
      SET result_received    = true,
          result_received_at = COALESCE(result_received_at, now())
      WHERE exam_card_id = p_card_id
        AND result_received = false;

  ELSIF p_to_status = 'contato_realizado' THEN
    -- Marca todos os itens como contatados
    UPDATE public.exam_item
      SET contacted    = true,
          contacted_at = COALESCE(contacted_at, now()),
          contacted_by = COALESCE(p_contacted_by, contacted_by)
      WHERE exam_card_id = p_card_id;
  END IF;

  -- Audit log
  INSERT INTO public.exam_card_log (
    exam_card_id, previous_status, new_status, changed_by, change_reason
  ) VALUES (
    p_card_id,
    p_from_status,
    p_to_status,
    COALESCE(p_contacted_by, p_moved_by),
    'Movido via drag-and-drop'
  );

  RETURN json_build_object(
    'success', true,
    'card_id', p_card_id,
    'from_status', p_from_status,
    'to_status', p_to_status
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.move_exam_card(UUID, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;

COMMENT ON FUNCTION public.move_exam_card IS
  'Move card entre colunas do kanban. Se → exame_pronto: marca itens como recebidos. Se → contato_realizado: marca itens como contatados.';
