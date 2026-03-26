-- =============================================================
-- MIGRATION: Ponte exam_tracking → exam_card + exam_item
-- Trigger automático: quando PamNexus cria exam_tracking (venda),
-- automaticamente cria exam_card + exam_item no pam-exam-monitor
-- =============================================================

-- ─── Função do trigger ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bridge_tracking_to_card()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_pet_name    TEXT;
  v_pet_species TEXT;
  v_pet_breed   TEXT;
  v_client_name TEXT;
  v_client_phone TEXT;
  v_client_email TEXT;
  v_vet_name    TEXT;
  v_card_id     UUID;
  v_exam_type   TEXT;
BEGIN
  -- Só processa origin='venda' (emails são processados pela Edge Function)
  IF NEW.origin <> 'venda' THEN
    RETURN NEW;
  END IF;

  -- Evita duplicata: se já existe exam_card com esse sale_id, ignora
  IF NEW.sale_id IS NOT NULL THEN
    PERFORM 1 FROM public.exam_card
    WHERE sale_id = NEW.sale_id;
    IF FOUND THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Busca dados do pet
  IF NEW.pet_id IS NOT NULL THEN
    SELECT name, species, breed
    INTO v_pet_name, v_pet_species, v_pet_breed
    FROM public.pets
    WHERE id = NEW.pet_id;
  END IF;

  -- Fallback: usa dados parseados se pet não encontrado
  v_pet_name := COALESCE(v_pet_name, NEW.pet_name_parsed);

  -- Busca dados do cliente
  IF NEW.client_code IS NOT NULL THEN
    SELECT "Nome", "Celular", "E-mail"
    INTO v_client_name, v_client_phone, v_client_email
    FROM public.clients
    WHERE "Código" = NEW.client_code;
  END IF;

  -- Fallback: usa dados parseados se cliente não encontrado
  v_client_name := COALESCE(v_client_name, NEW.client_name_parsed);

  -- Busca nome do veterinário
  IF NEW.veterinario_id IS NOT NULL THEN
    SELECT nome
    INTO v_vet_name
    FROM public.veterinarios
    WHERE id = NEW.veterinario_id;
  END IF;

  -- Determina tipo do exame
  v_exam_type := COALESCE(
    NULLIF(TRIM(NEW.exam_type), ''),
    NEW.sale_product_name,
    'Exame'
  );

  -- Cria exam_card
  INSERT INTO public.exam_card (
    status,
    alert_level,
    origin,
    is_orphan,
    sale_id,
    pet_name,
    pet_species,
    pet_breed,
    client_name,
    client_phone,
    client_email,
    vet_name
  ) VALUES (
    'aguardando_lab',
    'normal',
    'venda',
    FALSE,
    NEW.sale_id,
    v_pet_name,
    v_pet_species,
    v_pet_breed,
    v_client_name,
    v_client_phone,
    v_client_email,
    v_vet_name
  ) RETURNING id INTO v_card_id;

  -- Cria exam_item
  INSERT INTO public.exam_item (
    exam_card_id,
    exam_type,
    lab_name,
    result_received,
    result_received_at
  ) VALUES (
    v_card_id,
    v_exam_type,
    NEW.lab_name,
    FALSE,
    NULL
  );

  -- Log inicial
  INSERT INTO public.exam_card_log (
    exam_card_id,
    previous_status,
    new_status,
    changed_by,
    change_reason
  ) VALUES (
    v_card_id,
    NULL,
    'aguardando_lab',
    'system',
    'Venda de exame detectada: ' || v_exam_type
  );

  RETURN NEW;
END;
$$;

-- ─── Trigger na tabela exam_tracking ────────────────────────
DROP TRIGGER IF EXISTS trg_bridge_tracking_to_card ON public.exam_tracking;

CREATE TRIGGER trg_bridge_tracking_to_card
  AFTER INSERT ON public.exam_tracking
  FOR EACH ROW
  EXECUTE FUNCTION public.bridge_tracking_to_card();

-- ─── Comentário ─────────────────────────────────────────────
COMMENT ON FUNCTION public.bridge_tracking_to_card() IS
  'Ponte automática: quando PamNexus insere em exam_tracking (origin=venda), cria exam_card + exam_item para o monitor';
