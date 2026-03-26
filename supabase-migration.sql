-- =============================================================
-- MIGRAÇÃO: Novo modelo ExamCard com múltiplos exames
-- Rodar no Supabase SQL Editor
-- =============================================================

-- ─── 1. Tabela exam_card ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.exam_card (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status         text NOT NULL DEFAULT 'aguardando_lab'
                 CHECK (status IN ('aguardando_lab','exame_pronto','contato_realizado','atrasado')),
  alert_level    text NOT NULL DEFAULT 'normal'
                 CHECK (alert_level IN ('normal','warning','critical')),
  origin         text NOT NULL DEFAULT 'email'
                 CHECK (origin IN ('venda','email')),
  is_orphan      boolean NOT NULL DEFAULT false,
  sale_id        text,
  pet_name       text,
  pet_species    text,
  pet_breed      text,
  client_name    text,
  client_phone   text,
  client_email   text,
  vet_name       text,
  resolved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ─── 2. Tabela exam_item ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.exam_item (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_card_id        uuid NOT NULL REFERENCES public.exam_card(id) ON DELETE CASCADE,
  exam_type           text NOT NULL,
  lab_name            text,
  arquivo_url         text,
  result_received     boolean NOT NULL DEFAULT false,
  result_received_at  timestamptz,
  contacted           boolean NOT NULL DEFAULT false,
  contacted_at        timestamptz,
  contacted_by        text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ─── 3. Tabela exam_card_log ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.exam_card_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_card_id     uuid NOT NULL REFERENCES public.exam_card(id) ON DELETE CASCADE,
  previous_status  text,
  new_status       text NOT NULL,
  changed_by       text NOT NULL DEFAULT 'system',
  change_reason    text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ─── 4. Índices ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_exam_item_card  ON public.exam_item(exam_card_id);
CREATE INDEX IF NOT EXISTS idx_exam_card_status ON public.exam_card(status);
CREATE INDEX IF NOT EXISTS idx_exam_card_log_card ON public.exam_card_log(exam_card_id);

-- ─── 5. Trigger: updated_at automático ───────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_exam_card_updated_at ON public.exam_card;
CREATE TRIGGER trg_exam_card_updated_at
  BEFORE UPDATE ON public.exam_card
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_exam_item_updated_at ON public.exam_item;
CREATE TRIGGER trg_exam_item_updated_at
  BEFORE UPDATE ON public.exam_item
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── 6. Trigger: ao marcar item como contactado ───────────────
--   → Se todos os items do card estiverem contactados: status = contato_realizado
--   → Se pelo menos 1 resultado recebido e card ainda aguardando_lab: status = exame_pronto
CREATE OR REPLACE FUNCTION public.handle_exam_item_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_total    int;
  v_ready    int;
  v_contacted int;
  v_card_status text;
BEGIN
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE result_received = true),
    COUNT(*) FILTER (WHERE contacted = true),
    c.status
  INTO v_total, v_ready, v_contacted, v_card_status
  FROM public.exam_item i
  JOIN public.exam_card c ON c.id = i.exam_card_id
  WHERE i.exam_card_id = NEW.exam_card_id
  GROUP BY c.status;

  -- Todos contactados → contato_realizado
  IF v_contacted = v_total AND v_total > 0 THEN
    IF v_card_status <> 'contato_realizado' THEN
      INSERT INTO public.exam_card_log (exam_card_id, previous_status, new_status, changed_by, change_reason)
        VALUES (NEW.exam_card_id, v_card_status, 'contato_realizado', 'system', 'Todos os itens foram contactados');
      UPDATE public.exam_card
        SET status = 'contato_realizado', resolved_at = now()
        WHERE id = NEW.exam_card_id;
    END IF;

  -- Pelo menos 1 resultado recebido e card ainda aguardando_lab → exame_pronto
  ELSIF v_ready > 0 AND v_card_status = 'aguardando_lab' THEN
    INSERT INTO public.exam_card_log (exam_card_id, previous_status, new_status, changed_by, change_reason)
      VALUES (NEW.exam_card_id, v_card_status, 'exame_pronto', 'system', 'Resultado parcial recebido');
    UPDATE public.exam_card
      SET status = 'exame_pronto'
      WHERE id = NEW.exam_card_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_handle_item_update ON public.exam_item;
CREATE TRIGGER trg_handle_item_update
  AFTER UPDATE ON public.exam_item
  FOR EACH ROW
  WHEN (OLD.contacted IS DISTINCT FROM NEW.contacted
     OR OLD.result_received IS DISTINCT FROM NEW.result_received)
  EXECUTE FUNCTION public.handle_exam_item_update();

-- ─── 7. View v_exam_cards ─────────────────────────────────────
DROP VIEW IF EXISTS public.v_exam_cards;
CREATE VIEW public.v_exam_cards AS
SELECT
  c.id,
  c.status,
  -- alert_level dinâmico baseado em horas decorridas + status
  CASE
    WHEN c.status = 'atrasado'                                                     THEN 'critical'
    WHEN c.status = 'contato_realizado'                                            THEN 'normal'
    WHEN EXTRACT(EPOCH FROM (now() - c.created_at)) / 3600.0 > 24                 THEN 'critical'
    WHEN EXTRACT(EPOCH FROM (now() - c.created_at)) / 3600.0 > 12                 THEN 'warning'
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
  -- items como array JSON
  COALESCE(
    json_agg(
      json_build_object(
        'id',                 i.id,
        'exam_card_id',       i.exam_card_id,
        'exam_type',          i.exam_type,
        'lab_name',           i.lab_name,
        'arquivo_url',        i.arquivo_url,
        'result_received',    i.result_received,
        'result_received_at', i.result_received_at,
        'contacted',          i.contacted,
        'contacted_at',       i.contacted_at,
        'contacted_by',       i.contacted_by
      ) ORDER BY i.created_at
    ) FILTER (WHERE i.id IS NOT NULL),
    '[]'::json
  ) AS items,
  COUNT(i.id) FILTER (WHERE i.result_received = true) AS items_ready,
  COUNT(i.id)                                          AS items_total,
  ROUND(
    CAST(EXTRACT(EPOCH FROM (now() - c.created_at)) / 3600.0 AS numeric),
    1
  ) AS hours_elapsed,
  c.created_at,
  c.updated_at
FROM public.exam_card c
LEFT JOIN public.exam_item i ON i.exam_card_id = c.id
GROUP BY c.id;

-- ─── 8. RPC get_exam_card_summary ────────────────────────────
CREATE OR REPLACE FUNCTION public.get_exam_card_summary()
RETURNS json
LANGUAGE sql
STABLE
AS $$
  SELECT json_build_object(
    'total_aguardando_lab',    COUNT(*) FILTER (WHERE status = 'aguardando_lab'),
    'total_exame_pronto',      COUNT(*) FILTER (WHERE status = 'exame_pronto'),
    'total_atrasado',          COUNT(*) FILTER (WHERE status = 'atrasado'),
    'total_contato_realizado', COUNT(*) FILTER (WHERE status = 'contato_realizado'),
    'total_orphans',           COUNT(*) FILTER (WHERE is_orphan = true),
    'avg_contact_hours',       COALESCE(
      AVG(hours_elapsed) FILTER (WHERE status = 'contato_realizado'),
      0
    )
  )
  FROM public.v_exam_cards;
$$;

-- ─── 9. RLS: permitir anon ler (ajuste conforme sua policy) ──
ALTER TABLE public.exam_card     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_item     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_card_log ENABLE ROW LEVEL SECURITY;

-- Política permissiva (ajuste se necessário para produção)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'exam_card' AND policyname = 'allow_all_exam_card') THEN
    CREATE POLICY allow_all_exam_card ON public.exam_card FOR ALL USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'exam_item' AND policyname = 'allow_all_exam_item') THEN
    CREATE POLICY allow_all_exam_item ON public.exam_item FOR ALL USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'exam_card_log' AND policyname = 'allow_all_exam_card_log') THEN
    CREATE POLICY allow_all_exam_card_log ON public.exam_card_log FOR ALL USING (true) WITH CHECK (true);
  END IF;
