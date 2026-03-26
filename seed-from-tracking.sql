-- =============================================================
-- SEED: Importa registros de exam_tracking → exam_card + exam_item
-- Filtro: origin = 'venda', criados de quinta (2026-03-19) até hoje
-- Rodar no Supabase SQL Editor APÓS executar supabase-migration.sql
-- =============================================================

DO $$
DECLARE
  r          RECORD;
  new_status text;
  res_recv   boolean;
  contacted  boolean;
  card_id    uuid;
  n          int := 0;
BEGIN

  FOR r IN
    SELECT
      et.id,
      et.status,
      et.alert_level,
      et.origin,
      et.email_received_at,
      et.exam_type,
      et.sale_product_name,
      et.lab_name,
      et.arquivo_url,
      et.resolved_by,
      et.resolved_at,
      et.created_at,
      et.updated_at,
      -- dados enriquecidos da view (joins com pets, clientes, etc.)
      COALESCE(vd.pet_name,      et.pet_name_parsed)    AS pet_name,
      COALESCE(vd.pet_species,   NULL)                   AS pet_species,
      COALESCE(vd.pet_breed,     NULL)                   AS pet_breed,
      COALESCE(vd.client_name,   et.client_name_parsed)  AS client_name,
      COALESCE(vd.client_phone,  NULL)                   AS client_phone,
      COALESCE(vd.client_email,  NULL)                   AS client_email,
      COALESCE(vd.vet_name,      NULL)                   AS vet_name
    FROM public.exam_tracking et
    LEFT JOIN public.v_exam_dashboard vd ON vd.id = et.id
    WHERE et.origin = 'venda'
      AND et.created_at >= '2026-03-19 00:00:00-03'::timestamptz
      AND et.created_at <  '2026-03-23 00:00:00-03'::timestamptz
    ORDER BY et.created_at
  LOOP

    -- Mapeia status antigo → novo
    new_status := CASE r.status
      WHEN 'aguardando_resultado' THEN 'aguardando_lab'
      WHEN 'recebido'             THEN 'exame_pronto'
      WHEN 'aguardando_contato'   THEN 'exame_pronto'
      WHEN 'em_andamento'         THEN 'exame_pronto'
      WHEN 'enviado'              THEN 'contato_realizado'
      WHEN 'atrasado'             THEN 'atrasado'
      ELSE                             'aguardando_lab'
    END;

    -- Estado dos items baseado no status antigo
    -- Só marca como recebido se o N8n registrou o email (email_received_at preenchido)
    res_recv  := r.email_received_at IS NOT NULL;
    contacted := r.status = 'enviado';

    -- Cria exam_card (1 por registro antigo = 1 venda individual)
    INSERT INTO public.exam_card (
      status,
      alert_level,
      origin,
      is_orphan,
      pet_name,
      pet_species,
      pet_breed,
      client_name,
      client_phone,
      client_email,
      vet_name,
      resolved_at,
      created_at,
      updated_at
    ) VALUES (
      new_status,
      COALESCE(r.alert_level, 'normal'),
      'venda',
      false,
      r.pet_name,
      r.pet_species,
      r.pet_breed,
      r.client_name,
      r.client_phone,
      r.client_email,
      r.vet_name,
      r.resolved_at,
      r.created_at,
      r.updated_at
    ) RETURNING id INTO card_id;

    -- Cria exam_item correspondente
    INSERT INTO public.exam_item (
      exam_card_id,
      exam_type,
      lab_name,
      arquivo_url,
      result_received,
      result_received_at,
      contacted,
      contacted_at,
      contacted_by,
      created_at
    ) VALUES (
      card_id,
      COALESCE(NULLIF(TRIM(r.exam_type), ''), r.sale_product_name, 'Exame'),
      r.lab_name,
      r.arquivo_url,
      res_recv,
      CASE WHEN res_recv THEN r.email_received_at ELSE NULL END,
      contacted,
      CASE WHEN contacted THEN r.resolved_at ELSE NULL END,
      CASE WHEN contacted THEN r.resolved_by ELSE NULL END,
      r.created_at
    );

    -- Log inicial do card
    INSERT INTO public.exam_card_log (
      exam_card_id,
      previous_status,
      new_status,
      changed_by,
      change_reason,
      created_at
    ) VALUES (
      card_id,
      NULL,
      new_status,
      'migration',
      'Importado de exam_tracking (origin=venda, 2026-03-19 a 2026-03-22)',
      r.created_at
    );

    n := n + 1;
  END LOOP;

  RAISE NOTICE '✓ % cards importados com sucesso.', n;
END;
$$;

-- Verifica resultado
SELECT
  status,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE is_orphan) AS orphans
FROM public.v_exam_cards
GROUP BY status
ORDER BY status;
