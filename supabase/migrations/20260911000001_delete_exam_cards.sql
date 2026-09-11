-- Delete one or more exam cards and their dependent records atomically.
CREATE OR REPLACE FUNCTION public.delete_exam_cards(p_card_ids UUID[])
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INT := 0;
BEGIN
  IF p_card_ids IS NULL OR cardinality(p_card_ids) = 0 THEN
    RETURN json_build_object('success', false, 'error', 'Nenhum exame selecionado');
  END IF;

  DELETE FROM public.exam_card_log
  WHERE exam_card_id = ANY(p_card_ids);

  DELETE FROM public.exam_item
  WHERE exam_card_id = ANY(p_card_ids);

  DELETE FROM public.exam_card
  WHERE id = ANY(p_card_ids);

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN json_build_object('success', true, 'deleted', v_deleted);
EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_exam_cards(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_exam_cards(UUID[]) TO authenticated, anon;
