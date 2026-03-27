-- =============================================================
-- MIGRAÇÃO: Tabela lab_shipment + colunas de envio em exam_item
-- + view v_exam_cards atualizada com campos de envio
-- Rodar no Supabase SQL Editor
-- =============================================================

-- ─── 1. Tabela lab_shipment ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lab_shipment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_name     text,
  sent_by      text NOT NULL,
  items_count  int NOT NULL DEFAULT 0,
  notes        text,
  sent_at      timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lab_shipment_sent_at ON public.lab_shipment(sent_at DESC);

ALTER TABLE public.lab_shipment ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'lab_shipment' AND policyname = 'allow_all_lab_shipment') THEN
    CREATE POLICY allow_all_lab_shipment ON public.lab_shipment FOR ALL USING (true) WITH CHECK (true);
  END IF;
END$$;

-- ─── 2. Colunas de envio em exam_item ─────────────────────────
ALTER TABLE public.exam_item ADD COLUMN IF NOT EXISTS sent_to_lab_at timestamptz;
ALTER TABLE public.exam_item ADD COLUMN IF NOT EXISTS sent_to_lab_by text;
ALTER TABLE public.exam_item ADD COLUMN IF NOT EXISTS shipment_id uuid REFERENCES public.lab_shipment(id);

CREATE INDEX IF NOT EXISTS idx_exam_item_shipment ON public.exam_item(shipment_id);

-- ─── 3. View v_exam_cards atualizada (inclui campos de envio) ─
DROP VIEW IF EXISTS public.v_exam_cards;
CREATE VIEW public.v_exam_cards AS
SELECT
  c.id,
  c.status,
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
        'contacted_by',       i.contacted_by,
        'sent_to_lab_at',     i.sent_to_lab_at,
        'sent_to_lab_by',     i.sent_to_lab_by,
        'shipment_id',        i.shipment_id
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
