-- =============================================================
-- CORREÇÃO: Resetar result_received incorretamente marcado
-- Executa no Supabase SQL Editor
-- Problema: seed marcou result_received=true sem o N8n ter sinalizado
-- Critério correto: result_received=true somente se result_received_at IS NOT NULL
-- =============================================================

-- 1. Resetar exam_items que foram incorretamente marcados como recebidos
--    (N8n nunca sinalizou — result_received_at é NULL)
UPDATE public.exam_item
SET result_received = false,
    result_received_at = NULL
WHERE result_received = true
  AND result_received_at IS NULL;

-- 2. Recalcular status dos cards que não têm mais items prontos
--    Se nenhum item tem result_received=true, card volta para aguardando_lab
UPDATE public.exam_card c
SET status = 'aguardando_lab'
WHERE c.status = 'exame_pronto'
  AND NOT EXISTS (
    SELECT 1 FROM public.exam_item i
    WHERE i.exam_card_id = c.id
      AND i.result_received = true
  );

-- 3. Registrar a correção no log dos cards afetados
INSERT INTO public.exam_card_log (exam_card_id, previous_status, new_status, changed_by, change_reason)
SELECT
  c.id,
  'exame_pronto',
  'aguardando_lab',
  'migration_fix',
  'Correção: result_received estava incorretamente true (N8n não havia sinalizado)'
FROM public.exam_card c
WHERE c.status = 'aguardando_lab'
  AND EXISTS (
    SELECT 1 FROM public.exam_card_log l
    WHERE l.exam_card_id = c.id
      AND l.new_status IN ('exame_pronto', 'aguardando_lab')
      AND l.changed_by = 'migration'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.exam_card_log l
    WHERE l.exam_card_id = c.id
      AND l.changed_by = 'migration_fix'
  );

-- Verificação: exibir estado após correção
SELECT
  status,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE is_orphan) AS orphans
FROM public.v_exam_cards
GROUP BY status
ORDER BY status;
