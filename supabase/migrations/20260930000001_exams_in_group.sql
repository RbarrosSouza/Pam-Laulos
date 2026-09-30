-- The old "atrasado" column did not record when a result was shared.
-- Keep those cards ready for review; do not invent a group timestamp.
ALTER TABLE public.exam_card ADD COLUMN IF NOT EXISTS group_sent_at timestamptz;

INSERT INTO public.exam_card_log (exam_card_id, previous_status, new_status, changed_by, change_reason)
SELECT id, 'atrasado', 'exame_pronto', 'system',
       'Migração: atraso antigo sem registro de envio ao grupo; devolvido para Exame Pronto'
FROM public.exam_card
WHERE status = 'atrasado';

UPDATE public.exam_card
SET status = 'exame_pronto'
WHERE status = 'atrasado';

ALTER TABLE public.exam_card DROP CONSTRAINT IF EXISTS exam_card_status_check;
ALTER TABLE public.exam_card ADD CONSTRAINT exam_card_status_check
  CHECK (status IN ('aguardando_lab', 'exame_pronto', 'no_grupo', 'contato_realizado'));

CREATE OR REPLACE FUNCTION public.set_exam_group_sent_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'no_grupo' THEN
      NEW.group_sent_at := now();
    END IF;
  ELSIF NEW.status = 'no_grupo' AND OLD.status IS DISTINCT FROM 'no_grupo' THEN
    NEW.group_sent_at := now();
  ELSIF OLD.status = 'no_grupo' AND NEW.status NOT IN ('no_grupo', 'contato_realizado') THEN
    NEW.group_sent_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_exam_group_sent_at ON public.exam_card;
CREATE TRIGGER trg_exam_group_sent_at
  BEFORE INSERT OR UPDATE OF status ON public.exam_card
  FOR EACH ROW EXECUTE FUNCTION public.set_exam_group_sent_at();

CREATE OR REPLACE VIEW public.v_exam_cards AS
SELECT
  c.id,
  c.status,
  CASE
    WHEN c.status = 'no_grupo' AND c.group_sent_at < now() - interval '24 hours' THEN 'critical'
    ELSE 'normal'
  END AS alert_level,
  c.origin,
  c.is_orphan,
  c.sale_id,
  c.pet_name,
  c.pet_species,
  c.pet_breed,
  c.client_name,
  c.client_phone,
  c.client_email,
  c.vet_name,
  COALESCE(
    json_agg(
      json_build_object(
        'id', i.id,
        'exam_card_id', i.exam_card_id,
        'exam_type', i.exam_type,
        'lab_name', i.lab_name,
        'arquivo_url', i.arquivo_url,
        'result_received', i.result_received,
        'result_received_at', i.result_received_at,
        'contacted', i.contacted,
        'contacted_at', i.contacted_at,
        'contacted_by', i.contacted_by,
        'sent_to_lab_at', i.sent_to_lab_at,
        'sent_to_lab_by', i.sent_to_lab_by,
        'shipment_id', i.shipment_id
      ) ORDER BY i.created_at
    ) FILTER (WHERE i.id IS NOT NULL),
    '[]'::json
  ) AS items,
  COUNT(i.id) FILTER (WHERE i.result_received = true) AS items_ready,
  COUNT(i.id) AS items_total,
  ROUND(CAST(EXTRACT(EPOCH FROM (now() - c.created_at)) / 3600.0 AS numeric), 1) AS hours_elapsed,
  c.created_at,
  c.updated_at,
  c.group_sent_at
FROM public.exam_card c
LEFT JOIN public.exam_item i ON i.exam_card_id = c.id
GROUP BY c.id;

CREATE OR REPLACE FUNCTION public.get_exam_card_summary()
RETURNS json LANGUAGE sql STABLE AS $$
  SELECT json_build_object(
    'total_aguardando_lab', COUNT(*) FILTER (WHERE status = 'aguardando_lab'),
    'total_exame_pronto', COUNT(*) FILTER (WHERE status = 'exame_pronto'),
    'total_no_grupo', COUNT(*) FILTER (WHERE status = 'no_grupo'),
    'total_atrasado', COUNT(*) FILTER (WHERE status = 'no_grupo' AND alert_level = 'critical'),
    'total_contato_realizado', COUNT(*) FILTER (WHERE status = 'contato_realizado'),
    'total_orphans', COUNT(*) FILTER (WHERE is_orphan = true),
    'avg_contact_hours', COALESCE(AVG(hours_elapsed) FILTER (WHERE status = 'contato_realizado'), 0)
  ) FROM public.v_exam_cards;
$$;

-- Preserve the deployed matching function, including any production fixes,
-- while allowing new results to attach to cards already sent to the group.
DO $$
DECLARE
  v_function text;
BEGIN
  SELECT pg_get_functiondef(
    'public.receive_email_result(text,text,text,text,text,timestamp with time zone)'::regprocedure
  ) INTO v_function;

  IF position('''atrasado''' IN v_function) = 0 THEN
    RAISE EXCEPTION 'receive_email_result status list was not found; review the deployed function';
  END IF;

  EXECUTE replace(v_function, '''atrasado''', '''no_grupo''');
END;
$$;
