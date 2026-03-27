-- =============================================================
-- MIGRAÇÃO: RPC merge_exam_cards — Fundir dois cards de exame
-- Rodar no Supabase SQL Editor
-- =============================================================

CREATE OR REPLACE FUNCTION public.merge_exam_cards(
  p_target_card_id UUID,
  p_source_card_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_target_exists BOOLEAN;
  v_source_exists BOOLEAN;
  v_items_moved   INT;
  v_total         INT;
  v_ready         INT;
  v_contacted     INT;
  v_new_status    TEXT;
  v_old_status    TEXT;
BEGIN
  -- 1. Validate cards are different
  IF p_target_card_id = p_source_card_id THEN
    RETURN json_build_object('success', false, 'error', 'Target and source cards must be different');
  END IF;

  -- 2. Validate both cards exist
  SELECT EXISTS(SELECT 1 FROM public.exam_card WHERE id = p_target_card_id) INTO v_target_exists;
  SELECT EXISTS(SELECT 1 FROM public.exam_card WHERE id = p_source_card_id) INTO v_source_exists;

  IF NOT v_target_exists THEN
    RETURN json_build_object('success', false, 'error', 'Target card not found');
  END IF;

  IF NOT v_source_exists THEN
    RETURN json_build_object('success', false, 'error', 'Source card not found');
  END IF;

  -- 3. Move exam items from source to target
  UPDATE public.exam_item
    SET exam_card_id = p_target_card_id
    WHERE exam_card_id = p_source_card_id;

  GET DIAGNOSTICS v_items_moved = ROW_COUNT;

  -- 4. Calculate new status for target card
  SELECT status INTO v_old_status FROM public.exam_card WHERE id = p_target_card_id;

  SELECT
    COUNT(*)                                          INTO v_total
    FROM public.exam_item WHERE exam_card_id = p_target_card_id;

  SELECT
    COUNT(*) FILTER (WHERE result_received = true)    INTO v_ready
    FROM public.exam_item WHERE exam_card_id = p_target_card_id;

  SELECT
    COUNT(*) FILTER (WHERE contacted = true)          INTO v_contacted
    FROM public.exam_item WHERE exam_card_id = p_target_card_id;

  -- Apply same logic as handle_exam_item_update trigger
  IF v_contacted = v_total AND v_total > 0 THEN
    v_new_status := 'contato_realizado';
  ELSIF v_ready > 0 AND v_old_status = 'aguardando_lab' THEN
    v_new_status := 'exame_pronto';
  ELSE
    v_new_status := v_old_status;
  END IF;

  -- 5. Update target card
  UPDATE public.exam_card
    SET status     = v_new_status,
        is_orphan  = false,
        updated_at = now()
    WHERE id = p_target_card_id;

  -- 6. Log the merge on target card
  INSERT INTO public.exam_card_log (exam_card_id, previous_status, new_status, changed_by, change_reason)
    VALUES (
      p_target_card_id,
      v_old_status,
      v_new_status,
      'merge',
      'Card fundido — ' || v_items_moved || ' exame(s) movido(s) do card órfão'
    );

  -- 7. Delete the source card (items already moved, logs cascade-deleted)
  DELETE FROM public.exam_card WHERE id = p_source_card_id;

  -- 8. Return result
  RETURN json_build_object(
    'success',        true,
    'target_card_id', p_target_card_id,
    'items_moved',    v_items_moved,
    'new_status',     v_new_status
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.merge_exam_cards(UUID, UUID) TO authenticated, anon;
