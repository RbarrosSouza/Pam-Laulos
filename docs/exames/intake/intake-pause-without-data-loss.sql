BEGIN;
UPDATE public.exam_intake_alert_configuration SET enabled=false WHERE singleton;
SELECT enabled AS automatic_alert_delivery_enabled FROM public.exam_intake_alert_configuration;
COMMIT;