END$$;

GRANT EXECUTE ON FUNCTION public.get_exam_card_summary() TO anon, authenticated;

-- ─── 10. Dados de teste (opcional — remova em produção) ───────
/*
INSERT INTO public.exam_card (status, origin, is_orphan, pet_name, pet_species, client_name, client_phone, vet_name)
VALUES
  ('aguardando_lab', 'venda', false, 'Rex', 'Cão', 'João Silva', '(11) 99999-0001', 'Dra. Ana'),
  ('exame_pronto',   'venda', false, 'Mimi', 'Gato', 'Maria Costa', '(11) 99999-0002', 'Dra. Ana'),
  ('exame_pronto',   'email', true,  NULL,   NULL,   NULL,         NULL,             NULL),
  ('atrasado',       'venda', false, 'Thor', 'Cão', 'Carlos Lima', '(11) 99999-0003', 'Dr. Paulo');

INSERT INTO public.exam_item (exam_card_id, exam_type, lab_name, result_received)
SELECT id, 'Hemograma Completo', 'PetLab', false FROM public.exam_card WHERE pet_name = 'Rex'
UNION ALL
SELECT id, 'Urina Tipo I', 'PetLab', false FROM public.exam_card WHERE pet_name = 'Rex'
UNION ALL
SELECT id, 'Hemograma Completo', 'BioVet', true  FROM public.exam_card WHERE pet_name = 'Mimi'
UNION ALL
SELECT id, 'Perfil Renal', 'BioVet', true FROM public.exam_card WHERE pet_name = 'Mimi'
UNION ALL
SELECT id, 'Parasitológico', 'LabClin', true FROM public.exam_card WHERE pet_name IS NULL
UNION ALL
SELECT id, 'Hemograma Completo', 'PetLab', true FROM public.exam_card WHERE pet_name = 'Thor'
UNION ALL
SELECT id, 'PCR', 'PetLab', false FROM public.exam_card WHERE pet_name = 'Thor';
*/
